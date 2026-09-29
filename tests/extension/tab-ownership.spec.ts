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


// Fork-only (upstream just ungroups on disconnect, microsoft/playwright#41864):
// tabs the agent created are closed when its connection closes, tabs the user
// brought in are only ungrouped. NOT run locally on Windows (see CLAUDE.md), this
// is validated by the macOS tests_extension workflow and by hand.
import { test, expect, extensionId, clickAllowAndSelect, readExtensionToken, startWithExtensionFlag } from './extension-fixtures';

import type { BrowserContext } from 'playwright';

async function tabsWithUrl(browserContext: BrowserContext, url: string): Promise<{ groupId: number }[]> {
  const [sw] = browserContext.serviceWorkers();
  return await sw.evaluate(async (targetUrl: string) => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({ url: targetUrl });
    return tabs.map((tab: any) => ({ groupId: tab.groupId }));
  }, url);
}

test('token-bypass seed tab is agent-owned: closed on disconnect', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  const { client } = await startClient({
    clientName: 'client-a',
    args: ['--extension'],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });
  expect(await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } }))
      .toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });

  // browser_navigate resolves before the (async) chrome.tabs.group() lands.
  await expect.poll(async () => (await tabsWithUrl(browserContext, server.HELLO_WORLD))[0]?.groupId ?? -1).toBeGreaterThan(-1);

  await client.close();

  await expect.poll(async () => (await tabsWithUrl(browserContext, server.HELLO_WORLD)).length).toBe(0);
});

test('closing a connection closes agent-created tabs but only ungroups the picked one', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/second', '<title>Second</title><body>Second page</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const picked = await browserContext.newPage();
  await picked.goto(server.HELLO_WORLD);

  const client = await startWithExtensionFlag(browserWithExtension, startClient);
  const connectPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`)
  );
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await clickAllowAndSelect(await connectPagePromise, 'Title');
  await navigatePromise;

  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: server.PREFIX + '/second' } });
  await expect.poll(async () => (await tabsWithUrl(browserContext, server.PREFIX + '/second'))[0]?.groupId ?? -1).toBeGreaterThan(-1);

  await client.close();

  // The agent-created tab is gone; the picked tab survives, ungrouped.
  await expect.poll(async () => (await tabsWithUrl(browserContext, server.PREFIX + '/second')).length).toBe(0);
  await expect.poll(async () => (await tabsWithUrl(browserContext, server.HELLO_WORLD))[0]?.groupId).toBe(-1);
});
