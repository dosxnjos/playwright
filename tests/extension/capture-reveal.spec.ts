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

// Fork-only (FORK.md § Foco zero, "Screenshot: reveal for capture"): the extension shows the hidden tab of a client for a
// capture only when nobody looks at its window, and puts the user's tab back. Headless keeps a `focused` flag per window
// that chrome.windows.update moves: it stands for "the user is in another app".

import { test, expect } from './harness';

import type { RelayPeer, User } from './harness';

// The relay's blank tab, and a tab of the user in the same window, in front.
async function setup(user: User, peer: RelayPeer): Promise<{ agentTab: number, userTab: number }> {
  const agentTab = peer.announcedTabIds()[0];
  const userTab = await user.chrome(async (chrome, tabOf, agentTab: number) => {
    const { windowId } = await chrome.tabs.get(agentTab);
    const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
    return tab.id;
  }, agentTab);
  return { agentTab, userTab };
}

async function setWindowFocus(user: User, tabId: number, focused: boolean) {
  await user.chrome(async (chrome, tabOf, tabId: number, focused: boolean) => {
    const { windowId } = await chrome.tabs.get(tabId);
    await chrome.windows.update(windowId, { focused });
  }, tabId, focused);
}

async function activeTabOf(user: User, tabId: number): Promise<number> {
  return await user.chrome(async (chrome, tabOf, tabId: number) => {
    const { windowId } = await chrome.tabs.get(tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId });
    return active.id;
  }, tabId);
}

test('window without focus: the tab of the client is shown for the capture, and the tab of the user comes back', async ({ user, connectRelay }) => {
  const peer = await connectRelay('agent');
  const { agentTab, userTab } = await setup(user, peer);
  await setWindowFocus(user, userTab, false);

  expect(await peer.send('extension.revealForCapture', agentTab)).toEqual({ result: { revealed: true } });
  expect(await activeTabOf(user, userTab)).toBe(agentTab);
  expect(await peer.send('extension.restoreAfterCapture', agentTab)).toEqual({ result: { restored: true } });
  expect(await activeTabOf(user, userTab)).toBe(userTab);
});

test('window with focus: nothing is shown', async ({ user, connectRelay }) => {
  const peer = await connectRelay('agent');
  const { agentTab, userTab } = await setup(user, peer);
  await setWindowFocus(user, userTab, true);

  expect(await peer.send('extension.revealForCapture', agentTab)).toEqual({ result: { revealed: false } });
  expect(await activeTabOf(user, userTab)).toBe(userTab);
  expect(await peer.send('extension.restoreAfterCapture', agentTab)).toEqual({ result: { restored: false } });
});

test('a client cannot show a tab that it does not own', async ({ user, connectRelay }) => {
  const peer = await connectRelay('agent');
  const { userTab } = await setup(user, peer);
  await setWindowFocus(user, userTab, false);

  expect(await peer.send('extension.revealForCapture', userTab)).toEqual({ error: `Tab ${userTab} is not owned by this client` });
  expect(await activeTabOf(user, userTab)).toBe(userTab);
});

test('a client that leaves during a revealed capture gives the tab of the user back', async ({ user, connectRelay }) => {
  const peer = await connectRelay('agent');
  const { agentTab, userTab } = await setup(user, peer);
  await setWindowFocus(user, userTab, false);

  expect(await peer.send('extension.revealForCapture', agentTab)).toEqual({ result: { revealed: true } });
  peer.close();
  await expect.poll(() => activeTabOf(user, userTab)).toBe(userTab);
});
