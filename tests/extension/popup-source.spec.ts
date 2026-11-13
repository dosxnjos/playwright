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

// Fork-only (FORK.md § Foco zero, "Popups"): Chrome names the tab that was active as a popup's openerTabId, not the tab
// that opened it, and the tab of a background client is never the active one.

import { test, expect } from './harness';

test('popup of a background tab goes to its client, not to the tab the user looks at', async ({ user, connectWithToken }) => {
  user.definePage('Opener', `<button onclick="window.open('${user.urlOf('Opened')}', '_blank', 'noopener')">open</button>`);
  const page = await user.openTab('Alpha');
  await page.bringToFront();

  const client = await connectWithToken('worker', { args: ['--background'] });
  await client.navigate('Opener');
  expect(await user.activeTabs()).toEqual(['Alpha']);

  await client.click('e2');
  await expect.poll(client.tabs).toEqual(['Opener', 'Opened']);
  // Chrome makes the popup active: the background client puts the user's tab back.
  await expect.poll(user.activeTabs).toEqual(['Alpha']);
  await client.expectControls('Opened');
});

test('popup of the tab the user looks at stays in front', async ({ user, connectWithToken }) => {
  user.definePage('Opener', `<button onclick="window.open('${user.urlOf('Opened')}', '_blank', 'noopener')">open</button>`);
  const client = await connectWithToken('worker');
  await client.navigate('Opener');
  await user.pageOf('Opener').bringToFront();

  await client.click('e2');
  await expect.poll(client.tabs).toEqual(['Opener', 'Opened']);
  await expect.poll(user.activeTabs).toEqual(['Opened']);
});

test('popup of a background tab does not go to the client that owns the tab the user looks at', async ({ user, connect, connectWithToken }) => {
  user.definePage('Opener', `<button onclick="window.open('${user.urlOf('Opened')}', '_blank', 'noopener')">open</button>`);
  await user.openTab('Alpha');
  const main = await connect('main', { tabs: ['Alpha'] });
  await user.pageOf('Alpha').bringToFront();

  const worker = await connectWithToken('worker', { args: ['--background'] });
  await worker.navigate('Opener');
  expect(await user.activeTabs()).toEqual(['Alpha']);

  await worker.click('e2');
  await expect.poll(worker.tabs).toEqual(['Opener', 'Opened']);
  expect(await main.tabs()).toEqual(['Alpha']);
});
