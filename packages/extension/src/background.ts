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

import { debugLog } from './relayConnection';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, PLAYWRIGHT_GROUP_TITLE, cleanupStalePlaywrightGroups, isNonDebuggableUrl } from './connectedTabGroup';
import type { TabOwner } from './connectedTabGroup';

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
  protocolVersion: number;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  // Absent disconnects every active connection (keeps the single-connection
  // behavior identical to upstream); present targets just that one.
  connectionId?: number;
} | {
  type: 'keepalive';
};

type ActiveConnection = {
  group: ConnectedTabGroup;
  clientName: string | undefined;
  title: string;
};

class PlaywrightExtension {
  // Keyed by selectorTabId — the tab id of the connect page that established
  // the connection. It stays a stable, unique handle for the connection's
  // lifetime even after that tab is grouped away or closed.
  private _connections = new Map<number, ActiveConnection>();
  private _pendingConnections = new PendingConnections();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;

  constructor() {
    // TEMP DEBUG (16/07 investigation, retriggered after a broken CI run,
    // remove before PR): a durable (survives SW death, unlike an in-memory
    // variable) counter in chrome.storage.session — reading it > 1 during a
    // test proves the MV3 service worker restarted mid-test, wiping this
    // class's in-memory state (_connections etc).
    void chrome.storage.session.get('pwdebugRestartCount').then((stored: { pwdebugRestartCount?: number }) => {
      const count = (stored.pwdebugRestartCount ?? 0) + 1;
      void chrome.storage.session.set({ pwdebugRestartCount: count });
      // eslint-disable-next-line no-console
      console.log('[PWDEBUG] PlaywrightExtension constructed, restart count =', count);
    });
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested':
        this._pendingConnections.create(sender.tab!.id!, message.mcpRelayUrl, message.protocolVersion).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // Token-bypass (no specific pick) falls back to the connect page itself
        // so `ConnectedTabGroup` always has a concrete tab to start from. Both
        // sender.tab and UI-supplied tabs come from chrome.tabs.query / runtime
        // message sender, where `id` is always defined.
        const selectedTab = (message.tab ?? sender.tab!) as chrome.tabs.Tab & { id: number };
        // A tab explicitly picked from the connect page's list is the user's;
        // the token/newTab bypass falls back to the connect page itself, which
        // the agent effectively created for this connection.
        const seedOwner: TabOwner = message.tab ? 'user' : 'agent';
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName, seedOwner).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections.entries()].map(([id, connection]) => ({
            id,
            clientName: connection.clientName,
            tabIds: connection.group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        try {
          if (message.connectionId !== undefined)
            this._disconnectOne(message.connectionId, 'User disconnected');
          else
            this._disconnectAll('User disconnected');
          sendResponse({ success: true });
        } catch (error: any) {
          sendResponse({ success: false, error: error.message });
        }
        return true;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: chrome.tabs.Tab & { id: number }, clientName: string | undefined, seedOwner: TabOwner): Promise<void> {
    try {
      await this._cleanupPromise;

      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');

      // eslint-disable-next-line no-console
      console.log('[PWDEBUG] _connectTab', { selectorTabId, tabId: tab.id, clientName, seedOwner, existingConnections: [...this._connections.keys()] });

      const title = this._reserveGroupTitle(clientName);
      const group = new ConnectedTabGroup(connection, tab, title, seedOwner);
      group.onclose = () => {
        // eslint-disable-next-line no-console
        console.log('[PWDEBUG] group.onclose', { selectorTabId, tabId: tab.id, clientName });
        if (this._connections.get(selectorTabId)?.group === group)
          this._connections.delete(selectorTabId);
      };
      this._connections.set(selectorTabId, { group, clientName, title });

      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true }),
      ]).catch(() => {});

      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error: any) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }

  // `Playwright · <clientName>`, deduped with a `(2)`, `(3)`... suffix against
  // other currently-open connections so simultaneous clients with the same
  // name (or none) still get visually distinct groups.
  private _reserveGroupTitle(clientName: string | undefined): string {
    const base = clientName ? `${PLAYWRIGHT_GROUP_TITLE} · ${clientName}` : PLAYWRIGHT_GROUP_TITLE;
    const taken = new Set([...this._connections.values()].map(c => c.title));
    let title = base;
    for (let n = 2; taken.has(title); n++)
      title = `${base} (${n})`;
    return title;
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }

  // Closes one connection's group, if it exists. ConnectedTabGroup's onclose
  // handles state cleanup (connectedTabIds, badges, reconcile).
  private _disconnectOne(selectorTabId: number, reason: string) {
    this._connections.get(selectorTabId)?.group.close(reason);
    this._connections.delete(selectorTabId);
  }

  private _disconnectAll(reason: string) {
    for (const connection of this._connections.values())
      connection.group.close(reason);
    this._connections.clear();
  }
}

new PlaywrightExtension();
