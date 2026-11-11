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

// Fork-only (11/11/2026): the extension's MV3 service worker can die while a client is connected (idle death, crash).
// Its in-memory state dies with it, so `_onConnectionClose` never runs; the next worker start only found Playwright
// groups by title and ungrouped them, leaving the agent's tabs loose and open for good. Agent ownership now also lives
// in chrome.storage.session, and that start-up cleanup closes the agent's tabs (and a seed still on connect.html) and
// only ungroups the user's, and any agent tab that is the active tab of a focused window (the user may be typing in
// it). Same
// headless in-process harness as popup-source.spec.ts, so it runs on Windows: `npm run test-extension -- worker-death`.
// See FORK.md § The extension.

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
  // Relays first: with the worker dead, a Browser.close through a live relay would wait for an extension that is gone.
  for (const relay of relays.splice(0))
    relay.stop();
  // Bounded: a CDP browser whose relay is gone can wait forever for a Browser.close answer.
  const bounded = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), new Promise(f => setTimeout(f, 5000))]);
  for (const browser of browsers.splice(0))
    await bounded(browser.close());
  for (const { context, userDataDir } of headless.splice(0)) {
    await bounded(context.close());
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

// An agent connected with the token (its connect page is the seed tab, agent-owned), Playwright on its CDP side.
async function connectAgent(browserContext: BrowserContext): Promise<Page> {
  const relay = new tools.CDPRelayServer('chromium', process.execPath, undefined, undefined, { background: false });
  relays.push(relay);
  await relay.start();
  const connected = relay.establishExtensionConnection('agente');
  await expect.poll(() => launches.length).toBe(1);
  const connectPage = await browserContext.newPage();
  await connectPage.goto(launches[0]);
  await connected;
  const browser = await chromium.connectOverCDP(relay.cdpEndpoint());
  browsers.push(browser);
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().length).toBe(1);
  return context.pages()[0];
}

// The group a tab with this URL is in (-1: none), read from an extension page: unlike the worker, a page survives the
// worker's death, and reloading it wakes the next worker.
async function groupOf(probe: Page, url: string): Promise<number | undefined> {
  return await probe.evaluate(async u => {
    const [tab] = await chrome.tabs.query({ url: u });
    return tab ? tab.groupId : undefined;
  }, url);
}

// Kills the worker the way Chrome's idle timeout does: no JS runs, so no close handler and no cleanup. Repeated until
// that worker's target is gone (a close sent while the worker handles an event can be ignored).
async function killServiceWorker(browserContext: BrowserContext) {
  const cdp = await browserContext.browser()!.newBrowserCDPSession();
  const isWorker = (t: { type: string, url: string }) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`);
  const worker = (await cdp.send('Target.getTargets')).targetInfos.find(isWorker);
  expect(worker, 'extension service worker target').toBeTruthy();
  await expect.poll(async () => {
    await cdp.send('Target.closeTarget', { targetId: worker!.targetId }).catch(() => {});
    await new Promise(f => setTimeout(f, 200));
    return (await cdp.send('Target.getTargets')).targetInfos.some(t => t.targetId === worker!.targetId);
  }, { timeout: 15_000 }).toBe(false);
  await cdp.detach();
}

// Makes the probe the active tab of a focused window, so no agent tab is "in front of the user" (the start-up cleanup
// only ungroups an agent tab that is the active tab of a focused window). Headless keeps a per-window focused flag.
async function bringProbeToFront(probe: Page) {
  const state = await probe.evaluate(async () => {
    const tab = (await chrome.tabs.getCurrent())!;
    await chrome.tabs.update(tab.id!, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { active: (await chrome.tabs.get(tab.id!)).active, focused: (await chrome.windows.get(tab.windowId)).focused };
  });
  expect(state).toEqual({ active: true, focused: true });
}

// The tabs still showing the extension's connect page.
async function connectPageTabs(probe: Page): Promise<number[]> {
  return await probe.evaluate(async () => {
    const connectPage = chrome.runtime.getURL('connect.html');
    return (await chrome.tabs.query({})).filter(t => t.url?.startsWith(connectPage)).map(t => t.id!);
  });
}

async function agentTabRecord(probe: Page): Promise<number[]> {
  return await probe.evaluate(async () => (await chrome.storage.session.get('playwrightAgentTabs')).playwrightAgentTabs ?? []);
}

async function agentInGroupWithUserTab(browserContext: BrowserContext, server: { PREFIX: string, setContent: (path: string, content: string, mime: string) => void }) {
  server.setContent('/agent', '<title>agent</title>', 'text/html');
  server.setContent('/user', '<title>user</title>', 'text/html');
  const probe = await browserContext.newPage();
  await probe.goto(`chrome-extension://${extensionId}/status.html`);
  const agentPage = await connectAgent(browserContext);
  await agentPage.goto(server.PREFIX + '/agent');
  await expect.poll(() => groupOf(probe, server.PREFIX + '/agent')).toBeGreaterThan(-1);
  const groupId = (await groupOf(probe, server.PREFIX + '/agent'))!;
  // The user drags one of their own tabs into the agent's group.
  await probe.evaluate(async ({ url, groupId }) => {
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(f => setTimeout(f, 300));
    await chrome.tabs.group({ groupId, tabIds: [tab.id!] });
  }, { url: server.PREFIX + '/user', groupId });
  await expect.poll(() => groupOf(probe, server.PREFIX + '/user')).toBe(groupId);
  // Let the extension decide (and record) ownership of both tabs.
  await new Promise(f => setTimeout(f, 500));
  return { probe };
}

test('after a service worker death the next worker closes the agent tabs of the dead group and only ungroups the user tabs', async ({ pathToExtension, server }, testInfo) => {
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { probe } = await agentInGroupWithUserTab(browserContext, server);
  await bringProbeToFront(probe);

  await killServiceWorker(browserContext);
  // The kill runs no close path: against the extension before this fix the agent tab ends up merely ungrouped (-1), as
  // the old start-up cleanup does, where a normal close would have closed it (checked on 11/11/2026).
  // Any extension event starts the next worker (here the status page asking for the connections; a tab event may
  // already have).
  await probe.reload();
  await expect.poll(() => groupOf(probe, server.PREFIX + '/agent'), { message: 'the agent tab of the dead group is closed' }).toBe(undefined);
  await expect.poll(() => groupOf(probe, server.PREFIX + '/user'), { message: 'the user tab is kept, ungrouped' }).toBe(-1);
  const playwrightGroups = await probe.evaluate(async () => (await chrome.tabGroups.query({})).filter(g => g.title?.startsWith('Playwright')).length);
  expect(playwrightGroups).toBe(0);
});

test('without an ownership record (left by an older version) the next worker still only ungroups', async ({ pathToExtension, server }, testInfo) => {
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { probe } = await agentInGroupWithUserTab(browserContext, server);

  // Cleared before the kill: a worker woken by any tab event in between must already find no record.
  await probe.evaluate(async () => chrome.storage.session.clear());
  await killServiceWorker(browserContext);
  await probe.reload();
  await expect.poll(() => groupOf(probe, server.PREFIX + '/agent')).toBe(-1);
  await expect.poll(() => groupOf(probe, server.PREFIX + '/user')).toBe(-1);
});

test('a worker that dies before the agent first navigates leaves no connect page behind', async ({ pathToExtension }, testInfo) => {
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const probe = await browserContext.newPage();
  await probe.goto(`chrome-extension://${extensionId}/status.html`);
  // Connected, but the agent has not navigated yet: its only tab is the seed, still on connect.html.
  await connectAgent(browserContext);
  const seeds = await connectPageTabs(probe);
  expect(seeds, 'exactly one connect page, the agent seed').toHaveLength(1);
  await expect.poll(() => agentTabRecord(probe), { message: 'the seed is recorded as the agent\'s' }).toContain(seeds[0]);
  await bringProbeToFront(probe);

  await killServiceWorker(browserContext);
  await probe.reload();
  await expect.poll(() => connectPageTabs(probe), { message: 'the connect page is closed' }).toEqual([]);
});

test('an agent tab the user is looking at (active tab of a focused window) is only ungrouped, never closed', async ({ pathToExtension, server }, testInfo) => {
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { probe } = await agentInGroupWithUserTab(browserContext, server);
  // The user clicked into the agent's tab (to type a 2FA code, say).
  const state = await probe.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.update(tab.id!, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { active: (await chrome.tabs.get(tab.id!)).active, focused: (await chrome.windows.get(tab.windowId)).focused };
  }, server.PREFIX + '/agent');
  expect(state).toEqual({ active: true, focused: true });

  await killServiceWorker(browserContext);
  await probe.reload();
  await expect.poll(() => groupOf(probe, server.PREFIX + '/agent'), { message: 'the agent tab in front stays open, ungrouped' }).toBe(-1);
  await expect.poll(() => groupOf(probe, server.PREFIX + '/user')).toBe(-1);
  // And it is not closed a moment later either.
  await new Promise(f => setTimeout(f, 1000));
  expect(await groupOf(probe, server.PREFIX + '/agent')).toBe(-1);
});
