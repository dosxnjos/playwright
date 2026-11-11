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

const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;
// Green first, so a lone connection keeps the familiar look.
const PLAYWRIGHT_GROUP_COLORS: GroupColor[] = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

type GroupColor = `${chrome.tabGroups.Color}`;

// Fork: who a tab belongs to when its connection closes. Agent-owned tabs (the
// agent created them: token-bypass seed, popups, browser_tabs new,
// Target.createTarget) are closed, since leaving them open leaks a tab every time
// a client dies. User-owned tabs (picked in the connect page, or dragged into
// the group) are only ungrouped: closing a page the user brought in is destructive.
export type TabOwner = 'agent' | 'user';

export type GroupStyle = {
  title: string;
  color: GroupColor;
};

export function uniqueGroupStyle(clientName: string | undefined, taken: readonly GroupStyle[]): GroupStyle {
  const titles = new Set(taken.map(style => style.title));
  const base = PLAYWRIGHT_GROUP_TITLE_PREFIX + (clientName || 'unknown');
  let title = base;
  for (let i = 2; titles.has(title); i++)
    title = `${base} (${i})`;

  const colors = new Set(taken.map(style => style.color));
  const color = PLAYWRIGHT_GROUP_COLORS.find(candidate => !colors.has(candidate)) ?? PLAYWRIGHT_GROUP_COLORS[0];
  return { title, color };
}

// Fork (11/11/2026): a service worker that dies (MV3 idle death, crash) takes every connection's ownership map with it,
// and no close handler runs. Agent-owned tabs (and the agent's seed) are also recorded here so the next worker can close
// them. chrome.storage.session dies with the browser session, so a tab id Chrome reuses after a restart is never taken
// for an agent's tab. It is also wiped when the extension is reloaded, updated or disabled: the next worker then finds
// no record and only ungroups (agent tabs of a connection alive at that moment stay open, loose). Writes are chained so
// the store always ends with the latest set.
const AGENT_TABS_KEY = 'playwrightAgentTabs';
const agentTabRecord = new Set<number>();
let agentTabWrite: Promise<void> = Promise.resolve();

function persistAgentTabs(): void {
  const tabIds = [...agentTabRecord];
  agentTabWrite = agentTabWrite
      .then(() => chrome.storage.session.set({ [AGENT_TABS_KEY]: tabIds }))
      .catch(error => debugLog('Error recording agent tabs:', error));
}

function recordAgentTab(tabId: number): void {
  if (agentTabRecord.has(tabId))
    return;
  agentTabRecord.add(tabId);
  persistAgentTabs();
}

function forgetAgentTabs(tabIds: Iterable<number>): void {
  let changed = false;
  for (const tabId of tabIds)
    changed = agentTabRecord.delete(tabId) || changed;
  if (changed)
    persistAgentTabs();
}

async function readAgentTabRecord(): Promise<Set<number>> {
  try {
    const stored = (await chrome.storage.session.get(AGENT_TABS_KEY))[AGENT_TABS_KEY];
    return new Set(Array.isArray(stored) ? stored.filter((id): id is number => typeof id === 'number') : []);
  } catch (error: any) {
    debugLog('Error reading agent tabs:', error);
    return new Set();
  }
}

// One by one: a batch remove aborts on the first tab that is gone, and every other tab would survive.
async function closeTabs(tabIds: number[], what: string): Promise<void> {
  const results = await Promise.allSettled(tabIds.map(tabId => retryOnDrag(() => chrome.tabs.remove(tabId))));
  for (const result of results) {
    if (result.status === 'rejected')
      debugLog(`Error closing ${what}:`, result.reason);
  }
}

// The windows that have the focus. Unknown (the query failed) -> every window counts as focused, so nothing in front
// of the user is closed by mistake.
async function focusedWindowIds(): Promise<(windowId: number) => boolean> {
  try {
    const focused = new Set((await chrome.windows.getAll()).filter(w => w.focused).map(w => w.id));
    return windowId => focused.has(windowId);
  } catch (error: any) {
    debugLog('Error reading focused windows:', error);
    return () => true;
  }
}

// Runs once per service worker start: every Playwright-titled group belongs to a connection of a prior worker, now dead.
// Fork: the tabs that worker recorded as agent-owned are closed (with its seeds still on the connect page, which never
// entered a group), the rest are only ungrouped. Without a record (a worker of an older version) everything is
// ungrouped, as upstream does. An agent tab that is the active tab of a focused window is never closed, only
// ungrouped: the user may be typing in it (a 2FA code the agent asked for), main session's tab included.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const agentTabs = await readAgentTabRecord();
    const groups = await chrome.tabGroups.query({});
    // The bare title comes from versions that predate per-client groups.
    const stale = groups.filter(g => g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX));
    const tabsPerGroup = await Promise.all(stale.map(g => chrome.tabs.query({ groupId: g.id })));
    const groupTabs = tabsPerGroup.flat().filter(t => t.id !== undefined);
    const tabIds = groupTabs.map(t => t.id!);
    const isFocusedWindow = await focusedWindowIds();
    const inFront = (tab: chrome.tabs.Tab) => tab.active && isFocusedWindow(tab.windowId);
    const toClose = groupTabs.filter(t => agentTabs.has(t.id!) && !inFront(t)).map(t => t.id!);
    const toUngroup = tabIds.filter(id => !toClose.includes(id));
    if (toUngroup.length)
      await ungroupTabs(toUngroup);
    await closeTabs(toClose, 'an agent tab left by a dead service worker');
    const connectPage = chrome.runtime.getURL('connect.html');
    const ungrouped = await Promise.all([...agentTabs].filter(id => !tabIds.includes(id)).map(id => chrome.tabs.get(id).catch(() => undefined)));
    const seeds = ungrouped.filter(tab => tab?.id !== undefined && tab.url?.startsWith(connectPage) && !inFront(tab)).map(tab => tab!.id!);
    await closeTabs(seeds, 'an agent seed left by a dead service worker');
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  } finally {
    // Every connection the record spoke for is gone: this worker's connections start a new one.
    agentTabRecord.clear();
    persistAgentTabs();
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
  readonly clientName: string | undefined;
  groupStyle: GroupStyle;
  private _connection: RelayConnection;
  private _isTabReserved: (tabId: number) => boolean;
  private _groupId: number | null = null;
  private _groupTabIds: Set<number> = new Set();
  // Fork: ownership is decided once, when a tab enters the group (never on a later
  // re-attach, so a navigation can't promote a user's tab to agent-owned).
  private _agentOwnedTabs: Set<number> = new Set();
  // Owner intended for the next tab entering the group through an agent-initiated
  // path (seed tab, relay attach). A group entry with no pending owner is a user drag.
  private _pendingOwner: Map<number, TabOwner> = new Map();
  // The agent-created seed tab. While it still shows connect.html it may never
  // enter the group, so `_onConnectionClose` would not see it.
  private _agentSeedTabId: number | undefined;
  private _closed = false;
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;
  // Fork: asks the owner (which sees every connection) for the deduped title of a client-supplied label.
  onlabelrequest?: (label: string) => Promise<void>;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, clientName: string | undefined, groupStyle: GroupStyle, isTabReserved: (tabId: number) => boolean, seedOwner: TabOwner) {
    this.clientName = clientName;
    this.groupStyle = groupStyle;
    this._isTabReserved = isTabReserved;
    this._connection = connection;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    // A tab the user took over is theirs from now on: ungrouped on close, never closed.
    this._connection.ontabtakenover = (tabId: number) => this._disownTab(tabId);
    this._connection.onsetgrouplabel = async label => {
      if (!this.onlabelrequest)
        throw new Error('No label handler registered for this connection');
      await this.onlabelrequest(label);
    };
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // 'agent' when no tab was picked (token bypass), 'user' when the connect page's picker chose one.
    if (selectedTab.id !== undefined)
      this._pendingOwner.set(selectedTab.id, seedOwner);
    if (seedOwner === 'agent') {
      this._agentSeedTabId = selectedTab.id;
      if (selectedTab.id !== undefined)
        recordAgentTab(selectedTab.id);
    }
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

  // Applies an already-deduped title (computed by the owner, see onlabelrequest) to the Chrome tab group.
  async setTitle(title: string): Promise<void> {
    this.groupStyle = { ...this.groupStyle, title };
    if (this._groupId !== null)
      await chrome.tabGroups.update(this._groupId, { title });
  }

  releaseTab(tabId: number): void {
    if (!this._groupTabIds.has(tabId))
      return;
    this._groupTabIds.delete(tabId);
    this._disownTab(tabId);
    this._connection.detachTab(tabId);
  }

  // Fork: the in-memory owner map and the record that outlives the worker always change together.
  private _disownTab(tabId: number): void {
    this._agentOwnedTabs.delete(tabId);
    forgetAgentTabs([tabId]);
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      // Chrome may drop the connect page of a client that is still connecting
      // into our group; that tab is spoken for.
      if (this._isTabReserved(tabId)) {
        void ungroupTabs([tabId]);
        return;
      }
      this._groupTabIds.add(tabId);
      // No pending owner: a raw user drag, except a tab opened from a tab that is already in
      // the group (popup, ctrl+click), which Chrome drops into the opener's group and which the
      // relay attaches on its own: agent-owned, whichever of the two events lands first.
      // Fork (patch 7): the opener must be a tab this connection drives. A group tab the relay ignored (a user's tab
      // dragged into a sub-agent's group) drives nothing, so what it opened stays the user's.
      const fromGroupTab = tab.openerTabId !== undefined && this._connection.attachedTabs.has(tab.openerTabId);
      this._claimOwner(tabId, fromGroupTab ? 'agent' : 'user');
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      this._disownTab(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
    this._disownTab(tabId);
    this._pendingOwner.delete(tabId);
  }

  // Consumes the pending owner of a tab that just entered the group (or
  // `fallback` when there is none) and records agent ownership.
  private _claimOwner(tabId: number, fallback: TabOwner | undefined): void {
    const owner = this._pendingOwner.get(tabId) ?? fallback;
    this._pendingOwner.delete(tabId);
    if (owner === 'agent') {
      this._agentOwnedTabs.add(tabId);
      recordAgentTab(tabId);
    }
  }

  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    // A relay-initiated attach is agent-owned by default, unless the seed's
    // owner is already pending or the tab is already a member (re-attach).
    if (!this._groupTabIds.has(tabId) && !this._pendingOwner.has(tabId))
      this._pendingOwner.set(tabId, 'agent');
    void this._addTabToGroup(tabId);
  }

  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
  }

  private _onConnectionClose(): void {
    this._closed = true;
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    const agentOwnedTabs = groupTabs.filter(id => this._agentOwnedTabs.has(id));
    const userOwnedTabs = groupTabs.filter(id => !this._agentOwnedTabs.has(id));
    this._groupTabIds.clear();
    this._agentOwnedTabs.clear();
    this._pendingOwner.clear();
    // Agent seed still on connect.html: never entered the group, so it is not in `groupTabs`.
    const seedTabId = this._agentSeedTabId;
    this._agentSeedTabId = undefined;
    // This worker closes or ungroups them right here: nothing is left for a later worker.
    forgetAgentTabs(seedTabId === undefined ? groupTabs : [...groupTabs, seedTabId]);
    if (userOwnedTabs.length)
      void ungroupTabs(userOwnedTabs);
    void closeTabs(agentOwnedTabs, 'agent-owned tabs on close');
    if (seedTabId !== undefined && !groupTabs.includes(seedTabId)) {
      chrome.tabs.get(seedTabId).then(tab => {
        if (tab.url?.startsWith(chrome.runtime.getURL('connect.html')))
          return chrome.tabs.remove(seedTabId);
      }).catch(error => {
        debugLog('Error closing agent seed tab on close:', error);
      });
    }
    this.onclose?.();
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
    const owner = this._pendingOwner.get(tabId);
    try {
      await retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, this.groupStyle);
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      // The connection closed while the group call was in flight: nothing tracks this tab any more.
      if (this._closed) {
        if (owner === 'agent')
          await chrome.tabs.remove(tabId).catch(() => {});
        else
          await ungroupTabs([tabId]);
        return;
      }
      this._groupTabIds.add(tabId);
      // Ownership must also be decided here: the group-entry event can land while
      // `_groupId` is still null (first tab) or after this add, so
      // `_onTabGroupChanged` returns early and never consumes the pending owner,
      // and every agent tab, the seed included, would end up merely ungrouped.
      // Only consumes a pending entry, so a tab `_onTabGroupChanged` already
      // decided keeps its owner.
      this._claimOwner(tabId, undefined);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
      // Never grouped, so a stale 'agent' must not be consumed by a later user drag.
      this._pendingOwner.delete(tabId);
    }
  }

}

export async function ungroupTabs(tabIds: number[]): Promise<void> {
  try {
    await retryOnDrag(() => chrome.tabs.ungroup(tabIds));
  } catch (error: any) {
    debugLog('Error ungrouping tabs:', error);
  }
}

// Chrome throws "user may be dragging a tab" while a drag is in progress.
// Retry with backoff until it clears (or we give up).
async function retryOnDrag(fn: () => Promise<void>): Promise<void> {
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
