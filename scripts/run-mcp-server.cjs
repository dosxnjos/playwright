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

const NPX_FALLBACK_ARGS = ['-y', '@playwright/mcp@0.0.78'];

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

function main() {
  const argv = process.argv.slice(2);
  if (isForkStale()) {
    triggerBackgroundBuild();
    // shell: true is required on Windows for the same reason as above (npx
    // is a .cmd shim). argv is whatever ~/.claude.json passes us (e.g.
    // `--extension --browser chrome`) - trusted local config, not
    // attacker-controlled input, so unescaped shell concatenation is fine here.
    runAndExit('npx', [...NPX_FALLBACK_ARGS, ...argv], { shell: true });
  } else {
    runAndExit(process.execPath, [ENTRY, ...argv], {});
  }
}

main();
