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

import { AsyncLocalStorage } from 'async_hooks';

// Fork-only (patch 9): the vault variant chosen with browser_use_profile. The token never leaves the server process:
// it only goes into the connect page URL (cdpRelay.ts), never into a response or a log line.
export type ExtensionProfile = {
  variant: string;
  token: string;
  profileDirName: string;
};

// Fork-only. Set by the agent router around each agent's backend creation, read where the extension relay is built.
// - background (patch 7): a sub-agent's relay opens its connect page and its tabs without taking the user's window
//   (FORK.md § Foco zero).
// - profile (patch 9): the variant this conversation chose with browser_use_profile; it wins over
//   PLAYWRIGHT_MCP_EXTENSION_TOKEN, PLAYWRIGHT_MCP_PROFILE_DIR_NAME and --profile-dir-name.
export const relayScope = new AsyncLocalStorage<{ background: boolean, profile?: ExtensionProfile }>();

// Fork-only. Lets tools reach the extension relay of the browser they run on
// (session-level commands such as browser_set_group_label) without threading it
// through browserFactory/program/BrowserBackend, which upstream keeps rewriting.
export interface ExtensionSessionRelay {
  // Returns false when the client has no tab group (--no-tab-group).
  setGroupLabel(label: string): Promise<boolean>;
  // Patch 7: a relay whose tabs are never shown; browser_take_screenshot gives it a longer timeout.
  readonly background: boolean;
}

const relays = new WeakMap<object, ExtensionSessionRelay>();

export function registerExtensionRelay(browser: object, relay: ExtensionSessionRelay) {
  relays.set(browser, relay);
}

export function extensionRelayFor(browser: object | null | undefined): ExtensionSessionRelay | undefined {
  return browser ? relays.get(browser) : undefined;
}
