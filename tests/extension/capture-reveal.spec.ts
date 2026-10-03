/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Fork-only (03/10/2026, decided by the Gabriel: "mostrar só sem plateia"). Chrome draws no frame for a hidden tab, so a
// background relay's screenshot waited ~12-31 s in the live test. The relay asks the extension to show the tab for the
// capture (extension.revealForCapture) and to put the user's tab back (extension.restoreAfterCapture). The extension
// only reveals when the tab's window is not the focused one, never focuses a window, and does not put back a tab the
// user switched away from meanwhile. Headless does report and change chrome.windows focus (measured 03/10: a window is
// `focused` until chrome.windows.update(id, {focused:false})), so the "someone is looking" case is real here; the OS
// focus and the slow capture itself are not (headless captures a hidden tab at once). Runs on Windows like
// popup-source.spec.ts: `npm run test-extension -- capture-reveal`. FORK.md § Foco zero, "Screenshot".

import childProcess from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs/promises';

import { chromium } from 'playwright';

import { test, expect, extensionId } from './extension-fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

import type { Browser, BrowserContext, Page } from 'playwright';

type Relay = InstanceType<typeof tools.CDPRelayServer>;

const realSpawn = childProcess.spawn;
const ENV = ['PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'PLAYWRIGHT_MCP_FOCUS'];
const savedEnv = { ...process.env };
const relays: Relay[] = [];
const browsers: Browser[] = [];
const headless: { context: BrowserContext, userDataDir: string }[] = [];
let launches: string[] = [];

test.beforeEach(() => {
  process.env[ENV[0]] = randomUUID();
  delete process.env.PLAYWRIGHT_MCP_FOCUS;
  launches = [];
  (childProcess as any).spawn = (command: string, args: string[], options: any) => {
    if (command !== process.execPath)
      return realSpawn(command, args, options);
    launches.push(args[args.length - 1]);
    return new EventEmitter();
  };
});

test.afterEach(async () => {
  (childProcess as any).spawn = realSpawn;
  for (const browser of browsers.splice(0))
    await browser.close().catch(() => {});
  for (const relay of relays.splice(0))
    relay.stop();
  for (const { context, userDataDir } of headless.splice(0)) {
    await context.close().catch(() => {});
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  for (const name of ENV) {
    if (savedEnv[name] === undefined)
      delete process.env[name];
    else
      process.env[name] = savedEnv[name];
  }
});

async function launchHeadless(pathToExtension: string, userDataDir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });
  headless.push({ context, userDataDir });
  if (!context.serviceWorkers().length)
    await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/status.html`);
  await page.evaluate(value => localStorage.setItem('auth-token', value), process.env[ENV[0]]!);
  await page.close();
  return context;
}

async function swEval<T, A>(context: BrowserContext, fn: (arg: A) => Promise<T>, arg: A): Promise<T> {
  return await context.serviceWorkers()[0].evaluate(fn as any, arg);
}

const activeTab = (context: BrowserContext, windowId: number) => swEval(context, async (windowId: number) => {
  const [tab] = await (globalThis as any).chrome.tabs.query({ active: true, windowId });
  return tab?.id as number;
}, windowId);

async function newTab(context: BrowserContext, url: string, active: boolean): Promise<{ id: number, windowId: number }> {
  return await swEval(context, async ({ url, active }) => {
    const tab = await (globalThis as any).chrome.tabs.create({ url, active });
    await new Promise(f => setTimeout(f, 300));
    return { id: tab.id, windowId: tab.windowId };
  }, { url, active });
}

// Whether someone looks at the window: in headless chrome.windows.update moves this flag (see the header).
async function setWindowFocused(context: BrowserContext, windowId: number, focused: boolean) {
  await swEval(context, async ({ windowId, focused }) => {
    await (globalThis as any).chrome.windows.update(windowId, { focused });
  }, { windowId, focused });
  expect(await windowFocused(context, windowId)).toBe(focused);
}

const windowFocused = (context: BrowserContext, windowId: number) => swEval(context, async (windowId: number) => {
  return (await (globalThis as any).chrome.windows.get(windowId)).focused as boolean;
}, windowId);

// Every tab that becomes active from now on; `then` activates another tab right after the agent's (the user switching).
async function recordActivations(context: BrowserContext, options: { whenActivated?: number, then?: number } = {}) {
  await swEval(context, async ({ whenActivated, then }) => {
    const chrome = (globalThis as any).chrome;
    (globalThis as any).__activations = [];
    chrome.tabs.onActivated.addListener((info: { tabId: number }) => {
      (globalThis as any).__activations.push(info.tabId);
      if (info.tabId === whenActivated && then !== undefined)
        void chrome.tabs.update(then, { active: true });
    });
  }, options);
  return () => swEval(context, async () => (globalThis as any).__activations as number[], undefined);
}

// The user's tab in front, then the main agent with a token (a background relay since foco zero): its connect page,
// from the stubbed chrome.exe launch, puts the user's tab back. The agent's page (the seed) is never shown.
async function userAndAgent(context: BrowserContext, server: { EMPTY_PAGE: string, PREFIX: string, setContent: (path: string, content: string, mimeType: string) => void }) {
  const user = await newTab(context, server.EMPTY_PAGE, true);
  const relay = new tools.CDPRelayServer('chromium', process.execPath, undefined, undefined, { background: false });
  relays.push(relay);
  await relay.start();
  expect(relay.background).toBe(true);
  const connected = relay.establishExtensionConnection('main');
  await expect.poll(() => launches.length).toBe(1);
  const connectPage = await context.newPage();
  await connectPage.goto(launches[0]);
  await connected;
  const browser = await chromium.connectOverCDP(relay.cdpEndpoint());
  browsers.push(browser);
  await expect.poll(() => browser.contexts()[0].pages().length).toBe(1);
  const page: Page = browser.contexts()[0].pages()[0];
  server.setContent('/agent', '<title>agent</title><h1 style="color: rebeccapurple">agent page</h1>', 'text/html');
  await page.goto(server.PREFIX + '/agent');
  await expect.poll(() => activeTab(context, user.windowId)).toBe(user.id);
  const agent = await swEval(context, async (url: string) => {
    const [tab] = await (globalThis as any).chrome.tabs.query({ url });
    return tab.id as number;
  }, server.PREFIX + '/agent');
  expect(agent).not.toBe(user.id);
  return { relay, page, user, agent, windowId: user.windowId };
}

test('nobody looks at the window: the agent tab is shown for the capture and the user\'s tab comes back', async ({ pathToExtension, server }, testInfo) => {
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { page, user, agent, windowId } = await userAndAgent(context, server);
  await setWindowFocused(context, windowId, false);
  const activations = await recordActivations(context);
  expect((await page.screenshot()).length).toBeGreaterThan(0);
  await expect.poll(() => activations()).toEqual([agent, user.id]);
  expect(await activeTab(context, windowId)).toBe(user.id);
  // Never a window focus: the user stays in the other app.
  expect(await windowFocused(context, windowId)).toBe(false);
});

test('the user switched tabs during the capture: their choice stands, nothing is put back', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/other', '<title>other</title>', 'text/html');
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { page, user, agent, windowId } = await userAndAgent(context, server);
  const other = await newTab(context, server.PREFIX + '/other', false);
  await setWindowFocused(context, windowId, false);
  const activations = await recordActivations(context, { whenActivated: agent, then: other.id });
  await page.screenshot();
  await new Promise(f => setTimeout(f, 300));
  expect(await activations()).toEqual([agent, other.id]);
  expect(await activeTab(context, windowId)).toBe(other.id);
});

test('someone looks at the window: no tab is shown, the capture goes on (slowly in real Chrome)', async ({ pathToExtension, server }, testInfo) => {
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { page, user, windowId } = await userAndAgent(context, server);
  await setWindowFocused(context, windowId, true);
  const activations = await recordActivations(context);
  expect((await page.screenshot()).length).toBeGreaterThan(0);
  await new Promise(f => setTimeout(f, 300));
  expect(await activations()).toEqual([]);
  expect(await activeTab(context, windowId)).toBe(user.id);
});

// What a relay may ask: only its own tabs, only when they are hidden, and a restore only for a tab it revealed.
test('reveal and restore guards: tabs of this connection only, a tab already in front is left alone', async ({ pathToExtension, server }, testInfo) => {
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { relay, user, agent, windowId } = await userAndAgent(context, server);
  await setWindowFocused(context, windowId, false);
  const send = (method: string, params: any[]) => (relay as any)._extensionConnection.send(method, params);
  const activations = await recordActivations(context);

  await expect(send('extension.revealForCapture', [user.id])).rejects.toThrow(`Tab ${user.id} is not attached to this connection`);
  expect(await send('extension.restoreAfterCapture', [agent])).toEqual({ restored: false });
  await swEval(context, async (tabId: number) => {
    await (globalThis as any).chrome.tabs.update(tabId, { active: true });
  }, agent);
  expect(await send('extension.revealForCapture', [agent])).toEqual({ revealed: false });
  expect(await send('extension.restoreAfterCapture', [agent])).toEqual({ restored: false });
  await new Promise(f => setTimeout(f, 300));
  expect(await activations()).toEqual([agent]);
  expect(await activeTab(context, windowId)).toBe(agent);
});
