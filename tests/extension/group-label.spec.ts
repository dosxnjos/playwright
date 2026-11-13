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

// Fork-only (FORK.md, patch 2): browser_set_group_label renames the tab group of the client while it runs.

import { test, expect } from './harness';

import type { ExtensionClient } from './harness';

async function setLabel(client: ExtensionClient, label: string): Promise<string> {
  const response = await client.mcp.callTool({ name: 'browser_set_group_label', arguments: { label } }) as any;
  return response.content?.[0]?.text ?? '';
}

test('browser_set_group_label changes the title of the group, and keeps its color', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent');
  await client.navigate('Alpha');
  expect(await user.groups()).toEqual([{ title: 'Playwright · agent', color: 'green', tabs: ['Alpha'] }]);

  expect(await setLabel(client, 'My Task')).toContain('Tab group label set to "My Task"');
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · My Task', color: 'green', tabs: ['Alpha'] }]);

  await client.openTab('Beta');
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · My Task', color: 'green', tabs: ['Alpha', 'Beta'] }]);
});

test('two clients with the same label get different titles', async ({ user, connectWithToken }) => {
  const first = await connectWithToken('first');
  await first.navigate('Alpha');
  const second = await connectWithToken('second');
  await second.navigate('Beta');

  await setLabel(first, 'Same Task');
  await setLabel(second, 'Same Task');
  await expect.poll(async () => (await user.groups()).map(group => group.title).sort()).toEqual(['Playwright · Same Task', 'Playwright · Same Task (2)']);
});

test('browser_set_group_label without grouping is not an error', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent', { args: ['--no-tab-group'] });
  await client.navigate('Alpha');

  expect(await setLabel(client, 'My Task')).toContain('--no-tab-group');
  expect(await user.groups()).toEqual([]);
});
