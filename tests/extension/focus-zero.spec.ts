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

// Fork-only (FORK.md § Foco zero): with a token nothing the agents do takes the tab the user looks at.

import { test, expect } from './harness';

import type { ExtensionClient } from './harness';

const subAgent = { agente: 'agent-0000abcd', agenteTipo: 'general-purpose' };

async function navigateAs(client: ExtensionClient, url: string, meta: object) {
  await client.mcp.callTool({ name: 'browser_navigate', arguments: { url, _meta: meta } });
}

test('a client with the token works in the background without --background', async ({ user, connectWithToken, browserWithExtension }) => {
  const page = await user.openTab('Alpha');
  await page.bringToFront();

  const client = await connectWithToken('main');
  await client.navigate('Beta');
  expect(await client.snapshot()).toContain('Page Beta');
  expect(await user.activeTabs()).toEqual(['Alpha']);
  expect((await browserWithExtension.chromeStubArgs())[0]).toContain('--open-in-background');

  await client.openTab('Gamma');
  await client.selectTab('Beta');
  expect(await user.activeTabs()).toEqual(['Alpha']);
});

test('PLAYWRIGHT_MCP_FOCUS=on gives the main agent the front again', async ({ user, connectWithToken, browserWithExtension }) => {
  const page = await user.openTab('Alpha');
  await page.bringToFront();

  const client = await connectWithToken('main', { env: { PLAYWRIGHT_MCP_FOCUS: 'on' } });
  await client.navigate('Beta');
  expect(await user.activeTabs()).toEqual(['Beta']);
  expect((await browserWithExtension.chromeStubArgs())[0]).not.toContain('--open-in-background');
});

test('a connect page that a browser older than Chrome 158 opened in front gives the user\'s tab back', async ({ user, connectWithToken }) => {
  const page = await user.openTab('Alpha');
  await page.bringToFront();

  const client = await connectWithToken('main', { env: { PWTEST_CHROME_STUB_FOREGROUND: '1' } });
  await expect.poll(user.activeTabs).toEqual(['Alpha']);
  await client.navigate('Beta');
  expect(await user.activeTabs()).toEqual(['Alpha']);
});

test('a sub-agent connects through the connected main agent, in the background and in its own group', async ({ user, connectWithToken, browserWithExtension }) => {
  const client = await connectWithToken('main');
  await client.navigate('Alpha');
  const page = await user.openTab('Front');
  await page.bringToFront();

  await navigateAs(client, user.urlOf('Beta'), subAgent);
  await expect.poll(user.groups).toEqual([
    { title: 'Playwright · main', color: 'green', tabs: ['Alpha'] },
    { title: 'Playwright · main · gp-abcd', color: 'blue', tabs: ['Beta'] },
  ]);
  expect(await user.activeTabs()).toEqual(['Front']);
  // Only the main agent started the browser: the sub-agent's connect page came through the main agent's connection.
  expect(await browserWithExtension.chromeStubArgs()).toHaveLength(1);
});

test('PLAYWRIGHT_MCP_AGENT_SILENT=off: a sub-agent starts the browser again and comes to the front', async ({ user, connectWithToken, browserWithExtension }) => {
  const client = await connectWithToken('main', { env: { PLAYWRIGHT_MCP_AGENT_SILENT: 'off' } });
  await client.navigate('Alpha');

  await navigateAs(client, user.urlOf('Beta'), subAgent);
  await expect.poll(async () => (await user.groups()).map(group => group.title).sort()).toEqual(['Playwright · main', 'Playwright · main · gp-abcd']);
  expect(await browserWithExtension.chromeStubArgs()).toHaveLength(2);
  expect(await user.activeTabs()).toEqual(['Beta']);
});
