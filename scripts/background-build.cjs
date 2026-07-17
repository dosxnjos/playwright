#!/usr/bin/env node
/**
 * Runs `npm run build` for the fork and updates the stamp/lock used by
 * run-mcp-server.cjs. Spawned as a fully detached process so it survives
 * regardless of whether the wrapper that triggered it is still alive (a
 * short-lived wrapper invocation could otherwise exit before an 18-28s build
 * finishes, orphaning an in-process 'exit' listener that would never fire).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAMP_FILE = path.join(__dirname, '.build-stamp');
const LOCK_DIR = path.join(__dirname, '.build-lock');
const LOG_FILE = path.join(__dirname, '.build-log.txt');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

const logFd = fs.openSync(LOG_FILE, 'a');
try {
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    // shell: true is required on Windows (npm is a .cmd shim; Node refuses
    // to spawn .cmd files directly without a shell). Args here are fixed
    // literals, not user input.
    shell: true,
  });
  fs.writeFileSync(STAMP_FILE, '');
  log('background build finished successfully - the next launch will use the local fork');
} catch (error) {
  log(`background build failed: ${error.message}`);
} finally {
  fs.closeSync(logFd);
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // Already gone - nothing to do.
  }
}
