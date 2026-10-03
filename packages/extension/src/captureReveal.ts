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

// Fork-only (03/10/2026, decided by the Gabriel: "mostrar só sem plateia"). Chrome draws no frame for a hidden tab, so a
// background relay's Page.captureScreenshot waited ~12-31 s in the live test (the relay answers Page.bringToFront
// itself). For the capture the relay asks to show the tab (revealForCapture) and to put the user's tab back
// (restoreAfterCapture). Shown only inside its own window and only when that window is not the focused one: nobody is
// looking at it. Never chrome.windows.update(focused): the user stays in the app they are in. When the window has the
// focus, nothing changes and the capture goes on slowly. FORK.md § Foco zero, "Screenshot".
//
// One state for the whole extension, by window (review of 03/10): two Claude Code sessions are two server processes
// sharing this extension, and their reveals can cross in one window. A reveal into a window that already shows an agent
// tab for a capture keeps the user's tab as the one to put back (not the other agent's), and that tab comes back only
// when the window's last pending capture ends.

type WindowReveal = {
  // The tab to put back: the user's, active before the first reveal of this episode.
  userTabId: number;
  // Revealed tabs whose capture has not ended, by who asked (a connection only restores its own).
  pending: Map<number, object>;
  // Every tab revealed this episode: the user's tab comes back only while one of them is in front.
  revealed: Set<number>;
};

export class CaptureReveal {
  private _windows = new Map<number, WindowReveal>();
  // One reveal or restore at a time: two connections' commands arrive interleaved, and each reads the active tab before
  // it writes the state.
  private _queue: Promise<unknown> = Promise.resolve();

  private _serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this._queue.then(task);
    this._queue = result.catch(() => {});
    return result;
  }

  reveal(tabId: number, owner: object): Promise<{ revealed: boolean }> {
    return this._serialized(() => this._reveal(tabId, owner));
  }

  restore(tabId: number, owner: object): Promise<{ restored: boolean }> {
    return this._serialized(() => this._restore(tabId, owner));
  }

  private async _reveal(tabId: number, owner: object): Promise<{ revealed: boolean }> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active)
      return { revealed: false };
    const window = await chrome.windows.get(tab.windowId);
    if (window.focused)
      return { revealed: false };
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    // Nothing to put back afterwards: leave the window as it is.
    if (active?.id === undefined)
      return { revealed: false };
    let state = this._windows.get(tab.windowId);
    if (!state) {
      state = { userTabId: active.id, pending: new Map(), revealed: new Set() };
      this._windows.set(tab.windowId, state);
    } else if (!state.revealed.has(active.id)) {
      // The user picked another tab since the last reveal: that one is theirs now.
      state.userTabId = active.id;
    }
    state.pending.set(tabId, owner);
    state.revealed.add(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return { revealed: true };
  }

  // Only a tab this owner revealed. The user's tab comes back when the window's last pending capture ends, and only
  // while a revealed tab is still the active one: a user who switched tabs meanwhile keeps their choice.
  private async _restore(tabId: number, owner: object): Promise<{ restored: boolean }> {
    const found = [...this._windows].find(([, state]) => state.pending.get(tabId) === owner);
    if (!found)
      return { restored: false };
    const [windowId, state] = found;
    state.pending.delete(tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (state.pending.size) {
      // Another capture in this window still runs: show its tab again, not the user's yet. Not while someone looks at the
      // window (the user came back meanwhile): no agent tab switches under their eyes, the last restore puts theirs back.
      const [still] = [...state.pending.keys()].slice(-1);
      if (active?.id === tabId && !(await chrome.windows.get(windowId).then(w => w.focused, () => true)))
        await chrome.tabs.update(still, { active: true }).catch(() => {});
      return { restored: false };
    }
    this._windows.delete(windowId);
    if (active?.id === undefined || !state.revealed.has(active.id))
      return { restored: false };
    try {
      await chrome.tabs.update(state.userTabId, { active: true });
    } catch {
      // The user's tab is gone.
      return { restored: false };
    }
    return { restored: true };
  }

  // The connection is closing (relay gone mid-capture): put back what it revealed, before its tabs are closed.
  hasPending(owner: object): boolean {
    return [...this._windows.values()].some(state => [...state.pending.values()].includes(owner));
  }

  async restoreAll(owner: object): Promise<void> {
    const tabIds = [...this._windows.values()].flatMap(state => [...state.pending].filter(([, o]) => o === owner).map(([tabId]) => tabId));
    for (const tabId of tabIds)
      await this.restore(tabId, owner).catch(() => {});
  }
}

// Shared by every RelayConnection of this service worker (a service worker restart drops it along with the connections).
export const captureReveal = new CaptureReveal();
