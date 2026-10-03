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

// Fork-only (patch 7). Set by the agent router around a sub-agent's backend creation, read where the extension relay
// is built: a background relay opens its connect page and its tabs without taking the user's window
// (FORK.md § Silent connect).
export const relayScope = new AsyncLocalStorage<{ background: boolean }>();

// Fork-only. Lets tools reach the extension relay of the browser they run on
// (session-level commands such as browser_set_group_label) without threading it
// through browserFactory/program/BrowserBackend, which upstream keeps rewriting.
export interface ExtensionSessionRelay {
  setGroupLabel(label: string): Promise<void>;
  // Patch 7: a sub-agent's relay (tabs never shown); browser_take_screenshot gives it a longer timeout.
  readonly background: boolean;
}

const relays = new WeakMap<object, ExtensionSessionRelay>();

export function registerExtensionRelay(browser: object, relay: ExtensionSessionRelay) {
  relays.set(browser, relay);
}

export function extensionRelayFor(browser: object | null | undefined): ExtensionSessionRelay | undefined {
  return browser ? relays.get(browser) : undefined;
}
