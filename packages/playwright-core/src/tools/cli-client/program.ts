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

/* eslint-disable no-restricted-properties */

import { execFileSync, spawn } from 'child_process';

import crypto from 'crypto';
import path from 'path';

import { isKnownChannel, listChannelSessions } from './channelSessions';
import { sessionOwnershipPolicy } from './ownership';
import { JsonOutput, TextOutput } from './output';
import { isPlaywrightDaemonCommand } from './processUtils';
import { clientKey, createClientInfo, explicitSessionName, Registry, resolveSessionName } from './registry';
import { Session } from './session';
import { SessionLockTimeoutError, withSessionLock, withSessionLockIfAvailable } from './sessionLock';
import { libPath } from '../../package';
import { serverRegistry } from '../../serverRegistry';
import { minimist } from './minimist';

import type { ListData, ListedBrowser, Output } from './output';
import type { ClientInfo, SessionFile } from './registry';
import type { MinimistArgs } from './minimist';
import type { SessionPolicyAction } from './ownership';

type GlobalOptions = {
  help?: boolean;
  json?: boolean;
  raw?: boolean;
  session?: string;
  version?: boolean;
};

type AttachOptions = {
  config?: string;
  cdp?: string;
  endpoint?: string;
  extension?: boolean | string;
};

type OpenOptions = {
  browser?: string;
  config?: string;
  device?: string;
  headed?: boolean;
  mobile?: boolean;
  persistent?: boolean;
  profile?: string;
};

const globalOptions: (keyof (GlobalOptions & OpenOptions & AttachOptions))[] = [
  'json',
  'raw',
  'session',
];

const booleanOptions: (keyof (GlobalOptions & OpenOptions & AttachOptions & { all?: boolean }))[] = [
  'all',
  'help',
  'json',
  'raw',
  'version',
];

export async function program(options?: { embedderVersion?: string}) {
  const clientInfo = createClientInfo();
  const help = require(libPath('tools', 'cli-client', 'help.json'));

  const argv = process.argv.slice(2);
  const boolean = [...help.booleanOptions, ...booleanOptions];
  const args: MinimistArgs = minimist(argv, { boolean, string: ['_'] });
  // Normalize -s alias to --session
  if (args.s) {
    args.session = args.s;
    delete args.s;
  }

  const output: Output = args.json ? new JsonOutput() : new TextOutput();
  const commandName = args._?.[0];

  if (args.version || args.v) {
    output.version(options?.embedderVersion ?? clientInfo.version);
    process.exit(0);
  }

  const command = commandName && help.commands[commandName];
  if (args.help || args.h || !commandName) {
    if (command) {
      output.help(command.help);
    } else {
      const lines = ['playwright-cli - run playwright mcp commands from terminal'];
      if (process.env.CLAUDECODE || process.env.COPILOT_CLI)
        lines.push(`Agent skill: ${path.relative(process.cwd(), libPath('tools', 'cli-client', 'skill', 'SKILL.md'))}`);
      lines.push(help.global);
      output.help(lines.join('\n\n'));
    }
    process.exit(0);
  }

  if (!command)
    output.errorUnknownCommand(commandName, help.global);

  validateFlags(args, command, output);
  validateArgs(args, command, output);

  const registry = await Registry.load();
  const sessionName = resolveSessionName(args.session as string);

  switch (commandName) {
    case 'list': {
      const all = !!args.all;
      const data = await collectList(registry, clientInfo, all, clientInfo.owner !== undefined || (all && output.json));
      output.list(data);
      return;
    }
    case 'close-all': {
      const entries = registry.entries(clientInfo);
      const closed: string[] = [];
      const lockContended: string[] = [];
      let skipped = 0;
      for (const entry of entries) {
        try {
          await withSessionLock(clientInfo, entry.config.name, async () => {
            const currentEntry = await Registry.readEntry(clientInfo, entry.config.name);
            if (!currentEntry)
              return;
            const action = sessionOwnershipPolicy(clientInfo.owner, currentEntry.config.owner, 'open', 'close-all');
            if (action === 'skip') {
              skipped++;
              return;
            }
            await new Session(currentEntry).stop();
            closed.push(currentEntry.config.name);
          });
        } catch (error) {
          if (!(error instanceof SessionLockTimeoutError))
            throw error;
          lockContended.push(entry.config.name);
        }
      }
      output.closeAll(closed, clientInfo.owner !== undefined || skipped > 0 ? skipped : undefined, lockContended);
      return;
    }
    case 'delete-data': {
      const result = await withSessionLock(clientInfo, sessionName, async () => {
        const entry = await Registry.readEntry(clientInfo, sessionName);
        if (!entry)
          return { existed: false, deletedUserDataDir: false };
        assertPolicyAllows(sessionOwnershipPolicy(clientInfo.owner, entry.config.owner, 'open', 'use'), sessionName, 'delete its data');
        return await new Session(entry).deleteData();
      });
      output.deleteData(sessionName, result);
      return;
    }
    case 'kill-all': {
      assertPolicyAllows(sessionOwnershipPolicy(clientInfo.owner, undefined, 'none', 'kill-all'), sessionName, 'kill all daemons');
      const pids = await killAllDaemons(await ownedLiveDaemonPids());
      output.killAll(pids);
      return;
    }
    case 'open': {
      const params = args._.slice(1);
      const { pid, toolText } = await startSession(sessionName, clientInfo, args, 'open', { _: ['goto', ...(params.length ? params : ['about:blank'])] }, output);
      output.open(sessionName, pid, toolText);
      return;
    }
    case 'attach': {
      const attachTarget = args._[1] as string | undefined;
      const targetCount = (attachTarget ? 1 : 0) + (args.cdp ? 1 : 0) + (args.endpoint ? 1 : 0) + (args.extension ? 1 : 0);
      if (targetCount > 1)
        output.errorAttachConflict();
      const endpointTarget = attachTarget ?? (typeof args.endpoint === 'string' ? args.endpoint : undefined);
      if (endpointTarget)
        assertAttachTargetOwnership(registry, clientInfo.owner, endpointTarget);
      if (attachTarget)
        args.endpoint = attachTarget;
      const extensionChannel = typeof args.extension === 'string' ? args.extension : undefined;
      if (extensionChannel) {
        args.browser = extensionChannel;
        args.extension = true;
      }

      const cdpChannel = typeof args.cdp === 'string' && isKnownChannel(args.cdp) ? args.cdp : undefined;
      const targetName = attachTarget ?? cdpChannel ?? extensionChannel ?? args.endpoint as string ?? args.cdp as string;
      if (!targetName)
        output.errorAttachNoTarget();
      const attachSessionName = explicitSessionName(args.session as string) ?? attachTarget ?? cdpChannel ?? extensionChannel ?? sessionName;
      args.session = attachSessionName;
      const { pid, toolText } = await startSession(attachSessionName, clientInfo, args, 'attach', { _: ['snapshot'], filename: '<auto>' }, output);
      output.attach(attachSessionName, pid, targetName, toolText);
      return;
    }
    case 'close': {
      const { wasOpen } = await withSessionLock(clientInfo, sessionName, async () => {
        const closeEntry = await Registry.readEntry(clientInfo, sessionName);
        if (!closeEntry)
          return { wasOpen: false };
        assertPolicyAllows(sessionOwnershipPolicy(clientInfo.owner, closeEntry.config.owner, 'open', 'use'), sessionName, 'close it');
        return await new Session(closeEntry).stop();
      });
      output.close(sessionName, wasOpen);
      return;
    }
    case 'detach': {
      const { wasOpen } = await withSessionLock(clientInfo, sessionName, async () => {
        const detachEntry = await Registry.readEntry(clientInfo, sessionName);
        if (!detachEntry)
          return { wasOpen: false };
        assertPolicyAllows(sessionOwnershipPolicy(clientInfo.owner, detachEntry.config.owner, 'open', 'use'), sessionName, 'detach it');
        if (!detachEntry.config.attached)
          output.errorDetachNotAttached(sessionName);
        return await new Session(detachEntry).stop();
      });
      output.detach(sessionName, wasOpen);
      return;
    }
    case 'install':
      await runInitWorkspace(args, output);
      output.installed();
      return;
    case 'install-browser':
      await installBrowser();
      output.installed();
      return;
    case 'show': {
      const daemonScript = libPath('entry', 'dashboardApp.js');
      const daemonArgs = [
        daemonScript,
        `--workspaceDir=${clientInfo.workspaceDir ?? ''}`,
      ];
      // Only pass --sessionName when the user explicitly requested a session
      // (via -s/--session or PLAYWRIGHT_CLI_SESSION). Bare `playwright cli show`
      // opens the dashboard generically, with no specific session to reveal,
      // so the daemon should ack as soon as it's ready rather than waiting for
      // a reveal that was never asked for.
      const explicit = explicitSessionName(args.session as string);
      if (explicit)
        daemonArgs.push(`--sessionName=${explicit}`);
      if (args.port !== undefined)
        daemonArgs.push(`--port=${args.port}`);
      if (args.host !== undefined)
        daemonArgs.push(`--host=${args.host as string}`);
      if (args.kill) {
        daemonArgs.push(`--kill`);
        const child = spawn(process.execPath, daemonArgs, { stdio: 'ignore' });
        await new Promise<void>(resolve => child.on('exit', () => resolve()));
        return;
      }
      if (args.annotate) {
        args.raw = true;
        const text = await runOwnedSession(sessionName, clientInfo, args, output);
        output.toolResult(text);
        return;
      }
      const foreground = args.port !== undefined;
      const child = spawn(process.execPath, daemonArgs, {
        detached: !foreground,
        stdio: foreground ? 'inherit' : ['pipe', 'pipe', 'ignore'],
      });
      if (foreground) {
        await new Promise<void>(resolve => child.on('exit', () => resolve()));
        return;
      }
      const timer = setTimeout(() => child.stdin!.destroy(), 60_000);
      child.unref();
      let daemonPid: number;
      try {
        await new Promise<void>((resolve, reject) => {
          let outLog = '';
          child.stdout!.on('data', data => {
            outLog += data.toString();
            const match = outLog.match(/Dashboard is running pid=(\d+)/);
            if (match) {
              daemonPid = Number(match[1]);
              resolve();
            }
          });
          child.once('exit', (code, signal) => reject(new Error(`Dashboard daemon exited (code=${code}, signal=${signal}) before signaling READY${outLog ? '\n' + outLog : ''}`)));
        });
      } finally {
        clearTimeout(timer);
        child.removeAllListeners('exit');
        child.stdin!.destroy();
        child.stdout!.destroy();
      }
      output.show(sessionName, daemonPid!);
      return;
    }
    default: {
      if (command.raw)
        args.raw = true;
      const text = await runOwnedSession(sessionName, clientInfo, args, output);
      output.toolResult(text);
    }
  }
}

async function startSession(sessionName: string, clientInfo: ClientInfo, args: MinimistArgs, mode: 'open' | 'attach', initialCommand: MinimistArgs, output: Output) {
  const { result, newEntry } = await withSessionLock(clientInfo, sessionName, async () => {
    const entry = await Registry.readEntry(clientInfo, sessionName);
    const status = entry ? await new Session(entry).status() : 'none';
    const action = sessionOwnershipPolicy(clientInfo.owner, entry?.config.owner, status, mode);
    assertPolicyAllows(action, sessionName, 'replace it');
    if (entry && action === 'restart')
      await new Session(entry).stop();
    if (entry && action === 'clear-and-create')
      await new Session(entry).deleteSessionConfig();

    const result = await Session.startDaemon(clientInfo, args, mode);
    const newEntry = await Registry.readEntry(clientInfo, sessionName);
    if (!newEntry)
      throw new Error(`Could not start the session "${sessionName}"`);
    return { result, newEntry };
  });
  const toolText = await runInSessionOrStop(newEntry, clientInfo, initialCommand, output);
  return { ...result, toolText };
}

async function runOwnedSession(sessionName: string, clientInfo: ClientInfo, args: MinimistArgs, output: Output): Promise<string> {
  const entry = await withSessionLock(clientInfo, sessionName, async () => {
    const entry = await Registry.readEntry(clientInfo, sessionName);
    if (!entry)
      output.errorBrowserNotOpenForTool(sessionName);
    assertPolicyAllows(sessionOwnershipPolicy(clientInfo.owner, entry.config.owner, 'open', 'use'), sessionName, 'use it');
    return entry;
  });
  return await runInSession(entry, clientInfo, args, output);
}

function assertAttachTargetOwnership(registry: Registry, callerOwner: string | undefined, target: string): void {
  for (const entries of registry.entryMap().values()) {
    for (const entry of entries) {
      if (entry.config.name !== target)
        continue;
      const action = sessionOwnershipPolicy(callerOwner, entry.config.owner, 'open', 'attach-target');
      assertPolicyAllows(action, target, 'attach to it');
    }
  }
}

function assertPolicyAllows(action: SessionPolicyAction, sessionName: string, operation: string): void {
  switch (action) {
    case 'allow':
    case 'create':
    case 'restart':
    case 'clear-and-create':
      return;
    case 'refuse-owner':
      throw new Error(`Session '${sessionName}' belongs to another owner; refusing to ${operation}`);
    case 'refuse-unresponsive':
      throw new Error(`Session '${sessionName}' is unresponsive; refusing to ${operation}`);
    case 'refuse-kill-all':
      throw new Error('kill-all is disabled when PLAYWRIGHT_CLI_OWNER is set; use close or close-all instead');
    case 'not-found':
    case 'skip':
    case 'keep':
    case 'remove':
      throw new Error(`Session '${sessionName}' ownership policy refused to ${operation}`);
  }
}

async function runInSession(entry: SessionFile, clientInfo: ClientInfo, args: MinimistArgs, output: Output): Promise<string> {
  const raw = !!args.raw;
  for (const globalOption of globalOptions)
    delete args[globalOption];
  const session = new Session(entry);
  const result = await session.run(clientInfo, args, { raw, json: output.json });
  return result.text;
}

// Used by `open` / `attach` after `startSession`: if the implicit goto/snapshot
// fails post-spawn (e.g. tool runtime error), stop the freshly-spawned daemon
// so we don't strand a detached browser. Pre-spawn arg validation lives in
// `validateArgs`; this is a defense-in-depth backstop for runtime errors.
async function runInSessionOrStop(entry: SessionFile, clientInfo: ClientInfo, args: MinimistArgs, output: Output): Promise<string> {
  try {
    return await runInSession(entry, clientInfo, args, output);
  } catch (e) {
    await withSessionLock(clientInfo, entry.config.name, async () => {
      const currentEntry = await Registry.readEntry(clientInfo, entry.config.name);
      if (!entry.config.instanceId || currentEntry?.config.instanceId !== entry.config.instanceId)
        return;
      await new Session(currentEntry).stop();
    }).catch(() => {});
    throw e;
  }
}

async function runInitWorkspace(args: MinimistArgs, output: Output) {
  const cliPath = libPath('entry', 'cliDaemon.js');
  const daemonArgs: string[] = [cliPath, '--init-workspace', ...(args.skills ? ['--init-skills', String(args.skills)] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, daemonArgs, {
      stdio: output.installStdio(),
      cwd: process.cwd(),
    });
    child.on('close', code => {
      if (code === 0)
        resolve();
      else
        reject(new Error(`Workspace initialization failed with exit code ${code}`));
    });
  });
}

async function installBrowser() {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  const { libCli } = require('../../coreBundle.js') as typeof import('../../coreBundle');
  const { program } = require('../../utilsBundle.js') as typeof import('../../utilsBundle');
  if (!program.version())
    libCli.decorateProgram(program);
  program.parse(argv);
}

async function killAllDaemons(excludedPids: Set<number>): Promise<number[]> {
  const pidFilterEnv = process.env.PWTEST_KILL_ALL_PID_FILTER_FOR_TEST;
  const pidFilter = pidFilterEnv ? new Set(pidFilterEnv.split(',').map(p => parseInt(p, 10)).filter(n => !isNaN(n))) : undefined;
  const killed: number[] = [];

  try {
    if (process.platform === 'win32') {
      const result = execFileSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
      ], { encoding: 'utf-8' });
      const parsed: unknown = JSON.parse(result || '[]');
      const processes = Array.isArray(parsed) ? parsed : [parsed];
      for (const processInfo of processes) {
        if (!processInfo || typeof processInfo !== 'object')
          continue;
        const record = processInfo as Record<string, unknown>;
        if (typeof record.ProcessId !== 'number' || typeof record.CommandLine !== 'string')
          continue;
        killDaemonProcess(record.ProcessId, record.CommandLine, pidFilter, excludedPids, killed);
      }
    } else {
      const result = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
      const lines = result.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (match)
          killDaemonProcess(Number(match[1]), match[2], pidFilter, excludedPids, killed);
      }
    }
  } catch (e) {
    // Silently handle errors - no processes to kill is fine
  }
  return killed;
}

function killDaemonProcess(pid: number, commandLine: string, pidFilter: Set<number> | undefined, excludedPids: Set<number>, killed: number[]): void {
  if (excludedPids.has(pid) || !isPlaywrightDaemonCommand(commandLine) || (pidFilter && !pidFilter.has(pid)))
    return;
  try {
    process.kill(pid, 'SIGKILL');
    killed.push(pid);
  } catch {
    // Process may have already exited.
  }
}

async function ownedLiveDaemonPids(): Promise<Set<number>> {
  const result = new Set<number>();
  const registry = await Registry.load();
  for (const entries of registry.entryMap().values()) {
    for (const entry of entries) {
      if (entry.config.owner === undefined || entry.config.pid === undefined)
        continue;
      const status = await new Session(entry).status();
      if (status !== 'stale')
        result.add(entry.config.pid);
    }
  }
  return result;
}

async function collectList(registry: Registry, clientInfo: ClientInfo, all: boolean, ownershipDetails: boolean): Promise<ListData> {
  const browsers: ListedBrowser[] = [];
  const entries = registry.entryMap();

  // List early to GC.
  const serverEntries = await serverRegistry.list();
  const key = clientKey(clientInfo);
  for (const [workspaceKey, list] of entries) {
    if (!all && workspaceKey !== key)
      continue;
    for (const entry of list) {
      const entryClientInfo = { ...clientInfo, daemonProfilesDir: entry.daemonDir };
      let currentEntry = await Registry.readEntry(entryClientInfo, entry.config.name);
      if (!currentEntry)
        continue;
      let session = new Session(currentEntry);
      let status = await session.status();
      const gcAction = sessionOwnershipPolicy(clientInfo.owner, session.config.owner, status, 'list-gc');
      if (gcAction === 'remove') {
        const attempt = await withSessionLockIfAvailable(entryClientInfo, entry.config.name, async () => {
          const lockedEntry = await Registry.readEntry(entryClientInfo, entry.config.name);
          if (!lockedEntry)
            return true;
          const lockedSession = new Session(lockedEntry);
          const lockedStatus = await lockedSession.status();
          if (sessionOwnershipPolicy(clientInfo.owner, lockedSession.config.owner, lockedStatus, 'list-gc') !== 'remove')
            return false;
          await lockedSession.deleteSessionConfig();
          return true;
        });
        if (attempt.acquired && attempt.value)
          continue;
        currentEntry = await Registry.readEntry(entryClientInfo, entry.config.name);
        if (!currentEntry)
          continue;
        session = new Session(currentEntry);
        status = await session.status();
      }
      const config = session.config;
      const channel = config.browser?.launchOptions.channel ?? config.browser?.browserName;
      browsers.push({
        name: session.name,
        workspace: workspaceKey,
        status,
        ...(ownershipDetails ? {
          owner: config.owner ?? null,
          pid: config.pid ?? null,
          startedAt: config.startedAt ?? null,
          ownedByCaller: clientInfo.owner === config.owner,
        } : {}),
        browserType: channel,
        userDataDir: config.browser?.userDataDir ?? null,
        headed: config.browser ? !config.browser.launchOptions.headless : undefined,
        persistent: !!config.cli.persistent,
        attached: !!config.attached,
        compatible: session.isCompatible(clientInfo),
        version: config.version,
      });
    }
  }

  if (!all)
    return { all, browsers, ownershipDetails };

  const servers = [...serverEntries.values()].flat();
  return { all, browsers, ownershipDetails, servers, channelSessions: await listChannelSessions() };
}

function validateFlags(args: MinimistArgs, command: { flags: Record<string, 'boolean' | 'string'>, help: string }, output: Output) {
  const unknownFlags: string[] = [];
  for (const key of Object.keys(args)) {
    if (key === '_')
      continue;
    if ((globalOptions as readonly string[]).includes(key))
      continue;
    if (!(key in command.flags))
      unknownFlags.push(key);
  }
  if (unknownFlags.length)
    output.errorUnknownOption(unknownFlags, command.help);
}

function validateArgs(args: MinimistArgs, command: { args: string[], help: string }, output: Output) {
  const positional = args._.slice(1);
  if (positional.length > command.args.length)
    output.errorTooManyArguments(command.args.length, positional.length, command.help);
}

export function calculateSha1(buffer: Buffer | string): string {
  const hash = crypto.createHash('sha1');
  hash.update(buffer);
  return hash.digest('hex');
}
