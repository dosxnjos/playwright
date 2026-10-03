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

// Fork-only (patch 7): silent connect. A relay already connected in this process opens the next relay's connect page
// from inside Chrome (no chrome.exe launch, no stolen window); a sub-agent's relay opens it and its tabs in the
// background and answers Page.bringToFront locally. Real Chrome is checked by hand (extension tests need a human on
// Windows): here the extension is a fake WebSocket client speaking protocol v2. See FORK.md § Silent connect.

import childProcess from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { WebSocket } from 'ws';

import { test, expect } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

type Command = { id: number, method: string, params: any[] };
type Relay = InstanceType<typeof tools.CDPRelayServer>;

const TAB = { id: 7, index: 0, windowId: 1, active: false, pinned: false, url: 'about:blank' };

// What the fake does with a chrome.tabs.create of a connect page: load it (connect to the relay it names), open it and
// never connect (a background page that does not run), answer only after `lateMs` (a slow service worker), or fail.
type CreateMode = 'connect' | 'stall' | 'late' | 'fail';

function methodName(c: Command) {
  return c.method === 'chrome.debugger.sendCommand' ? `${c.method} ${c.params[1]}` : c.method;
}

// Stands for the extension's RelayConnection: answers allow-listed chrome.* commands, records them, and, like the
// connect page the real extension would load, connects a new fake to the relay named in a created connect page URL.
class FakeExtension {
  readonly received: Command[] = [];
  readonly spawned: FakeExtension[] = [];
  // Overrides, by methods() name (`chrome.debugger.sendCommand Page.captureScreenshot`, `extension.revealForCapture`):
  // what the extension answers, after an optional wait. Unlisted methods get the defaults below.
  readonly answers = new Map<string, (params: any[]) => Promise<{ result?: any, error?: string }>>();
  private _ws: WebSocket;
  private _mode: CreateMode;
  private _lateMs: number;

  private constructor(ws: WebSocket, mode: CreateMode, lateMs: number) {
    this._ws = ws;
    this._mode = mode;
    this._lateMs = lateMs;
    ws.on('message', data => void this._onMessage(JSON.parse(data.toString())));
  }

  // `seedTabs` are pushed before the handshake ends, like the real extension's initial attachTab (the seed).
  static async connect(endpoint: string, mode: CreateMode = 'connect', lateMs = 0, seedTabs: object[] = []): Promise<FakeExtension> {
    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const fake = new FakeExtension(ws, mode, lateMs);
    for (const tab of seedTabs)
      fake.emit('chrome.tabs.onCreated', [tab]);
    ws.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
    return fake;
  }

  // An event the extension forwards to the relay (chrome.tabs.onCreated of a tab that entered the group, a detach...).
  emit(method: string, params: any[]) {
    this._ws.send(JSON.stringify({ method, params }));
  }

  attached() {
    return this.received.filter(c => c.method === 'chrome.debugger.attach').map(c => c.params[0].tabId);
  }

  removed() {
    return this.received.filter(c => c.method === 'chrome.tabs.remove').map(c => c.params[0]);
  }

  methods() {
    return this.received.map(methodName);
  }

  close() {
    this._ws.close();
  }

  private async _onMessage(message: Command) {
    if (message.id === undefined || !message.method)
      return;
    this.received.push(message);
    const answer = this.answers.get(methodName(message));
    if (answer) {
      const { result, error } = await answer(message.params);
      this._ws.send(JSON.stringify(error === undefined ? { id: message.id, result: result ?? {} } : { id: message.id, error }));
      return;
    }
    let result: any = {};
    if (message.method === 'chrome.tabs.create') {
      const relayUrl = new URL(message.params[0].url ?? 'about:blank').searchParams.get('mcpRelayUrl');
      if (relayUrl && this._mode === 'fail') {
        this._ws.send(JSON.stringify({ id: message.id, error: 'No tab with id' }));
        return;
      }
      if (relayUrl && this._mode === 'late')
        await new Promise(f => setTimeout(f, this._lateMs));
      if (relayUrl && this._mode === 'connect')
        this.spawned.push(await FakeExtension.connect(relayUrl));
      result = { ...TAB, active: message.params[0].active ?? true };
    } else if (message.method === 'chrome.debugger.sendCommand' && message.params[1] === 'Target.getTargetInfo') {
      result = { targetInfo: { targetId: `T${message.params[0].tabId}`, type: 'page', url: 'about:blank', title: '' } };
    }
    this._ws.send(JSON.stringify({ id: message.id, result }));
  }
}

// CDP side of a relay (what Playwright's connectOverCDP talks to).
class FakePlaywright extends EventEmitter {
  private _ws: WebSocket;
  private _lastId = 0;

  private constructor(ws: WebSocket) {
    super();
    this._ws = ws;
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      this.emit(message.id ? `response-${message.id}` : 'event', message);
    });
  }

  static async connect(endpoint: string): Promise<FakePlaywright> {
    const ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new FakePlaywright(ws);
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<{ result?: any, error?: { message: string } }> {
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise(resolve => this.once(`response-${id}`, resolve));
  }

  close() {
    this._ws.close();
  }
}

const relays: Relay[] = [];
const fakes: (FakeExtension | FakePlaywright)[] = [];
const savedEnv = { ...process.env };
const ENV = ['PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'PLAYWRIGHT_MCP_AGENT_SILENT', 'PLAYWRIGHT_MCP_FOCUS', 'PWTEST_EXTENSION_CARRIER_TIMEOUT', 'PWTEST_EXTENSION_REVEAL_HOLD_MS'];
// The chrome.exe launches (fallback path), by connect page URL. The relay calls child_process.spawn through the module
// object, so replacing it here catches the launch without running anything.
let launches: string[] = [];
const realSpawn = childProcess.spawn;

test.beforeEach(() => {
  // Having a token is what lets a connect page in the background connect without a click; any value does here.
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = randomUUID();
  delete process.env.PLAYWRIGHT_MCP_AGENT_SILENT;
  delete process.env.PLAYWRIGHT_MCP_FOCUS;
  delete process.env.PWTEST_EXTENSION_CARRIER_TIMEOUT;
  launches = [];
  (childProcess as any).spawn = (command: string, args: string[]) => {
    launches.push(args[args.length - 1]);
    return new EventEmitter();
  };
});

test.afterEach(() => {
  (childProcess as any).spawn = realSpawn;
  for (const fake of fakes.splice(0))
    fake.close();
  for (const relay of relays.splice(0))
    relay.stop();
  for (const name of ENV) {
    if (savedEnv[name] === undefined)
      delete process.env[name];
    else
      process.env[name] = savedEnv[name];
  }
});

// executablePath = node: the spawn fallback never looks Chrome up (and the launch itself is stubbed above).
async function startRelay(background?: boolean): Promise<Relay> {
  const relay = background === undefined ? new tools.CDPRelayServer('chrome', process.execPath) : new tools.CDPRelayServer('chrome', process.execPath, undefined, undefined, { background });
  relays.push(relay);
  await relay.start();
  return relay;
}

// The main agent's relay, connected the way the real first connection is (its connect page came from a chrome.exe launch).
// A relay is a carrier only after the extension handshake, which establishExtensionConnection waits for.
async function connectedCarrier(mode: CreateMode = 'connect', lateMs = 0): Promise<{ relay: Relay, extension: FakeExtension }> {
  const relay = await startRelay();
  const established = relay.establishExtensionConnection('main');
  const extension = await FakeExtension.connect(relay.extensionEndpoint(), mode, lateMs);
  fakes.push(extension);
  await established;
  // Its own (stubbed) chrome.exe launch is not what the tests count.
  launches.splice(0);
  return { relay, extension };
}

function createdConnectPage(extension: FakeExtension) {
  const created = extension.received.filter(c => c.method === 'chrome.tabs.create');
  expect(created).toHaveLength(1);
  return created[0].params[0] as { url: string, active: boolean };
}

test('a sub-agent relay opens its connect page in the background through a connected relay', async () => {
  const carrier = await connectedCarrier();
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');

  const page = createdConnectPage(carrier.extension);
  expect(page.active).toBe(false);
  const url = new URL(page.url);
  expect(url.protocol).toBe('chrome-extension:');
  expect(url.searchParams.get('mcpRelayUrl')).toBe(sub.extensionEndpoint());
  expect(JSON.parse(url.searchParams.get('client')!).name).toBe('main · gp-1111');
  expect(carrier.extension.spawned).toHaveLength(1);
  fakes.push(...carrier.extension.spawned);
});

// Fork (foco zero, 03/10/2026): with a token the main agent works in the background too; PLAYWRIGHT_MCP_FOCUS=on brings
// back the old behavior (connect page, tabs and bringToFront in front). FORK.md § Foco zero.
test('with a token the main agent relay also opens its connect page in the background through a connected relay', async () => {
  const carrier = await connectedCarrier();
  const reconnect = await startRelay(false);
  await reconnect.establishExtensionConnection('main');
  expect(createdConnectPage(carrier.extension).active).toBe(false);
  fakes.push(...carrier.extension.spawned);
});

test('PLAYWRIGHT_MCP_FOCUS=on: the main agent relay opens its connect page in the foreground; a sub-agent stays in the background', async () => {
  process.env.PLAYWRIGHT_MCP_FOCUS = 'on';
  const carrier = await connectedCarrier();
  const reconnect = await startRelay(false);
  await reconnect.establishExtensionConnection('main');
  expect(createdConnectPage(carrier.extension).active).toBe(true);
  fakes.push(...carrier.extension.spawned);
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');
  const created = carrier.extension.received.filter(c => c.method === 'chrome.tabs.create');
  expect(created.map(c => c.params[0].active)).toEqual([true, false]);
  fakes.push(...carrier.extension.spawned);
});

// The extension only knows a connect page is meant to stay out of the way from this flag: the chrome.exe launch opens
// it in front, and only the extension can put the previous tab back (extension background.ts, `silent`).
for (const [name, background, env, expected] of [
  ['with a token the main agent', false, {}, '1'],
  ['with a token a sub-agent', true, {}, '1'],
  ['PLAYWRIGHT_MCP_FOCUS=on: the main agent', false, { PLAYWRIGHT_MCP_FOCUS: 'on' }, null],
  ['without a token the main agent', false, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: undefined }, null],
  ['without a token a sub-agent', true, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: undefined }, null],
  ['PLAYWRIGHT_MCP_AGENT_SILENT=off: the main agent', false, { PLAYWRIGHT_MCP_AGENT_SILENT: 'off' }, null],
] as const) {
  test(`${name} asks the extension for a silent connect: silent=${expected}`, async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
    const relay = await startRelay(background);
    const established = relay.establishExtensionConnection('main');
    const extension = await FakeExtension.connect(relay.extensionEndpoint());
    fakes.push(extension);
    await established;
    expect(launches).toHaveLength(1);
    expect(new URL(launches[0]).searchParams.get('silent')).toBe(expected);
  });
}

test('without a token the connect page opens in the foreground: the user has to click Allow', async () => {
  delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const carrier = await connectedCarrier();
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');
  expect(createdConnectPage(carrier.extension).active).toBe(true);
  fakes.push(...carrier.extension.spawned);
});

test('a carrier whose extension went away is skipped', async () => {
  const gone = await connectedCarrier();
  gone.extension.close();
  const live = await connectedCarrier();
  // Let the relay see the closed socket of the first carrier.
  await new Promise(f => setTimeout(f, 200));
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');
  expect(gone.extension.received).toHaveLength(0);
  expect(createdConnectPage(live.extension).active).toBe(false);
  fakes.push(...live.extension.spawned);
});

test('PLAYWRIGHT_MCP_AGENT_SILENT=off keeps the chrome.exe launch and the foreground', async () => {
  process.env.PLAYWRIGHT_MCP_AGENT_SILENT = 'off';
  const carrier = await connectedCarrier();
  const sub = await startRelay(true);
  const established = sub.establishExtensionConnection('main · gp-1111');
  // The launch went to node, not Chrome: connect the extension by hand, as the user would on the connect page.
  const subExtension = await FakeExtension.connect(sub.extensionEndpoint());
  fakes.push(subExtension);
  await established;
  expect(carrier.extension.received).toHaveLength(0);
  expect(launches).toHaveLength(1);

  const playwright = await FakePlaywright.connect(sub.cdpEndpoint());
  fakes.push(playwright);
  const attached = new Promise<any>(resolve => playwright.on('event', e => e.method === 'Target.attachedToTarget' && resolve(e.params)));
  await playwright.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await attached;
  expect(createdConnectPage(subExtension).active).toBeUndefined();
  await playwright.send('Page.bringToFront', {}, sessionId);
  expect(subExtension.methods()).toContain('chrome.debugger.sendCommand Page.bringToFront');
});

test('a sub-agent relay opens its tabs in the background and never brings them to front', async () => {
  const carrier = await connectedCarrier();
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');
  const subExtension = carrier.extension.spawned[0];
  fakes.push(subExtension);

  const playwright = await FakePlaywright.connect(sub.cdpEndpoint());
  fakes.push(playwright);
  const attached = new Promise<any>(resolve => playwright.on('event', e => e.method === 'Target.attachedToTarget' && resolve(e.params)));
  expect((await playwright.send('Target.createTarget', { url: 'about:blank' })).result).toEqual({ targetId: 'T7' });
  const { sessionId } = await attached;
  expect(createdConnectPage(subExtension).active).toBe(false);

  expect(await playwright.send('Page.bringToFront', {}, sessionId)).toEqual(expect.objectContaining({ result: {} }));
  expect(subExtension.methods()).not.toContain('chrome.debugger.sendCommand Page.bringToFront');
});

test('with a token the main agent relay opens its tabs in the background and never brings them to front', async () => {
  const relay = await startRelay(false);
  const extension = await FakeExtension.connect(relay.extensionEndpoint());
  fakes.push(extension);
  const playwright = await FakePlaywright.connect(relay.cdpEndpoint());
  fakes.push(playwright);
  const attached = new Promise<any>(resolve => playwright.on('event', e => e.method === 'Target.attachedToTarget' && resolve(e.params)));
  await playwright.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await attached;
  expect(createdConnectPage(extension).active).toBe(false);

  expect(await playwright.send('Page.bringToFront', {}, sessionId)).toEqual(expect.objectContaining({ result: {} }));
  expect(extension.methods()).not.toContain('chrome.debugger.sendCommand Page.bringToFront');
});

for (const [name, env] of [
  ['PLAYWRIGHT_MCP_FOCUS=on', { PLAYWRIGHT_MCP_FOCUS: 'on' }],
  ['without a token', { PLAYWRIGHT_MCP_EXTENSION_TOKEN: undefined }],
  ['PLAYWRIGHT_MCP_AGENT_SILENT=off', { PLAYWRIGHT_MCP_AGENT_SILENT: 'off' }],
] as const) {
  test(`${name}: the main agent relay opens tabs in the foreground and forwards Page.bringToFront`, async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
    const relay = await startRelay(false);
    const extension = await FakeExtension.connect(relay.extensionEndpoint());
    fakes.push(extension);
    const playwright = await FakePlaywright.connect(relay.cdpEndpoint());
    fakes.push(playwright);
    const attached = new Promise<any>(resolve => playwright.on('event', e => e.method === 'Target.attachedToTarget' && resolve(e.params)));
    await playwright.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await attached;
    expect(createdConnectPage(extension).active).toBeUndefined();

    await playwright.send('Page.bringToFront', {}, sessionId);
    expect(extension.methods()).toContain('chrome.debugger.sendCommand Page.bringToFront');
    expect(extension.methods()).not.toContain('chrome.debugger.sendCommand Emulation.setFocusEmulationEnabled');
  });
}

// A background tab gets no requestAnimationFrame, and the 'stable' check of click/hover/check polls on it. With
// --extension Playwright connects with noDefaults and skips focus emulation (crPage.ts), so the background relay turns
// it on per tab, right after the attach and before Playwright sees the target.
test('a sub-agent relay, and with a token the main one, turn focus emulation on for every tab they attach', async () => {
  const carrier = await connectedCarrier();
  const sub = await startRelay(true);
  await sub.establishExtensionConnection('main · gp-1111');
  const subExtension = carrier.extension.spawned[0];
  fakes.push(subExtension);
  const playwright = await FakePlaywright.connect(sub.cdpEndpoint());
  fakes.push(playwright);
  await playwright.send('Target.createTarget', { url: 'about:blank' });
  const methods = subExtension.methods();
  const focus = methods.indexOf('chrome.debugger.sendCommand Emulation.setFocusEmulationEnabled');
  expect(focus).toBeGreaterThan(methods.indexOf('chrome.debugger.attach'));
  expect(focus).toBeLessThan(methods.indexOf('chrome.debugger.sendCommand Target.getTargetInfo'));
  expect(subExtension.received[focus].params).toEqual([{ tabId: 7 }, 'Emulation.setFocusEmulationEnabled', { enabled: true }]);

  const mainPlaywright = await FakePlaywright.connect(carrier.relay.cdpEndpoint());
  fakes.push(mainPlaywright);
  await mainPlaywright.send('Target.createTarget', { url: 'about:blank' });
  expect(carrier.extension.methods()).toContain('chrome.debugger.attach');
  // Without a token or with PLAYWRIGHT_MCP_FOCUS=on it does not: see the foreground tests above.
  expect(carrier.extension.methods()).toContain('chrome.debugger.sendCommand Emulation.setFocusEmulationEnabled');
});

test('a connect page opened by a carrier that never connects is closed and chrome.exe takes over', async () => {
  process.env.PWTEST_EXTENSION_CARRIER_TIMEOUT = '300';
  const carrier = await connectedCarrier('stall');
  const sub = await startRelay(true);
  const established = sub.establishExtensionConnection('main · gp-1111');
  await expect.poll(() => launches).toHaveLength(1);
  expect(new URL(launches[0]).searchParams.get('mcpRelayUrl')).toBe(sub.extensionEndpoint());
  expect(createdConnectPage(carrier.extension).active).toBe(false);
  expect(carrier.extension.removed()).toEqual([7]);
  // The launched page connects (here: by hand).
  fakes.push(await FakeExtension.connect(sub.extensionEndpoint()));
  await established;
});

test('a carrier that answers after the deadline: chrome.exe takes over and the late page is closed', async () => {
  process.env.PWTEST_EXTENSION_CARRIER_TIMEOUT = '200';
  const carrier = await connectedCarrier('late', 600);
  const sub = await startRelay(true);
  const established = sub.establishExtensionConnection('main · gp-1111');
  await expect.poll(() => launches).toHaveLength(1);
  expect(carrier.extension.removed()).toEqual([]);
  fakes.push(await FakeExtension.connect(sub.extensionEndpoint()));
  await established;
  // Left open, the late page would try to connect too and stay up with "Another extension connection already established".
  await expect.poll(() => carrier.extension.removed()).toEqual([7]);
});

test('a carrier that fails to open the page falls back to chrome.exe', async () => {
  const carrier = await connectedCarrier('fail');
  const sub = await startRelay(true);
  const established = sub.establishExtensionConnection('main · gp-1111');
  await expect.poll(() => launches).toHaveLength(1);
  expect(createdConnectPage(carrier.extension).active).toBe(false);
  fakes.push(await FakeExtension.connect(sub.extensionEndpoint()));
  await established;
});

test('relays connecting at the same time: only the first launches chrome.exe, the next go through it', async () => {
  const first = await startRelay(true);
  const second = await startRelay(true);
  const third = await startRelay(true);
  const all = [first, second, third].map((relay, i) => relay.establishExtensionConnection(`main · gp-000${i}`));
  await expect.poll(() => launches).toHaveLength(1);
  expect(new URL(launches[0]).searchParams.get('mcpRelayUrl')).toBe(first.extensionEndpoint());
  const firstExtension = await FakeExtension.connect(first.extensionEndpoint());
  fakes.push(firstExtension);
  await Promise.all(all);
  fakes.push(...firstExtension.spawned);
  expect(launches).toHaveLength(1);
  const created = firstExtension.received.filter(c => c.method === 'chrome.tabs.create').map(c => c.params[0]);
  expect(created.map(page => new URL(page.url).searchParams.get('mcpRelayUrl')).sort()).toEqual([second.extensionEndpoint(), third.extensionEndpoint()].sort());
  expect(created.map(page => page.active)).toEqual([false, false]);
});

test('a relay that starts while an older one waits for its extension goes through it, not chrome.exe', async () => {
  const first = await startRelay(true);
  const firstEstablished = first.establishExtensionConnection('main · gp-0000');
  await expect.poll(() => launches).toHaveLength(1);
  // The older relay already launched chrome.exe and now waits for its connect page; this one starts later.
  const second = await startRelay(true);
  const secondEstablished = second.establishExtensionConnection('main · gp-0001');
  await new Promise(f => setTimeout(f, 100));
  const firstExtension = await FakeExtension.connect(first.extensionEndpoint());
  fakes.push(firstExtension);
  await Promise.all([firstEstablished, secondEstablished]);
  fakes.push(...firstExtension.spawned);
  expect(launches).toHaveLength(1);
  expect(createdConnectPage(firstExtension).active).toBe(false);
});

test('the router creates every agent but main inside the background relay scope', async () => {
  const scopes: Record<string, unknown> = {};
  class FakeBackend extends EventEmitter {
    async callTool(name: string) {
      return { content: [{ type: 'text' as const, text: name }] };
    }
  }
  const factory = {
    name: 'fake', nameInConfig: 'fake', version: '0', toolSchemas: [],
    create: async (clientInfo: { clientName: string }) => {
      await new Promise(f => setTimeout(f, 10));
      // Read after an await, like createExtensionBrowser does after its profile lookups.
      scopes[clientInfo.clientName] = tools.relayScope.getStore()?.background;
      return new FakeBackend();
    },
  };
  const clientInfo = { cwd: process.cwd(), clientName: 'test' };
  const router = await tools.withAgentRouting(factory as any, { extension: true, browser: {} } as any).create(clientInfo);
  await router.initialize?.(clientInfo);
  const signal = new AbortController().signal;
  try {
    await router.callTool('browser_navigate', { _meta: { agente: 'main' } }, signal);
    await router.callTool('browser_navigate', { _meta: { agente: 'a0000000000001111', agenteTipo: 'general-purpose' } }, signal);
    expect(scopes).toEqual({ 'test': undefined, 'test · gp-1111': true });
    expect(tools.relayScope.getStore()).toBeUndefined();
  } finally {
    await router.dispose?.();
  }
});

// Fork (patch 7, defect 1 of the 03/10 live test): in a sub-agent's relay, a tab that shows up in its group after the
// handshake is attached only if the relay already knows it (re-attach) or its opener is one of its tabs (popup). A
// leftover tab the user (or Chrome) drops into the group stays unattached, so the sub-agent never reads or drives it.
const SEED = { ...TAB, url: 'chrome-extension://x/connect.html' };
const INTRUDER = { ...TAB, id: 42, url: 'https://example.net/#x' };
const POPUP = { ...TAB, id: 43, url: 'https://example.net/popup', openerTabId: 7 };

// A relay whose extension came up with tab 7 as its seed, and Playwright on its CDP side with auto-attach on.
async function seededRelay(background: boolean, options: { beforeAutoAttach?: (extension: FakeExtension) => void } = {}) {
  const relay = await startRelay(background);
  const established = relay.establishExtensionConnection(background ? 'main · gp-1111' : 'main');
  // No carrier in these tests: the (stubbed) chrome.exe launch, then the connect page connects by hand.
  const extension = await FakeExtension.connect(relay.extensionEndpoint(), 'connect', 0, [SEED]);
  fakes.push(extension);
  await established;
  options.beforeAutoAttach?.(extension);
  const playwright = await FakePlaywright.connect(relay.cdpEndpoint());
  fakes.push(playwright);
  const targets: string[] = [];
  playwright.on('event', e => e.method === 'Target.attachedToTarget' && targets.push(e.params.targetInfo.targetId));
  await playwright.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attachedTo = (targetId: string, times = 1) => expect.poll(() => targets.filter(t => t === targetId).length).toBe(times);
  return { relay, extension, playwright, targets, attachedTo };
}

test('a sub-agent relay attaches its seed but not a tab that entered its group without an opener', async () => {
  const { extension, attachedTo, targets } = await seededRelay(true);
  await attachedTo('T7');
  extension.emit('chrome.tabs.onCreated', [INTRUDER]);
  // Same socket, same order: once the popup is attached, the intruder's event was handled before it.
  extension.emit('chrome.tabs.onCreated', [POPUP]);
  await attachedTo('T43');
  expect(extension.attached()).toEqual([7, 43]);
  expect(targets).toEqual(['T7', 'T43']);
});

test('a sub-agent relay ignores a tab that entered its group between the handshake and auto-attach', async () => {
  const { extension, attachedTo } = await seededRelay(true, { beforeAutoAttach: extension => extension.emit('chrome.tabs.onCreated', [INTRUDER]) });
  await attachedTo('T7');
  expect(extension.attached()).toEqual([7]);
});

test('a sub-agent relay re-attaches a tab it already knows', async () => {
  const { extension, attachedTo } = await seededRelay(true);
  await attachedTo('T7');
  // What the extension sends when the debugger detaches (navigation to another process) and it re-attaches the tab.
  extension.emit('chrome.debugger.onDetach', [{ tabId: 7 }, 'target_closed']);
  extension.emit('chrome.tabs.onCreated', [SEED]);
  await attachedTo('T7', 2);
  expect(extension.attached()).toEqual([7, 7]);
});

for (const [name, background, silent] of [['the main agent relay', false, undefined], ['PLAYWRIGHT_MCP_AGENT_SILENT=off', true, 'off']] as const) {
  test(`${name} attaches a tab that entered its group without an opener (upstream behavior)`, async () => {
    if (silent)
      process.env.PLAYWRIGHT_MCP_AGENT_SILENT = silent;
    const { extension, attachedTo } = await seededRelay(background);
    await attachedTo('T7');
    extension.emit('chrome.tabs.onCreated', [INTRUDER]);
    await attachedTo('T42');
    expect(extension.attached()).toEqual([7, 42]);
  });
}

// Fork (patch 7, defect 2 of the 03/10 live test): a screenshot of a sub-agent's never-shown background tab took 4-5 s
// and failed at the 5 s action timeout; the main agent keeps the configured one.
test('a background relay says so: a sub-agent always, the main agent with a token unless PLAYWRIGHT_MCP_FOCUS=on; PLAYWRIGHT_MCP_AGENT_SILENT=off turns all off', async () => {
  expect((await startRelay(true)).background).toBe(true);
  expect((await startRelay(false)).background).toBe(true);
  expect((await startRelay()).background).toBe(true);
  process.env.PLAYWRIGHT_MCP_FOCUS = 'on';
  expect((await startRelay(true)).background).toBe(true);
  expect((await startRelay(false)).background).toBe(false);
  delete process.env.PLAYWRIGHT_MCP_FOCUS;
  delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  expect((await startRelay(true)).background).toBe(true);
  expect((await startRelay(false)).background).toBe(false);
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = randomUUID();
  process.env.PLAYWRIGHT_MCP_AGENT_SILENT = 'off';
  expect((await startRelay(true)).background).toBe(false);
  expect((await startRelay(false)).background).toBe(false);
});

// Fork (03/10 live test, extension 0.4.0.4, decided by the Gabriel: "mostrar só sem plateia"): Chrome draws no frame for
// a hidden tab, so Page.captureScreenshot of a background relay's tab waited ~12-31 s. The relay now asks the extension
// to show the tab for the capture (extension.revealForCapture: only when its window is not the focused one, the
// extension decides) and to put the user's tab back right after (extension.restoreAfterCapture), even when the capture
// fails. The extension side is tests/extension/capture-reveal.spec.ts. FORK.md § Foco zero, "Screenshot".
const REVEAL = 'extension.revealForCapture';
const RESTORE = 'extension.restoreAfterCapture';
const CAPTURE = 'chrome.debugger.sendCommand Page.captureScreenshot';
const PNG = { data: 'iVBORw0KGgo=' };

async function capturingRelay(background: boolean, timeline: string[] = [], name = '') {
  const relay = await startRelay(background);
  const established = relay.establishExtensionConnection('main');
  const extension = await FakeExtension.connect(relay.extensionEndpoint());
  fakes.push(extension);
  await established;
  const playwright = await FakePlaywright.connect(relay.cdpEndpoint());
  fakes.push(playwright);
  const attached = new Promise<any>(resolve => playwright.on('event', e => e.method === 'Target.attachedToTarget' && resolve(e.params)));
  await playwright.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await attached;
  // What the extension does by default here: a window nobody looks at (revealed), a capture that works.
  const answer = (method: string, reply: (params: any[]) => Promise<{ result?: any, error?: string }>) => extension.answers.set(method, async params => {
    timeline.push(`${name}${method}`);
    return await reply(params);
  });
  answer(REVEAL, async () => ({ result: { revealed: true } }));
  answer(CAPTURE, async () => ({ result: PNG }));
  answer(RESTORE, async () => ({ result: { restored: true } }));
  const capture = () => playwright.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const calls = () => extension.received.filter(c => [REVEAL, RESTORE, CAPTURE].includes(methodName(c))).map(c => [methodName(c), ...(methodName(c) === CAPTURE ? [] : c.params)]);
  return { relay, extension, playwright, sessionId, capture, calls, answer };
}

for (const [name, background] of [['a sub-agent relay', true], ['with a token the main agent relay', false]] as const) {
  test(`${name} shows its tab for the capture and puts the user's tab back`, async () => {
    const { capture, calls, playwright, sessionId } = await capturingRelay(background);
    // Only the capture: nothing else waits for a frame.
    await playwright.send('Page.getLayoutMetrics', {}, sessionId);
    expect(calls()).toEqual([]);
    expect((await capture()).result).toEqual(PNG);
    expect(calls()).toEqual([[REVEAL, 7], [CAPTURE], [RESTORE, 7]]);
  });
}

test('a window someone looks at: the extension does not reveal, the capture goes on slowly and nothing is put back', async () => {
  const { capture, calls, answer } = await capturingRelay(true);
  answer(REVEAL, async () => ({ result: { revealed: false } }));
  expect((await capture()).result).toEqual(PNG);
  expect(calls()).toEqual([[REVEAL, 7], [CAPTURE]]);
});

test('a capture that fails still puts the user\'s tab back, and its error reaches Playwright', async () => {
  const { capture, calls, answer } = await capturingRelay(true);
  answer(CAPTURE, async () => ({ error: 'Unable to capture screenshot' }));
  expect((await capture()).error?.message).toContain('Unable to capture screenshot');
  expect(calls()).toEqual([[REVEAL, 7], [CAPTURE], [RESTORE, 7]]);
});

test('an extension older than 0.4.0.5 (no reveal command): the capture goes on as before, without an error', async () => {
  const { capture, calls, answer } = await capturingRelay(true);
  answer(REVEAL, async () => ({ error: `Unknown method: ${REVEAL}` }));
  expect((await capture()).result).toEqual(PNG);
  expect(calls()).toEqual([[REVEAL, 7], [CAPTURE]]);
});

test('a restore that fails does not hide the capture', async () => {
  const { capture, calls, answer } = await capturingRelay(true);
  answer(RESTORE, async () => ({ error: 'No tab with id: 3' }));
  expect((await capture()).result).toEqual(PNG);
  expect(calls()).toEqual([[REVEAL, 7], [CAPTURE], [RESTORE, 7]]);
});

for (const [name, env] of [
  ['PLAYWRIGHT_MCP_FOCUS=on', { PLAYWRIGHT_MCP_FOCUS: 'on' }],
  ['without a token', { PLAYWRIGHT_MCP_EXTENSION_TOKEN: undefined }],
  ['PLAYWRIGHT_MCP_AGENT_SILENT=off', { PLAYWRIGHT_MCP_AGENT_SILENT: 'off' }],
] as const) {
  test(`${name}: the main agent relay captures its tab as upstream, no reveal`, async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
    const { capture, calls } = await capturingRelay(false);
    expect((await capture()).result).toEqual(PNG);
    expect(calls()).toEqual([[CAPTURE]]);
  });
}

// Two agents of one session capturing in the same window at once: revealing B would hide A again (its capture waits on)
// and, depending on which ends first, the restore could leave an agent tab in front instead of the user's.
test('captures of two background relays at the same time: one reveal at a time', async () => {
  const timeline: string[] = [];
  const a = await capturingRelay(true, timeline, 'A ');
  const b = await capturingRelay(true, timeline, 'B ');
  a.answer(CAPTURE, async () => {
    await new Promise(f => setTimeout(f, 300));
    return { result: PNG };
  });
  const first = a.capture();
  await expect.poll(() => timeline).toContain(`A ${CAPTURE}`);
  const second = b.capture();
  expect((await first).result).toEqual(PNG);
  expect((await second).result).toEqual(PNG);
  expect(timeline).toEqual([`A ${REVEAL}`, `A ${CAPTURE}`, `A ${RESTORE}`, `B ${REVEAL}`, `B ${CAPTURE}`, `B ${RESTORE}`]);
});

test('a window someone looks at does not hold the other captures back', async () => {
  const timeline: string[] = [];
  const a = await capturingRelay(true, timeline, 'A ');
  const b = await capturingRelay(true, timeline, 'B ');
  a.answer(REVEAL, async () => ({ result: { revealed: false } }));
  let slowCapture!: () => void;
  a.answer(CAPTURE, () => new Promise(f => slowCapture = () => f({ result: PNG })));
  const first = a.capture();
  await expect.poll(() => timeline).toContain(`A ${CAPTURE}`);
  expect((await b.capture()).result).toEqual(PNG);
  slowCapture();
  expect((await first).result).toEqual(PNG);
  expect(timeline).toEqual([`A ${REVEAL}`, `A ${CAPTURE}`, `B ${REVEAL}`, `B ${CAPTURE}`, `B ${RESTORE}`]);
});

test('a revealed capture that never answers holds the next reveal back only for a while', async () => {
  process.env.PWTEST_EXTENSION_REVEAL_HOLD_MS = '300';
  const timeline: string[] = [];
  const a = await capturingRelay(true, timeline, 'A ');
  const b = await capturingRelay(true, timeline, 'B ');
  a.answer(CAPTURE, () => new Promise(() => {}));
  void a.capture();
  await expect.poll(() => timeline).toContain(`A ${CAPTURE}`);
  expect((await b.capture()).result).toEqual(PNG);
  expect(timeline).toEqual([`A ${REVEAL}`, `A ${CAPTURE}`, `B ${REVEAL}`, `B ${CAPTURE}`, `B ${RESTORE}`]);
});

// Fork (03/10 live test, extension 0.4.0.4): a hidden tab's capture took ~12 s (sub-agent) and 28-31 s (main), at the
// old 30 s ceiling. The relay now shows the tab for the capture when nobody looks at its window; when someone does, it
// captures slowly, so the ceiling is 60 s (decided by the Gabriel, 03/10).
test('screenshot timeout: at least 60 s for a background tab, the action timeout otherwise', () => {
  expect(tools.screenshotTimeout({ timeouts: { action: 5000 } }, true)).toBe(60_000);
  expect(tools.screenshotTimeout({ timeouts: { action: 90_000 } }, true)).toBe(90_000);
  expect(tools.screenshotTimeout({ timeouts: { action: 5000 } }, false)).toBe(5000);
  expect(tools.screenshotTimeout({}, false)).toBeUndefined();
});

// What browser_take_screenshot reads: the relay registered for the tab's Browser (not its context or page).
test('screenshot timeout of a tab: from the relay registered for its browser', () => {
  const tabOn = (browser: object | null) => ({ page: { context: () => ({ browser: () => browser }) }, context: { config: { timeouts: { action: 5000 } } } });
  const subAgentBrowser = {};
  const mainBrowser = {};
  tools.registerExtensionRelay(subAgentBrowser, { background: true, setGroupLabel: async () => {} });
  tools.registerExtensionRelay(mainBrowser, { background: false, setGroupLabel: async () => {} });
  expect(tools.screenshotTimeoutFor(tabOn(subAgentBrowser) as any)).toEqual({ background: true, timeout: 60_000 });
  expect(tools.screenshotTimeoutFor(tabOn(mainBrowser) as any)).toEqual({ background: false, timeout: 5000 });
  // Not an extension browser (or no browser at all): the action timeout.
  expect(tools.screenshotTimeoutFor(tabOn({}) as any)).toEqual({ background: false, timeout: 5000 });
  expect(tools.screenshotTimeoutFor(tabOn(null) as any)).toEqual({ background: false, timeout: 5000 });
});

test('browser_take_screenshot passes the background timeout to the capture', async () => {
  const screenshot = tools.browserTools.find(tool => tool.schema.name === 'browser_take_screenshot')!;
  const capture = async (browser: object) => {
    let options: any;
    const tab = {
      modalStates: () => [],
      context: { config: { timeouts: { action: 5000 } } },
      page: { context: () => ({ browser: () => browser }), screenshot: async (o: any) => { options = o; return Buffer.from(''); } },
    };
    const response = { resolveClientOutputFile: async () => ({ relativeName: 'page.png' }), addCode: () => {}, addFileResult: async () => {}, registerImageResult: async () => {}, addError: () => {} };
    await screenshot.handle({ ensureTab: async () => tab } as any, { scale: 'css' } as any, response as any, undefined as any);
    return options.timeout;
  };
  const subAgentBrowser = {};
  tools.registerExtensionRelay(subAgentBrowser, { background: true, setGroupLabel: async () => {} });
  expect(await capture(subAgentBrowser)).toBe(60_000);
  expect(await capture({})).toBe(5000);
});

test('browser_take_screenshot logs its duration, the background flag and the timeout on pw:mcp:shot', async ({ startClient, server }) => {
  // The MCP server is a real child process: undo this file's spawn stub.
  (childProcess as any).spawn = realSpawn;
  const { client, stderr } = await startClient({ env: { DEBUG: 'pw:mcp:shot' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.callTool({ name: 'browser_take_screenshot' });
  // The fixture runs the server with --timeout-action=10000; not an extension relay, so not background.
  await expect.poll(() => stderr()).toMatch(/pw:mcp:shot screenshot viewport background=false timeout=10000 took \d+ms ok/);
});
