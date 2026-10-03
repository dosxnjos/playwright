#!/usr/bin/env node
/**
 * Unit test for the output-folder prune in scripts/run-mcp-server.cjs (fork only, not part of
 * the upstream test suites). Plain node, no runner: `node scripts/run-mcp-server.test.cjs`,
 * exit 0 = all green, 1 = at least one failure.
 *
 * RUN_MCP_SERVER_PATH points the test at another copy of the wrapper (used to run it against
 * mutants: every guard of the prune must make at least one case fail when removed).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPER = process.env.RUN_MCP_SERVER_PATH || path.join(__dirname, 'run-mcp-server.cjs');
const wrapper = require(WRAPPER);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-mcp-server-test-'));
}

function makeFile(dir, name, ageDays, content = 'x') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, when, when);
  return file;
}

function makeDir(dir, name, ageDays) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub);
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(sub, when, when);
  return sub;
}

function collectingLog() {
  const lines = [];
  const log = message => lines.push(message);
  log.lines = lines;
  return log;
}

test('the md cases: generated 8d goes, generated 6d stays, chosen name 30d stays, subfolder stays', async () => {
  const dir = tempDir();
  const old = makeFile(dir, 'page-2026-09-20T10-11-12-345Z.yml', 8);
  const young = makeFile(dir, 'page-2026-09-28T10-11-12-345Z.yml', 6);
  const chosen = makeFile(dir, 'meu-print.png', 30);
  const sub = makeDir(dir, 'page-2026-08-01T10-11-12-345Z.yml', 30);
  const inside = makeFile(sub, 'console-2026-08-01T10-11-12-345Z.log', 30);
  fs.utimesSync(sub, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  const log = collectingLog();
  const result = await wrapper.pruneOutputDir(dir, { days: 7, now: NOW, log });
  assert.deepStrictEqual(log.lines, [], 'a clean prune logs no error (a subfolder is skipped, not attempted)');
  assert.strictEqual(fs.existsSync(old), false, 'generated file of 8 days must be removed');
  assert.strictEqual(fs.existsSync(young), true, 'generated file of 6 days must stay');
  assert.strictEqual(fs.existsSync(chosen), true, 'file with a chosen name must stay');
  assert.strictEqual(fs.existsSync(sub), true, 'subfolder must stay, even with a generated-looking name');
  assert.strictEqual(fs.existsSync(inside), true, 'files inside a subfolder are never touched');
  assert.strictEqual(result.removed, 1);
  assert.strictEqual(result.bytes, 1);
});

test('every real generated name is matched; near misses are not', async () => {
  const dir = tempDir();
  const generated = [
    'page-2026-08-16T09-15-01-123Z.yml',
    'console-2026-08-16T09-15-01-123Z.log',
    'page-2026-08-16T09-15-01-123Z.png',
    'page-2026-08-16T09-15-01-123Z.jpeg',
    'page-2026-08-16T09-15-01-123Z.pdf',
    'network-2026-08-16T09-15-01-123Z.log',
    'trace-2026-08-16T09-15-01-123Z.trace.zip',
    'video-2026-08-16T09-15-01-123Z.webm',
  ];
  const kept = [
    'exp-pistache.png',
    'exp-2026.png',
    'page.yml',
    'page-final.png',
    'page-2026-08-16.png',
    'page-2026-08-16T09-15-01-123Z',
    'mypage-2026-08-16T09-15-01-123Z.yml',
    'page-2026-08-16T09-15-01-123Z.yml.bak copy',
  ];
  for (const name of [...generated, ...kept])
    makeFile(dir, name, 30);
  await wrapper.pruneOutputDir(dir, { days: 7, now: NOW, log: collectingLog() });
  for (const name of generated)
    assert.strictEqual(fs.existsSync(path.join(dir, name)), false, `${name} should have been pruned`);
  for (const name of kept)
    assert.strictEqual(fs.existsSync(path.join(dir, name)), true, `${name} must never be pruned`);
});

test('dry run removes nothing but reports what it would remove', async () => {
  const dir = tempDir();
  const old = makeFile(dir, 'console-2026-09-01T00-00-00-000Z.log', 20, 'abcd');
  const result = await wrapper.pruneOutputDir(dir, { days: 7, now: NOW, dryRun: true, log: collectingLog() });
  assert.strictEqual(fs.existsSync(old), true, 'dry run must not delete');
  assert.strictEqual(result.removed, 1, 'dry run still counts the would-be removals');
  assert.strictEqual(result.bytes, 4);
});

test('retention days come from PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS; 0 disables; garbage falls back to 7', () => {
  assert.strictEqual(wrapper.retentionDays({}, collectingLog()), 7);
  assert.strictEqual(wrapper.retentionDays({ PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS: '14' }, collectingLog()), 14);
  assert.strictEqual(wrapper.retentionDays({ PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS: '0' }, collectingLog()), 0);
  for (const bad of ['abc', '-3', '']) {
    const log = collectingLog();
    assert.strictEqual(wrapper.retentionDays({ PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS: bad }, log), 7, `"${bad}" falls back to 7`);
    if (bad !== '')
      assert.ok(log.lines.some(line => /RETENTION_DAYS/.test(line)), `"${bad}" is reported in the log`);
  }
});

test('retention 0 prunes nothing at all', async () => {
  const cwd = tempDir();
  const dir = path.join(cwd, '.playwright-mcp');
  fs.mkdirSync(dir);
  const old = makeFile(dir, 'page-2026-01-01T00-00-00-000Z.yml', 300);
  await wrapper.schedulePrune({ cwd, env: { PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS: '0' }, argv: [], now: NOW, log: collectingLog() });
  assert.strictEqual(fs.existsSync(old), true, 'retention 0 must disable the prune');
});

test('folders pruned: <cwd>/.playwright-mcp, PLAYWRIGHT_MCP_OUTPUT_DIR and --output-dir, resolved against cwd', () => {
  const cwd = path.resolve(tempDir());
  assert.deepStrictEqual(wrapper.outputDirsToPrune(cwd, {}, ['--extension']), [path.join(cwd, '.playwright-mcp')]);
  assert.deepStrictEqual(
      wrapper.outputDirsToPrune(cwd, { PLAYWRIGHT_MCP_OUTPUT_DIR: 'out' }, ['--output-dir', 'other']),
      [path.join(cwd, '.playwright-mcp'), path.join(cwd, 'out'), path.join(cwd, 'other')]);
  assert.deepStrictEqual(
      wrapper.outputDirsToPrune(cwd, { PLAYWRIGHT_MCP_OUTPUT_DIR: '.playwright-mcp' }, ['--output-dir=.playwright-mcp']),
      [path.join(cwd, '.playwright-mcp')], 'the same folder is listed once');
});

test('the prune never blocks the caller: schedulePrune returns before touching the file system', async () => {
  const cwd = tempDir();
  const dir = path.join(cwd, '.playwright-mcp');
  fs.mkdirSync(dir);
  const old = makeFile(dir, 'page-2026-01-01T00-00-00-000Z.yml', 300);
  const touched = [];
  const originals = { readdir: fs.promises.readdir, readdirSync: fs.readdirSync };
  fs.promises.readdir = (...args) => {
    touched.push('readdir');
    return originals.readdir.apply(fs.promises, args);
  };
  fs.readdirSync = (...args) => {
    touched.push('readdirSync');
    return originals.readdirSync.apply(fs, args);
  };
  let pending;
  try {
    pending = wrapper.schedulePrune({ cwd, env: {}, argv: [], now: NOW, log: collectingLog() });
    assert.deepStrictEqual(touched, [], 'no file-system call happens before schedulePrune returns');
  } finally {
    if (!pending) {
      fs.promises.readdir = originals.readdir;
      fs.readdirSync = originals.readdirSync;
    }
  }
  assert.ok(pending && typeof pending.then === 'function', 'schedulePrune returns a promise');
  assert.strictEqual(fs.existsSync(old), true, 'nothing is deleted synchronously');
  try {
    await pending;
  } finally {
    fs.promises.readdir = originals.readdir;
    fs.readdirSync = originals.readdirSync;
  }
  assert.strictEqual(fs.existsSync(old), false, 'the old generated file is gone once the prune settles');
  assert.ok(touched.length > 0 && !touched.includes('readdirSync'), 'the prune ran, with async calls only');
});

test('main() schedules the prune after spawning the server, never before', () => {
  const source = fs.readFileSync(WRAPPER, 'utf8');
  const body = source.slice(source.indexOf('function main()'), source.indexOf('if (require.main === module)'));
  const prune = body.indexOf('schedulePrune(');
  const lastSpawn = body.lastIndexOf('runAndExit(');
  assert.ok(prune > 0, 'main() calls schedulePrune');
  assert.ok(lastSpawn > 0 && prune > lastSpawn, 'schedulePrune comes after every runAndExit in main()');
});

test('an unexpected throw inside the prune is caught and logged, never rejected', async () => {
  const log = collectingLog();
  const results = await wrapper.schedulePrune({ cwd: undefined, env: {}, argv: [], now: NOW, log });
  assert.deepStrictEqual(results, []);
  assert.ok(log.lines.some(line => /prune failed/.test(line)), 'the throw is reported in the log');
});

test('errors never escape: missing folder is silent, a folder that is a file is logged, the promise resolves', async () => {
  const cwd = tempDir();
  const missingLog = collectingLog();
  await wrapper.schedulePrune({ cwd, env: {}, argv: [], now: NOW, log: missingLog });
  assert.deepStrictEqual(missingLog.lines, [], 'a cwd without .playwright-mcp is the common case, not an error');

  fs.writeFileSync(path.join(cwd, '.playwright-mcp'), 'not a folder');
  const fileLog = collectingLog();
  await wrapper.schedulePrune({ cwd, env: {}, argv: [], now: NOW, log: fileLog });
  assert.ok(fileLog.lines.some(line => /prune/.test(line)), 'the failure is reported in the log');
});

test('two launches pruning the same folder at once log no error (ENOENT race is not a failure)', async () => {
  const cwd = tempDir();
  const dir = path.join(cwd, '.playwright-mcp');
  fs.mkdirSync(dir);
  for (let i = 0; i < 50; i++)
    makeFile(dir, `page-2026-01-01T00-00-00-${String(i).padStart(3, '0')}Z.yml`, 300);
  const logA = collectingLog();
  const logB = collectingLog();
  await Promise.all([
    wrapper.pruneOutputDir(dir, { days: 7, now: NOW, log: logA }),
    wrapper.pruneOutputDir(dir, { days: 7, now: NOW, log: logB }),
  ]);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'everything old is gone');
  assert.deepStrictEqual([...logA.lines, ...logB.lines], [], 'a file the other launch removed first is not an error');
});

test('a log that throws still does not reject the scheduled prune', async () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, '.playwright-mcp'), 'not a folder');
  const throwingLog = () => {
    throw new Error('log exploded');
  };
  await wrapper.schedulePrune({ cwd, env: {}, argv: [], now: NOW, log: throwingLog });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed++;
      process.stdout.write(`FAIL ${name}\n     ${String(error && error.message || error).split('\n')[0]}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
  process.exitCode = failed ? 1 : 0;
})();
