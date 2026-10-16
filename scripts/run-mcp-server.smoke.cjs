#!/usr/bin/env node
/**
 * End-to-end smoke for the per-session TEMP of scripts/run-mcp-server.cjs (fork only). Unlike the unit test
 * it launches a REAL headless chromium through the fork's MCP server, so it needs the fork built and the
 * stamp up to date (`isForkStale()` false). It is the executor's proof, not a gate: never wire it into
 * .pre-commit-config.yaml. `node scripts/run-mcp-server.smoke.cjs` prints `smoke ok` or `smoke FAIL <step>`,
 * exit 0/1. With PLAYWRIGHT_MCP_SESSION_TEMP=0 in the environment it must print `smoke FAIL 4`.
 *
 * Roadmap: roadmap/2026-10-12-melhoria-temp-por-sessao-ia.md, Fase 1 passo 7. Steps:
 *   3 the AI session (CENTRAL_ORIGEM=ia:*) initializes and navigates (launches chromium)
 *   4 its TEMP is %TEMP%\pw-ia\<wrapper pid>-*, and the chromium profile lives inside it
 *   5 hard death, wrapper FIRST (its 'exit' handler never runs; the server survives because this process
 *     still holds the shared stdin pipe), then the server
 *   6 the dead session's folder is still there (the leftover the next launch must sweep)
 *   8 a new AI launch sweeps it, and on a clean stdin close removes its own folder
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// RUN_MCP_SERVER_PATH: a mutant copy of the wrapper (must sit in scripts/, it resolves the fork from its own location).
const WRAPPER = process.env.RUN_MCP_SERVER_PATH || path.join(__dirname, 'run-mcp-server.cjs');
const { isForkStale, isPidAlive } = require(WRAPPER);
const ROOT = path.join(os.tmpdir(), 'pw-ia');
const PROFILE = /^playwright_chromiumdev_profile-/;
const ARTIFACTS = /^playwright-artifacts-/;
const LEAK = /^(playwright_chromiumdev_profile|playwright-artifacts)-/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = [];
const created = new Set();

class Failure extends Error {
  constructor(step, detail) {
    super(detail || '');
    this.step = step;
  }
}

function rootProfiles() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(name => LEAK.test(name));
  } catch {
    return [];
  }
}

function sessionDirs(pid) {
  try {
    return fs.readdirSync(ROOT).filter(name => name.startsWith(`${pid}-`)).map(name => path.join(ROOT, name));
  } catch {
    return [];
  }
}

function launch() {
  const child = spawn(process.execPath, [WRAPPER, '--extension', '--browser', 'chrome'], {
    env: { ...process.env, CENTRAL_ORIGEM: 'ia:prova' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.out = '';
  child.err = '';
  child.exited = new Promise(resolve => child.once('exit', resolve));
  child.stdout.on('data', data => child.out += data);
  child.stderr.on('data', data => child.err += data);
  alive.push(child);
  return child;
}

async function waitFor(predicate, ms, step) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate())
      return;
    await sleep(100);
  }
  throw new Failure(step);
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function gotResponse(child, id) {
  return child.out.split('\n').some(line => {
    try {
      return JSON.parse(line).id === id;
    } catch {
      return false;
    }
  });
}

async function startSession(child, label) {
  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-mcp-server.smoke', version: '1' } } });
  await waitFor(() => gotResponse(child, 1), 30000, `3 initialize (${label})`);
  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
  await waitFor(() => gotResponse(child, 2), 60000, `3 navigate (${label})`);
}

function serverPidOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).server;
  } catch {
    return null;
  }
}

// chromium holds `lockfile` in its profile until it exits; the sweep gets EBUSY while it is still there.
function profileLocked(dir) {
  try {
    return fs.readdirSync(dir).filter(name => PROFILE.test(name)).some(name => fs.existsSync(path.join(dir, name, 'lockfile')));
  } catch {
    return false;
  }
}

async function closeCleanly(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    child.stdin.end();
  } catch {
    // Already closed.
  }
  await Promise.race([child.exited, sleep(20000)]);
}

// Whatever happened, leave no process and no folder behind: the smoke must not create the leak it checks for.
async function cleanUp() {
  for (const child of alive)
    await closeCleanly(child);
  for (const child of alive) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill();
  }
  // No kill by pid here: a pid read from a dead session's owner.json may belong to someone else by now. The
  // wrapper's kill-on-close job object takes the server down with it.
  await sleep(1500);
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Reported by the leftovers check of the next run, not worth failing here.
    }
  }
}

async function main() {
  if (isForkStale())
    throw new Failure('0', 'fork build is stale or missing: run `npm run build` and touch scripts/.build-stamp (FORK.md)');
  const profilesBefore = new Set(rootProfiles());

  const first = launch();
  const wrapperPid = first.pid;
  await startSession(first, 'first');

  const dirs = sessionDirs(wrapperPid);
  for (const dir of dirs)
    created.add(dir);
  if (dirs.length !== 1)
    throw new Failure('4', `expected one ${ROOT}\\${wrapperPid}-* folder, found ${dirs.length}`);
  const dead = dirs[0];
  const inside = fs.readdirSync(dead);
  if (!inside.some(name => PROFILE.test(name)) || !inside.some(name => ARTIFACTS.test(name)))
    throw new Failure('4', `expected a chromium profile AND a playwright-artifacts folder inside ${dead}, found: ${inside.join(', ')}`);

  // (5) hard death, wrapper first (D12): TerminateProcess runs no 'exit' handler, so the wrapper cleans nothing.
  // Measured 16/10/2026 on Windows: libuv puts every child in a kill-on-close job object, so the server (and
  // its chromium) die WITH the wrapper; the stdin-pipe trick from the roadmap does not keep the server alive.
  // Either way the leftover below is what a real hard kill leaves; if the server did survive, kill it too.
  const server = serverPidOf(dead);
  if (!server)
    throw new Failure('5', 'owner.json has no server pid');
  first.kill();
  await Promise.race([first.exited, sleep(5000)]);
  await sleep(1000);
  if (isPidAlive(server)) {
    try {
      process.kill(server); // the pid was read seconds ago from a session this smoke started
    } catch (error) {
      throw new Failure('5', `cannot kill the server ${server}: ${error.message}`);
    }
  }
  first.stdin.destroy();
  await waitFor(() => !isPidAlive(server) && !profileLocked(dead), 15000, '5 chromium still alive 15 s after the server died');
  await sleep(1000);

  // (6) the leftover the sweep exists for.
  if (!fs.existsSync(dead))
    throw new Failure('6', 'the dead session folder vanished before the next launch');
  const fresh = rootProfiles().filter(name => !profilesBefore.has(name));
  if (fresh.length)
    process.stderr.write(`smoke warning: new chromium profile/artifact folders in the %TEMP% root (another project's suite?): ${fresh.join(', ')}\n`);

  // (7) next AI launch: sweeps the dead folder (async, after its spawn), then a clean stdin close.
  const second = launch();
  await startSession(second, 'second');
  const secondDirs = sessionDirs(second.pid);
  for (const dir of secondDirs)
    created.add(dir);
  await sleep(5000);
  await closeCleanly(second);
  if (second.exitCode === null && second.signalCode === null)
    throw new Failure('8', 'the second wrapper did not exit within 20 s of the stdin close');

  // (8)
  if (fs.existsSync(dead))
    throw new Failure('8', `the dead session folder survived the next launch: ${dead}\n${second.err}`);
  if (sessionDirs(second.pid).length)
    throw new Failure('8', `the clean exit left ${sessionDirs(second.pid).join(', ')} behind\n${second.err}`);
}

main().then(async () => {
  await cleanUp();
  process.stdout.write('smoke ok\n');
  process.exit(0);
}, async error => {
  const step = error instanceof Failure ? error.step : 'unexpected';
  const detail = error && error.message || error;
  try {
    await cleanUp();
  } catch {
    // The verdict below matters more.
  }
  process.stdout.write(`smoke FAIL ${step}${detail ? `: ${detail}` : ''}\n`);
  process.exit(1);
});
