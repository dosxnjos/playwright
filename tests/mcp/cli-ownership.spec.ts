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

import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';

import { test, expect, daemonFolder } from './cli-fixtures';
import { isPlaywrightDaemonCommand } from '../../packages/playwright-core/lib/tools/cli-client/processUtils';
import { sessionOwnershipPolicy } from '../../packages/playwright-core/lib/tools/cli-client/ownership';

const ownerA = { PLAYWRIGHT_CLI_OWNER: 'A' };
const ownerB = { PLAYWRIGHT_CLI_OWNER: 'B' };

function isAlive(pid: number | undefined): boolean {
  if (!pid)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
}

function daemonPids(sessionName: string): number[] {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' }).split('\n');
  const result: number[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !isPlaywrightDaemonCommand(match[2]))
      continue;
    if (match[2].endsWith(`cliDaemon.js ${sessionName}`) || match[2].includes(`cliDaemon.js ${sessionName} `))
      result.push(Number(match[1]));
  }
  return result;
}

function expectOwnershipFailure(result: { exitCode: number | undefined, output: string, error: string }): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.output + result.error).toContain('belongs to another owner');
}

async function killCreatedPid(pid: number, expectedCommand: string, reason: string): Promise<void> {
  const command = commandLine(pid);
  expect(command).toContain(expectedCommand);
  console.log(`OWNERSHIP_TEST_KILL pid=${pid} command=${JSON.stringify(command)} reason=${reason}`);
  process.kill(pid, 'SIGKILL');
  await expect.poll(() => isAlive(pid)).toBe(false);
}

test('owners can use independent sessions in one workspace', async ({ cli, server }) => {
  const a = await cli('-s', 'a', 'open', server.HELLO_WORLD, { env: ownerA });
  const b = await cli('-s', 'b', 'open', server.HELLO_WORLD, { env: ownerB });

  expect(isAlive(a.daemonPid)).toBe(true);
  expect(isAlive(b.daemonPid)).toBe(true);
  expect((await cli('-s', 'a', 'goto', server.EMPTY_PAGE, { env: ownerA })).exitCode).toBe(0);
  expect((await cli('-s', 'b', 'goto', server.EMPTY_PAGE, { env: ownerB })).exitCode).toBe(0);

  const textList = (await cli('list', { env: ownerA })).output;
  expect(textList).toContain('owner: A');
  expect(textList).toContain(`pid: ${a.daemonPid}`);
  expect(textList).toContain('started-at:');
  expect(textList).toContain('owned-by-caller: true');

  const listed = JSON.parse((await cli('--json', 'list', { env: ownerA })).output);
  expect(listed.browsers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'a', owner: 'A', pid: a.daemonPid, status: 'open', ownedByCaller: true, startedAt: expect.any(Number) }),
    expect.objectContaining({ name: 'b', owner: 'B', pid: b.daemonPid, status: 'open', ownedByCaller: false, startedAt: expect.any(Number) }),
  ]));
});

test('same owner can reopen without leaving the old daemon alive', async ({ cli, server }) => {
  const first = await cli('-s', 'reopen', 'open', server.HELLO_WORLD, { env: ownerA });
  const second = await cli('-s', 'reopen', 'open', server.EMPTY_PAGE, { env: ownerA });

  expect(first.daemonPid).toBeDefined();
  expect(second.daemonPid).toBeDefined();
  expect(second.daemonPid).not.toBe(first.daemonPid);
  await expect.poll(() => isAlive(first.daemonPid)).toBe(false);
  expect(isAlive(second.daemonPid)).toBe(true);
  expect(daemonPids('reopen')).toEqual([second.daemonPid]);
  expect((await cli('-s', 'reopen', 'goto', server.HELLO_WORLD, { env: ownerA })).exitCode).toBe(0);

  const daemonDir = await daemonFolder();
  const registration = JSON.parse(await fs.promises.readFile(path.join(daemonDir!, 'reopen.session'), 'utf-8'));
  expect(registration).toEqual(expect.objectContaining({
    instanceId: expect.any(String),
    owner: 'A',
    pid: second.daemonPid,
    startedAt: expect.any(Number),
  }));
});

test('concurrent opens serialize for different owners and unscoped callers', async ({ cli, server }) => {
  const owned = await Promise.all([
    cli('-s', 'owned-race', 'open', server.HELLO_WORLD, { env: ownerA }),
    cli('-s', 'owned-race', 'open', server.EMPTY_PAGE, { env: ownerB }),
  ]);
  const winners = owned.filter(result => result.exitCode === 0);
  const losers = owned.filter(result => result.exitCode !== 0);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expectOwnershipFailure(losers[0]);
  const winnerOwner = winners[0] === owned[0] ? ownerA : ownerB;
  expect(isAlive(winners[0].daemonPid)).toBe(true);
  expect(daemonPids('owned-race')).toEqual([winners[0].daemonPid]);
  expect((await cli('-s', 'owned-race', 'goto', server.HELLO_WORLD, { env: winnerOwner })).exitCode).toBe(0);

  const unscoped = await Promise.all([
    cli('-s', 'unscoped-race', 'open', server.HELLO_WORLD),
    cli('-s', 'unscoped-race', 'open', server.EMPTY_PAGE),
  ]);
  expect(unscoped.map(result => result.exitCode)).toEqual([0, 0]);
  const pids = unscoped.map(result => result.daemonPid!);
  await expect.poll(() => pids.filter(isAlive).length).toBe(1);
  const listed = JSON.parse((await cli('--json', 'list', '--all')).output);
  const registration = listed.browsers.find((entry: { name: string }) => entry.name === 'unscoped-race');
  expect(registration.pid).toBe(pids.find(isAlive));
  expect(daemonPids('unscoped-race')).toEqual([registration.pid]);
});

test('another owner cannot replace, close, drive, delete, or attach through a session name', async ({ cli, server }) => {
  const a = await cli('-s', 'protected', 'open', server.HELLO_WORLD, '--persistent', { env: ownerA });
  const attempts = [
    await cli('-s', 'protected', 'open', server.EMPTY_PAGE, { env: ownerB }),
    await cli('-s', 'protected', 'close', { env: ownerB }),
    await cli('-s', 'protected', 'goto', server.EMPTY_PAGE, { env: ownerB }),
    await cli('-s', 'protected', 'delete-data', { env: ownerB }),
    await cli('-s', 'protected', 'detach', { env: ownerB }),
    await cli('attach', 'protected', { env: ownerB }),
  ];
  for (const attempt of attempts)
    expectOwnershipFailure(attempt);

  expect(isAlive(a.daemonPid)).toBe(true);
  expect((await cli('-s', 'protected', 'goto', server.HELLO_WORLD, { env: ownerA })).exitCode).toBe(0);
});

test('close only affects the caller owner', async ({ cli, server }) => {
  const a = await cli('-s', 'close-a', 'open', server.HELLO_WORLD, { env: ownerA });
  const b = await cli('-s', 'close-b', 'open', server.HELLO_WORLD, { env: ownerB });

  expect((await cli('-s', 'close-a', 'close', { env: ownerA })).exitCode).toBe(0);
  await expect.poll(() => isAlive(a.daemonPid)).toBe(false);
  expect(isAlive(b.daemonPid)).toBe(true);
  expect((await cli('-s', 'close-b', 'goto', server.EMPTY_PAGE, { env: ownerB })).exitCode).toBe(0);
});

test('close-all closes only matching owner sessions and reports skips', async ({ cli, server }) => {
  const a1 = await cli('-s', 'all-a1', 'open', server.HELLO_WORLD, { env: ownerA });
  const a2 = await cli('-s', 'all-a2', 'open', server.HELLO_WORLD, { env: ownerA });
  const b = await cli('-s', 'all-b', 'open', server.HELLO_WORLD, { env: ownerB });
  const unowned = await cli('-s', 'all-unowned', 'open', server.HELLO_WORLD);

  const text = await cli('close-all', { env: ownerA });
  expect(text.output).toContain('Skipped 2 sessions owned by another owner.');
  await expect.poll(() => isAlive(a1.daemonPid) || isAlive(a2.daemonPid)).toBe(false);
  expect(isAlive(b.daemonPid)).toBe(true);
  expect(isAlive(unowned.daemonPid)).toBe(true);

  await cli('-s', 'all-a3', 'open', server.HELLO_WORLD, { env: ownerA });
  const json = JSON.parse((await cli('--json', 'close-all', { env: ownerA })).output);
  expect(json).toEqual({ closed: ['all-a3'], skipped: 2 });

  const unscopedJson = JSON.parse((await cli('--json', 'close-all')).output);
  expect(unscopedJson).toEqual({ closed: ['all-unowned'], skipped: 1 });
  await expect.poll(() => isAlive(unowned.daemonPid)).toBe(false);
  expect(isAlive(b.daemonPid)).toBe(true);
});

test('kill-all is refused for owners and excludes owned daemons for unscoped callers', async ({ cli, server }) => {
  const b = await cli('-s', 'kill-owned', 'open', server.HELLO_WORLD, { env: ownerB });
  expect(b.daemonPid).toBeDefined();

  const refused = await cli('kill-all', { env: { ...ownerA, PWTEST_KILL_ALL_PID_FILTER_FOR_TEST: String(b.daemonPid) } });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.output + refused.error).toContain('kill-all is disabled');
  expect(refused.output + refused.error).toContain('close-all');
  expect(isAlive(b.daemonPid)).toBe(true);

  const unscoped = await cli('kill-all', { env: { PWTEST_KILL_ALL_PID_FILTER_FOR_TEST: String(b.daemonPid) } });
  expect(unscoped.exitCode).toBe(0);
  expect(unscoped.output).toContain('No daemon processes found.');
  expect(isAlive(b.daemonPid)).toBe(true);
});

test('kill-all ignores argument mentions and the MCP wrapper script name', async ({ cli }, testInfo) => {
  const wrapper = testInfo.outputPath('run-mcp-server.cjs');
  await fs.promises.writeFile(wrapper, 'setInterval(() => {}, 1000);\n');
  const mention = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'mentions cliDaemon.js run-cli-server dashboardApp.js'], { stdio: 'ignore' });
  const mcp = spawn(process.execPath, [wrapper, '--extension'], { stdio: 'ignore' });
  expect(mention.pid).toBeDefined();
  expect(mcp.pid).toBeDefined();

  try {
    await expect.poll(() => isAlive(mention.pid) && isAlive(mcp.pid)).toBe(true);
    const result = await cli('kill-all', {
      env: { PWTEST_KILL_ALL_PID_FILTER_FOR_TEST: `${mention.pid},${mcp.pid}` },
    });
    expect(result.exitCode).toBe(0);
    expect(isAlive(mention.pid)).toBe(true);
    expect(isAlive(mcp.pid)).toBe(true);
  } finally {
    if (mention.pid && isAlive(mention.pid)) {
      const exited = once(mention, 'exit');
      await killCreatedPid(mention.pid, 'mentions cliDaemon.js', 'test decoy teardown');
      await exited;
    }
    if (mcp.pid && isAlive(mcp.pid)) {
      const exited = once(mcp, 'exit');
      await killCreatedPid(mcp.pid, 'run-mcp-server.cjs', 'test MCP wrapper teardown');
      await exited;
    }
  }
});

test('crashed sessions are recovered only by their owner', async ({ cli, server }) => {
  const a = await cli('-s', 'crashed-a', 'open', server.HELLO_WORLD, { env: ownerA });
  const b = await cli('-s', 'crashed-b', 'open', server.HELLO_WORLD, { env: ownerB });
  expect(a.daemonPid).toBeDefined();
  const daemonDir = await daemonFolder();
  const crashedRegistration = path.join(daemonDir!, 'crashed-a.session');
  await killCreatedPid(a.daemonPid!, 'cliDaemon.js crashed-a', 'simulate owner A daemon crash');
  expect(fs.existsSync(crashedRegistration)).toBe(true);

  expect(isAlive(b.daemonPid)).toBe(true);
  expect((await cli('-s', 'crashed-b', 'goto', server.EMPTY_PAGE, { env: ownerB })).exitCode).toBe(0);
  expectOwnershipFailure(await cli('-s', 'crashed-a', 'open', server.EMPTY_PAGE, { env: ownerB }));

  const listed = JSON.parse((await cli('--json', 'list', { env: ownerA })).output);
  expect(listed.browsers.some((entry: { name: string }) => entry.name === 'crashed-a')).toBe(false);
  expect(fs.existsSync(crashedRegistration)).toBe(false);
  const recovered = await cli('-s', 'crashed-a', 'open', server.EMPTY_PAGE, { env: ownerA });
  expect(recovered.exitCode).toBe(0);
  expect(isAlive(recovered.daemonPid)).toBe(true);
});

test('a hand-written stale registration cannot be inherited by another owner', async ({ cli, server }, testInfo) => {
  await cli('-s', 'seed', 'open', server.HELLO_WORLD, { env: ownerA });
  const daemonDir = await daemonFolder();
  expect(daemonDir).not.toBeNull();
  expect(isAlive(999999)).toBe(false);
  const staleFile = path.join(daemonDir!, 'manual-stale.session');
  const staleConfig = {
    name: 'manual-stale',
    version: '1.62.0-next',
    timestamp: Date.now(),
    socketPath: testInfo.outputPath('missing.sock'),
    instanceId: 'dead-instance',
    pid: 999999,
    startedAt: Date.now() - 1000,
    owner: 'X',
    workspaceDir: testInfo.outputPath(),
    cli: {},
    browser: { browserName: 'chromium', launchOptions: { headless: true } },
  };
  await fs.promises.writeFile(staleFile, JSON.stringify(staleConfig, null, 2));
  const unresponsiveFile = path.join(daemonDir!, 'manual-unresponsive.session');
  await fs.promises.writeFile(unresponsiveFile, JSON.stringify({
    ...staleConfig,
    name: 'manual-unresponsive',
    socketPath: testInfo.outputPath('also-missing.sock'),
    pid: process.pid,
  }, null, 2));

  const foreignList = JSON.parse((await cli('--json', 'list', { env: { PLAYWRIGHT_CLI_OWNER: 'Y' } })).output);
  expect(foreignList.browsers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'manual-stale', status: 'stale', owner: 'X', ownedByCaller: false }),
    expect.objectContaining({ name: 'manual-unresponsive', status: 'unresponsive', owner: 'X', ownedByCaller: false }),
  ]));
  const unresponsive = await cli('-s', 'manual-unresponsive', 'open', server.EMPTY_PAGE, { env: { PLAYWRIGHT_CLI_OWNER: 'X' } });
  expect(unresponsive.exitCode).not.toBe(0);
  expect(unresponsive.output + unresponsive.error).toContain('is unresponsive');
  expect(fs.existsSync(unresponsiveFile)).toBe(true);

  expectOwnershipFailure(await cli('-s', 'manual-stale', 'open', server.EMPTY_PAGE, { env: { PLAYWRIGHT_CLI_OWNER: 'Y' } }));
  expect(fs.existsSync(staleFile)).toBe(true);
  const recovered = await cli('-s', 'manual-stale', 'open', server.EMPTY_PAGE, { env: { PLAYWRIGHT_CLI_OWNER: 'X' } });
  expect(recovered.exitCode).toBe(0);
  expect(isAlive(recovered.daemonPid)).toBe(true);

  const legacyUnresponsiveFile = path.join(daemonDir!, 'legacy-unresponsive.session');
  await fs.promises.writeFile(legacyUnresponsiveFile, JSON.stringify({
    ...staleConfig,
    name: 'legacy-unresponsive',
    socketPath: testInfo.outputPath('legacy-missing.sock'),
    pid: process.pid,
    owner: undefined,
  }, null, 2));
  const legacyRecovered = await cli('-s', 'legacy-unresponsive', 'open', server.EMPTY_PAGE);
  expect(legacyRecovered.exitCode).toBe(0);
  expect(isAlive(legacyRecovered.daemonPid)).toBe(true);
});

test('legacy unowned sessions reject owner-scoped operations', async ({ cli, server }) => {
  const legacy = await cli('-s', 'legacy', 'open', server.HELLO_WORLD);
  const listed = JSON.parse((await cli('--json', 'list', { env: ownerA })).output);
  expect(listed.browsers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'legacy', owner: null, ownedByCaller: false }),
  ]));
  expectOwnershipFailure(await cli('-s', 'legacy', 'close', { env: ownerA }));
  expectOwnershipFailure(await cli('-s', 'legacy', 'open', server.EMPTY_PAGE, { env: ownerA }));
  expectOwnershipFailure(await cli('-s', 'legacy', 'goto', server.EMPTY_PAGE, { env: ownerA }));
  expect(isAlive(legacy.daemonPid)).toBe(true);

  expect((await cli('-s', 'legacy', 'close', { env: { PLAYWRIGHT_CLI_OWNER: '' } })).exitCode).toBe(0);
  await expect.poll(() => isAlive(legacy.daemonPid)).toBe(false);
});

test('owner validation and the ownership decision table fail closed', async ({ cli }) => {
  const invalidControl = await cli('list', { env: { PLAYWRIGHT_CLI_OWNER: 'bad\nowner' } });
  expect(invalidControl.exitCode).not.toBe(0);
  expect(invalidControl.error).toContain('at most 256 printable ASCII characters');
  const invalidLength = await cli('list', { env: { PLAYWRIGHT_CLI_OWNER: 'x'.repeat(257) } });
  expect(invalidLength.exitCode).not.toBe(0);
  expect(invalidLength.error).toContain('at most 256 printable ASCII characters');
  expect((await cli('list', { env: { PLAYWRIGHT_CLI_OWNER: 'x'.repeat(256) } })).exitCode).toBe(0);

  expect(sessionOwnershipPolicy('A', undefined, 'none', 'open')).toBe('create');
  expect(sessionOwnershipPolicy('A', 'A', 'stale', 'open')).toBe('clear-and-create');
  expect(sessionOwnershipPolicy('A', 'A', 'open', 'open')).toBe('restart');
  expect(sessionOwnershipPolicy('A', 'B', 'open', 'open')).toBe('refuse-owner');
  expect(sessionOwnershipPolicy('A', 'B', 'stale', 'open')).toBe('refuse-owner');
  expect(sessionOwnershipPolicy('A', 'A', 'unresponsive', 'open')).toBe('refuse-unresponsive');
  expect(sessionOwnershipPolicy(undefined, undefined, 'unresponsive', 'open')).toBe('clear-and-create');
  expect(sessionOwnershipPolicy('A', 'B', 'open', 'use')).toBe('refuse-owner');
  expect(sessionOwnershipPolicy('A', 'B', 'open', 'close-all')).toBe('skip');
  expect(sessionOwnershipPolicy('A', 'B', 'stale', 'list-gc')).toBe('keep');
  expect(sessionOwnershipPolicy('A', 'A', 'stale', 'list-gc')).toBe('remove');
  expect(sessionOwnershipPolicy('A', undefined, 'none', 'kill-all')).toBe('refuse-kill-all');
  expect(sessionOwnershipPolicy(undefined, 'A', 'open', 'attach-target')).toBe('allow');
  expect(sessionOwnershipPolicy('A', 'B', 'open', 'attach-target')).toBe('refuse-owner');
});
