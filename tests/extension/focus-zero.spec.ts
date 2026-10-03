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

// Fork-only (foco zero, 03/10/2026): the first connection of a session comes from a chrome.exe launch, which opens the
// connect page as the active tab. With a token (and no PLAYWRIGHT_MCP_FOCUS=on) the relay asks for a silent connect
// (`silent=1`) and the extension puts back the tab the user was on. Headless shows no OS focus, so only the active tab
// is checked here; giving the focus back to the terminal is checked by hand (FORK.md § Foco zero). Runs on Windows like
// popup-source.spec.ts: `npm run test-extension -- focus-zero`.

import childProcess from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs/promises';

import { chromium } from 'playwright';

import { test, expect, extensionId } from './extension-fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

import type { Browser, BrowserContext } from 'playwright';

type Relay = InstanceType<typeof tools.CDPRelayServer>;

const realSpawn = childProcess.spawn;
const ENV = ['PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'PLAYWRIGHT_MCP_FOCUS'];
const savedEnv = { ...process.env };
const relays: Relay[] = [];
const browsers: Browser[] = [];
const headless: { context: BrowserContext, userDataDir: string }[] = [];
// The chrome.exe launch of the relay, by connect page URL: the test opens that page itself, in front, as Chrome would.
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

const activeTab = (context: BrowserContext) => swEval(context, async () => {
  const [tab] = await (globalThis as any).chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { id: tab?.id as number, url: tab?.url as string };
}, undefined);

// The user's tab, in front, before the agent's first browser call.
async function userTab(context: BrowserContext, url: string): Promise<number> {
  return await swEval(context, async (url: string) => {
    const tab = await (globalThis as any).chrome.tabs.create({ url, active: true });
    await new Promise(f => setTimeout(f, 300));
    return tab.id;
  }, url);
}

// The main agent's first connection: the relay's (stubbed) chrome.exe launch, whose connect page this test opens in
// front, then Playwright on the relay's CDP side.
async function connectMain(context: BrowserContext): Promise<{ relay: Relay, connectUrl: URL }> {
  const relay = new tools.CDPRelayServer('chromium', process.execPath, undefined, undefined, { background: false });
  relays.push(relay);
  await relay.start();
  const connected = relay.establishExtensionConnection('main');
  await expect.poll(() => launches.length).toBe(1);
  const connectPage = await context.newPage();
  await connectPage.goto(launches[0]);
  await connected;
  const browser = await chromium.connectOverCDP(relay.cdpEndpoint());
  browsers.push(browser);
  await expect.poll(() => browser.contexts()[0].pages().length).toBe(1);
  return { relay, connectUrl: new URL(launches[0]) };
}

test('with a token the first connection puts back the tab the user was on', async ({ pathToExtension, server }, testInfo) => {
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const user = await userTab(context, server.EMPTY_PAGE);
  const { connectUrl } = await connectMain(context);
  expect(connectUrl.searchParams.get('silent')).toBe('1');
  await expect.poll(async () => (await activeTab(context)).id).toBe(user);
});

test('a user who moved to another tab before the connection keeps that tab', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/other', '<title>other</title>', 'text/html');
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const user = await userTab(context, server.EMPTY_PAGE);
  const relay = new tools.CDPRelayServer('chromium', process.execPath, undefined, undefined, { background: false });
  relays.push(relay);
  await relay.start();
  const connected = relay.establishExtensionConnection('main');
  await expect.poll(() => launches.length).toBe(1);
  const connectPage = await context.newPage();
  // Between Chrome showing the connect page and the page connecting, the user clicks another tab.
  const other = await userTab(context, server.PREFIX + '/other');
  await connectPage.goto(launches[0]);
  await connected;
  await new Promise(f => setTimeout(f, 500));
  const active = (await activeTab(context)).id;
  expect(active).toBe(other);
  expect(active).not.toBe(user);
});

// The service worker sleeps between connections and wakes up for the connect page's tabs.onCreated, when Chrome already
// shows that tab: only what it stored before sleeping (chrome.storage.session) knows the tab the user was on.
test('the tab the user was on survives a service worker restart', async ({ pathToExtension, server }, testInfo) => {
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const user = await userTab(context, server.EMPTY_PAGE);
  const worker = context.serviceWorkers()[0];
  // Through the user's own tab: opening another one would change the active tab.
  await expect.poll(() => context.pages().some(page => page.url() === server.EMPTY_PAGE)).toBe(true);
  const userPage = context.pages().find(page => page.url() === server.EMPTY_PAGE)!;
  const cdp = await context.newCDPSession(userPage);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extensionId}/`))!;
  await worker.evaluate(() => (globalThis as any).__beforeRestart = true);
  await cdp.send('Target.closeTarget', { targetId: target.targetId });
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(info => info.targetId === target.targetId)).toBe(false);
  // The connect page's tab wakes a new worker up.
  await connectMain(context);
  // A new realm: Playwright re-attaches the same Worker object to the restarted worker.
  expect(await swEval(context, async () => (globalThis as any).__beforeRestart, undefined)).toBeUndefined();
  await expect.poll(async () => (await activeTab(context)).id).toBe(user);
});

test('PLAYWRIGHT_MCP_FOCUS=on: the connect page stays in front, as before', async ({ pathToExtension, server }, testInfo) => {
  process.env.PLAYWRIGHT_MCP_FOCUS = 'on';
  const context = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const user = await userTab(context, server.EMPTY_PAGE);
  const { connectUrl } = await connectMain(context);
  expect(connectUrl.searchParams.get('silent')).toBe(null);
  await new Promise(f => setTimeout(f, 500));
  const active = await activeTab(context);
  expect(active.id).not.toBe(user);
  expect(active.url).toContain(`chrome-extension://${extensionId}/connect.html`);
});
