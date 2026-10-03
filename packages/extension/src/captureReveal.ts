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

type Revealed = { windowId: number, previousTabId: number };

export class CaptureReveal {
  // By revealed tab: what to put back. One entry per tab; the relay reveals one tab at a time per process.
  private _revealed = new Map<number, Revealed>();

  async reveal(tabId: number): Promise<{ revealed: boolean }> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active)
      return { revealed: false };
    const window = await chrome.windows.get(tab.windowId);
    if (window.focused)
      return { revealed: false };
    const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    // Nothing to put back afterwards: leave the window as it is.
    if (previous?.id === undefined)
      return { revealed: false };
    this._revealed.set(tabId, { windowId: tab.windowId, previousTabId: previous.id });
    await chrome.tabs.update(tabId, { active: true });
    return { revealed: true };
  }

  // Only a tab this connection revealed, and only while it is still the active one: a user who switched tabs meanwhile
  // keeps their choice.
  async restore(tabId: number): Promise<{ restored: boolean }> {
    const revealed = this._revealed.get(tabId);
    this._revealed.delete(tabId);
    if (!revealed)
      return { restored: false };
    const [active] = await chrome.tabs.query({ active: true, windowId: revealed.windowId });
    if (active?.id !== tabId)
      return { restored: false };
    try {
      await chrome.tabs.update(revealed.previousTabId, { active: true });
    } catch {
      // The previous tab is gone.
      return { restored: false };
    }
    return { restored: true };
  }
}
