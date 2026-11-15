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

// Fork-only (patch 9): browser_use_profile, the conversation picks a Chrome profile of the token vault at run time
// (roadmap/2026-11-15-perfil-por-conversa.md). The router cases use a fake backend factory and read the profile each
// backend was created with; one case runs a real server against a stub browser to see the token and the profile
// folder reach the connect page. The tokens here are dummies; none may show in a response, a description or a log.

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { test, expect, parseResponse } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

type Args = Record<string, unknown>;

const vault = {
  PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'dummy-padrao',
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 13',
  PLAYWRIGHT_MCP_EXTENSION_TOKEN__padrao: 'dummy-padrao',
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME__padrao: 'Profile 13',
  PLAYWRIGHT_MCP_EXTENSION_TOKEN__jacira: 'dummy-jacira',
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME__jacira: 'Profile 6',
  // Unusable, it has no profile folder.
  PLAYWRIGHT_MCP_EXTENSION_TOKEN__semperfil: 'dummy-semperfil',
  // Unusable, it has no extension token.
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME__semtoken: 'Profile 9',
};
const dummies = ['dummy-padrao', 'dummy-jacira', 'dummy-semperfil'];

function expectNoToken(text: string) {
  for (const dummy of dummies)
    expect(text).not.toContain(dummy);
}

const textOf = (result: { content?: unknown }) => JSON.stringify(result.content);

type Created = { clientName: string, background: boolean, profile?: { variant: string, profileDirName: string } };

async function startRouter(config: object, env: Args = vault, connecting?: Promise<void>) {
  const created: Created[] = [];
  let disposed = 0;
  class FakeBackend extends EventEmitter {
    constructor(readonly profile: string | undefined) {
      super();
    }
    async callTool(name: string) {
      return { content: [{ type: 'text' as const, text: name }] };
    }
    dynamicTools() {
      return [{ name: `page_tool_of_${this.profile ?? 'env'}` }];
    }
    async dispose() {
      disposed++;
    }
  }
  const factory = {
    name: 'fake', nameInConfig: 'fake', version: '0',
    toolSchemas: tools.filteredTools({ capabilities: [] }).map(tool => tool.schema),
    create: async (clientInfo: { clientName: string }) => {
      const store = tools.relayScope.getStore();
      const profile = store?.profile ? { variant: store.profile.variant, profileDirName: store.profile.profileDirName } : undefined;
      created.push({ clientName: clientInfo.clientName, background: !!store?.background, profile });
      // The first backend may stay connecting until the test lets it go.
      if (created.length === 1)
        await connecting;
      return new FakeBackend(profile?.variant);
    },
  };
  const clientInfo = { cwd: process.cwd(), clientName: 'test' };
  // Never the real Chrome's Local State nor the user's alias file: missing ones unless the test names them.
  const routerEnv = {
    PWTEST_EXTENSION_USER_DATA_DIR: test.info().outputPath('no-chrome'),
    PLAYWRIGHT_MCP_PROFILE_ALIASES: test.info().outputPath('no-aliases.json'),
    ...env,
  } as NodeJS.ProcessEnv;
  const routed = tools.withAgentRouting(factory as any, config as any, routerEnv);
  const router = await routed.create(clientInfo);
  await router.initialize?.(clientInfo);
  const signal = new AbortController().signal;
  const call = (agente: string, name: string, args: Args = {}) => router.callTool(name, { ...args, _meta: { agente } }, signal);
  return { routed, router, call, created, disposed: () => disposed };
}

const extensionConfig = { extension: true, browser: {} };

test('a switch before the first browser call opens no browser, and every agent then uses the chosen profile', async () => {
  const { router, call, created, disposed } = await startRouter(extensionConfig);
  try {
    const result = await call('main', 'browser_use_profile', { profile: 'jacira' });
    expect(result.isError).toBeFalsy();
    expect(parseResponse(result as any)?.result).toContain('Now using profile jacira (folder "Profile 6"). No browser was open.');
    expectNoToken(textOf(result));
    expect(created).toHaveLength(0);

    await call('main', 'browser_navigate');
    await call('a1', 'browser_navigate');
    expect(created).toEqual([
      { clientName: 'test', background: false, profile: { variant: 'jacira', profileDirName: 'Profile 6' } },
      { clientName: 'test · agente-a1', background: true, profile: { variant: 'jacira', profileDirName: 'Profile 6' } },
    ]);
    expect(disposed()).toBe(0);
  } finally {
    await router.dispose?.();
  }
});

test('a switch closes the backends of every agent, and the next calls reopen them in the new profile', async () => {
  const { router, call, created, disposed } = await startRouter(extensionConfig);
  try {
    await call('main', 'browser_navigate');
    await call('a1', 'browser_navigate');
    // D3: without a switch, the relay takes the env's token and profile.
    expect(created.map(c => c.profile)).toEqual([undefined, undefined]);

    // The start variant (env token and profile folder) is the current one: nothing closes.
    const same = await call('main', 'browser_use_profile', { profile: 'padrao' });
    expect(parseResponse(same as any)?.result).toContain('Already using profile padrao');
    expect(disposed()).toBe(0);

    // A sub-agent switches: the conversation switches (D2), main included.
    const result = await call('a1', 'browser_use_profile', { profile: 'jacira' });
    expect(parseResponse(result as any)?.result).toContain('Closed the browser of 2 agent(s)');
    expect(disposed()).toBe(2);

    await call('main', 'browser_navigate');
    await call('a2', 'browser_navigate');
    expect(created.slice(2).map(c => c.profile?.variant)).toEqual(['jacira', 'jacira']);

    // Back to the start variant: now it is a real switch.
    expect(parseResponse(await call('main', 'browser_use_profile', { profile: 'padrao' }) as any)?.result).toContain('Closed the browser of 2 agent(s)');
    await call('main', 'browser_navigate');
    expect(created.at(-1)?.profile).toEqual({ variant: 'padrao', profileDirName: 'Profile 13' });
  } finally {
    await router.dispose?.();
  }
});

test('a switch while main is still connecting to the old profile disposes that connection once it is up', async () => {
  let connected!: () => void;
  const { router, call, created, disposed } = await startRouter(extensionConfig, vault, new Promise<void>(resolve => connected = resolve));
  try {
    const first = call('main', 'browser_navigate');
    await expect.poll(() => created.length).toBe(1);
    const switched = call('main', 'browser_use_profile', { profile: 'jacira' });
    await call('main', 'browser_navigate');
    expect(created.at(-1)?.profile?.variant).toBe('jacira');
    connected();
    await first;
    expect(parseResponse(await switched as any)?.result).toContain('Closed the browser of 1 agent(s)');
    expect(disposed()).toBe(1);
    // The late backend of the old profile never became the current main.
    expect(router.dynamicTools?.().map(tool => tool.name)).toEqual(['page_tool_of_jacira']);
  } finally {
    await router.dispose?.();
  }
});

test('an unusable profile is an error that lists the valid ones and changes nothing', async () => {
  const { router, call, created, disposed } = await startRouter(extensionConfig);
  try {
    await call('main', 'browser_navigate');
    const cases: [unknown, string][] = [
      ['mae', 'there is no profile named "mae"'],
      ['semperfil', 'profile "semperfil" has no Chrome profile folder registered (PLAYWRIGHT_MCP_PROFILE_DIR_NAME__semperfil)'],
      ['semtoken', 'profile "semtoken" has no extension token (PLAYWRIGHT_MCP_EXTENSION_TOKEN__semtoken)'],
      [undefined, 'there is no profile named ""'],
    ];
    for (const [profile, why] of cases) {
      const result = await call('main', 'browser_use_profile', { profile });
      expect(result.isError).toBe(true);
      expect(parseResponse(result as any)?.error).toBe(`Cannot switch: ${why}. Nothing changed. Valid profiles: jacira, padrao.`);
      expectNoToken(textOf(result));
    }
    await call('main', 'browser_navigate');
    expect(created).toHaveLength(1);
    expect(disposed()).toBe(0);
  } finally {
    await router.dispose?.();
  }
});

test('the description lists the usable profiles with the user\'s aliases and the names Chrome shows, never a token', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  await fs.promises.mkdir(userDataDir, { recursive: true });
  // Chrome can name a profile after its e-mail address (the real Profile 6 on 15/11), hence the aliases.
  await fs.promises.writeFile(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 6': { name: 'someone@example.com' }, 'Profile 13': { name: 'Gabriel' } } } }));
  const aliases = testInfo.outputPath('aliases.json');
  await fs.promises.writeFile(aliases, JSON.stringify({ '_comment': 'who is who', 'jacira': ['minha mãe', 'mother'], 'padrao': 'eu', 'outro': ['' ] }));
  const { routed, router, call } = await startRouter({ extension: true, browser: { userDataDir } }, { ...vault, PLAYWRIGHT_MCP_PROFILE_ALIASES: aliases });
  try {
    const description = routed.toolSchemas.find(schema => schema.name === 'browser_use_profile')!.description;
    expect(description).toContain('Profiles: jacira (also called "minha mãe", "mother"; Chrome name "someone@example.com"; folder "Profile 6"); padrao (also called "eu"; Chrome name "Gabriel"; folder "Profile 13") - in use when this conversation started.');
    expect(description).not.toContain('semperfil');
    expect(description).not.toContain('semtoken');
    expectNoToken(description);
    // The answer names the profile the same way.
    expect(parseResponse(await call('main', 'browser_use_profile', { profile: 'jacira' }) as any)?.result).toContain('Now using profile jacira (also called "minha mãe", "mother"; Chrome name "someone@example.com"; folder "Profile 6")');
  } finally {
    await router.dispose?.();
  }
});

test('without --extension the tool answers that it does not apply', async ({ client, startClient }) => {
  // No router (the default persistent browser), then the router without --extension (--isolated).
  for (const mcp of [client, (await startClient({ args: ['--isolated'], env: vault })).client]) {
    const response = await mcp.callTool({ name: 'browser_use_profile', arguments: { profile: 'jacira' } });
    expect(response.isError).toBeFalsy();
    expect(parseResponse(response as any)?.result).toContain('this session is not running with --extension');
  }
});

test('the chosen token and profile folder reach the connect page, and no log line has a token', async ({ startClient }, testInfo) => {
  // A stub browser: records its arguments and never connects, so each browser call fails after the short timeout.
  const stub = testInfo.outputPath('browser-stub.js');
  const argsLog = testInfo.outputPath('browser-stub.log');
  await fs.promises.writeFile(stub, `require('fs').appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const userDataDir = testInfo.outputPath('user-data');
  await fs.promises.mkdir(userDataDir, { recursive: true });
  const { client, stderr } = await startClient({
    args: ['--extension'],
    env: {
      ...vault,
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: stub,
      PWTEST_EXTENSION_USER_DATA_DIR: userDataDir,
      PLAYWRIGHT_MCP_PROFILE_ALIASES: testInfo.outputPath('no-aliases.json'),
      PWTEST_EXTENSION_CONNECT_TIMEOUT: '1000',
      DEBUG: 'pw:mcp:*',
    },
  });
  const starts = async () => (await fs.promises.readFile(argsLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  const connectTokenOf = (args: string[]) => new URL(args.at(-1)!).searchParams.get('token');
  const responses: string[] = [];

  responses.push(textOf(await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } })));
  await expect.poll(async () => (await starts()).length).toBe(1);
  expect((await starts())[0]).toContain('--profile-directory=Profile 13');
  expect(connectTokenOf((await starts())[0])).toBe('dummy-padrao');

  const switched = await client.callTool({ name: 'browser_use_profile', arguments: { profile: 'jacira' } });
  responses.push(textOf(switched));
  expect(switched.isError).toBeFalsy();

  responses.push(textOf(await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } })));
  await expect.poll(async () => (await starts()).length).toBe(2);
  expect((await starts())[1]).toContain('--profile-directory=Profile 6');
  expect(connectTokenOf((await starts())[1])).toBe('dummy-jacira');

  const { tools: list } = await client.listTools();
  responses.push(JSON.stringify(list));
  expect(stderr()).toContain('use profile variant=jacira profileDir=Profile 6');
  expectNoToken(responses.join('\n'));
  expectNoToken(stderr());
});
