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
 * WebSocket server that bridges Playwright MCP and the Playwright extension.
 *
 *   Playwright (connectOverCDP)
 *        │  CDP: Target.*, Page.*, ... with pw-tab-N session ids
 *        ▼  ws /cdp/<uuid>
 *   ┌─ CDPRelayServer (this file) ───────────────────────────────────────────┐
 *   │ Speaks: CDP framing only (command ids ↔ responses). Launches Chrome    │
 *   │ with the connect page, accepts both sockets, waits for the handshake.  │
 *   │ Knows nothing about tabs, sessions or chrome.* APIs.                   │
 *   │ ┌─ BrowserModel (browserModel.ts) ────────────────────────────────────┐│
 *   │ │ Speaks: CDP semantics AND the extension protocol. The only          ││
 *   │ │ translator, in both directions:                                     ││
 *   │ │   CDP command    → chrome.* command  (Target.*, Browser.* switch)   ││
 *   │ │   chrome.* event → CDP event         (chrome.tabs/debugger switch)  ││
 *   │ │ State: tab id ↔ pw-tab-N session id, child sessions (workers).      ││
 *   │ │ ┌─ ExtensionConnection ────────────────────────────────────────────┐││
 *   │ │ │ Speaks: extension protocol framing only (ids ↔ responses).       │││
 *   │ │ └──────────────────────────────────────────────────────────────────┘││
 *   │ └─────────────────────────────────────────────────────────────────────┘│
 *   └────┬───────────────────────────────────────────────────────────────────┘
 *        │  extension protocol (protocol.ts): chrome.* calls and events
 *        │  mirrored 1:1, plus extension.initialized
 *        ▼  ws /extension/<uuid>
 *   ┌─ Playwright extension (packages/extension/src) ────────────────────────┐
 *   │ ClientSession: speaks extension protocol. Runs a chrome.* command only │
 *   │   for a tab that its client owns, sends the events of those tabs.      │
 *   │ TabRegistry: the owner of each tab. A tab has one client at most.      │
 *   │ TabGroupManager: keeps the tab group of a client equal to its tabs.    │
 *   └────┬───────────────────────────────────────────────────────────────────┘
 *        │  chrome.debugger / chrome.tabs / chrome.tabGroups
 *        ▼
 *   Chrome
 *
 * Handshake: the extension connects first, reports its initial tabs with
 * `chrome.tabs.onCreated`, then sends `extension.initialized`. Only then is
 * Playwright connected to the CDP endpoint, so `Target.setAutoAttach` is
 * answered from a populated BrowserModel.
 *
 * The protocol version advertised to the extension can be overridden with the
 * PWTEST_EXTENSION_PROTOCOL env variable, and the connection timeout with
 * PWTEST_EXTENSION_CONNECT_TIMEOUT (both used in tests).
 */

import { spawn } from 'child_process';

import debug from 'debug';
import ws from 'ws';
import { ManualPromise } from '@isomorphic/manualPromise';
import { monotonicTime } from '@isomorphic/time';
import { raceAgainstDeadline } from '@isomorphic/timeoutRunner';
import { WSServer } from '@utils/wsServer';
import { registry } from '../../server/registry/index';

import { playwrightExtensionId } from '../utils/extension';
import { logUnhandledError } from './log';
import { BrowserModel } from './browserModel';
import * as protocol from './protocol';
import { relayScope } from '../backend/extensionSession';

import type { CDPMessage } from './browserModel';
import type { WebSocket } from 'ws';


const debugLogger = debug('pw:mcp:relay');

const extensionConnectionTimeout = +(process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT ?? 30_000);

// Fork-only (patch 7): relays whose extension finished its handshake. One of them opens the next relay's connect page
// from inside Chrome, so that no browser start takes the user's window: Chrome older than 158 ignores
// --open-in-background (FORK.md § Foco zero, "Carrier").
const connectedRelays = new Set<CDPRelayServer>();
// Relays opening their connect page right now, oldest first: a relay with no carrier waits for an older one.
const connectingRelays = new Set<CDPRelayServer>();
const silentConnect = () => process.env.PLAYWRIGHT_MCP_AGENT_SILENT !== 'off';
const mainFocus = () => process.env.PLAYWRIGHT_MCP_FOCUS === 'on';
// From the carrier's chrome.tabs.create to the connect page's WebSocket. Read per call: tests shorten it.
const carrierTimeout = () => +(process.env.PWTEST_EXTENSION_CARRIER_TIMEOUT ?? 10_000);

export type TabGroupOptions = {
  title?: string;
  color?: string;
};

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

export class CDPRelayServer {
  private _wsServer: WSServer;
  private _wsHost!: string;
  private _browserChannel: string;
  private _executablePath?: string;
  private _customUserDataDir?: string;
  private _profileDirectory?: string;
  private _background: boolean;
  private _cdpPath: string;
  private _extensionPath: string;
  private _cdpConnection: WebSocket | null = null;
  private _browser: BrowserModel | null = null;
  // Resolved once the extension has connected and finished its initial handshake.
  private _extensionReady = new ManualPromise<void>();
  private _protocolVersion: number;
  private _token?: string;

  constructor(browserChannel: string, executablePath?: string, customUserDataDir?: string, profileDirectory?: string, background = false) {
    this._browserChannel = browserChannel;
    this._executablePath = executablePath;
    this._customUserDataDir = customUserDataDir;
    this._profileDirectory = profileDirectory;
    this._protocolVersion = parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? protocol.VERSION.toString(), 10);
    this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    // Fork (patch 7, foco zero): a sub-agent's relay is always in the background, and the main agent's too when a token
    // connects it without a click, unless PLAYWRIGHT_MCP_FOCUS=on. Without a token the main agent's connect page has to
    // stay in front: the user clicks Allow there. PLAYWRIGHT_MCP_AGENT_SILENT=off turns both off (--background stays).
    const subAgent = !!relayScope.getStore()?.background && silentConnect();
    this._background = background || subAgent || (silentConnect() && !!this._token && !mainFocus());
    debugLogger(`Relay created, background=${this._background} subAgent=${subAgent}`);

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    void this._extensionReady.catch(logUnhandledError);
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

  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async establishExtensionConnection(clientName: string, tabGroup: TabGroupOptions | undefined) {
    debugLogger('Establishing extension connection');
    // Fork (patch 7): synchronous, before any await, so relays started in the same tick still get an order. A relay
    // stays here until it connects or fails, so a younger one waits for it instead of starting the browser again.
    const earlier = [...connectingRelays];
    connectingRelays.add(this);
    try {
      await this._openConnectPageInBrowser(clientName, tabGroup, earlier);
      debugLogger('Waiting for incoming extension connection');
      // Without a token the user has to approve the connection in the browser, which can take arbitrarily long.
      const deadline = this._token ? monotonicTime() + extensionConnectionTimeout : 0;
      const { timedOut } = await raceAgainstDeadline(() => this._extensionReady, deadline);
      if (timedOut) {
        const profile = this._profileDirectory ? ` "${this._profileDirectory}"` : '';
        throw new Error(`Playwright extension did not connect within ${extensionConnectionTimeout / 1000}s after opening the connect page. Make sure the extension is installed in the Chrome profile${profile} and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token.`);
      }
      debugLogger('Extension connection established');
    } finally {
      connectingRelays.delete(this);
    }
  }

  // Fork-only (patch 7): read by browser_take_screenshot (backend/extensionSession.ts) for its longer timeout.
  get background(): boolean {
    return this._background;
  }

  // Fork-only (patch 7, foco zero). Opens the connect page through a relay of this process that is already connected,
  // in the background when this relay is (only with a token: without one the user has to see the page to click Allow).
  // Returns false to fall back to the browser start: no carrier, a carrier that fails or does not answer, or (with a
  // token) a page that does not connect in time, which is closed first, so that it does not race the started one.
  private async _openConnectPageViaCarrier(href: string, earlier: CDPRelayServer[]): Promise<boolean> {
    if (!silentConnect())
      return false;
    // No carrier yet: an older relay is starting the browser right now; wait for it rather than start a second one.
    // Not without a token: that relay waits for a click, for as long as the user takes.
    if (this._token && !CDPRelayServer._carriers().length)
      await CDPRelayServer._waitForEarlierRelay(earlier);
    const active = !(this._background && this._token);
    for (const carrier of CDPRelayServer._carriers()) {
      const deadline = monotonicTime() + carrierTimeout();
      const created = carrier.sendToExtension('chrome.tabs.create', [{ url: href, active }]);
      let tabId: number | undefined;
      try {
        const answer = await raceAgainstDeadline(() => created, deadline);
        if (answer.timedOut) {
          void created.then(tab => closeTab(carrier, tab?.id), () => {});
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
      await raceAgainstDeadline(() => this._extensionReady.catch(() => {}), deadline);
      if (this._browser || this._extensionReady.isDone())
        return true;
      debugLogger(`Connect page opened via portador did not connect within ${carrierTimeout() / 1000}s: closing it, starting ${this._browserChannel}`);
      closeTab(carrier, tabId);
      return false;
    }
    return false;
  }

  private async _openConnectPageInBrowser(clientName: string, tabGroup: TabGroupOptions | undefined, earlier: CDPRelayServer[]) {
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
    if (!tabGroup)
      url.searchParams.set('tabGroup', 'false');
    if (tabGroup?.title)
      url.searchParams.set('tabGroupTitle', tabGroup.title);
    if (tabGroup?.color)
      url.searchParams.set('tabGroupColor', tabGroup.color);
    if (this._background)
      url.searchParams.set('background', 'true');
    if (this._token)
      url.searchParams.set('token', this._token);
    const href = url.toString();
    // Fork (patch 7): through a relay already connected in this process when there is one, so no browser start.
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
    // Without a token, the user must see the connect page to approve the connection.
    if (this._background && this._token)
      args.push('--open-in-background');
    args.push(href);
    // Fork: Windows cannot start a .js file, and the Chrome stub of tests/extension is one: run it with node.
    const [command, commandArgs] = executablePath.endsWith('.js') ? [process.execPath, [executablePath, ...args]] : [executablePath, args];
    spawn(command, commandArgs, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  }

  // Fork-only: relabels this client's Chrome tab group (browser_set_group_label). False without grouping.
  async setGroupLabel(label: string): Promise<boolean> {
    const { labeled } = await this.sendToExtension('extension.setGroupLabel', [label]);
    return labeled;
  }

  // Fork-only (patch 7).
  private static _carriers(): CDPRelayServer[] {
    return [...connectedRelays].filter(relay => !!relay._browser);
  }

  // Fork-only (patch 7): only relays registered before this one; waiting on later ones too, relays started together
  // would wait on each other.
  private static async _waitForEarlierRelay(earlier: CDPRelayServer[]) {
    const pending = earlier.filter(relay => !relay._extensionReady.isDone());
    if (!pending.length)
      return;
    debugLogger(`Waiting for ${pending.length} older relay(s) to connect before opening the connect page`);
    let left = pending.length;
    const anyConnected = new Promise<void>(resolve => {
      for (const relay of pending) {
        relay._extensionReady.then(resolve, () => {
          if (--left === 0)
            resolve();
        });
      }
    });
    await raceAgainstDeadline(() => anyConnected, monotonicTime() + extensionConnectionTimeout);
  }

  stop(): void {
    connectedRelays.delete(this);
    this._closeCDPConnection('Server stopped');
    this._closeExtensionConnection('Server stopped');
    void this._wsServer.close().catch(logUnhandledError);
  }

  // Fork-only (patch 7): a carrier sends extension commands that are not CDP (opening another relay's connect page).
  sendToExtension<M extends keyof protocol.ExtensionCommands>(method: M, params: protocol.ExtensionCommands[M]['params']): Promise<protocol.ExtensionCommands[M]['result']> {
    if (!this._browser)
      return Promise.reject(new Error('Extension not connected'));
    return this._browser.sendToExtension(method, params);
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._browser) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    this._browser = new BrowserModel(ws, this._background, {
      sendToCDPClient: message => this._sendToCDPClient(message),
      onInitialized: () => {
        // Fork (patch 7): a carrier only after the handshake, like the CDP traffic.
        connectedRelays.add(this);
        this._extensionReady.resolve();
      },
      onClose: reason => {
        connectedRelays.delete(this);
        debugLogger('Extension WebSocket closed:', reason);
        if (!this._extensionReady.isDone())
          this._extensionReady.reject(new Error(`Extension disconnected before initialization: ${reason}`));
        this._closeCDPConnection(`Extension disconnected: ${reason}`);
      },
    });
  }

  private _closeExtensionConnection(reason: string) {
    this._browser?.close(reason);
    if (!this._extensionReady.isDone())
      this._extensionReady.reject(new Error(reason));
  }

  private _handlePlaywrightConnection(ws: WebSocket): void {
    if (!this._browser) {
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

  private _closeCDPConnection(reason: string) {
    if (this._cdpConnection?.readyState === ws.OPEN)
      this._cdpConnection.close(1000, reason);
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
    if (!this._browser)
      throw new Error('Extension not connected');
    return await this._browser.handleCDPCommand(method, params, sessionId);
  }

  private _sendToCDPClient(message: CDPMessage): void {
    debugLogger('→ Playwright:', `${message.method ?? `response(id=${message.id})`}`);
    this._cdpConnection?.send(JSON.stringify(message));
  }
}

// Fork-only (patch 7): closes a connect page a carrier opened. Best effort: the carrier may be gone already.
function closeTab(carrier: CDPRelayServer, tabId: number | undefined) {
  if (tabId !== undefined)
    carrier.sendToExtension('chrome.tabs.remove', [tabId]).catch(error => debugLogger('Could not close the connect page:', error));
}
