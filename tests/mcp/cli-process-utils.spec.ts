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

import { test, expect } from './fixtures';
import { isPlaywrightDaemonCommand } from '../../packages/playwright-core/lib/tools/cli-client/processUtils';

test('recognizes Playwright daemon entry points', () => {
  expect(isPlaywrightDaemonCommand('/usr/local/bin/node /x/playwright-core/lib/entry/cliDaemon.js default --browser=chromium')).toBe(true);
  expect(isPlaywrightDaemonCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\lib\\entry\\dashboardApp.js')).toBe(true);
  expect(isPlaywrightDaemonCommand('node /x/cli.js run-cli-server')).toBe(true);
  expect(isPlaywrightDaemonCommand('node /x/cli.js cli-daemon')).toBe(true);
});

test('rejects commands that only mention daemon patterns', () => {
  expect(isPlaywrightDaemonCommand('node -e "setTimeout(() => {}, 600000)" -- "mentions cliDaemon.js"')).toBe(false);
  expect(isPlaywrightDaemonCommand('claude -p "prompt mentions run-mcp-server"')).toBe(false);
  expect(isPlaywrightDaemonCommand('node /x/scripts/run-mcp-server.cjs --extension')).toBe(false);
  expect(isPlaywrightDaemonCommand('vim /x/cliDaemon.js')).toBe(false);
  expect(isPlaywrightDaemonCommand('grep cliDaemon.js')).toBe(false);
});
