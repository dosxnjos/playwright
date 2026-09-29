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

// Mirrors connectViaPicker in multi-connection.spec.ts: connects a client
// through the tab picker (user-owned seed tab), parameterized by client name
// so multiple simultaneous connections get distinct identities.
async function connectViaPicker(
  browserContext: BrowserContext,
  startClient: StartClient,
  browserWithExtension: BrowserWithExtension,
  clientName: string,
  tabTitle: string,
  navigateUrl: string,
): Promise<Client> {
  const { client } = await startClient({
    clientName,
    args: ['--extension'],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const connectPagePromise = browserContext.waitForEvent('page', p =>
    p.url().startsWith(`chrome-extension://${extensionId}/connect.html`)
  );
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url: navigateUrl } });
  const connectPage = await connectPagePromise;
  await clickAllowAndSelect(connectPage, tabTitle);
  await navigatePromise;
  return client;
}

test('browser_set_group_label changes the tab group title', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/labeled', '<title>Labeled</title><body>Labeled content</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const client = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent A', 'Labeled', server.PREFIX + '/labeled');

  expect(await client.callTool({
    name: 'browser_set_group_label',
    arguments: { label: 'My Task' },
  })).toHaveResponse({
    result: expect.stringContaining('My Task'),
  });

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const [tab] = await chrome.tabs.query({ title: 'Labeled' });
      if (!tab || tab.groupId === -1)
        return null;
      const g = await chrome.tabGroups.get(tab.groupId);
      return { color: g.color, title: g.title };
    });
  }).toEqual({ color: 'green', title: 'Playwright · My Task' });
});

test('two connections labeling with the same name get deduped titles', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/first', '<title>First</title><body>First content</body>', 'text/html');
  server.setContent('/second', '<title>Second</title><body>Second content</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const clientA = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent A', 'First', server.PREFIX + '/first');
  const clientB = await connectViaPicker(browserContext, startClient, browserWithExtension, 'Agent B', 'Second', server.PREFIX + '/second');

  await clientA.callTool({ name: 'browser_set_group_label', arguments: { label: 'Same Task' } });
  await clientB.callTool({ name: 'browser_set_group_label', arguments: { label: 'Same Task' } });

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups
          .filter((g: any) => g.title?.startsWith('Playwright · Same Task'))
          .map((g: any) => g.title)
          .sort();
    });
  }).toEqual(['Playwright · Same Task', 'Playwright · Same Task (2)']);
});
