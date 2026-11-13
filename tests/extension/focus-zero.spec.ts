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

import { test, expect, RelayPeer } from './harness';
import { extensionId } from './extension-fixtures';

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
  // The main agent in front (PLAYWRIGHT_MCP_FOCUS=on): only the sub-agent's own scope makes it background.
  const client = await connectWithToken('main', { env: { PLAYWRIGHT_MCP_FOCUS: 'on', DEBUG: 'pw:mcp:relay' } });
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
  expect(client.stderr()).toContain('Connect page opened via portador');

  // Its screenshot, with nobody looking at the window: the tab is shown for the capture, and the user's comes back.
  await user.chrome(async (chrome, tabOf) => chrome.windows.update((await tabOf('Front')).windowId, { focused: false }));
  const shot = await client.mcp.callTool({ name: 'browser_take_screenshot', arguments: { _meta: subAgent } }) as any;
  expect(shot.isError).toBeFalsy();
  expect(client.stderr()).toMatch(/Capture of tab \d+: revealed=true/);
  expect(await user.activeTabs()).toEqual(['Front']);
});

test('a carrier cannot close the connect page it opened once a client owns it', async ({ user, connectRelay, server }) => {
  const carrier = await connectRelay('carrier');
  // The second relay is the test server again: its connect page goes through the carrier, as a sub-agent's does.
  const socket = new Promise<any>(resolve => server.onceWebSocketConnection(resolve));
  const url = new URL(`chrome-extension://${extensionId}/connect.html`);
  url.searchParams.set('mcpRelayUrl', `ws://127.0.0.1:${server.PORT}/ws`);
  url.searchParams.set('protocolVersion', '2');
  url.searchParams.set('client', JSON.stringify({ name: 'sub-agent' }));
  url.searchParams.set('token', await user.token());
  const { result: tab } = await carrier.send('chrome.tabs.create', { url: url.toString(), active: false });
  const subAgentPeer = new RelayPeer(await socket);
  await expect.poll(() => subAgentPeer.eventNames()).toContain('extension.initialized');
  expect(subAgentPeer.announcedTabIds()).toEqual([tab.id]);

  expect(await carrier.send('chrome.tabs.remove', tab.id)).toEqual({ error: `Tab ${tab.id} is not owned by this client` });
});

test('PLAYWRIGHT_MCP_AGENT_SILENT=off: a sub-agent starts the browser again and comes to the front', async ({ user, connectWithToken, browserWithExtension }) => {
  const client = await connectWithToken('main', { env: { PLAYWRIGHT_MCP_AGENT_SILENT: 'off' } });
  await client.navigate('Alpha');

  await navigateAs(client, user.urlOf('Beta'), subAgent);
  await expect.poll(async () => (await user.groups()).map(group => group.title).sort()).toEqual(['Playwright · main', 'Playwright · main · gp-abcd']);
  expect(await browserWithExtension.chromeStubArgs()).toHaveLength(2);
  expect(await user.activeTabs()).toEqual(['Beta']);
});
