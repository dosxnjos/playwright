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

// Fork-only (patch 7): a sub-agent's tab lives in the background, and Chrome's openerTabId names the ACTIVE tab, not the
// tab that opened a popup (Chromium, 03/10/2026). The real source comes from webNavigation.onCreatedNavigationTarget.
// Unlike the other files here this one runs headless and in-process (real extension, real relays, no MCP server, no
// window), so it also runs on Windows: `npm run test-extension -- popup-source`. See FORK.md § Silent connect.

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
const ENV = ['PLAYWRIGHT_MCP_EXTENSION_TOKEN'];
const savedEnv = { ...process.env };
const relays: Relay[] = [];
const browsers: Browser[] = [];
const headless: { context: BrowserContext, userDataDir: string }[] = [];
// The chrome.exe launch of the first relay, by connect page URL: the test opens that page itself.
let launches: string[] = [];

test.beforeEach(() => {
  // The extension of this throwaway profile is given the same random value below.
  process.env[ENV[0]] = randomUUID();
  launches = [];
  // Only the relay's launch (its executablePath is node, see startRelay): this process also launches Chromium.
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

async function startRelay(background: boolean): Promise<Relay> {
  const relay = new tools.CDPRelayServer('chromium', process.execPath, undefined, undefined, { background });
  relays.push(relay);
  await relay.start();
  return relay;
}

async function connectPlaywright(relay: Relay): Promise<{ context: BrowserContext, page: Page }> {
  const browser = await chromium.connectOverCDP(relay.cdpEndpoint());
  browsers.push(browser);
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().length).toBe(1);
  return { context, page: context.pages()[0] };
}

// The main agent (connect page from the stubbed chrome.exe launch, opened here in the foreground) and a sub-agent (its
// connect page opened in the background by the main relay, the carrier), each with Playwright on its CDP side.
async function mainAndSubAgent(browserContext: BrowserContext) {
  const main = await startRelay(false);
  const mainConnected = main.establishExtensionConnection('main');
  await expect.poll(() => launches.length).toBe(1);
  const connectPage = await browserContext.newPage();
  await connectPage.goto(launches[0]);
  await mainConnected;
  const mainAgent = await connectPlaywright(main);

  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · sub');
  const subAgent = await connectPlaywright(sub);
  return { main, sub, mainAgent, subAgent };
}

test('a popup of a sub-agent background tab goes to the sub-agent, not to the agent whose tab is active', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/opener', '<a id=link href="/empty.html" target=_blank>open</a>', 'text/html');
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { mainAgent, subAgent } = await mainAndSubAgent(browserContext);
  await mainAgent.page.goto(server.EMPTY_PAGE);
  await subAgent.page.goto(server.PREFIX + '/opener');
  // The main agent's tab is the one in front; the sub-agent's never is.
  const activeUrl = await swEval(browserContext, async () => (await (globalThis as any).chrome.tabs.query({ active: true }))[0].url, undefined);
  expect(activeUrl).toBe(server.EMPTY_PAGE);

  const [popup] = await Promise.all([
    subAgent.context.waitForEvent('page', { timeout: 10_000 }),
    subAgent.page.click('#link'),
  ]);
  await popup.waitForURL(server.EMPTY_PAGE);
  expect(subAgent.context.pages()).toHaveLength(2);
  // The main agent never got it (openerTabId named its tab).
  await new Promise(f => setTimeout(f, 500));
  expect(mainAgent.context.pages()).toHaveLength(1);
});

test('a popup of the main agent foreground tab still goes to the main agent', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/opener', '<a id=link href="/empty.html" target=_blank>open</a>', 'text/html');
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { mainAgent, subAgent } = await mainAndSubAgent(browserContext);
  await mainAgent.page.goto(server.PREFIX + '/opener');
  const [popup] = await Promise.all([
    mainAgent.context.waitForEvent('page', { timeout: 10_000 }),
    mainAgent.page.click('#link'),
  ]);
  await popup.waitForURL(server.EMPTY_PAGE);
  await new Promise(f => setTimeout(f, 500));
  expect(subAgent.context.pages()).toHaveLength(1);
});

test('a sub-agent popup is agent-owned: closed when the sub-agent ends', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/opener', '<a id=link href="/popup-target" target=_blank>open</a>', 'text/html');
  server.setContent('/popup-target', '<title>popup</title>', 'text/html');
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { sub, subAgent } = await mainAndSubAgent(browserContext);
  await subAgent.page.goto(server.PREFIX + '/opener');
  const [popup] = await Promise.all([
    subAgent.context.waitForEvent('page', { timeout: 10_000 }),
    subAgent.page.click('#link'),
  ]);
  await popup.waitForURL(server.PREFIX + '/popup-target');
  const popupTabs = () => swEval(browserContext, async (url: string) => (await (globalThis as any).chrome.tabs.query({ url })).length, server.PREFIX + '/popup-target');
  expect(await popupTabs()).toBe(1);
  sub.stop();
  await expect.poll(popupTabs).toBe(0);
});

test('a tab dragged into a sub-agent group, opened from another ignored tab there, is the user\'s: never closed', async ({ pathToExtension, server }, testInfo) => {
  server.setContent('/user-a', '<title>user a</title>', 'text/html');
  server.setContent('/user-b', '<title>user b</title>', 'text/html');
  const browserContext = await launchHeadless(pathToExtension, testInfo.outputPath('user-data-dir'));
  const { sub, subAgent } = await mainAndSubAgent(browserContext);
  await subAgent.page.goto(server.EMPTY_PAGE);
  // Two user tabs, the second opened from the first, both dragged (here: grouped through the extension API, which fires
  // the same onUpdated.groupId a drag does) into the sub-agent's group. The relay ignores both (own tabs only).
  const ids = await swEval(browserContext, async ({ empty, a, b }: { empty: string, a: string, b: string }) => {
    const chrome = (globalThis as any).chrome;
    const [subTab] = await chrome.tabs.query({ url: empty });
    const userA = await chrome.tabs.create({ url: a, active: true });
    const userB = await chrome.tabs.create({ url: b, active: false, openerTabId: userA.id });
    await new Promise(f => setTimeout(f, 300));
    await chrome.tabs.group({ groupId: subTab.groupId, tabIds: [userA.id] });
    await new Promise(f => setTimeout(f, 300));
    await chrome.tabs.group({ groupId: subTab.groupId, tabIds: [userB.id] });
    return { a: userA.id, b: userB.id, opener: (await chrome.tabs.get(userB.id)).openerTabId };
  }, { empty: server.EMPTY_PAGE, a: server.PREFIX + '/user-a', b: server.PREFIX + '/user-b' });
  expect(ids.opener).toBe(ids.a);
  await new Promise(f => setTimeout(f, 500));
  expect(subAgent.context.pages()).toHaveLength(1);
  sub.stop();
  const userTabs = () => swEval(browserContext, async ({ a, b }: { a: number, b: number }) => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({});
    return [a, b].map(id => tabs.find((t: any) => t.id === id)?.groupId ?? 'closed');
  }, ids);
  // Both ungrouped, both still open.
  await expect.poll(userTabs).toEqual([-1, -1]);
});
