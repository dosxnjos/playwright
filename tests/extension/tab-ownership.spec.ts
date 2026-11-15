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

// Fork-only (FORK.md, patch 3): the tabs that a client created close when it leaves; the tabs of the user go free.
// The harness keeps them for upstream's specs (PLAYWRIGHT_MCP_AGENT_TABS=keep); these specs run the fork's default.

import { test, expect } from './harness';

const close = { env: { PLAYWRIGHT_MCP_AGENT_TABS: 'close' } };
const sorted = (tabs: () => Promise<string[]>) => async () => (await tabs()).sort();

test('tabs that the client opened close when it leaves, the tab that the user picked stays', async ({ user, connect }) => {
  user.definePage('Opener', `<button onclick="window.open('${user.urlOf('Opened')}', '_blank', 'noopener')">open</button>`);
  await user.openTab('Alpha');
  const client = await connect('worker', { tabs: ['Alpha'] }, close);
  await client.openTab('Opener');
  await client.click('e2');
  await expect.poll(sorted(client.tabs)).toEqual(['Alpha', 'Opened', 'Opener']);
  // The user looks at the tab they gave, not at a tab of the agent (that one would stay, see below).
  await user.pageOf('Alpha').bringToFront();

  await client.close();
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · worker', color: 'grey', tabs: ['Alpha'] }]);
  expect(await user.tabs()).not.toContain('Opener');
  expect(await user.tabs()).not.toContain('Opened');
});

test('blank tab of a client with the token closes when it leaves, and leaves no group', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent', close);
  await client.navigate('Alpha');
  await client.openTab('Beta');
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · agent', color: 'green', tabs: ['Alpha', 'Beta'] }]);

  await client.close();
  await expect.poll(user.groups).toEqual([]);
  expect(await user.tabs()).not.toContain('Alpha');
  expect(await user.tabs()).not.toContain('Beta');
});

test('tab that the user dragged into the group stays, and goes free', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent', close);
  await client.navigate('Alpha');
  await user.openTab('Beta');
  await user.dragIntoGroupOf('Beta', 'Alpha');
  await expect.poll(sorted(client.tabs)).toEqual(['Alpha', 'Beta']);

  await client.close();
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · agent', color: 'grey', tabs: ['Beta'] }]);
  expect(await user.tabs()).not.toContain('Alpha');
});

test('tab of a client that the user moved to another client belongs to the user there', async ({ user, connectWithToken }) => {
  const first = await connectWithToken('first', close);
  await first.navigate('Alpha');
  const second = await connectWithToken('second', close);
  await second.navigate('Beta');

  await user.dragIntoGroupOf('Alpha', 'Beta');
  await expect.poll(sorted(second.tabs)).toEqual(['Alpha', 'Beta']);
  await first.close();
  expect(await user.tabs()).toContain('Alpha');

  await second.close();
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · second', color: 'grey', tabs: ['Alpha'] }]);
});

test('agent tab in front of the user stays when the client leaves, and a popup of a user tab is the user\'s', async ({ user, connect }) => {
  user.definePage('Alpha', `<button onclick="window.open('${user.urlOf('Opened')}', '_blank', 'noopener')">open</button>`);
  await user.openTab('Alpha');
  const client = await connect('worker', { tabs: ['Alpha'] }, close);
  await client.selectTab('Alpha');
  expect(await client.snapshot()).toContain('button "open" [ref=e2]');
  await client.click('e2');
  await expect.poll(sorted(client.tabs)).toEqual(['Alpha', 'Opened']);
  await client.openTab('Beta');
  await expect.poll(sorted(client.tabs)).toEqual(['Alpha', 'Beta', 'Opened']);
  await user.chrome(async (chrome, tabOf) => {
    const beta = await tabOf('Beta');
    await chrome.tabs.update(beta.id, { active: true });
    await chrome.windows.update(beta.windowId, { focused: true });
  });

  await client.close();
  await expect.poll(user.connectedClients).toEqual([]);
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · worker', color: 'grey', tabs: ['Alpha', 'Beta', 'Opened'] }]);
});

test('agent tab whose page asks "Leave site?" closes without the dialog: on browser_tabs close, on leave, and with a dialog already open', async ({ user, connectWithToken }) => {
  // The harness's own Playwright connection accepts every beforeunload dialog when nothing listens to it, and so hides
  // the bug. A listener that does nothing leaves the dialogs to the extension, as in the Chrome of a person.
  user.browserContext.on('dialog', () => {});
  // A page that saw a click and has a beforeunload handler asks before it goes, also when its tab is closed.
  for (const title of ['Asks', 'AsksOnLeave', 'AsksWhileOpen'])
    user.definePage(title, `<button>Click me</button><script>window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });</script>`);
  const client = await connectWithToken('agent', close);
  await client.navigate('Alpha');
  for (const title of ['Asks', 'AsksOnLeave', 'AsksWhileOpen']) {
    await client.openTab(title);
    await client.selectTab(title);
    await client.click('e2');
  }

  // browser_tabs close (Target.closeTarget, i.e. chrome.tabs.remove) used to hang with the dialog up.
  await client.closeTab('Asks');
  await expect.poll(() => user.tabs()).not.toContain('Asks');

  // A navigation of the agent waits on the dialog: the dialog is dismissed (the page stays) and the tab closes.
  await client.selectTab('AsksWhileOpen');
  expect(await client.runCode(`async page => { await page.goto('${user.urlOf('Beta')}'); }`)).toContain('"beforeunload" dialog');

  await client.close();
  await expect.poll(user.groups).toEqual([]);
  expect(await user.tabs()).not.toContain('AsksOnLeave');
  expect(await user.tabs()).not.toContain('AsksWhileOpen');
  expect(await user.tabs()).not.toContain('Beta');
});

test('PLAYWRIGHT_MCP_AGENT_TABS=keep keeps the tabs of the client in a gray group, as upstream', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent', { env: { PLAYWRIGHT_MCP_AGENT_TABS: 'keep' } });
  await client.navigate('Alpha');

  await client.close();
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · agent', color: 'grey', tabs: ['Alpha'] }]);
});

test('agent tabs of a dead service worker close, unless the user looks at it', async ({ user, connectWithToken }) => {
  const client = await connectWithToken('agent', { env: { PLAYWRIGHT_MCP_AGENT_TABS: 'close', PLAYWRIGHT_MCP_FOCUS: 'on' } });
  await client.navigate('Alpha');
  await client.openTab('Beta');
  await user.openTab('Gamma');
  await user.dragIntoGroupOf('Gamma', 'Alpha');
  // Alpha is the tab in front, in the focused window: the user may be typing in it.
  await user.chrome(async (chrome, tabOf) => {
    const alpha = await tabOf('Alpha');
    await chrome.tabs.update(alpha.id, { active: true });
    await chrome.windows.update(alpha.windowId, { focused: true });
  });

  // Stop the worker and start the next one without a new active tab (user.stopExtensionWorker() opens one): close its
  // target, then open a background tab, an event that starts the worker.
  const cdp = await user.browserContext.newCDPSession(user.pageOf('Gamma'));
  const isWorker = (target: { type: string, url: string }) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://');
  const worker = (await cdp.send('Target.getTargets')).targetInfos.find(isWorker)!;
  await expect.poll(async () => {
    await cdp.send('Target.closeTarget', { targetId: worker.targetId }).catch(() => {});
    return (await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === worker.targetId);
  }).toBe(false);
  await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
  await expect.poll(() => user.tabs()).not.toContain('Beta');
  expect(await user.tabs()).toContain('Alpha');
  expect(await user.tabs()).toContain('Gamma');
  await expect.poll(user.groups).toEqual([{ title: 'Playwright · agent', color: 'grey', tabs: ['Alpha', 'Gamma'] }]);
});
