#!/usr/bin/env node
/**
 * Wrapper for ~/.claude.json's mcpServers.playwright entry.
 *
 * Runs the MCP server from this fork's local build (packages/playwright-core/
 * lib/entry/mcp.js) instead of always fetching @playwright/mcp from npm — but
 * never blocks the MCP handshake on a build. Measured on 2026-07-17: a cold
 * `npm run build` here takes ~28s and even a single-file touch takes ~18s
 * (build.js is not meaningfully incremental) — neither fits with margin under
 * Claude Code's ~30s server-startup timeout. So the rule is:
 *
 *   - Fork build up to date (stamp newer than everything under
 *     packages/playwright-core/src/) -> spawn the local fork immediately.
 *   - Fork stale or missing -> spawn the official npx package for THIS
 *     launch (never block), and kick off `npm run build` in the background
 *     (behind a lock, so concurrent launches don't race each other) so the
 *     *next* launch picks up the fresh fork.
 *   - Background build fails -> clear stderr message, stamp is left stale so
 *     every subsequent launch keeps retrying the build (still non-blocking)
 *     until the fork is fixed.
 *
 * See C:\Dev\playwright\CLAUDE.md, section "This fork", for the manual
 * override to force pure npx if this wrapper itself misbehaves.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'packages', 'playwright-core', 'src');
const ENTRY = path.join(ROOT, 'packages', 'playwright-core', 'lib', 'entry', 'mcp.js');
const STAMP_FILE = path.join(__dirname, '.build-stamp');
const LOCK_DIR = path.join(__dirname, '.build-lock');

const NPX_FALLBACK_ARGS = ['-y', '@playwright/mcp@0.0.83'];

function log(message) {
  process.stderr.write(`[run-mcp-server] ${message}\n`);
}

function latestMtimeUnder(dir) {
  let latest = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (mtimeMs > latest)
          latest = mtimeMs;
      }
    }
  }
  return latest;
}

function stampMtime() {
  try {
    return fs.statSync(STAMP_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function isForkStale() {
  if (!fs.existsSync(ENTRY))
    return true;
  return latestMtimeUnder(SRC_DIR) > stampMtime();
}

function tryAcquireBuildLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST')
      return false;
    throw error;
  }
}

function releaseBuildLock() {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // Already gone / never held - nothing to do.
  }
}

function triggerBackgroundBuild() {
  if (!tryAcquireBuildLock()) {
    log('another instance is already rebuilding the fork, skipping (using npx fallback for this launch)');
    return;
  }
  log('fork build is stale, rebuilding in background - this launch uses the npx fallback (see scripts/.build-log.txt for progress)');
  // Delegate to a fully detached, independent process rather than tracking
  // completion via an in-process 'exit' listener here: this wrapper process
  // may itself exit (e.g. a short-lived invocation) well before an 18-28s
  // build finishes, which would orphan that listener and leave the stamp/
  // lock stuck forever. background-build.cjs owns writing the stamp and
  // releasing the lock itself, regardless of our own lifetime.
  const build = spawn(process.execPath, [path.join(__dirname, 'background-build.cjs')], {
    detached: true,
    stdio: 'ignore',
  });
  build.unref();
}

// `options.onExit` (not passed to spawn) runs once, synchronously, right before this wrapper exits
// with the child's fate (child 'exit' or spawn 'error'); a throwing hook changes nothing. Returns the child.
function runAndExit(command, args, options) {
  const { onExit, ...spawnOptions } = options || {};
  let hookRan = false;
  const runHook = () => {
    if (hookRan || !onExit)
      return;
    hookRan = true;
    try {
      onExit();
    } catch {
      // The hook is housekeeping: it must never change how this wrapper exits.
    }
  };
  const child = spawn(command, args, { stdio: 'inherit', ...spawnOptions });
  child.on('exit', (code, signal) => {
    runHook();
    if (signal)
      process.kill(process.pid, signal);
    else
      process.exit(code === null ? 1 : code);
  });
  child.on('error', error => {
    log(`failed to launch ${command}: ${error.message}`);
    runHook();
    process.exit(1);
  });
  return child;
}

// Sessions opened BY an AI (central's maestro/board executors) export
// CENTRAL_ORIGEM="ia:<route>" (see C:\Dev\CLAUDE.md, "sessão iniciada por IA").
// Those sessions must never depend on the Chrome extension: overnight there is
// nobody/no browser to accept the connection, and the first tool call hangs
// silently until Claude Code's 1800s MCP idle timeout (measured 2026-08-21,
// two maestro rounds lost). For them, swap extension mode for a local isolated
// headless chromium; --isolated is required because concurrent AI sessions
// sharing one persistent profile would collide on chromium's ProcessSingleton.
// Human sessions (no marker, or "humano:*") keep the argv untouched.
function argvForAiSession(argv, origem) {
  if (!/^ia:/.test(origem || ''))
    return argv;
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extension' || argv[i] === '--isolated' || argv[i] === '--headless')
      continue;
    if (argv[i] === '--browser') {
      i++; // skip its value too
      continue;
    }
    out.push(argv[i]);
  }
  out.push('--browser', 'chromium', '--isolated', '--headless');
  return out;
}

// The argv is not the only way to ask for extension mode: the server also reads
// PLAYWRIGHT_MCP_EXTENSION from the environment (tools/mcp/config.ts) and merges
// it into the same `config.extension` that browser_set_group_label keys off. An
// AI session inheriting that variable would still be asking for the extension we
// just stripped from its argv - and would get an error on the very first tool
// call, which is what the chromium mode exists to avoid. Same branch, same rule.
//
// `sessionTemp` (see prepareSessionTemp) also becomes the TEMP of the server and of the Chromium it
// launches: os.tmpdir() reads TEMP then TMP on Windows, Chromium's GetTempPath reads TMP first, POSIX
// tools read TMPDIR. Null = leave the TEMP alone.
function envForAiSession(env, origem, sessionTemp) {
  if (!/^ia:/.test(origem || ''))
    return env;
  const out = { ...env };
  delete out.PLAYWRIGHT_MCP_EXTENSION;
  if (sessionTemp) {
    out.TEMP = sessionTemp;
    out.TMP = sessionTemp;
    out.TMPDIR = sessionTemp;
  }
  // Per-agent routing (FORK.md § Agent routing) stays off here until a maestro round with
  // browsing sub-agents is measured: in --isolated each agent gets its own browser context.
  out.PLAYWRIGHT_MCP_AGENT_ROUTING = 'off';
  return out;
}

// Every extension token in the vault (`PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variant>` in ~/.claude.json)
// has a Chrome profile folder registered beside it (`PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variant>`,
// e.g. `Profile 13`). The extension token lives in ONE profile; if the connect page opens in another
// one (Chrome uses the last-focused profile), the connection hangs or the token is offered to the
// wrong profile. So the profile follows the active token: swapping the token swaps the profile.
// An explicit PLAYWRIGHT_MCP_PROFILE_DIR_NAME always wins; the legacy PLAYWRIGHT_MCP_PROFILE_DIRECTORY
// (this fork's pre-v2 name) is honoured as a fallback. No token match -> warn, never guess.
function envForActiveProfile(env, argv) {
  if (!argv.includes('--extension') && env.PLAYWRIGHT_MCP_EXTENSION !== 'true' && env.PLAYWRIGHT_MCP_EXTENSION !== '1')
    return env;
  if (env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME)
    return env;
  const token = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (!token)
    return env;
  const prefix = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN__';
  const variant = Object.keys(env).find(key => key.startsWith(prefix) && env[key] === token);
  const profile = (variant && env['PLAYWRIGHT_MCP_PROFILE_DIR_NAME__' + variant.slice(prefix.length)]) || env.PLAYWRIGHT_MCP_PROFILE_DIRECTORY;
  if (!profile) {
    log(`active extension token${variant ? ` (variant "${variant.slice(prefix.length)}")` : ''} has no Chrome profile registered (PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variant>): the connect page may open in the wrong profile`);
    return env;
  }
  log(`Chrome profile "${profile}" chosen from the active extension token${variant ? ` (variant "${variant.slice(prefix.length)}")` : ' (legacy variable)'}`);
  return { ...env, PLAYWRIGHT_MCP_PROFILE_DIR_NAME: profile };
}

// Every tool call leaves a snapshot (`page-<timestamp>.yml`) or a log (`console-<timestamp>.log`)
// in `<cwd>/.playwright-mcp` (backend/context.ts::outputDir), and nothing ever removes them: on
// 2026-10-03 C:\Dev\unclick held 605 files / 110 MB going back three months. Each launch prunes the
// generated ones older than the retention (default 7 days; the agent reads its own session's snapshots
// by path, so a recent one must survive). Only first-level FILES whose name is the server's generated
// pattern go: never a subfolder, never a name someone chose (a screenshot saved on purpose). The prune
// runs after the server is spawned, all async, and a failure only reaches stderr: it can neither delay
// the ~30 s MCP startup nor kill it. PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS=0 turns it off.
const GENERATED_OUTPUT_NAME = /^(page|console|network|trace|video)-\d{4}-\d{2}-\d{2}T[\d-]+Z?(\.\w+)+$/;
const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function retentionDays(env, logFn = log) {
  const raw = env.PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS;
  if (raw === undefined || raw === '')
    return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    logFn(`PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS="${raw}" is not a number of days >= 0, using ${DEFAULT_RETENTION_DAYS}`);
    return DEFAULT_RETENTION_DAYS;
  }
  return days;
}

// Same folders the server writes to: the default `<cwd>/.playwright-mcp` plus an explicit output dir
// (PLAYWRIGHT_MCP_OUTPUT_DIR or `--output-dir`), both resolved against cwd like the server does.
function outputDirsToPrune(cwd, env, argv) {
  const dirs = [path.join(cwd, '.playwright-mcp')];
  if (env.PLAYWRIGHT_MCP_OUTPUT_DIR)
    dirs.push(path.resolve(cwd, env.PLAYWRIGHT_MCP_OUTPUT_DIR));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output-dir' && argv[i + 1])
      dirs.push(path.resolve(cwd, argv[i + 1]));
    else if (argv[i].startsWith('--output-dir='))
      dirs.push(path.resolve(cwd, argv[i].slice('--output-dir='.length)));
  }
  return [...new Set(dirs)];
}

// Windows answers EPERM (not ENOENT) to an unlink of a file that another process is deleting at that
// very moment (measured 2026-10-03: two prunes on the same 50 files, 7 EPERM). Give the other delete
// a moment to land; if the file is then gone, the race was harmless.
async function removedByAnotherLaunch(file, error) {
  if (error.code !== 'EPERM' && error.code !== 'EBUSY')
    return false;
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    await fs.promises.lstat(file);
    return false;
  } catch (statError) {
    return statError.code === 'ENOENT';
  }
}

// Prunes one folder. ENOENT is not an error: a cwd without `.playwright-mcp` is the common case, and
// every Claude Code session starts its own wrapper, so two launches race on the same files.
async function pruneOutputDir(dir, { days, now = Date.now(), dryRun = false, log: logFn = log }) {
  const result = { dir, scanned: 0, removed: 0, bytes: 0, errors: 0 };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.errors++;
      logFn(`output prune: cannot read ${dir}: ${error.message}`);
    }
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !GENERATED_OUTPUT_NAME.test(entry.name))
      continue;
    result.scanned++;
    const file = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.lstat(file);
      if (now - stat.mtimeMs <= days * DAY_MS)
        continue;
      if (!dryRun)
        await fs.promises.unlink(file);
      result.removed++;
      result.bytes += stat.size;
    } catch (error) {
      if (error.code === 'ENOENT' || await removedByAnotherLaunch(file, error))
        continue;
      result.errors++;
      logFn(`output prune: cannot remove ${file}: ${error.message}`);
    }
  }
  return result;
}

// Called by main() AFTER the server is spawned. The work starts on the next turn of the event loop,
// so the caller is never held up, and the returned promise never rejects (an unhandled rejection
// would kill this wrapper, and the server with it).
function schedulePrune({ cwd, env, argv, now, dryRun, log: logFn = log }) {
  const safeLog = message => {
    try {
      logFn(message);
    } catch {
      // A broken log must not break the start either.
    }
  };
  return new Promise(resolve => setImmediate(resolve)).then(async () => {
    const days = retentionDays(env, safeLog);
    if (days === 0)
      return [];
    const results = [];
    for (const dir of outputDirsToPrune(cwd, env, argv))
      results.push(await pruneOutputDir(dir, { days, now, dryRun, log: safeLog }));
    const removed = results.reduce((sum, r) => sum + r.removed, 0);
    if (removed) {
      const mb = results.reduce((sum, r) => sum + r.bytes, 0) / 1024 / 1024;
      safeLog(`output prune: removed ${removed} generated file(s) older than ${days} day(s), ${mb.toFixed(1)} MB`);
    }
    return results;
  }).catch(error => {
    safeLog(`output prune failed: ${error && error.message || error}`);
    return [];
  });
}

// An AI session that dies hard (TerminateProcess runs no handler) leaves the isolated chromium's
// profile (~11 MB, `playwright_chromiumdev_profile-*`) and `playwright-artifacts-*` in %TEMP%: 7 of them
// between 10 and 11/10/2026 while the disk of the central's machine neared its floor. Nothing inside the
// dying process can clean that, so each AI session gets its OWN TEMP, `<TEMP>\pw-ia\<pid>-<base36 time>`,
// and the NEXT AI launch sweeps the folders whose processes are gone. The wrapper only ever deletes what
// it created (name pattern below). A session that ends normally removes its own folder on exit. Any
// failure degrades to the default TEMP and a line on stderr: this must never block the MCP handshake.
// PLAYWRIGHT_MCP_SESSION_TEMP=0 turns all of it off.
const SESSION_DIR_NAME = /^\d+-[0-9a-z]+$/;
const SESSION_NO_OWNER_MIN_AGE_MS = 10 * 60 * 1000;

function sessionTempDisabled(env) {
  return env.PLAYWRIGHT_MCP_SESSION_TEMP === '0';
}

function sessionTempRoot() {
  return path.join(os.tmpdir(), 'pw-ia');
}

// owner.json is replaced atomically (write + rename): the sweep of a neighbouring launch may read it at any moment.
function writeSessionOwner(dir, owner) {
  const tmp = path.join(dir, 'owner.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(owner));
  fs.renameSync(tmp, path.join(dir, 'owner.json'));
}

// New folder per launch, never reused nor cleaned here: a recycled pid must not land on the folder of a live
// server, and the wrapper may die before its server wherever the OS does not tie the two together (on Windows
// libuv's kill-on-close job object does, measured 16/10/2026, but the rule must not depend on it).
// Returns the folder, or null (switched off, or any error: logged, never thrown).
function prepareSessionTemp(root, pid, { env = process.env, log: logFn = log, now = Date.now() } = {}) {
  if (sessionTempDisabled(env))
    return null;
  let dir;
  try {
    fs.mkdirSync(root, { recursive: true });
    dir = path.join(root, `${pid}-${now.toString(36)}`);
    fs.mkdirSync(dir);
    writeSessionOwner(dir, { wrapper: pid, server: null, createdAt: new Date(now).toISOString() });
    return dir;
  } catch (error) {
    try {
      logFn(`session temp: cannot create ${dir || root}: ${error.message}; using the default TEMP`);
    } catch {
      // A broken log must not break the start either.
    }
    try {
      if (dir)
        fs.rmSync(dir, { recursive: true, force: true }); // half-made (e.g. ENOSPC on owner.json): do not leave it behind
    } catch {
      // The sweep collects it later.
    }
    return null;
  }
}

// After the spawn: the server's pid joins the wrapper's in owner.json (a folder is dead only when BOTH are).
function recordServerPid(dir, serverPid) {
  try {
    const file = path.join(dir, 'owner.json');
    writeSessionOwner(dir, { ...JSON.parse(fs.readFileSync(file, 'utf8')), server: serverPid ?? null });
  } catch {
    // Without the server pid the folder is judged by the wrapper pid alone: still safe.
  }
}

function removeSessionTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Still held by a dying chromium: the next AI launch sweeps it.
  }
}

// EPERM = alive, owned by someone else (pid 4 on Windows). Anything but "no such process" counts as alive:
// a wrong "alive" only delays a cleanup, a wrong "dead" deletes the folder of a running server.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH')
      return false;
    return true;
  }
}

async function sessionTempIsLive(dir, name, now, isAlive) {
  let pids = null;
  try {
    const owner = JSON.parse(await fs.promises.readFile(path.join(dir, 'owner.json'), 'utf8'));
    pids = [owner.wrapper, owner.server].filter(pid => Number.isInteger(pid) && pid > 0);
    if (!pids.length)
      pids = null;
  } catch {
    // Missing or unreadable: judged by the pid in the folder name, and only once it is old enough.
  }
  if (!pids) {
    const stat = await fs.promises.stat(dir);
    if (now - stat.mtimeMs < SESSION_NO_OWNER_MIN_AGE_MS)
      return true; // a neighbour may be between its mkdir and the owner.json write
    pids = [Number(name.split('-')[0])];
  }
  return pids.some(pid => isAlive(pid));
}

async function sessionTempSize(dir) {
  let total = 0;
  try {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        total += await sessionTempSize(full);
      else
        total += (await fs.promises.lstat(full)).size;
    }
  } catch {
    // Size is only for the log line.
  }
  return total;
}

// Removes the session folders under `root` whose processes are all gone. Never rejects. A folder that cannot
// be removed right now (EBUSY/EPERM: something still holds a file) is skipped and logged; the next launch retries.
async function sweepSessionTemps(root, { ownDir, now = Date.now(), isAlive = isPidAlive, log: logFn = log } = {}) {
  const result = { removed: 0, skipped: 0, bytes: 0 };
  const safeLog = message => {
    try {
      logFn(message);
    } catch {
      // A broken log must not break the sweep either.
    }
  };
  try {
    let entries;
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT')
        safeLog(`session temp sweep: cannot read ${root}: ${error.message}`);
      return result;
    }
    const own = ownDir ? path.basename(ownDir).toLowerCase() : null;
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR_NAME.test(entry.name) || entry.name.toLowerCase() === own)
        continue;
      const dir = path.join(root, entry.name);
      try {
        if (await sessionTempIsLive(dir, entry.name, now, isAlive))
          continue;
        const bytes = await sessionTempSize(dir);
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        result.removed++;
        result.bytes += bytes;
      } catch (error) {
        result.skipped++;
        safeLog(`session temp sweep: cannot remove ${dir}: ${error.message}`);
      }
    }
    if (result.removed)
      safeLog(`session temp sweep: removed ${result.removed} dead session folder(s), ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    safeLog(`session temp sweep failed: ${error && error.message || error}`);
  }
  return result;
}

// Same shape as schedulePrune: starts on the next turn of the event loop, the caller is never held up.
function scheduleSessionTempSweep({ root, ownDir, now, isAlive, log: logFn = log }) {
  return new Promise(resolve => setImmediate(resolve))
      .then(() => sweepSessionTemps(root, { ownDir, now, isAlive, log: logFn }))
      .catch(() => ({ removed: 0, skipped: 0, bytes: 0 }));
}

function main() {
  const rawArgv = process.argv.slice(2);
  const argv = argvForAiSession(rawArgv, process.env.CENTRAL_ORIGEM);
  const aiSession = argv !== rawArgv;
  const sessionTemp = aiSession ? prepareSessionTemp(sessionTempRoot(), process.pid, { env: process.env }) : null;
  const env = envForActiveProfile(envForAiSession(process.env, process.env.CENTRAL_ORIGEM, sessionTemp), argv);
  if (aiSession)
    log(`CENTRAL_ORIGEM=${process.env.CENTRAL_ORIGEM}: AI-opened session, swapping extension mode for isolated headless chromium`);
  const onExit = sessionTemp ? () => removeSessionTemp(sessionTemp) : undefined;
  let child;
  if (isForkStale()) {
    triggerBackgroundBuild();
    // shell: true is required on Windows for the same reason as above (npx
    // is a .cmd shim). argv is whatever ~/.claude.json passes us (e.g.
    // `--extension --browser chrome`) - trusted local config, not
    // attacker-controlled input, so unescaped shell concatenation is fine here.
    child = runAndExit('npx', [...NPX_FALLBACK_ARGS, ...argv], { shell: true, env, onExit });
  } else {
    child = runAndExit(process.execPath, [ENTRY, ...argv], { env, onExit });
  }
  // After the spawn, never before: see schedulePrune.
  if (sessionTemp)
    recordServerPid(sessionTemp, child.pid);
  schedulePrune({ cwd: process.cwd(), env, argv });
  if (aiSession && !sessionTempDisabled(process.env))
    scheduleSessionTempSweep({ root: sessionTempRoot(), ownDir: sessionTemp });
}

if (require.main === module)
  main();

module.exports = {
  argvForAiSession,
  envForAiSession,
  envForActiveProfile,
  retentionDays,
  outputDirsToPrune,
  pruneOutputDir,
  schedulePrune,
  GENERATED_OUTPUT_NAME,
  runAndExit,
  sessionTempRoot,
  prepareSessionTemp,
  sweepSessionTemps,
  scheduleSessionTempSweep,
  isPidAlive,
  isForkStale,
};
