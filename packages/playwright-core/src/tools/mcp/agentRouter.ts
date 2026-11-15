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
import { USE_PROFILE_TOOL, chromeProfileNames, describeVariant, extensionProfileOf, extensionUserDataDir, notApplicableText, startVariant, unusableVariantError, usableVariant, useProfileDescription, vaultVariants } from '../backend/useProfile';

import type { CallToolRequest, CallToolResult, ClientInfo, ServerBackend, ServerBackendFactory, Tool } from '../utils/mcp/server';
import type { FullConfig } from './config';
import type { ExtensionProfile } from '../backend/extensionSession';

const routerDebug = debug('pw:mcp:router');

const MAIN = 'main';
const ID = /^[\w-]{1,64}$/;
// Tab group colors repeat from the 9th group on (extension/src/tabGroupManager.ts): warn, never cap.
const WARN_AFTER = 8;
const SWEEP_MS = 5000;
// Routers whose session folders go on process exit (see _watch).
const routersWithSessions = new Set<AgentRouter>();
let exitListener: (() => void) | undefined;

export function agentRoutingEnabled(config: FullConfig): boolean {
  if (process.env.PLAYWRIGHT_MCP_AGENT_ROUTING === 'off')
    return false;
  if (config.browser.remoteEndpoint || config.browser.cdpEndpoint || config.sharedBrowserContext)
    return false;
  // Persistent profile: a second backend fails with "use --isolated", so routing stays off there.
  return !!config.browser.isolated || !!config.extension;
}

// `env` is only passed by tests; the server reads the vault from its own env.
export function withAgentRouting(inner: ServerBackendFactory, config: FullConfig, env: NodeJS.ProcessEnv = process.env): ServerBackendFactory {
  if (!agentRoutingEnabled(config))
    return inner;
  const extension = !!config.extension;
  const profileNames = () => chromeProfileNames(extensionUserDataDir(config.browser?.userDataDir, config.browser?.launchOptions?.channel, env));
  // Patch 9: the description of browser_use_profile lists the vault, read once at start (decision D1).
  const toolSchemas = inner.toolSchemas.map(schema => schema.name === USE_PROFILE_TOOL && extension ? {
    ...schema,
    description: useProfileDescription(vaultVariants(env), profileNames(), startVariant(env)),
  } : schema);
  return { ...inner, toolSchemas, create: async clientInfo => new AgentRouter(inner, clientInfo, { extension, env, profileNames }) };
}

type RouterOptions = {
  // --extension: browser_use_profile switches profiles; without it the tool answers that it does not apply.
  extension: boolean;
  // Where the vault is read (PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variant>, PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variant>).
  env: NodeJS.ProcessEnv;
  // Chrome's names of its profiles, by folder.
  profileNames: () => Map<string, string>;
};

// Upper bound for the switch to wait for the old backends to close (a create still connecting can take 30 s).
const SWITCH_WAIT_MS = 10_000;

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
  // Patch 9: the vault variant chosen with browser_use_profile, for every agent of this conversation (decision D2).
  // Undefined = the env's token and profile (the wrapper's folder table already applied, decision D3).
  private _profile: ExtensionProfile | undefined;
  private _options: RouterOptions;

  constructor(inner: ServerBackendFactory, clientInfo: ClientInfo, options: RouterOptions) {
    super();
    this._inner = inner;
    this._clientInfo = clientInfo;
    this._options = options;
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
    // Patch 9: handled here, before any backend exists, so the switch never opens a browser in the old profile.
    if (name === USE_PROFILE_TOOL)
      return await this._useProfile(args.profile);
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
    // Patch 7: a sub-agent's extension relay connects and opens tabs in the background (cdpRelay.ts, FORK.md § Foco zero).
    // Patch 9: every agent's relay uses the profile chosen with browser_use_profile (extensionContextFactory.ts).
    const created = relayScope.run({ background: key !== MAIN, profile: this._profile }, () => this._inner.create(clientInfo));
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

  // Patch 9 (roadmap/2026-11-15-perfil-por-conversa.md). Synchronous up to the drop, so two switches at the same time
  // end on the last one and no agent gets a backend of a profile that is no longer chosen.
  private async _useProfile(profile: unknown): Promise<CallToolResult> {
    // D5: no extension, no profile (an `ia:*` session runs an isolated chromium).
    if (!this._options.extension)
      return textResult(notApplicableText());
    const name = typeof profile === 'string' ? profile : '';
    const variants = vaultVariants(this._options.env);
    const chosen = variants.find(variant => variant.name === name);
    // D4: a variant without a token or a profile folder changes nothing.
    if (!chosen || !usableVariant(chosen))
      return errorResult(unusableVariantError(name, variants));
    const names = this._options.profileNames;
    if (this._isCurrent(chosen))
      return textResult(`Already using profile ${describeVariant(chosen, names())}. Nothing changed.`);
    this._profile = extensionProfileOf(chosen);
    // The group names of the agents came from main's label in the old profile.
    this._mainLabel = undefined;
    const entries = [...this._entries];
    for (const [key, entry] of entries)
      this._drop(key, entry, false);
    // D6: the variant and its folder only, never the token.
    routerDebug(`use profile variant=${chosen.name} profileDir=${chosen.profileDirName} closing=${entries.length}`);
    // Wait for the old relays to go before answering: their agent tabs close (patch 3), and the next call does not race
    // them. Bounded: a backend still connecting to the old profile is disposed whenever its create ends.
    const disposed = Promise.allSettled(entries.map(([, entry]) => entry.promise.then(backend => backend.dispose?.())));
    await Promise.race([disposed, new Promise(resolve => setTimeout(resolve, SWITCH_WAIT_MS).unref())]);
    const closed = entries.length ? `Closed the browser of ${entries.length} agent(s) of this conversation in the old profile.` : 'No browser was open.';
    return textResult(`Now using profile ${describeVariant(chosen, names())}. ${closed} The next browser call opens in this profile.`);
  }

  private _isCurrent(variant: { name: string, profileDirName: string }): boolean {
    if (this._profile)
      return this._profile.variant === variant.name;
    // Nothing chosen yet: the server's start variant, when its profile folder is the one the env pins.
    const env = this._options.env;
    return startVariant(env)?.name === variant.name && env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME === variant.profileDirName;
  }

  private _watch(sessao: string) {
    if (this._sessions.has(sessao))
      return;
    this._sessions.add(sessao);
    this._ensureSessionDir(sessao);
    this._sweepTimer ??= setInterval(() => this._sweep(), SWEEP_MS).unref();
    // On stdio the server no longer disposes the backend when stdin ends (upstream 12/11: the exit watchdog closes the
    // browsers and exits), so the session folder also goes on process exit.
    // One process listener for every router (the HTTP mode has a router per client).
    routersWithSessions.add(this);
    if (!exitListener) {
      exitListener = () => [...routersWithSessions].forEach(router => router._removeSessionDirs());
      process.once('exit', exitListener);
    }
  }

  _removeSessionDirs() {
    routersWithSessions.delete(this);
    for (const sessao of this._sessions) {
      try {
        fs.rmSync(path.join(this._releaseRoot, sessao), { recursive: true, force: true });
      } catch (e) {
        // A leftover folder is harmless (empty markers); never let it keep the backends alive.
        routerDebug(`release dir for ${sessao}: ${e}`);
      }
    }
    this._sessions.clear();
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
    this._removeSessionDirs();
    const entries = [...this._entries.values()];
    this._entries.clear();
    this._main = undefined;
    for (const entry of entries)
      clearTimeout(entry.idle);
    await Promise.allSettled(entries.map(entry => entry.promise.then(backend => backend.dispose?.())));
  }
}

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text: `### Result\n${text}` }] });
const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text: `### Error\n${text}` }], isError: true });

const shortType = (tipo: unknown) => tipo === 'general-purpose' ? 'gp' : tipo === 'workflow-subagent' ? 'wf'
  : typeof tipo === 'string' && ID.test(tipo) ? tipo.slice(0, 16) : 'agente';
