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

/**
 * WebSocket server that bridges Playwright MCP and Chrome Extension.
 *
 * Endpoints:
 * - /cdp/guid - Full CDP interface for Playwright MCP
 * - /extension/guid - Extension connection
 *
 * The protocol version advertised to the extension can be overridden with the
 * PWTEST_EXTENSION_PROTOCOL env variable, and the connection timeout with
 * PWTEST_EXTENSION_CONNECT_TIMEOUT (both used in tests).
 */

import { spawn } from 'child_process';
import os from 'os';

import debug from 'debug';
import ws from 'ws';
import { ManualPromise } from '@isomorphic/manualPromise';
import { monotonicTime } from '@isomorphic/time';
import { raceAgainstDeadline } from '@isomorphic/timeoutRunner';
import { WSServer } from '@utils/wsServer';
import { registry } from '../../server/registry/index';

import { playwrightExtensionId } from '../utils/extension';
import { logUnhandledError } from './log';
import { ExtensionProtocolV2 } from './cdpRelayV2';
import * as protocol from './protocol';

import type websocket from 'ws';
import type { ExtensionCommandV2, ExtensionEventsV2 } from './protocol';
import type { CDPMessage } from './browserModel';
import type { WebSocket } from 'ws';


const debugLogger = debug('pw:mcp:relay');

const extensionConnectionTimeout = +(process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT ?? 30_000);

// Fork-only (patch 7): relays whose extension is connected. One of them opens the next relay's connect page from inside
// Chrome, so no chrome.exe launch takes the user's window (FORK.md § Silent connect).
const connectedRelays = new Set<CDPRelayServer>();
// Relays opening their connect page right now, oldest first: a relay with no carrier waits for an older one.
const connectingRelays = new Set<CDPRelayServer>();
const silentConnect = () => process.env.PLAYWRIGHT_MCP_AGENT_SILENT !== 'off';
// Fork (foco zero, 03/10/2026): with a token the main agent works in the background too; this brings its focus back.
const mainFocus = () => process.env.PLAYWRIGHT_MCP_FOCUS === 'on';
// From the carrier's chrome.tabs.create to the connect page's WebSocket. Read per call: tests shorten it.
const carrierTimeout = () => +(process.env.PWTEST_EXTENSION_CARRIER_TIMEOUT ?? 10_000);

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type CDPResponse = CDPMessage;

export class CDPRelayServer {
  private _wsServer: WSServer;
  private _wsHost!: string;
  private _browserChannel: string;
  private _executablePath?: string;
  private _customUserDataDir?: string;
  private _profileDirectory?: string;
  private _cdpPath: string;
  private _extensionPath: string;
  private _cdpConnection: WebSocket | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _protocolVersion: number;
  private _token?: string;
  private _handler: ExtensionProtocolV2;
  private _extensionConnectionPromise = new ManualPromise<void>();
  // Fork-only (patch 7, foco zero): a relay whose connect page and tabs open without taking the user's window: a
  // sub-agent's, and the main agent's with a token unless PLAYWRIGHT_MCP_FOCUS=on.
  private _background: boolean;
  // Fork-only (patch 7): resolves once this relay's extension finished its handshake and the relay carries other
  // relays' connect pages; rejects if it stops or loses its extension before that.
  private _carrierReady = new ManualPromise<void>();

  constructor(browserChannel: string, executablePath?: string, customUserDataDir?: string, profileDirectory?: string, options: { background?: boolean } = {}) {
    this._browserChannel = browserChannel;
    this._executablePath = executablePath;
    this._customUserDataDir = customUserDataDir;
    this._profileDirectory = profileDirectory;
    this._protocolVersion = parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? protocol.VERSION.toString(), 10);
    this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    const subAgent = !!options.background && silentConnect();
    // Fork (foco zero): the main agent too, when a token connects it without a click (FORK.md § Foco zero). Without a
    // token its connect page and tabs stay in front: the user has to click Allow there.
    this._background = subAgent || (silentConnect() && !!this._token && !mainFocus());
    debugLogger(`Relay created, background=${this._background} subAgent=${subAgent}`);

    const sendCommand = (method: string, params: any): Promise<any> => {
      if (!this._extensionConnection)
        throw new Error('Extension not connected');
      // Fork (patch 7, foco zero): a background relay's new tabs (browser_tabs new) open in the background.
      if (this._background && method === 'chrome.tabs.create')
        params = [{ ...params?.[0], active: false }];
      if (this._background && method === 'chrome.debugger.attach')
        return this._attachWithFocusEmulation(this._extensionConnection, params);
      return this._extensionConnection.send(method as keyof ExtensionCommandV2, params);
    };
    // Fork (patch 7): a sub-agent's relay never attaches a tab that merely entered its group (FORK.md § Silent connect).
    // Not the main agent's, even in the background: a tab dragged into its group is still handed over (upstream).
    this._handler = new ExtensionProtocolV2(sendCommand, { ownTabsOnly: subAgent });

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    void this._extensionConnectionPromise.catch(logUnhandledError);
    void this._carrierReady.catch(() => {});
    this._wsServer = new WSServer({
      onRequest: (request, response) => {
        response.statusCode = 404;
        response.end();
      },
      onHeaders: () => {},
      onUpgrade: () => undefined,
      isAllowedPathname: pathname => pathname === this._cdpPath || pathname === this._extensionPath,
      onConnection: (request, url, ws) => {
        debugLogger(`New connection to ${url.pathname}`);
        if (url.pathname === this._cdpPath)
          this._handlePlaywrightConnection(ws);
        else
          this._handleExtensionConnection(ws);
        return undefined;
      },
    });
  }

  async start(): Promise<void> {
    this._wsHost = await this._wsServer.listen(0, undefined, '');
  }

  cdpEndpoint() {
    return `${this._wsHost}${this._cdpPath}`;
  }

  // Fork-only (patch 7): read by browser_take_screenshot (backend/extensionSession.ts) for its longer timeout.
  get background(): boolean {
    return this._background;
  }

  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async establishExtensionConnection(clientName: string) {
    debugLogger('Establishing extension connection');
    // Fork (patch 7): synchronous, before any await, so relays started in the same tick still get an order. A relay
    // stays here until it connects or fails, so a younger one waits for it instead of launching chrome.exe again.
    const earlier = [...connectingRelays];
    connectingRelays.add(this);
    try {
      await this._openConnectPageInBrowser(clientName, earlier);
      debugLogger('Waiting for incoming extension connection');
      // Without a token the user has to approve the connection in the browser, which can take arbitrarily long.
      const deadline = this._token ? monotonicTime() + extensionConnectionTimeout : 0;
      const { timedOut } = await raceAgainstDeadline(async () => {
        await this._extensionConnectionPromise;
        await this._handler.ready();
      }, deadline);
      if (timedOut) {
        const profile = this._profileDirectory ? ` "${this._profileDirectory}"` : '';
        throw new Error(`Playwright extension did not connect within ${extensionConnectionTimeout / 1000}s after opening the connect page. Make sure the extension is installed in the Chrome profile${profile} and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token.`);
      }
      debugLogger('Extension connection established');
    } finally {
      connectingRelays.delete(this);
    }
  }

  private async _openConnectPageInBrowser(clientName: string, earlier: CDPRelayServer[]) {
    const mcpRelayEndpoint = `${this._wsHost}${this._extensionPath}`;
    const url = new URL(`chrome-extension://${playwrightExtensionId}/connect.html`);
    url.searchParams.set('mcpRelayUrl', mcpRelayEndpoint);
    const client = {
      name: clientName,
      // Not used anymore.
      version: undefined,
    };
    url.searchParams.set('client', JSON.stringify(client));
    url.searchParams.set('protocolVersion', this._protocolVersion.toString());
    if (this._token)
      url.searchParams.set('token', this._token);
    // Fork (foco zero): the chrome.exe launch opens the connect page in front; this asks the extension to put the tab
    // the user was on back once connected. Without a token the page has to stay: the user clicks Allow there.
    if (this._background && this._token)
      url.searchParams.set('silent', '1');
    const href = url.toString();
    // Fork (patch 7): through a relay already connected in this process when there is one, so no chrome.exe launch.
    if (await this._openConnectPageViaCarrier(href, earlier))
      return;

    const channel = registry.isChromiumAlias(this._browserChannel) ? 'chromium' : this._browserChannel;
    let executablePath = this._executablePath;
    if (!executablePath) {
      const executableInfo = registry.findExecutable(channel);
      if (!executableInfo)
        throw new Error(`Unsupported channel: "${this._browserChannel}"`);
      executablePath = executableInfo.executablePath();
      if (!executablePath)
        throw new Error(`"${this._browserChannel}" executable not found. Make sure it is installed at a standard location.`);
    }

    const args: string[] = [];
    // The default profile dir is not passed explicitly, the browser resolves it on its own.
    if (this._customUserDataDir)
      args.push(`--user-data-dir=${this._customUserDataDir}`);
    if (this._profileDirectory)
      args.push(`--profile-directory=${this._profileDirectory}`);
    if (os.platform() === 'linux' && channel === 'chromium')
      args.push('--no-sandbox');
    args.push(href);
    spawn(executablePath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  }

  // Fork-only (patch 7, foco zero). A background relay's connect page opens in the background, unless there is no token: then the user
  // has to see it to click Allow. Returns false to fall back to the chrome.exe launch: no carrier, a carrier that fails
  // or does not answer, or (with a token) a page that does not connect in time, which is closed first. Without that
  // close, a page connecting late would race the launched one and stay open with an error.
  private async _openConnectPageViaCarrier(href: string, earlier: CDPRelayServer[]): Promise<boolean> {
    if (!silentConnect())
      return false;
    // No carrier yet: an older relay is launching chrome.exe right now; wait for it rather than launch a second one.
    // Not without a token: that relay waits for a click, for as long as the user takes.
    if (this._token && !this._carriers().length)
      await this._waitForEarlierRelay(earlier);
    const active = !(this._background && this._token);
    for (const connection of this._carriers()) {
      const deadline = monotonicTime() + carrierTimeout();
      const created: Promise<{ id?: number } | undefined> = connection.send('chrome.tabs.create', [{ url: href, active }]);
      let tabId: number | undefined;
      try {
        const answer = await raceAgainstDeadline(() => created, deadline);
        if (answer.timedOut) {
          void created.then(tab => closeTab(connection, tab?.id), () => {});
          throw new Error(`no answer within ${carrierTimeout() / 1000}s`);
        }
        tabId = answer.result?.id;
      } catch (error) {
        debugLogger('A connected relay could not open the connect page:', error);
        continue;
      }
      debugLogger(`Connect page opened via portador (a connected relay), active=${active}`);
      if (!this._token)
        return true;
      // Swallowed: a relay stopped meanwhile rejects it, and establishExtensionConnection reports that.
      await raceAgainstDeadline(() => this._extensionConnectionPromise.catch(() => {}), deadline);
      if (this._extensionConnection || this._extensionConnectionPromise.isDone())
        return true;
      debugLogger(`Connect page opened via portador did not connect within ${carrierTimeout() / 1000}s: closing it, launching ${this._browserChannel}`);
      closeTab(connection, tabId);
      return false;
    }
    return false;
  }

  private _carriers(): ExtensionConnection[] {
    return [...connectedRelays].map(relay => relay._extensionConnection).filter((connection): connection is ExtensionConnection => !!connection);
  }

  // Only relays registered before this one: waiting on later ones too, relays started together would wait on each other.
  private async _waitForEarlierRelay(earlier: CDPRelayServer[]) {
    const pending = earlier.filter(relay => !relay._carrierReady.isDone());
    if (!pending.length)
      return;
    debugLogger(`Waiting for ${pending.length} older relay(s) to connect before opening the connect page`);
    let left = pending.length;
    const anyConnected = new Promise<void>(resolve => {
      for (const relay of pending) {
        relay._carrierReady.then(resolve, () => {
          if (--left === 0)
            resolve();
        });
      }
    });
    await raceAgainstDeadline(() => anyConnected, monotonicTime() + extensionConnectionTimeout);
  }

  // Fork-only (patch 7). A background tab gets no requestAnimationFrame, and the 'stable' check of click, hover and
  // check polls on it. connectOverCDP with noDefaults skips focus emulation (crPage.ts), so turn it on per tab, before
  // Playwright sees the target. Best effort: the attach result stands either way.
  private async _attachWithFocusEmulation(connection: ExtensionConnection, params: any): Promise<any> {
    const result = await connection.send('chrome.debugger.attach', params);
    await connection.send('chrome.debugger.sendCommand', [params[0], 'Emulation.setFocusEmulationEnabled', { enabled: true }])
        .catch(error => debugLogger('Could not turn focus emulation on:', error));
    return result;
  }

  // Fork-only: relabels this connection's Chrome tab group (browser_set_group_label).
  async setGroupLabel(label: string): Promise<void> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    await this._extensionConnection.send('extension.setGroupLabel', [label]);
  }

  stop(): void {
    this._leaveCarriers('Server stopped');
    this._closeConnections('Server stopped');
    void this._wsServer.close().catch(logUnhandledError);
  }

  private _closeConnections(reason: string) {
    this._closeCDPConnection(reason);
    this._closeExtensionConnection(reason);
  }

  // Fork-only (patch 7).
  private _leaveCarriers(reason: string) {
    connectedRelays.delete(this);
    if (!this._carrierReady.isDone())
      this._carrierReady.reject(new Error(reason));
  }

  private _handlePlaywrightConnection(ws: WebSocket): void {
    if (!this._extensionConnection) {
      debugLogger('Rejecting Playwright connection: extension not connected');
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._cdpConnection) {
      debugLogger('Rejecting second Playwright connection');
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP(msg => this._sendToCDPClient(msg));
    ws.on('message', async data => {
      try {
        await this._handlePlaywrightMessage(JSON.parse(data.toString()));
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    ws.on('close', () => {
      this._closeExtensionConnection('Playwright client disconnected');
      debugLogger('Playwright WebSocket closed');
    });
    ws.on('error', error => {
      debugLogger('Playwright WebSocket error:', error);
    });
    debugLogger('Playwright MCP connected');
  }

  private _closeExtensionConnection(reason: string) {
    this._extensionConnection?.close(reason);
    if (!this._extensionConnectionPromise.isDone())
      this._extensionConnectionPromise.reject(new Error(reason));
  }

  private _closeCDPConnection(reason: string) {
    if (this._cdpConnection?.readyState === ws.OPEN)
      this._cdpConnection.close(1000, reason);
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    this._extensionConnection = new ExtensionConnection(ws);
    // Fork (patch 7): a carrier only after the handshake, like the CDP traffic (cdpRelayV2.ts ready()).
    this._handler.ready().then(() => {
      if (this._carrierReady.isDone())
        return;
      connectedRelays.add(this);
      this._carrierReady.resolve();
    }, () => {});
    this._extensionConnection.onclose = reason => {
      this._leaveCarriers(reason);
      debugLogger('Extension WebSocket closed:', reason);
      this._handler.onExtensionDisconnect(reason);
      this._closeCDPConnection(`Extension disconnected: ${reason}`);
    };
    this._extensionConnection.onmessage = (method, params) => this._handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
  }

  private async _handlePlaywrightMessage(message: CDPCommand): Promise<void> {
    debugLogger('← Playwright:', `${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToCDPClient({ id, sessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._sendToCDPClient({
        id,
        sessionId,
        error: { message: (e as Error).message }
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, sessionId: string | undefined): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return { };
      }
      case 'Page.bringToFront': {
        // Fork (patch 7, foco zero): a background relay never brings its tab over the one the user is looking at
        // (browser_tabs select). PLAYWRIGHT_MCP_FOCUS=on gives the main agent its bringToFront back.
        if (this._background)
          return { };
        break;
      }
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled)
      return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToCDPClient(message: CDPResponse): void {
    debugLogger('→ Playwright:', `${message.method ?? `response(id=${message.id})`}`);
    this._cdpConnection?.send(JSON.stringify(message));
  }
}

// Fork-only (patch 7): closes a connect page a carrier opened. Best effort: the carrier may be gone already.
function closeTab(connection: ExtensionConnection, tabId: number | undefined) {
  if (tabId !== undefined)
    connection.send('chrome.tabs.remove', [tabId]).catch(error => debugLogger('Could not close the connect page:', error));
}

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: Error) => void, error: Error }>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEventsV2>(method: M, params: ExtensionEventsV2[M]['params']) => void;
  onclose?: (reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
    this._ws.on('close', this._onClose.bind(this));
    this._ws.on('error', this._onError.bind(this));
  }

  async send<M extends keyof ExtensionCommandV2>(method: M, params: ExtensionCommandV2[M]['params']): Promise<any> {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message: string) {
    debugLogger('closing extension connection:', message);
    if (this._ws.readyState === ws.OPEN)
      this._ws.close(1000, message);
  }

  private _onMessage(event: websocket.RawData) {
    const eventData = event.toString();
    let parsedJson;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }

  private _handleParsedMessage(object: ExtensionResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      debugLogger('← Extension: unexpected response', object);
    } else {
      this.onmessage?.(object.method! as keyof ExtensionEventsV2, object.params);
    }
  }

  private _onClose(code: number, reason: Buffer) {
    const message = reason.toString();
    debugLogger(`<ws closed> code=${code} reason=${message}`);
    this._dispose();
    this.onclose?.(message);
  }

  private _onError(event: websocket.ErrorEvent) {
    debugLogger(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
    this._dispose();
  }

  private _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}
