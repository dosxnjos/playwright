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


import { OwnedTab, detachDebuggersOfPreviousServiceWorker } from './ownedTab';
import { closeTabs, forgetAgentTabs, recordAgentTab } from './agentTabs';

import type { ChromeListeners } from './chromeListeners';
import type { ClientSession } from './clientSession';

// Fork (FORK.md § Foco zero, "Popups"): Chrome's openerTabId names the tab that was ACTIVE when a popup opened, not the
// tab that opened it, and the tab of a background client never is (measured in Chromium 1247 on 03/10/2026 and on the
// extension 0.5.0 with Chromium 158 on 12/11/2026: tests/extension/popup-source.spec.ts). With the webNavigation
// permission a popup is claimed from onCreatedNavigationTarget, whose sourceTabId is the real opener. Without it,
// upstream's openerTabId path.
function popupSourceEvents(): typeof chrome.webNavigation.onCreatedNavigationTarget | undefined {
  return (globalThis as any).chrome?.webNavigation?.onCreatedNavigationTarget;
}

export class TabRegistry {
  readonly ready = detachDebuggersOfPreviousServiceWorker();
  private _tabs = new Map<number, OwnedTab>();
  private _reservedTabIds = new Set<number>();

  onTabClaimed?: (tab: chrome.tabs.Tab, session: ClientSession) => void;

  constructor(listeners: ChromeListeners) {
    listeners.add(chrome.tabs.onCreated, tab => this._onTabCreated(tab));
    listeners.add(chrome.tabs.onRemoved, (tabId, removeInfo) => this._onTabRemoved(tabId, removeInfo));
    listeners.add(chrome.tabs.onUpdated, (tabId, changeInfo, tab) => {
      if (changeInfo.url !== undefined)
        this._tabs.get(tabId)?.didNavigate(tab);
    });
    listeners.add(chrome.debugger.onEvent, (source, method, params) => {
      this._tabs.get(source.tabId!)?.didReceiveDebuggerEvent(source, method, params);
    });
    listeners.add(chrome.debugger.onDetach, (source, reason) => {
      const tab = this._tabs.get(source.tabId!);
      // Fork (patch 3): the user took the tab over (Cancel on the debugger bar, DevTools opened): it is theirs now, never
      // closed when the client leaves.
      if (tab?.agent && reason !== 'target_closed') {
        tab.agent = false;
        forgetAgentTabs([tab.tabId]);
      }
      tab?.didDetachDebugger(reason);
    });
    const popupEvents = popupSourceEvents();
    if (popupEvents)
      listeners.add(popupEvents, details => void this._onPopupCreated(details));
  }

  // A reserved tab has no owner, and no client can claim it.
  async reserve(tabId: number): Promise<void> {
    this._reservedTabIds.add(tabId);
    await this.release(tabId);
  }

  unreserve(tabId: number): void {
    this._reservedTabIds.delete(tabId);
  }

  isReserved(tabId: number): boolean {
    return this._reservedTabIds.has(tabId);
  }

  isFree(tabId: number): boolean {
    return !this._tabs.has(tabId) && !this._reservedTabIds.has(tabId);
  }

  ownedTab(tabId: number): OwnedTab | undefined {
    return this._tabs.get(tabId);
  }

  ownerOf(tabId: number): ClientSession | undefined {
    return this._tabs.get(tabId)?.session;
  }

  tabIdsOf(session: ClientSession): number[] {
    return [...this._tabs.values()].filter(tab => tab.session === session).map(tab => tab.tabId);
  }

  // Fork (patch 3): `agent` marks a tab that the client created; it is closed when the client leaves (agentTabs.ts).
  claim(tab: chrome.tabs.Tab, session: ClientSession, options: { announce?: boolean, agent?: boolean } = {}): void {
    const tabId = tab.id!;
    const owner = this.ownerOf(tabId);
    if (owner === session)
      return;
    if (owner)
      throw new Error('This tab is already connected to another client');
    if (this._reservedTabIds.has(tabId))
      throw new Error('This tab is a connect page');
    const ownedTab = new OwnedTab(tab, session, options.announce ?? true);
    if (options.agent && session.options.closeAgentTabs !== false) {
      ownedTab.agent = true;
      recordAgentTab(tabId);
    }
    this._tabs.set(tabId, ownedTab);
    this.onTabClaimed?.(tab, session);
  }

  async release(tabId: number): Promise<void> {
    const tab = this._tabs.get(tabId);
    if (!tab)
      return;
    this._tabs.delete(tabId);
    forgetAgentTabs([tabId]);
    tab.session.tabReleased(tabId);
    await tab.dispose();
  }

  // Fork (patch 3): the client left, its agent tabs go. Dropped from the table first, so that the session (already
  // closed) gets no event for them; the detach and the close run one tab at a time.
  async closeAgentTabs(session: ClientSession): Promise<void> {
    const tabs = [...this._tabs.values()].filter(tab => tab.session === session && tab.agent);
    for (const tab of tabs)
      this._tabs.delete(tab.tabId);
    const tabIds = tabs.map(tab => tab.tabId);
    forgetAgentTabs(tabIds);
    await Promise.all(tabs.map(tab => tab.dispose()));
    await closeTabs(tabIds);
  }

  async transfer(tab: chrome.tabs.Tab, to: ClientSession): Promise<void> {
    await this.release(tab.id!);
    this.claim(tab, to);
  }

  async releaseAll(session: ClientSession): Promise<void> {
    await Promise.all(this.tabIdsOf(session).map(tabId => this.release(tabId)));
  }

  private _onTabCreated(tab: chrome.tabs.Tab): void {
    // Fork: popups come from onCreatedNavigationTarget when it is there (see popupSourceEvents).
    if (popupSourceEvents())
      return;
    const opener = tab.openerTabId === undefined ? undefined : this.ownerOf(tab.openerTabId);
    if (opener)
      this.claim(tab, opener, { agent: true });
  }

  // Fork (FORK.md § Foco zero, "Popups"): a popup goes to the owner of the tab that opened it, the real source.
  private async _onPopupCreated(details: chrome.webNavigation.WebNavigationSourceCallbackDetails): Promise<void> {
    const owner = this.ownerOf(details.sourceTabId);
    if (!owner)
      return;
    const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
    if (!tab || this.ownerOf(details.sourceTabId) !== owner)
      return;
    // Chrome makes the popup active and names the tab that was active then as its openerTabId: for a background
    // client, put that tab back. Not when it is the source itself: the user was looking at the tab of the client (to
    // follow it, to log in), and the popup is what they see next. A popup in a window of its own still comes to the front.
    if (owner.options.background && tab.active && tab.openerTabId !== undefined && tab.openerTabId !== tab.id && tab.openerTabId !== details.sourceTabId)
      void chrome.tabs.update(tab.openerTabId, { active: true }).catch(() => {});
    try {
      this.claim({ ...tab, openerTabId: details.sourceTabId }, owner, { agent: true });
    } catch {
      // Another client took the tab meanwhile.
    }
  }

  private _onTabRemoved(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo): void {
    this._reservedTabIds.delete(tabId);
    const tab = this._tabs.get(tabId);
    if (!tab)
      return;
    this._tabs.delete(tabId);
    forgetAgentTabs([tabId]);
    tab.session.tabClosed(tabId, removeInfo);
    void tab.dispose();
  }
}
