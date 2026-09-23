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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isProcessAlive } from './processUtils';

import type { ClientInfo } from './registry';

const defaultLockTimeout = 60_000;
const validLockStaleAge = 5 * 60_000;
const invalidLockStaleAge = 10_000;
const retryDelay = 50;

type LockContents = {
  pid: number;
  createdAt: number;
  nonce: string;
};

type LockInspection = {
  contents: LockContents | undefined;
  stale: boolean;
};

type LockAttempt<T> =
  { acquired: true, value: T } |
  { acquired: false };

export class SessionLockTimeoutError extends Error {
  constructor(readonly sessionName: string, readonly holderPid: number | undefined) {
    const holder = holderPid === undefined ? 'an unknown process' : `pid ${holderPid}`;
    super(`Timed out waiting for session '${sessionName}' lifecycle lock held by ${holder}`);
    this.name = 'SessionLockTimeoutError';
  }
}

export async function withSessionLock<T>(clientInfo: ClientInfo, sessionName: string, callback: () => Promise<T>): Promise<T> {
  return await withSessionLockTimeout(clientInfo, sessionName, lockTimeout(), callback);
}

export async function withSessionLockIfAvailable<T>(clientInfo: ClientInfo, sessionName: string, callback: () => Promise<T>): Promise<LockAttempt<T>> {
  try {
    const value = await withSessionLockTimeout(clientInfo, sessionName, 0, callback);
    return { acquired: true, value };
  } catch (error) {
    if (error instanceof SessionLockTimeoutError)
      return { acquired: false };
    throw error;
  }
}

async function withSessionLockTimeout<T>(clientInfo: ClientInfo, sessionName: string, timeout: number, callback: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionLock(clientInfo, sessionName, timeout);
  try {
    return await callback();
  } finally {
    releaseSessionLock(lock);
  }
}

async function acquireSessionLock(clientInfo: ClientInfo, sessionName: string, timeout: number): Promise<{ file: string, nonce: string }> {
  fs.mkdirSync(clientInfo.daemonProfilesDir, { recursive: true });
  const file = path.join(clientInfo.daemonProfilesDir, `${sessionName}.lock`);
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + timeout;
  let holderPid: number | undefined;

  while (true) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        const contents: LockContents = { pid: process.pid, createdAt: Date.now(), nonce };
        fs.writeFileSync(fd, JSON.stringify(contents));
      } finally {
        fs.closeSync(fd);
      }
      return { file, nonce };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
    }

    const inspection = inspectLock(file);
    holderPid = inspection.contents?.pid;
    if (inspection.stale) {
      if (breakStaleLock(file))
        continue;
    }

    if (Date.now() >= deadline)
      throw new SessionLockTimeoutError(sessionName, holderPid);
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
}

function inspectLock(file: string): LockInspection {
  let age: number;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { contents: undefined, stale: false };
    throw error;
  }

  const contents = readLock(file);
  if (!contents)
    return { contents, stale: age > invalidLockStaleAge };
  return { contents, stale: age > validLockStaleAge || !isProcessAlive(contents.pid) };
}

function readLock(file: string): LockContents | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!value || typeof value !== 'object')
      return undefined;
    const candidate = value as Record<string, unknown>;
    if (!Number.isInteger(candidate.pid) || typeof candidate.createdAt !== 'number' || typeof candidate.nonce !== 'string')
      return undefined;
    return candidate as LockContents;
  } catch {
    return undefined;
  }
}

function breakStaleLock(file: string): boolean {
  const staleFile = `${file}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, staleFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false;
    throw error;
  }
  fs.unlinkSync(staleFile);
  return true;
}

function releaseSessionLock(lock: { file: string, nonce: string }): void {
  const contents = readLock(lock.file);
  if (contents?.nonce !== lock.nonce)
    return;
  try {
    fs.unlinkSync(lock.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
}

function lockTimeout(): number {
  const override = Number(process.env.PWTEST_CLI_SESSION_LOCK_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 0 ? override : defaultLockTimeout;
}
