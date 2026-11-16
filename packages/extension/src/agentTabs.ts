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

// Fork-only (FORK.md, patch 3). A tab that a client created (its blank tab, `chrome.tabs.create`, a popup of one of its
// tabs) is the agent's: it is closed when the client leaves, so that a day of agents does not leave gray groups behind.
// A tab that the user gave (picked on the connect page, a group taken over, dragged in) only goes free, as upstream does.
//
// A service worker that dies (idle, crash) takes the sessions with it and no close runs. So the agent tabs are also
// recorded in chrome.storage.session, and the next worker closes them. That store dies with the browser session (a
// tab id reused after a restart is never taken for an agent's) and is wiped when the extension is reloaded, updated
// or disabled: then the next worker finds no record and the tabs only go free (gray group), as upstream does.

const STORAGE_KEY = 'playwrightAgentTabs';
// The cleanup of a dead worker's tabs must never hold a new connection for long (fork, 11/11/2026).
export const AGENT_TAB_CLEANUP_CAP_MS = 3000;

const record = new Set<number>();
// Writes are chained so the store always ends with the latest set, and they start after the previous record was read.
let writes: Promise<unknown> = Promise.resolve();

export function recordAgentTab(tabId: number): void {
  if (record.has(tabId))
    return;
  record.add(tabId);
  persist();
}

export function forgetAgentTabs(tabIds: Iterable<number>): void {
  let changed = false;
  for (const tabId of tabIds)
    changed = record.delete(tabId) || changed;
  if (changed)
    persist();
}

function persist(): void {
  const tabIds = [...record];
  writes = writes.then(() => chrome.storage.session.set({ [STORAGE_KEY]: tabIds })).catch(() => {});
}

// The longest wait for one agent tab to close (fork, 15/11/2026): a dialog nobody answers must not hold the rest of the
// client's leave (releaseAll, the gray group of the user's tabs) or a browser_tabs close forever. It covers every step
// of the close, the dismiss of an open dialog included; the tabs close side by side, so a leave waits 5 s at most.
export const AGENT_TAB_CLOSE_CAP_MS = 5000;

// The type of the JavaScript dialog open on each tab ('alert', 'confirm', 'prompt', 'beforeunload'), as the debugger
// reported it. CDP has no way to ask for it, so it is read from the events (tabRegistry.ts feeds them). Only a debugger
// with the Page domain on hears of a dialog; the client's usually is.
const openDialogs = new Map<number, string>();

export function noteDebuggerEvent(tabId: number | undefined, method: string, params?: object): void {
  if (tabId === undefined)
    return;
  if (method === 'Page.javascriptDialogOpening')
    openDialogs.set(tabId, String((params as { type?: string } | undefined)?.type));
  else if (method === 'Page.javascriptDialogClosed')
    openDialogs.delete(tabId);
}

// The tab is gone or its debugger detached: what it heard no longer holds.
export function forgetOpenDialog(tabId: number | undefined): void {
  if (tabId !== undefined)
    openDialogs.delete(tabId);
}

// A "Leave site?" dialog is open on the tab, so a navigation of the agent waits on it.
export function hasBeforeUnloadDialog(tabId: number): boolean {
  return openDialogs.get(tabId) === 'beforeunload';
}

// One by one: a batch remove aborts on the first tab that is gone, and every other tab would survive.
export async function closeTabs(tabIds: number[]): Promise<void> {
  await Promise.allSettled(tabIds.map(closeTabWithoutBeforeUnload));
}

// Fork (15/11/2026): chrome.tabs.remove runs the page's beforeunload. A page that saw a click and has a beforeunload
// handler then asks "Leave site?": the tab stays open with the dialog up and the remove never settles (measured,
// tests/extension/tab-ownership.spec.ts). An agent tab closes the way Playwright's page.close() closes one
// (runBeforeUnload: false), through the debugger while it is still attached: a "Leave site?" dialog already open is
// dismissed first (a navigation of the agent that waits on it stays on its page), then the beforeunload dialog of the
// close is accepted. Only on a close: on a navigation the agent answers with browser_handle_dialog. An alert, confirm
// or prompt is never answered here (15/11/2026 review): Chrome drops it with the tab. A tab without the debugger
// (a dead worker's) gets the plain remove, so its dialog stays for the user to answer.
async function closeTabWithoutBeforeUnload(tabId: number): Promise<void> {
  const target = { tabId };
  const acceptBeforeUnload = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId === tabId && method === 'Page.javascriptDialogOpening' && (params as { type?: string } | undefined)?.type === 'beforeunload')
      chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  };
  chrome.debugger.onEvent.addListener(acceptBeforeUnload);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cap = new Promise<void>(resolve => timer = setTimeout(resolve, AGENT_TAB_CLOSE_CAP_MS));
    const close = async () => {
      await dismissOpenDialog(tabId);
      // The beforeunload dialog of the close only reaches a debugger with the Page domain on (the client's usually is).
      // Never sent while a dialog is open: the page cannot answer it then, and the call hangs (measured 15/11/2026).
      if (!openDialogs.has(tabId))
        await chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {});
      await retryOnDrag(() => chrome.tabs.remove(tabId));
      forgetOpenDialog(tabId);
    };
    await Promise.race([close(), cap]);
  } finally {
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(acceptBeforeUnload);
  }
}

// Dismisses the "Leave site?" dialog open on the tab, through the debugger. True if it did. Never another type of
// dialog: an alert, confirm or prompt may be what the user is reading. False at once without such a dialog or without
// the debugger.
async function dismissOpenDialog(tabId: number): Promise<boolean> {
  if (!hasBeforeUnloadDialog(tabId))
    return false;
  const dismissed = await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: false }).then(() => true, () => false);
  if (dismissed)
    openDialogs.delete(tabId);
  return dismissed;
}

// Runs once per service worker start: the recorded tabs belong to clients of a dead worker. A tab that is the active
// tab of a focused window is never closed, only let go: the user may be typing in it (a 2FA code the agent asked for).
// A failed window query counts as focused.
export async function closeAgentTabsOfPreviousServiceWorker(): Promise<void> {
  const read = chrome.storage.session.get(STORAGE_KEY).then(stored => stored[STORAGE_KEY], () => undefined);
  writes = read;
  const stored = await read;
  const tabIds = Array.isArray(stored) ? stored.filter((id): id is number => typeof id === 'number') : [];
  // This worker's clients start a new record.
  persist();
  if (!tabIds.length)
    return;
  const inFront = await tabsInFrontOfUser(tabIds);
  await closeTabs(tabIds.filter(tabId => !inFront.has(tabId)));
}

// The tabs that are the active tab of a focused window: the user may be typing in them (a 2FA code the agent asked for).
// A failed window query counts as focused. A tab that is gone is not in front.
export async function tabsInFrontOfUser(tabIds: number[]): Promise<Set<number>> {
  const tabs = (await Promise.all(tabIds.map(tabId => chrome.tabs.get(tabId).catch(() => undefined)))).filter(tab => !!tab);
  let focused: (windowId: number) => boolean;
  try {
    const windows = new Set((await chrome.windows.getAll()).filter(w => w.focused).map(w => w.id));
    focused = windowId => windows.has(windowId);
  } catch {
    focused = () => true;
  }
  return new Set(tabs.filter(tab => tab.active && focused(tab.windowId)).map(tab => tab.id!));
}

// Chrome refuses tab changes while the user drags a tab.
async function retryOnDrag<T>(action: () => Promise<T>): Promise<T> {
  for (const delay of [100, 200, 400, 800]) {
    try {
      return await action();
    } catch (error: any) {
      if (!error?.message?.includes('user may be dragging a tab'))
        throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return await action();
}
