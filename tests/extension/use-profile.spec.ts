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

// Fork-only (patch 9): browser_use_profile with the real extension. The test browser has one profile, so both
// variants carry the extension's token and only the profile folder differs: the Chrome stub records the folder each
// browser start asks for. Separate Chrome profiles are only checked by hand in the real Chrome.

import fs from 'fs/promises';
import path from 'path';

import { test, expect } from './harness';
import { extensionId } from './extension-fixtures';

const subAgent = { agente: 'agent-0000abcd', agenteTipo: 'general-purpose' };

test('a switch closes the agent tabs of every agent, and the next call connects in the chosen profile', async ({ user, start, browserWithExtension }, testInfo) => {
  // The relay checks that the extension is installed in the profile folder it was given.
  await fs.mkdir(path.join(browserWithExtension.userDataDir, 'Profile 6', 'Extensions', extensionId), { recursive: true });
  const client = await start('main', {
    env: {
      PLAYWRIGHT_MCP_AGENT_TABS: 'close',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: await user.token(),
      PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Default',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN__padrao: await user.token(),
      PLAYWRIGHT_MCP_PROFILE_DIR_NAME__padrao: 'Default',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN__jacira: await user.token(),
      PLAYWRIGHT_MCP_PROFILE_DIR_NAME__jacira: 'Profile 6',
      PLAYWRIGHT_MCP_PROFILE_ALIASES: testInfo.outputPath('no-aliases.json'),
      DEBUG: 'pw:mcp:*',
    },
  });
  await client.navigate('Alpha');
  await client.mcp.callTool({ name: 'browser_navigate', arguments: { url: user.urlOf('Beta'), _meta: subAgent } });
  await expect.poll(() => user.tabs()).toEqual(expect.arrayContaining(['Alpha', 'Beta']));

  const switched = await client.mcp.callTool({ name: 'browser_use_profile', arguments: { profile: 'jacira' } });
  expect(switched.isError).toBeFalsy();
  expect(JSON.stringify(switched.content)).toContain('Closed the browser of 2 agent(s)');
  // Both agents' tabs closed (patch 3), the sub-agent's too.
  await expect.poll(async () => (await user.tabs()).filter(title => title === 'Alpha' || title === 'Beta')).toEqual([]);

  await client.navigate('Gamma');
  expect(await client.snapshot()).toContain('Page Gamma');
  const starts = await browserWithExtension.chromeStubArgs();
  // The new profile started the browser itself: no relay of the old profile carried its connect page.
  expect(starts.map(args => args.find(arg => arg.startsWith('--profile-directory=')))).toEqual(['--profile-directory=Default', '--profile-directory=Profile 6']);
  expect(client.stderr()).toContain('use profile variant=jacira profileDir=Profile 6 closing=2');
  expect(client.stderr()).not.toContain(await user.token());
  expect(JSON.stringify(switched.content)).not.toContain(await user.token());

  // The sub-agent lost its tabs to main's switch: its next result says so.
  const subAgentNext = await client.mcp.callTool({ name: 'browser_navigate', arguments: { url: user.urlOf('Delta'), _meta: subAgent } });
  expect(JSON.stringify(subAgentNext.content)).toContain('Another agent of this conversation switched it to profile jacira');
});
