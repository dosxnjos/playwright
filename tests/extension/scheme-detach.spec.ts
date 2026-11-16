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

import fs from 'fs/promises';
import path from 'path';

import { test, expect } from './harness';

import type { User } from './harness';

type Detach = { source: { tabId?: number, frameId?: string }, reason: string };

// Records the debugger detach events that Chrome sends to the extension.
async function recordDebuggerDetach(user: User): Promise<() => Promise<Detach[]>> {
  await user.chrome(async chrome => {
    const detaches: object[] = (globalThis as any).__detaches = [];
    chrome.debugger.onDetach.addListener((source: object, reason: string) => detaches.push({ source, reason }));
  });
  return () => user.chrome(async () => (globalThis as any).__detaches);
}

// Chrome detaches the debugger from the tab when one of its frames goes to a scheme that Chrome does not know.
async function addFrameWithUnknownScheme(user: User, title: string): Promise<void> {
  await user.pageOf(title).evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.src = 'customscheme://cc/';
    document.body.appendChild(iframe);
  }).catch(() => {});
}

// An extension that adds its own frame to the page "Framed". Chrome does not let other extensions debug such a frame.
const testWithFrameInjector = test.extend({
  extraExtensions: async ({}, use, testInfo) => {
    const injector = testInfo.outputPath('frame-injector');
    await fs.mkdir(injector);
    await fs.writeFile(path.join(injector, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Frame injector',
      version: '1.0',
      content_scripts: [{ matches: ['http://*/*'], js: ['content.js'], run_at: 'document_idle' }],
      web_accessible_resources: [{ resources: ['frame.html'], matches: ['<all_urls>'] }],
    }));
    await fs.writeFile(path.join(injector, 'content.js'), `
      if (location.pathname === '/Framed') {
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('frame.html');
        document.documentElement.appendChild(frame);
      }
    `);
    await fs.writeFile(path.join(injector, 'frame.html'), '<!DOCTYPE html><title>Foreign frame</title>');
    await use([injector]);
  },
});

test('frame with an unknown scheme detaches the debugger from the tab, and the tab stays open', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/42089' },
}, async ({ user, connectWithToken }) => {
  const client = await connectWithToken('worker');
  await client.navigate('SignIn');
  const detaches = await recordDebuggerDetach(user);

  await addFrameWithUnknownScheme(user, 'SignIn');

  // The detach is for the tab, not for the frame.
  await expect.poll(detaches).toEqual([{ source: { tabId: await user.tabId('SignIn') }, reason: 'target_closed' }]);
  expect(await user.tabs()).toContain('SignIn');
});

test('client controls the tab again after a frame with an unknown scheme detaches the debugger', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/42089' },
}, async ({ user, connectWithToken }) => {
  const client = await connectWithToken('worker');
  await client.navigate('SignIn');
  const detaches = await recordDebuggerDetach(user);

  await addFrameWithUnknownScheme(user, 'SignIn');
  await expect.poll(detaches).toHaveLength(1);

  await client.expectControls('SignIn');
  expect(await client.mcp.callTool({ name: 'browser_take_screenshot', arguments: {} })).toHaveResponse({
    code: expect.stringContaining('page.screenshot'),
  });
});

// Fork: Chrome's PDF viewer is the frame of an extension too. Seen on 15/11/2026: a click that showed a PDF in an iframe
// closed the page of the agent; the tab came back at the end of the list and another tab was current.
test('tab detached by a PDF frame comes back current, at its place', async ({ user, connectWithToken, server }) => {
  const client = await connectWithToken('worker');
  await client.navigate('Alpha');
  await client.openTab('Origin');
  await client.openTab('Beta');
  await client.selectTab('Origin');
  const detaches = await recordDebuggerDetach(user);

  await user.pageOf('Origin').evaluate(src => {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    document.body.appendChild(iframe);
  }, server.PREFIX + '/empty.pdf');
  await expect.poll(detaches).toEqual([{ source: { tabId: await user.tabId('Origin') }, reason: 'target_closed' }]);

  await expect.poll(client.tabs).toEqual(['Alpha', 'Origin', 'Beta']);
  expect(await client.currentTab()).toBe('Origin');
  expect(await client.snapshot()).toContain('Page Origin');
});

// Holds the extension's announce of a detached tab (it reads the tab first) until releaseAnnounce().
async function holdAnnounce(user: User, title: string): Promise<void> {
  await user.chrome(async (chrome, tabOf, title: string) => {
    const tabId = (await tabOf(title)).id;
    const get = (globalThis as any).__get ??= chrome.tabs.get;
    (globalThis as any).__held = true;
    chrome.tabs.get = async (id: number) => {
      while (id === tabId && (globalThis as any).__held)
        await new Promise(resolve => setTimeout(resolve, 20));
      return await get.call(chrome.tabs, id);
    };
  }, title);
}

async function releaseAnnounce(user: User): Promise<void> {
  await user.chrome(async () => (globalThis as any).__held = false);
}

async function addPdfFrame(user: User, title: string, src: string): Promise<void> {
  await user.pageOf(title).evaluate(src => {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    document.body.appendChild(iframe);
  }, src);
}

// Fork: the agent picked a tab while the detached one was away; when it comes back it must not take the pick over.
// A blank tab that a call opened because no tab was left is not a pick.
test('tab detached by a PDF frame does not come back current after the agent selected or opened a tab', async ({ user, connectWithToken, server }) => {
  const pdf = server.PREFIX + '/empty.pdf';
  // The context waits 3 s for a detached tab: a pick made later proves nothing.
  const pickInTime = (lostAt: number) => expect(Date.now() - lostAt, 'pick made within the 3 s wait').toBeLessThan(2500);
  const client = await connectWithToken('worker');
  await client.navigate('Alpha');
  await client.openTab('Origin');
  await client.openTab('Beta');
  await client.selectTab('Origin');
  const detaches = await recordDebuggerDetach(user);

  await holdAnnounce(user, 'Origin');
  await addPdfFrame(user, 'Origin', pdf);
  await expect.poll(async () => (await detaches()).length).toBe(1);
  let lostAt = Date.now();
  await expect.poll(client.tabs).toEqual(['Alpha', 'Beta']);
  await client.selectTab('Alpha');
  pickInTime(lostAt);
  await releaseAnnounce(user);
  await expect.poll(client.tabs).toEqual(['Alpha', 'Beta', 'Origin']);
  expect(await client.currentTab()).toBe('Alpha');

  await client.selectTab('Beta');
  await holdAnnounce(user, 'Beta');
  await addPdfFrame(user, 'Beta', pdf);
  await expect.poll(async () => (await detaches()).length).toBe(2);
  lostAt = Date.now();
  await expect.poll(client.tabs).toEqual(['Alpha', 'Origin']);
  await client.openTab('Gamma');
  pickInTime(lostAt);
  await releaseAnnounce(user);
  await expect.poll(client.tabs).toEqual(['Alpha', 'Origin', 'Gamma', 'Beta']);
  expect(await client.currentTab()).toBe('Gamma');

  // The only tab of a client detaches: the next call opens a blank tab, and the detached tab still comes back current.
  const lone = await connectWithToken('lone');
  await lone.navigate('Lone');
  await holdAnnounce(user, 'Lone');
  await addPdfFrame(user, 'Lone', pdf);
  await expect.poll(async () => (await detaches()).length).toBe(3);
  await expect.poll(lone.tabs).toEqual(['']);
  await releaseAnnounce(user);
  await expect.poll(lone.tabs).toEqual(['Lone', '']);
  expect(await lone.currentTab()).toBe('Lone');
});

testWithFrameInjector('client reports an error when the frame of another extension detaches the debugger', {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/43230' },
}, async ({ user, connectWithToken }) => {
  const client = await connectWithToken('worker');
  const detaches = await recordDebuggerDetach(user);

  const response = await client.mcp.callTool({ name: 'browser_navigate', arguments: { url: user.urlOf('Framed') } });
  expect(response).toHaveResponse({
    isError: true,
    error: expect.stringContaining('frame that extensions are not allowed to debug'),
  });
  expect(JSON.stringify(response)).not.toContain('TypeError');
  await expect.poll(detaches).toContainEqual(expect.objectContaining({ reason: 'target_closed' }));

  // The client works after the error.
  await client.navigate('Alpha');
  expect(await client.snapshot()).toContain('Page Alpha');
});
