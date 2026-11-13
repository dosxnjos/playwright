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

// Fork-only (FORK.md, patch 8): a client can delete some cookies, but cannot plant one or clear them all.

import { test, expect } from './harness';

import type { ExtensionClient } from './harness';

async function call(client: ExtensionClient, name: string, args: Record<string, unknown> = {}): Promise<{ text: string, isError: boolean }> {
  const response = await client.mcp.callTool({ name, arguments: args }) as any;
  return { text: response.content?.[0]?.text ?? '', isError: !!response.isError };
}

test('browser_cookie_delete deletes one cookie; set and clear are refused', async ({ user, connectWithToken }) => {
  user.definePage('Cookies', `<script>document.cookie = 'keep=1; max-age=3600'; document.cookie = 'drop=2; max-age=3600';</script>Page Cookies`);
  const client = await connectWithToken('agent', { args: ['--caps=storage'] });
  await client.navigate('Cookies');
  const list = await call(client, 'browser_cookie_list');
  expect(list.text).toContain('keep');
  expect(list.text).toContain('drop');

  const deleted = await call(client, 'browser_cookie_delete', { name: 'drop' });
  expect(deleted.isError).toBe(false);
  const after = await call(client, 'browser_cookie_list');
  expect(after.text).toContain('keep');
  expect(after.text).not.toContain('drop');

  const set = await call(client, 'browser_cookie_set', { name: 'planted', value: '3', domain: '127.0.0.1', path: '/' });
  expect(set.isError).toBe(true);
  expect(set.text).toContain('Storage.setCookies is not allowed');

  const clear = await call(client, 'browser_cookie_clear');
  expect(clear.isError).toBe(true);
  expect(clear.text).toContain('Storage.clearCookies is not allowed');
  expect((await call(client, 'browser_cookie_list')).text).toContain('keep');
});

test('Storage.setCookies passes only when every cookie of the call is already expired', async ({ user, connectRelay }) => {
  const client = await connectRelay('worker');
  const [tabId] = client.announcedTabIds();
  await client.attach(tabId);
  const url = user.urlOf('Alpha');
  const refused = { error: 'Storage.setCookies is not allowed: it changes the state of the browser, not of the tab' };

  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url }] })).toEqual(refused);
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url, expires: -1 }] })).toEqual(refused);
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url, expires: Date.now() / 1000 + 3600 }] })).toEqual(refused);
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url, expires: 0 }, { name: 'b', value: '1', url }] })).toEqual(refused);
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [] })).toEqual(refused);
  for (const method of ['Network.setCookie', 'Network.setCookies', 'Network.deleteCookies'])
    expect(await client.sendToTab(tabId, method, {})).toEqual({ error: `${method} is not allowed: it changes the state of the browser, not of the tab` });

  // An expired cookie of a site where the client has no tab: deleting it would log the user out there.
  const otherSite = { error: 'Storage.setCookies is not allowed for cookies of example.org: this client has no tab on that site. Pass the domain of a tab of this client.' };
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', domain: '.example.org', path: '/', expires: 0 }] })).toEqual(otherSite);
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url, expires: 0 }] })).toEqual({ error: 'Storage.setCookies is not allowed for cookies of localhost: this client has no tab on that site. Pass the domain of a tab of this client.' });
  // Its tab on the site: an expired cookie of that site passes.
  await client.sendToTab(tabId, 'Page.navigate', { url });
  await expect.poll(() => user.tabs()).toContain('Alpha');
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', url, expires: 0 }] })).toEqual({ result: {} });
  expect(await client.sendToTab(tabId, 'Storage.setCookies', { cookies: [{ name: 'a', value: '1', domain: '.localhost', path: '/', expires: 0 }] })).toEqual({ result: {} });
});
