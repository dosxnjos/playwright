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

import { RelayConnection, debugLog } from './relayConnection';

export const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_COLOR = 'green';
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

// The extension's own connect page is infrastructure, never a legitimate
// automation target. A neighboring connection's group can otherwise pick it
// up (Chrome inserts a new window's tab into the active group) and attach it
// before its owning connection does, stealing the debugger and leaving the
// owning connection's model empty - see microsoft/playwright#41843.
export function isOwnConnectPage(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL('connect.html'));
}

// Who a tab "belongs to" when its connection closes: agent-owned tabs get
// closed (the agent created them, so leaving them open is a leak); user-owned
// tabs only get ungrouped (closing a tab the user brought in themselves would
// be destructive). See ConnectedTabGroup's ownership comment for the rules.
export type TabOwner = 'agent' | 'user';

// Ownership survives a service worker restart (chrome.storage.session persists
// across MV3 worker deaths, and zeroes on browser restart - exactly the window
// a worker can die and come back in while groups are still open) so
// `cleanupStalePlaywrightGroups` can tell, after a cold start, which tabs in a
// leftover group were agent-created vs. the user's own - see
// microsoft/playwright#41843.
type PwGroupsStorage = { [groupId: number]: { agentOwned: number[] } };
const PW_GROUPS_STORAGE_KEY = 'pwGroups';

async function readPwGroups(): Promise<PwGroupsStorage> {
  const result = await chrome.storage.session.get(PW_GROUPS_STORAGE_KEY);
  return (result[PW_GROUPS_STORAGE_KEY] as PwGroupsStorage | undefined) ?? {};
}

async function writePwGroups(map: PwGroupsStorage): Promise<void> {
  await chrome.storage.session.set({ [PW_GROUPS_STORAGE_KEY]: map });
}

// Reconciles leftover Playwright-titled groups from a prior service worker.
// Titles vary per connection (`Playwright · <clientName>`, see
// PlaywrightExtension._reserveGroupTitle), so match by prefix instead of the
// old exact-title query — chrome.tabGroups.query({title}) does not support
// patterns, so we query all groups and filter here. Tabs recorded as
// agent-owned (persisted by the connection that's now gone) get closed;
// everything else - including groups with no persisted entry at all, e.g. a
// worker restart that predates this instrumentation - falls back to the
// original behavior of just ungrouping, since closing a user's own tab
// without that record would be destructive.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    const staleGroups = groups.filter(g => g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE));
    if (!staleGroups.length)
      return;
    const pwGroups = await readPwGroups();
    const tabsPerGroup = await Promise.all(staleGroups.map(g => chrome.tabs.query({ groupId: g.id })));
    const toUngroup: number[] = [];
    const toClose: number[] = [];
    for (let i = 0; i < staleGroups.length; i++) {
      const groupId = staleGroups[i].id;
      const agentOwned = new Set(pwGroups[groupId]?.agentOwned ?? []);
      for (const tab of tabsPerGroup[i]) {
        if (tab.id === undefined)
          continue;
        if (agentOwned.has(tab.id))
          toClose.push(tab.id);
        else
          toUngroup.push(tab.id);
      }
      delete pwGroups[groupId];
    }
    if (toUngroup.length)
      await chrome.tabs.ungroup(toUngroup as [number, ...number[]]);
    if (toClose.length)
      await chrome.tabs.remove(toClose).catch(() => {});
    await writePwGroups(pwGroups);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The Playwright tab group for an active RelayConnection. The Chrome tab group
// is the single source of truth for which tabs the client targets:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// `_groupTabIds` caches group membership from Chrome events so hot-path checks
// in `_onTabUpdated` stay synchronous.
export class ConnectedTabGroup {
  private _connection: RelayConnection;
  private _groupId: number | null = null;
  private _groupTitle: string;
  private _groupTabIds: Set<number> = new Set();
  // Tabs to close (vs. just ungroup) when the connection closes. Populated
  // only in `_onTabGroupChanged`'s entry branch — the single point where a
  // tab becomes a group member — so a later re-attach (e.g. after navigation)
  // never re-decides ownership for a tab already in the group.
  private _agentOwnedTabs: Set<number> = new Set();
  // Owner intended for the next tab that enters the group via an
  // agent-initiated path (seed tab, or `_addTabToGroup` from a relay attach).
  // `_onTabGroupChanged` consumes it when the membership change lands; a
  // group-entry with no pending entry (typically a user drag) defaults to
  // 'user'.
  private _pendingOwner: Map<number, TabOwner> = new Map();
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;
  // Fired when the client asks (via session.setGroupLabel) to relabel this
  // connection's group. The caller (background.ts's PlaywrightExtension) owns
  // cross-connection dedupe - see _reserveGroupTitle - so it computes the
  // final title and calls setLabel() back; this callback only carries the
  // raw requested label up to whoever can see every active connection.
  onlabelrequest?: (label: string) => Promise<void>;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, groupTitle: string = PLAYWRIGHT_GROUP_TITLE, seedOwner: TabOwner = 'agent') {
    this._connection = connection;
    this._groupTitle = groupTitle;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._connection.onsetgrouplabel = (label: string) => this._onLabelRequested(label);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // Seed ownership: 'agent' for the token/newTab bypass path (no tab was
    // picked), 'user' when the connect page's tab picker chose an existing
    // tab — see PlaywrightExtension._connectTab.
    if (selectedTab.id !== undefined)
      this._pendingOwner.set(selectedTab.id, seedOwner);
    // Seed the relay with the user-selected tab, then close out the initial
    // handshake. The relay holds Playwright-side CDP traffic until
    // `didInitialize` arrives, so it sees a fully populated tab model by the
    // time it handles `Target.setAutoAttach`.
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  private async _onLabelRequested(label: string): Promise<void> {
    if (!this.onlabelrequest)
      throw new Error('No label handler registered for this connection');
    await this.onlabelrequest(label);
  }

  // Applies an already-deduped, already-prefixed title (see background.ts's
  // _reserveGroupTitle) to this connection's Chrome tab group. Takes the
  // final title rather than the raw label so the "Playwright · X" prefix and
  // (2)/(3) dedupe suffix are computed in exactly one place - the caller,
  // which is also the only place with visibility into every other active
  // connection's current title.
  async setLabel(title: string): Promise<void> {
    this._groupTitle = title;
    if (this._groupId !== null)
      await chrome.tabGroups.update(this._groupId, { title });
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url) && !isOwnConnectPage(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  //
  // This is also the single point where tab ownership is decided (D2): a
  // group-entry consumes `_pendingOwner` (set by the constructor for the seed
  // tab, or by `_onTabAttached` for a relay-initiated attach) if present,
  // otherwise the entry was a raw user drag and defaults to 'user'. Deciding
  // ownership only here — never on re-attach — means a later navigation of an
  // already-grouped tab can't retroactively promote it to agent-owned.
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      this._groupTabIds.add(tabId);
      const owner = this._pendingOwner.get(tabId) ?? 'user';
      this._pendingOwner.delete(tabId);
      if (owner === 'agent')
        this._agentOwnedTabs.add(tabId);
      if (!isNonDebuggableUrl(tab.url) && !isOwnConnectPage(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      this._agentOwnedTabs.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
    void this._persistOwnership();
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
    this._agentOwnedTabs.delete(tabId);
    this._pendingOwner.delete(tabId);
    void this._persistOwnership();
  }

  // A relay-initiated attach (popup, `browser_tabs new`, `Target.createTarget`)
  // is agent-owned by default. Only register that when there's no pending
  // owner yet and the tab isn't already a group member: the constructor
  // pre-registers the seed tab's owner (which may be 'user', from the tab
  // picker) before its own attachTab call reaches here, and a re-attach of an
  // existing member (e.g. after navigation) must not re-decide ownership —
  // see `_onTabGroupChanged`.
  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    if (!this._groupTabIds.has(tabId) && !this._pendingOwner.has(tabId))
      this._pendingOwner.set(tabId, 'agent');
    void this._addTabToGroup(tabId);
  }

  // The debugger detached (drag-out, tab close, or external action). Usually
  // this is transient: clear the badge and leave the tab in the group, since a
  // subsequent navigation will re-attach via _onTabUpdated. But chrome.debugger
  // can never attach to non-debuggable URLs (chrome://, edge://, devtools://)
  // — if that's why this tab detached, no future navigation fixes it on its
  // own, so it would otherwise sit in the group permanently attached-but-dead.
  // Close it outright rather than just ungrouping, regardless of ownership:
  // whatever content the tab held before is already gone (overwritten by the
  // navigation that caused this), so there's nothing left to preserve by
  // leaving it open loose in the browser.
  private async _onTabDetached(tabId: number): Promise<void> {
    void this._updateBadge(tabId, { text: '' });
    if (!this._groupTabIds.has(tabId))
      return;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return; // Already gone - _onTabRemoved handles that.
    }
    if (!isNonDebuggableUrl(tab.url))
      return;
    this._groupTabIds.delete(tabId);
    this._agentOwnedTabs.delete(tabId);
    void this._persistOwnership();
    await this._retryOnDrag(() => chrome.tabs.remove([tabId])).catch(error => {
      debugLog('Error closing dead (non-debuggable) tab:', error);
    });
  }

  // Agent-owned tabs (created by the agent — seed via token/newTab, popups,
  // browser_tabs new, Target.createTarget) are closed: leaving them open would
  // leak windows every time a Claude instance dies. User-owned tabs (the tab
  // picked in the connect page, or dragged into the group) are only
  // ungrouped — the user's own page, closing it would be destructive. Same
  // path for a manual disconnect (status page) and the connection dying.
  private _onConnectionClose(): void {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    const agentOwnedTabs = groupTabs.filter(id => this._agentOwnedTabs.has(id));
    const userOwnedTabs = groupTabs.filter(id => !this._agentOwnedTabs.has(id));
    this._groupTabIds.clear();
    this._agentOwnedTabs.clear();
    this._pendingOwner.clear();
    void this._clearPersistedOwnership();
    if (userOwnedTabs.length) {
      this._retryOnDrag(() => chrome.tabs.ungroup(userOwnedTabs as [number, ...number[]])).catch(error => {
        debugLog('Error ungrouping tabs on close:', error);
      });
    }
    if (agentOwnedTabs.length) {
      this._retryOnDrag(() => chrome.tabs.remove(agentOwnedTabs)).catch(error => {
        debugLog('Error closing agent-owned tabs on close:', error);
      });
    }
    this.onclose?.();
  }

  // Mirrors `_agentOwnedTabs` into chrome.storage.session, keyed by this
  // connection's group id, so `cleanupStalePlaywrightGroups` can tell agent-
  // owned tabs from user-owned ones after a service worker restart drops all
  // in-memory state. No-op before the group exists (`_groupId` still null).
  private async _persistOwnership(): Promise<void> {
    if (this._groupId === null)
      return;
    try {
      const pwGroups = await readPwGroups();
      pwGroups[this._groupId] = { agentOwned: [...this._agentOwnedTabs] };
      await writePwGroups(pwGroups);
    } catch (error: any) {
      debugLog('Error persisting tab ownership:', error);
    }
  }

  private async _clearPersistedOwnership(): Promise<void> {
    if (this._groupId === null)
      return;
    try {
      const pwGroups = await readPwGroups();
      delete pwGroups[this._groupId];
      await writePwGroups(pwGroups);
    } catch (error: any) {
      debugLog('Error clearing persisted tab ownership:', error);
    }
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _addTabToGroup(tabId: number): Promise<void> {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await this._retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, { color: PLAYWRIGHT_GROUP_COLOR, title: this._groupTitle });
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
    }
  }

  // Chrome throws "user may be dragging a tab" while a drag is in progress.
  // Retry with backoff until it clears (or we give up).
  private async _retryOnDrag(fn: () => Promise<void>): Promise<void> {
    const delays = [0, 100, 200, 400, 800];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay)
        await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fn();
        return;
      } catch (error: any) {
        if (!error?.message?.includes('user may be dragging a tab'))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
