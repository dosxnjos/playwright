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

import debug from 'debug';
import { defaultUserDataDirForChannel } from '@utils/chromiumChannels';
import { playwright } from '../../inprocess';
import { findPlaywrightExtensionProfile, isExtensionInstalledInProfile, playwrightExtensionInstallUrl } from '../utils/extension';
import { CDPRelayServer } from './cdpRelay';
import { registerExtensionRelay, relayScope } from '../backend/extensionSession';

import type * as playwrightTypes from '../../..';

const debugLogger = debug('pw:mcp:relay');

export async function createExtensionBrowser(channel: string, executablePath: string | undefined, customUserDataDir: string | undefined, profileDirName: string | undefined, clientName: string): Promise<playwrightTypes.Browser> {
  customUserDataDir ??= process.env.PWTEST_EXTENSION_USER_DATA_DIR;
  // Custom executablePath may target a browser in a different filesystem (e.g. Windows chrome.exe from WSL2), so the local profile path is not meaningful.
  const userDataDir = customUserDataDir ?? (executablePath ? undefined : defaultUserDataDirForChannel(channel));
  const profileDirectory = profileDirName ?? (userDataDir ? await findPlaywrightExtensionProfile(userDataDir) : undefined);
  if (userDataDir && !executablePath && (!profileDirectory || !await isExtensionInstalledInProfile(path.join(userDataDir, profileDirectory))))
    throw new Error(`Playwright Extension not found in "${profileDirectory ? path.join(userDataDir, profileDirectory) : userDataDir}". Install it from ${playwrightExtensionInstallUrl}, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.`);

  // Fork (patch 7): set by the agent router for a sub-agent's backend.
  const relay = new CDPRelayServer(channel, executablePath, customUserDataDir, profileDirectory, { background: relayScope.getStore()?.background ?? false });
  await relay.start();
  debugLogger(`CDP relay server started, extension endpoint: ${relay.extensionEndpoint()}.`);

  try {
    await relay.establishExtensionConnection(clientName);
    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });
    registerExtensionRelay(browser, relay);
    browser.on('disconnected', () => relay.stop());
    return browser;
  } catch (error) {
    relay.stop();
    throw error;
  }
}
