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

function runAndExit(command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  child.on('exit', (code, signal) => {
    if (signal)
      process.kill(process.pid, signal);
    else
      process.exit(code === null ? 1 : code);
  });
  child.on('error', error => {
    log(`failed to launch ${command}: ${error.message}`);
    process.exit(1);
  });
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
function envForAiSession(env, origem) {
  if (!/^ia:/.test(origem || ''))
    return env;
  const out = { ...env };
  delete out.PLAYWRIGHT_MCP_EXTENSION;
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

function main() {
  const rawArgv = process.argv.slice(2);
  const argv = argvForAiSession(rawArgv, process.env.CENTRAL_ORIGEM);
  const env = envForActiveProfile(envForAiSession(process.env, process.env.CENTRAL_ORIGEM), argv);
  if (argv !== rawArgv)
    log(`CENTRAL_ORIGEM=${process.env.CENTRAL_ORIGEM}: AI-opened session, swapping extension mode for isolated headless chromium`);
  if (isForkStale()) {
    triggerBackgroundBuild();
    // shell: true is required on Windows for the same reason as above (npx
    // is a .cmd shim). argv is whatever ~/.claude.json passes us (e.g.
    // `--extension --browser chrome`) - trusted local config, not
    // attacker-controlled input, so unescaped shell concatenation is fine here.
    runAndExit('npx', [...NPX_FALLBACK_ARGS, ...argv], { shell: true, env });
  } else {
    runAndExit(process.execPath, [ENTRY, ...argv], { env });
  }
  // After the spawn, never before: see schedulePrune.
  schedulePrune({ cwd: process.cwd(), env, argv });
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
};
