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

import path from 'path';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function isPlaywrightDaemonCommand(commandLine: string): boolean {
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length < 2)
    return false;

  const executable = commandBasename(tokens[0]).toLowerCase();
  const currentExecutable = commandBasename(process.execPath).toLowerCase();
  if (executable !== 'node' && executable !== 'node.exe' && executable !== currentExecutable)
    return false;

  const entryPoint = commandBasename(tokens[1]);
  if (entryPoint === 'cliDaemon.js' || entryPoint === 'dashboardApp.js')
    return true;
  return tokens[2] === 'run-cli-server' || tokens[2] === 'cli-daemon';
}

function tokenizeCommandLine(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map(token => {
    const quoted = token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\'')));
    return quoted ? token.slice(1, -1) : token;
  });
}

function commandBasename(file: string): string {
  return file.includes('\\') ? path.win32.basename(file) : path.basename(file);
}
