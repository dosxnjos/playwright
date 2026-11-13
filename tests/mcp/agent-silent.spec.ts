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

// Fork-only (patch 7): the longer screenshot timeout of a background relay. The rest of patch 7 (carrier, background
// relay, focus emulation, popup source, reveal for capture, put back the user's tab) runs against the real extension in
// tests/extension/{focus-zero,popup-source,capture-reveal}.spec.ts. See FORK.md § Foco zero.

import { test, expect } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

test('screenshot timeout: at least 60 s for a background tab, the action timeout otherwise', () => {
  expect(tools.screenshotTimeout({ timeouts: { action: 5000 } }, true)).toBe(60_000);
  expect(tools.screenshotTimeout({ timeouts: { action: 90_000 } }, true)).toBe(90_000);
  expect(tools.screenshotTimeout({ timeouts: { action: 5000 } }, false)).toBe(5000);
  expect(tools.screenshotTimeout({}, false)).toBeUndefined();
});

// What browser_take_screenshot reads: the relay registered for the tab's Browser (not its context or page).
test('screenshot timeout of a tab: from the relay registered for its browser', () => {
  const tabOn = (browser: object | null) => ({ page: { context: () => ({ browser: () => browser }) }, context: { config: { timeouts: { action: 5000 } } } });
  const subAgentBrowser = {};
  const mainBrowser = {};
  tools.registerExtensionRelay(subAgentBrowser, { background: true, setGroupLabel: async () => true });
  tools.registerExtensionRelay(mainBrowser, { background: false, setGroupLabel: async () => true });
  expect(tools.screenshotTimeoutFor(tabOn(subAgentBrowser) as any)).toEqual({ background: true, timeout: 60_000 });
  expect(tools.screenshotTimeoutFor(tabOn(mainBrowser) as any)).toEqual({ background: false, timeout: 5000 });
  // Not an extension browser (or no browser at all): the action timeout.
  expect(tools.screenshotTimeoutFor(tabOn({}) as any)).toEqual({ background: false, timeout: 5000 });
  expect(tools.screenshotTimeoutFor(tabOn(null) as any)).toEqual({ background: false, timeout: 5000 });
});

test('browser_take_screenshot logs its duration, the background flag and the timeout on pw:mcp:shot', async ({ startClient, server }) => {
  const { client, stderr } = await startClient({ env: { DEBUG: 'pw:mcp:shot' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.callTool({ name: 'browser_take_screenshot' });
  // Not an extension relay, so not background: the fixture's action timeout.
  await expect.poll(() => stderr()).toMatch(/pw:mcp:shot screenshot viewport background=false timeout=\d+ took \d+ms ok/);
});
