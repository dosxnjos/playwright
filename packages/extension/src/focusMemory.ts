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

// Fork-only (foco zero, 03/10/2026). The first connection of a session comes from a chrome.exe launch: Chrome opens the
// connect page as the active tab and brings its window to the front. With a token and `silent=1` in its URL
// (cdpRelay.ts), the connection should leave the screen as it was: the tab the user was on and, if Chrome was not the
// focused app, the focus. By the time the connect page talks to us, its tab is already active, and asking Chrome then
// returns the connect page (measured in Chromium 1247 headless: inside tabs.onCreated, tabs.query({active}) already
// names the new tab, and a tab created with active:false gets lastAccessed = its creation time, so "most recently
// accessed" picks agent tabs). So the active tab of each window and the focused window are tracked from events and
// kept in chrome.storage.session (the service worker sleeps between connections and would forget them), and each new
// tab gets a snapshot of both at tabs.onCreated, which Chrome fires before the tab's onActivated. FORK.md § Foco zero.

import { debugLog } from './relayConnection';

type Snapshot = {
  // The active tab of the new tab's window just before it; undefined when unknown.
  previousTabId?: number;
  // Whether any Chrome window had the focus just before; undefined when unknown.
  chromeFocused?: boolean;
};

type State = {
  active: Record<number, number>;
  focusedWindowId?: number;
};

const STORAGE_KEY = 'focoZero';
const MAX_SNAPSHOTS = 64;

export class FocusMemory {
  private _state: State = { active: {} };
  // Events apply in the order Chrome fired them, after the stored state loaded.
  private _queue: Promise<void>;
  private _before = new Map<number, Snapshot>();

  // Listeners are added synchronously so that a sleeping service worker wakes up for them (MV3).
  constructor() {
    this._queue = this._load();
    chrome.tabs.onActivated.addListener(info => this._apply(() => {
      this._state.active[info.windowId] = info.tabId;
    }));
    chrome.windows.onFocusChanged.addListener(windowId => this._apply(() => {
      this._state.focusedWindowId = windowId;
    }));
    chrome.windows.onRemoved.addListener(windowId => this._apply(() => {
      delete this._state.active[windowId];
    }));
    chrome.tabs.onCreated.addListener(tab => this._apply(() => this._snapshot(tab), false));
    chrome.tabs.onRemoved.addListener(tabId => this._before.delete(tabId));
  }

  // Puts back the tab that was active before `tabId` was created and, if Chrome was not focused then, takes the focus
  // away again. Only while `tabId` is still the active tab: if the user moved on meanwhile, that choice stands.
  async putBack(tabId: number): Promise<void> {
    await this._queue;
    const before = this._before.get(tabId);
    this._before.delete(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    debugLog(`Foco zero: put back tab ${tabId}`, before, tab?.active);
    if (!before || !tab?.active)
      return;
    if (before.previousTabId !== undefined)
      await chrome.tabs.update(before.previousTabId, { active: true }).catch(() => {});
    // Unmeasured on Windows (roadmap 2026-10-03 foco zero, step 2): whether this hands the focus back to the terminal.
    if (before.chromeFocused === false)
      await chrome.windows.update(tab.windowId, { focused: false }).catch(() => {});
  }

  private _apply(change: () => void, persist = true) {
    this._queue = this._queue.then(() => {
      change();
      if (persist)
        void this._store()?.set({ [STORAGE_KEY]: this._state }).catch(() => {});
    }).catch(() => {});
  }

  private _snapshot(tab: chrome.tabs.Tab) {
    if (tab.id === undefined)
      return;
    const previous = this._state.active[tab.windowId];
    const focused = this._state.focusedWindowId;
    this._before.set(tab.id, {
      previousTabId: previous !== tab.id ? previous : undefined,
      chromeFocused: focused === undefined ? undefined : focused !== chrome.windows.WINDOW_ID_NONE,
    });
    if (this._before.size > MAX_SNAPSHOTS)
      this._before.delete(this._before.keys().next().value!);
  }

  private async _load(): Promise<void> {
    try {
      const stored = (await this._store()?.get(STORAGE_KEY))?.[STORAGE_KEY] as State | undefined;
      if (stored) {
        this._state = stored;
        return;
      }
      // First start in this browser session: what is in front now. If a connect page is already the active tab here,
      // its snapshot names no previous tab (it is never its own previous) and nothing is put back.
      const [tabs, lastFocused] = await Promise.all([
        chrome.tabs.query({ active: true }),
        chrome.windows.getLastFocused().catch(() => undefined),
      ]);
      for (const tab of tabs) {
        if (tab.id !== undefined)
          this._state.active[tab.windowId] = tab.id;
      }
      if (lastFocused)
        this._state.focusedWindowId = lastFocused.focused ? lastFocused.id : chrome.windows.WINDOW_ID_NONE;
    } catch (error: any) {
      debugLog('Foco zero: could not load the focus memory:', error?.message);
    }
  }

  // Undefined on an extension without the "storage" permission: then the memory lives only as long as the worker.
  private _store(): chrome.storage.StorageArea | undefined {
    return (globalThis as any).chrome?.storage?.session;
  }
}
