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

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TabItem  } from './tabItem';
import { AuthTokenSection } from './authToken';

type ConnectionInfo = { id: number, clientName?: string, tabIds: number[] };
type ConnectionView = { info: ConnectionInfo, tabs: chrome.tabs.Tab[] };

const StatusApp: React.FC = () => {
  const [connections, setConnections] = useState<ConnectionView[]>([]);

  useEffect(() => {
    void loadStatus();
  }, []);

  // Returns the freshly loaded connections so callers (e.g. disconnect) can
  // decide whether anything is left without a stale-closure re-read of state.
  const loadStatus = async (): Promise<ConnectionView[]> => {
    const { connections } = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' }) as { connections: ConnectionInfo[] };
    const withTabs = await Promise.all((connections ?? []).map(async info => ({
      info,
      tabs: await Promise.all(info.tabIds.map(tabId => chrome.tabs.get(tabId))),
    })));
    setConnections(withTabs);
    return withTabs;
  };

  const openTab = async (tabId: number) => {
    await chrome.tabs.update(tabId, { active: true });
    window.close();
  };

  // Disconnecting the last remaining connection closes the window, matching
  // the previous single-connection behavior; disconnecting one of several
  // just refreshes the list so the others stay visible.
  const disconnect = async (connectionId: number) => {
    await chrome.runtime.sendMessage({ type: 'disconnect', connectionId });
    const remaining = await loadStatus();
    if (remaining.length === 0)
      window.close();
  };

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {connections.length > 0 ? (
          connections.map(({ info, tabs }) => (
            <div key={info.id} className='connection-section'>
              <div className='connection-header'>
                <div className='client-info'>
                  Connected to <strong>"{info.clientName || 'unknown'}"</strong>
                </div>
                <Button variant='primary' onClick={() => disconnect(info.id)}>
                  Disconnect
                </Button>
              </div>
              <div className='tab-section-title'>
                {tabs.length === 1 ? 'Accessible page:' : 'Accessible pages:'}
              </div>
              <div>
                {tabs.map(tab => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    onClick={() => openTab(tab.id!)}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className='status-banner'>
            No clients are currently connected. You can connect from the Playwright CLI or MCP server by passing the --extension flag.
          </div>
        )}
        <AuthTokenSection />
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<StatusApp />);
}
