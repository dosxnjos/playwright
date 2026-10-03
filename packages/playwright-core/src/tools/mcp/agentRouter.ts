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

// Fork-only (patch 6). One browser backend per calling agent, inside the same MCP session.
// The caller comes in arguments._meta.agente, stamped by a PreToolUse hook (FORK.md § Agent routing).

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import debug from 'debug';

import { relayScope } from '../backend/extensionSession';

import type { CallToolRequest, CallToolResult, ClientInfo, ServerBackend, ServerBackendFactory, Tool } from '../utils/mcp/server';
import type { FullConfig } from './config';

const routerDebug = debug('pw:mcp:router');

const MAIN = 'main';
const ID = /^[\w-]{1,64}$/;
// Tab group colors repeat from the 9th group on (extension/src/connectedTabGroup.ts): warn, never cap.
const WARN_AFTER = 8;
const SWEEP_MS = 5000;

export function agentRoutingEnabled(config: FullConfig): boolean {
  if (process.env.PLAYWRIGHT_MCP_AGENT_ROUTING === 'off')
    return false;
  if (config.browser.remoteEndpoint || config.browser.cdpEndpoint || config.sharedBrowserContext)
    return false;
  // Persistent profile: a second backend fails with "use --isolated", so routing stays off there.
  return !!config.browser.isolated || !!config.extension;
}

export function withAgentRouting(inner: ServerBackendFactory, config: FullConfig): ServerBackendFactory {
  return agentRoutingEnabled(config) ? { ...inner, create: async clientInfo => new AgentRouter(inner, clientInfo) } : inner;
}

type Entry = { promise: Promise<ServerBackend>, inFlight: number, idle?: NodeJS.Timeout };

class AgentRouter extends EventEmitter<{ disconnected: [], dynamictoolschange: [] }> implements ServerBackend {
  private _entries = new Map<string, Entry>();
  private _main: ServerBackend | undefined;
  private _mainLabel: string | undefined;
  // A Workflow agent with high effort can think for a long time between browser calls.
  private _idleMs = Number(process.env.PLAYWRIGHT_MCP_AGENT_IDLE_MS) || 30 * 60_000;
  private _inner: ServerBackendFactory;
  private _clientInfo: ClientInfo;
  // Release markers: a SubagentStop hook drops <root>/<sessao>/<agente> when that agent ends (FORK.md § Agent routing).
  private _releaseRoot = process.env.PLAYWRIGHT_MCP_AGENT_RELEASE_DIR || path.join(os.homedir(), '.playwright-mcp', 'agentes-fim');
  private _sessions = new Set<string>();
  private _sweepTimer: NodeJS.Timeout | undefined;

  constructor(inner: ServerBackendFactory, clientInfo: ClientInfo) {
    super();
    this._inner = inner;
    this._clientInfo = clientInfo;
  }

  async initialize(clientInfo: ClientInfo) {
    // No browser opens here: each agent opens its own on its first call.
    this._clientInfo = clientInfo;
  }

  dynamicTools(): Tool[] {
    // tools/list carries no caller, so only the main agent's page WebMCP tools are listed.
    return this._main?.dynamicTools?.() ?? [];
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'] = {}, signal: AbortSignal): Promise<CallToolResult> {
    const meta = (args._meta && typeof args._meta === 'object' ? args._meta : {}) as { agente?: unknown, agenteTipo?: unknown, sessao?: unknown };
    if (typeof meta.sessao === 'string' && ID.test(meta.sessao))
      this._watch(meta.sessao);
    const key = typeof meta.agente === 'string' && ID.test(meta.agente) ? meta.agente : MAIN;
    // Release ended agents before picking the entry. The caller's own marker is only deleted: an agent that calls is
    // alive (resumed after its SubagentStop, or kept going by another hook), so it keeps its browser.
    this._sweep(key);
    const entry = this._entryFor(key, meta.agenteTipo);
    entry.inFlight++;
    clearTimeout(entry.idle);
    try {
      const result = await (await entry.promise).callTool(name, args, signal);
      // The backend already disposed itself on close (browserBackend.ts isClose); 'disconnected' may not follow.
      if (!result.isError && name === 'browser_close')
        this._drop(key, entry, false);
      if (!result.isError && key === MAIN && name === 'browser_set_group_label')
        this._mainLabel = String(args.label);
      return result;
    } finally {
      entry.inFlight--;
      // Idle only counts with nothing in flight: a long call must never lose its browser. Main never expires.
      if (key !== MAIN && !entry.inFlight && this._entries.get(key) === entry)
        entry.idle = setTimeout(() => this._drop(key, entry, true), this._idleMs).unref();
    }
  }

  private _entryFor(key: string, tipo: unknown): Entry {
    const existing = this._entries.get(key);
    if (existing)
      return existing;
    const clientName = key === MAIN ? this._clientInfo.clientName : `${this._mainLabel ?? this._clientInfo.clientName} · ${shortType(tipo)}-${key.slice(-4)}`;
    // clientName becomes the tab group title in extension mode (browserFactory.ts createExtensionBrowser).
    const clientInfo = { ...this._clientInfo, clientName };
    const entry = { inFlight: 0 } as Entry;
    routerDebug(`create key=${key} clientName=${clientName}`);
    // Patch 7: a sub-agent's extension relay connects and opens tabs in the background (cdpRelay.ts, FORK.md § Silent connect).
    const created = key === MAIN ? this._inner.create(clientInfo) : relayScope.run({ background: true }, () => this._inner.create(clientInfo));
    entry.promise = created.then(async backend => {
      await backend.initialize?.(clientInfo);
      // NEVER re-emit 'disconnected' upwards: the server would drop every agent, main included (server.ts).
      backend.once('disconnected', () => this._drop(key, entry, true));
      if (key === MAIN) {
        this._main = backend;
        backend.on?.('dynamictoolschange', () => this.emit('dynamictoolschange'));
      }
      return backend;
    });
    // A failed create is forgotten, so the next call of that agent tries again.
    entry.promise.catch(() => this._drop(key, entry, false));
    // Set synchronously: two parallel first calls of the same agent share one create.
    this._entries.set(key, entry);
    if (this._entries.size === WARN_AFTER + 1) {
      // eslint-disable-next-line no-console
      console.error(`Playwright MCP agent router: ${this._entries.size} agents hold a browser at once; tab group colors start repeating.`);
    }
    return entry;
  }

  private _watch(sessao: string) {
    if (this._sessions.has(sessao))
      return;
    this._sessions.add(sessao);
    this._ensureSessionDir(sessao);
    this._sweepTimer ??= setInterval(() => this._sweep(), SWEEP_MS).unref();
  }

  private _ensureSessionDir(sessao: string) {
    try {
      fs.mkdirSync(path.join(this._releaseRoot, sessao), { recursive: true });
    } catch (e) {
      routerDebug(`release dir for ${sessao}: ${e}`);
    }
  }

  private _sweep(caller?: string) {
    for (const sessao of this._sessions) {
      const dir = path.join(this._releaseRoot, sessao);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // Gone (an older server of the same session removed it on dispose): recreate, or markers would never land.
        this._ensureSessionDir(sessao);
        continue;
      }
      for (const agente of names) {
        // The caller's own marker is stale (it is calling, so it is alive): delete it, keep the browser.
        const entry = agente === caller ? undefined : this._entries.get(agente);
        // An agent ending with a call in flight (Esc, crash): keep the marker, the next sweep releases it.
        if (agente !== MAIN && entry?.inFlight)
          continue;
        try {
          fs.unlinkSync(path.join(dir, agente));
        } catch (e) {
          // A marker that cannot be removed (not a file) would release the agent on every sweep: ignore it.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            continue;
        }
        routerDebug(agente === caller ? `stale marker key=${agente} (caller)` : `release key=${agente} known=${!!entry}`);
        // Unknown key: the marker is only deleted, a browser is never created for it. Main is never released.
        if (agente !== MAIN && entry)
          this._drop(agente, entry, true);
      }
    }
  }

  private _drop(key: string, entry: Entry, dispose: boolean) {
    if (this._entries.get(key) !== entry)
      return;
    routerDebug(`drop key=${key} dispose=${dispose}`);
    this._entries.delete(key);
    clearTimeout(entry.idle);
    if (key === MAIN)
      this._main = undefined;
    if (dispose)
      void entry.promise.then(backend => backend.dispose?.()).catch(() => {});
  }

  async dispose() {
    // Synchronous and first: on stdio the client kills the process soon after closing stdin.
    clearInterval(this._sweepTimer);
    this._sweepTimer = undefined;
    for (const sessao of this._sessions) {
      try {
        fs.rmSync(path.join(this._releaseRoot, sessao), { recursive: true, force: true });
      } catch (e) {
        // A leftover folder is harmless (empty markers); never let it keep the backends alive.
        routerDebug(`release dir for ${sessao}: ${e}`);
      }
    }
    this._sessions.clear();
    const entries = [...this._entries.values()];
    this._entries.clear();
    this._main = undefined;
    for (const entry of entries)
      clearTimeout(entry.idle);
    await Promise.allSettled(entries.map(entry => entry.promise.then(backend => backend.dispose?.())));
  }
}

const shortType = (tipo: unknown) => tipo === 'general-purpose' ? 'gp' : tipo === 'workflow-subagent' ? 'wf'
  : typeof tipo === 'string' && ID.test(tipo) ? tipo.slice(0, 16) : 'agente';
