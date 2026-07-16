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

import { test, expect, extensionId, clickAllowAndSelect } from './extension-fixtures';

import type { BrowserWithExtension } from './extension-fixtures';
import type { StartClient } from '../mcp/fixtures';
import type { BrowserContext } from 'playwright';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Connects a client through the tab picker (user-owned seed tab), mirroring
// clickAllowAndSelect's usage in tab-grouping.spec.ts but parameterized by
// client name so multiple simultaneous connections get distinct identities.
async function connectViaPicker(
  browserContext: BrowserContext,
  startClient: StartClient,
  browserWithExtension: BrowserWithExtension,
  clientName: string,
  tabTitle: string,
): Promise<Client> {
  const connectPagePromise = browserContext.waitForEvent('page', p =>
    p.url().startsWith(`chrome-extension://${extensionId}/connect.html`)
  );
  const clientPromise = startClient({
    clientName,
    args: ['--extension'],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const connectPage = await connectPagePromise;
  await clickAllowAndSelect(connectPage, tabTitle);
  return (await clientPromise).client;
}

// Connects a client through the token bypass (agent-owned seed tab, no tab
// list, no click needed) — mirrors the 'bypass connection dialog with token'
// scenario in extension.spec.ts.
async function connectViaToken(
  browserContext: BrowserContext,
  startClient: StartClient,
  browserWithExtension: BrowserWithExtension,
  clientName: string,
): Promise<Client> {
  const statusPage = await browserContext.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
  const tokenText = await statusPage.locator('.auth-token-code').textContent();
  const [, token] = tokenText?.split('=') || [];
  await statusPage.close();

  const { client } = await startClient({
    clientName,
    args: ['--extension'],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token || '',
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });
  return client;
}

test.describe(() => {
  test.beforeEach(({ protocolVersion }) => {
    test.skip(protocolVersion === 1, 'Multiple simultaneous connections are a protocol v2 feature');
  });

  test('two simultaneous connections get independent, named tab groups with no stealing', async ({ browserWithExtension, startClient, server }) => {
    server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
    const browserContext = await browserWithExtension.launch();

    // Agent A connects via the token bypass — agent-owned seed tab.
    const clientA = await connectViaToken(browserContext, startClient, browserWithExtension, 'Agent A');
    const navA = await clientA.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    expect(navA).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });

    // Agent B connects via the tab picker, on its own pre-existing tab — user-owned seed tab.
    const pageB = await browserContext.newPage();
    await pageB.goto(server.PREFIX + '/second');
    const clientB = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent B', 'Second');
    const navB = await clientB.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/second' } });
    expect(navB).toHaveResponse({ snapshot: expect.stringContaining('Second content') });

    // B connecting must not have stolen A's connection.
    const navA2 = await clientA.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    expect(navA2).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });

    const [sw] = browserContext.serviceWorkers();
    const groups = await sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const all = await chrome.tabGroups.query({});
      return all
          .filter((g: any) => g.title?.startsWith('Playwright'))
          .map((g: any) => ({ color: g.color, title: g.title }))
          .sort((a: any, b: any) => a.title.localeCompare(b.title));
    });
    expect(groups).toEqual([
      { color: 'green', title: 'Playwright · Agent A' },
      { color: 'green', title: 'Playwright · Agent B' },
    ]);

    await clientA.close();
    await clientB.close();
  });

  test('two connections with the same client name get a disambiguating suffix', async ({ browserWithExtension, startClient, server }) => {
    server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
    const browserContext = await browserWithExtension.launch();

    const pageA = await browserContext.newPage();
    await pageA.goto(server.HELLO_WORLD);
    await connectViaPicker(browserContext, startClient, browserWithExtension, 'Same Name', 'Title');

    const pageB = await browserContext.newPage();
    await pageB.goto(server.PREFIX + '/second');
    await connectViaPicker(browserContext, startClient, browserWithExtension, 'Same Name', 'Second');

    const [sw] = browserContext.serviceWorkers();
    const titles = await sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups.filter((g: any) => g.title?.startsWith('Playwright')).map((g: any) => g.title).sort();
    });
    expect(titles).toEqual(['Playwright · Same Name', 'Playwright · Same Name (2)']);
  });

  test('disconnecting one connection from the status page does not affect the other', async ({ browserWithExtension, startClient, server }) => {
    server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
    const browserContext = await browserWithExtension.launch();

    const pageA = await browserContext.newPage();
    await pageA.goto(server.HELLO_WORLD);
    await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent A', 'Title');

    const pageB = await browserContext.newPage();
    await pageB.goto(server.PREFIX + '/second');
    const clientB = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent B', 'Second');

    const statusPage = await browserContext.newPage();
    await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
    await expect(statusPage.locator('.connection-section')).toHaveCount(2);

    const sectionA = statusPage.locator('.connection-section', { hasText: 'Agent A' });
    await sectionA.getByRole('button', { name: 'Disconnect' }).click();

    const [sw] = browserContext.serviceWorkers();

    // A's tab is a picker-selected (user-owned) seed, so it survives — only ungrouped.
    await expect.poll(async () => {
      return sw.evaluate(async () => {
        const chrome = (globalThis as any).chrome;
        const [tab] = await chrome.tabs.query({ title: 'Title' });
        return tab?.groupId ?? -1;
      });
    }).toBe(-1);

    // B's group survives untouched.
    await expect.poll(async () => {
      return sw.evaluate(async () => {
        const chrome = (globalThis as any).chrome;
        const [tab] = await chrome.tabs.query({ title: 'Second' });
        if (!tab || tab.groupId === -1)
          return null;
        const g = await chrome.tabGroups.get(tab.groupId);
        return { color: g.color, title: g.title };
      });
    }).toEqual({ color: 'green', title: 'Playwright · Agent B' });

    // B is still fully usable.
    const navB = await clientB.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/second' } });
    expect(navB).toHaveResponse({ snapshot: expect.stringContaining('Second content') });

    await clientB.close();
  });

  test('status page lists every active connection with its own header', async ({ browserWithExtension, startClient, server }) => {
    server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
    const browserContext = await browserWithExtension.launch();

    const pageA = await browserContext.newPage();
    await pageA.goto(server.HELLO_WORLD);
    await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent A', 'Title');

    const pageB = await browserContext.newPage();
    await pageB.goto(server.PREFIX + '/second');
    await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent B', 'Second');

    const statusPage = await browserContext.newPage();
    await statusPage.goto(`chrome-extension://${extensionId}/status.html`);

    await expect(statusPage.locator('.connection-section')).toHaveCount(2);
    await expect(statusPage.locator('.connection-section', { hasText: 'Agent A' })).toBeVisible();
    await expect(statusPage.locator('.connection-section', { hasText: 'Agent B' })).toBeVisible();
  });

  test('closing a connection closes its agent-owned tabs but only ungroups the user-owned seed', async ({ browserWithExtension, startClient, server }) => {
    server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
    const browserContext = await browserWithExtension.launch();

    // User-owned seed: an existing tab picked from the connect page's list.
    const pageA = await browserContext.newPage();
    await pageA.goto(server.HELLO_WORLD);
    const clientA = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent A', 'Title');

    // Agent-owned tab: created by the agent itself mid-session.
    await clientA.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: server.PREFIX + '/second' } });

    const [sw] = browserContext.serviceWorkers();

    // Wait for the new tab to actually join the group before disconnecting.
    await expect.poll(async () => {
      return sw.evaluate(async (targetUrl: string) => {
        const chrome = (globalThis as any).chrome;
        const [t] = await chrome.tabs.query({ url: targetUrl });
        return t?.groupId ?? -1;
      }, server.PREFIX + '/second');
    }).toBeGreaterThan(-1);

    await clientA.close();

    // The agent-created tab is gone.
    await expect.poll(async () => {
      return sw.evaluate(async (targetUrl: string) => {
        const chrome = (globalThis as any).chrome;
        return (await chrome.tabs.query({ url: targetUrl })).length;
      }, server.PREFIX + '/second');
    }).toBe(0);

    // The user-picked seed tab survives, just ungrouped.
    await expect.poll(async () => {
      return sw.evaluate(async () => {
        const chrome = (globalThis as any).chrome;
        const [tab] = await chrome.tabs.query({ title: 'Title' });
        return tab?.groupId ?? -1;
      });
    }).toBe(-1);
  });

  test('token-bypass seed tab is agent-owned and closes on disconnect', async ({ browserWithExtension, startClient, server }) => {
    const browserContext = await browserWithExtension.launch();

    const client = await connectViaToken(browserContext, startClient, browserWithExtension, 'Agent A');
    const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    expect(nav).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });

    const [sw] = browserContext.serviceWorkers();
    const tabCountBefore = await sw.evaluate(async (targetUrl: string) => {
      const chrome = (globalThis as any).chrome;
      return (await chrome.tabs.query({ url: targetUrl })).length;
    }, server.HELLO_WORLD);
    expect(tabCountBefore).toBe(1);

    await client.close();

    await expect.poll(async () => {
      return sw.evaluate(async (targetUrl: string) => {
        const chrome = (globalThis as any).chrome;
        return (await chrome.tabs.query({ url: targetUrl })).length;
      }, server.HELLO_WORLD);
    }).toBe(0);
  });
});
