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

// Fork-only (patch 6): one browser backend per calling agent, keyed by arguments._meta.agente.
// The persistent mode does not route (a second backend fails with "use --isolated"), so the
// routed cases run with --isolated. See FORK.md § Agent routing.

import { EventEmitter } from 'events';

import { test, expect, parseResponse } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

type Args = Record<string, unknown>;

const as = (client: Client, agente: string | undefined, name: string, args: Args = {}) =>
  client.callTool({ name, arguments: agente === undefined ? args : { ...args, _meta: { agente } } });

async function tabs(client: Client, agente: string | undefined): Promise<string> {
  const response = await as(client, agente, 'browser_tabs', { action: 'list' });
  expect(response.isError).toBeFalsy();
  return parseResponse(response as any)?.result ?? '';
}

async function pageUrl(client: Client, agente: string | undefined): Promise<string | undefined> {
  const response = await as(client, agente, 'browser_snapshot');
  expect(response.isError).toBeFalsy();
  return parseResponse(response as any)?.page?.match(/Page URL: (\S+)/)?.[1];
}

// --isolated: every routed backend is one context on the browser they share, so main can count them.
async function contextCount(client: Client): Promise<number> {
  const response = await as(client, 'main', 'browser_run_code_unsafe', { code: 'async page => page.context().browser().contexts().length' });
  expect(response.isError).toBeFalsy();
  return Number(parseResponse(response as any)?.result?.match(/\d+/)?.[0]);
}

test('main and a sub-agent keep their own current tab', async ({ startClient, server }) => {
  const { client, stderr } = await startClient({ args: ['--isolated'], env: { DEBUG: 'pw:mcp:router' } });
  // A no-op without --extension, but the router still names the agents' groups after main's label.
  expect((await as(client, 'main', 'browser_set_group_label', { label: 'mae' })).isError).toBeFalsy();
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  await as(client, 'a1', 'browser_navigate', { url: server.HELLO_WORLD + '#a1' });
  expect(stderr()).toContain('create key=a1 clientName=mae · agente-a1');
  expect((await as(client, 'a1', 'browser_tabs', { action: 'new', url: server.HELLO_WORLD + '#a1-2' })).isError).toBeFalsy();

  expect(await pageUrl(client, 'main')).toBe(server.HELLO_WORLD + '#main');
  const mainTabs = await tabs(client, 'main');
  expect(mainTabs).toContain('#main');
  expect(mainTabs).not.toContain('#a1');

  expect(await pageUrl(client, 'a1')).toBe(server.HELLO_WORLD + '#a1-2');
  const agentTabs = await tabs(client, 'a1');
  expect(agentTabs).toContain('#a1)');
  expect(agentTabs).toContain('#a1-2)');
  expect(agentTabs).not.toContain('#main');
});

test('browser_close of a sub-agent leaves main alone and the agent starts clean', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'] });
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  await as(client, 'a1', 'browser_navigate', { url: server.HELLO_WORLD + '#a1' });

  const closed = await as(client, 'a1', 'browser_close');
  expect(closed.isError).toBeFalsy();

  expect(await pageUrl(client, 'main')).toBe(server.HELLO_WORLD + '#main');
  const agentTabs = await tabs(client, 'a1');
  expect(agentTabs).not.toContain(server.PREFIX);
});

test('a call without _meta is the main agent', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'] });
  await as(client, undefined, 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  expect(await tabs(client, 'main')).toContain('#main');
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main-2' });
  expect(await pageUrl(client, undefined)).toBe(server.HELLO_WORLD + '#main-2');
});

test('two parallel first calls of the same agent share one backend', async ({ startClient, server }) => {
  const { client, stderr } = await startClient({ args: ['--isolated'], env: { DEBUG: 'pw:mcp:router' } });
  const [x, y] = await Promise.all([
    as(client, 'a2', 'browser_tabs', { action: 'new', url: server.HELLO_WORLD + '#x' }),
    as(client, 'a2', 'browser_tabs', { action: 'new', url: server.HELLO_WORLD + '#y' }),
  ]);
  expect(x.isError).toBeFalsy();
  expect(y.isError).toBeFalsy();
  const agentTabs = await tabs(client, 'a2');
  expect(agentTabs).toContain('#x)');
  expect(agentTabs).toContain('#y)');
  expect(stderr().match(/create key=a2 /g)).toHaveLength(1);
});

test('persistent mode does not route: every agent shares the browser, without errors', async ({ startClient, server }) => {
  const { client } = await startClient();
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  expect(await tabs(client, 'a1')).toContain('#main');
});

test('PLAYWRIGHT_MCP_AGENT_ROUTING=off turns routing off', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'], env: { PLAYWRIGHT_MCP_AGENT_ROUTING: 'off' } });
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  expect(await tabs(client, 'a1')).toContain('#main');
});

test('an idle sub-agent loses its browser, main never does', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'], env: { PLAYWRIGHT_MCP_AGENT_IDLE_MS: '1000' } });
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  await as(client, 'a1', 'browser_navigate', { url: server.HELLO_WORLD + '#a1' });
  expect(await tabs(client, 'a1')).toContain('#a1');
  // a1's idle timer runs from its last call; main's calls never touch it.
  expect(await contextCount(client)).toBe(2);

  await new Promise(f => setTimeout(f, 2500));

  // The idle backend is disposed, not only forgotten: its context is gone (checked before a1 calls again).
  await expect.poll(() => contextCount(client), { timeout: 10_000 }).toBe(1);
  expect(await tabs(client, 'a1')).not.toContain(server.PREFIX);
  expect(await tabs(client, 'main')).toContain('#main');
});

test('a sub-agent whose browser disconnects does not take main down', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'] });
  await as(client, 'main', 'browser_navigate', { url: server.HELLO_WORLD + '#main' });
  await as(client, 'a3', 'browser_navigate', { url: server.HELLO_WORLD + '#a3' });

  // Closing the context fires the backend's 'disconnected' without browser_close.
  await as(client, 'a3', 'browser_run_code_unsafe', { code: 'async page => { await page.context().close(); }' });

  expect(await pageUrl(client, 'main')).toBe(server.HELLO_WORLD + '#main');
  expect(await tabs(client, 'a3')).not.toContain(server.PREFIX);
  await as(client, 'a4', 'browser_navigate', { url: server.HELLO_WORLD + '#a4' });
  expect(await tabs(client, 'a4')).toContain('#a4');
  expect(await tabs(client, 'main')).not.toContain('#a4');
});

test('a sub-agent never goes idle while one of its calls is in flight', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--isolated'], env: { PLAYWRIGHT_MCP_AGENT_IDLE_MS: '500' } });
  await as(client, 'a1', 'browser_navigate', { url: server.HELLO_WORLD + '#a1' });
  const long = as(client, 'a1', 'browser_run_code_unsafe', { code: 'async page => { await page.waitForTimeout(2500); return page.url(); }' });
  await new Promise(f => setTimeout(f, 200));
  // A short call ends while the long one runs: it must not arm the idle timer.
  expect((await as(client, 'a1', 'browser_tabs', { action: 'list' })).isError).toBeFalsy();

  const result = await long;
  expect(result.isError).toBeFalsy();
  expect(parseResponse(result as any)?.result).toContain('#a1');
});

test('browser_close drops the caller even when its backend never reports disconnected', async () => {
  // Extension mode may not emit 'disconnected' after browser_close; a fake backend that never does stands for it.
  const created: string[] = [];
  let disposed = 0;
  class FakeBackend extends EventEmitter {
    async callTool(name: string, args: Args) {
      return { content: [{ type: 'text' as const, text: name }], isError: !!args.fail };
    }
    async dispose() {
      disposed++;
    }
  }
  const factory = {
    name: 'fake', nameInConfig: 'fake', version: '0', toolSchemas: [],
    create: async (clientInfo: { clientName: string }) => {
      created.push(clientInfo.clientName);
      return new FakeBackend();
    },
  };
  const clientInfo = { cwd: process.cwd(), clientName: 'test' };
  const router = await tools.withAgentRouting(factory as any, { browser: { isolated: true } } as any).create(clientInfo);
  await router.initialize?.(clientInfo);
  const signal = new AbortController().signal;
  const call = (name: string, args: Args = {}) => router.callTool(name, { ...args, _meta: { agente: 'a1' } }, signal);

  try {
    await call('browser_navigate');
    expect(created).toHaveLength(1);

    expect((await call('browser_close')).isError).toBeFalsy();
    await call('browser_navigate');
    expect(created).toHaveLength(2);
    // The closed backend disposes itself (browserBackend.ts); the router only forgets it.
    expect(disposed).toBe(0);

    // A failed close keeps the caller's backend.
    expect((await call('browser_close', { fail: true })).isError).toBeTruthy();
    await call('browser_navigate');
    expect(created).toHaveLength(2);
  } finally {
    await router.dispose?.();
  }
});
