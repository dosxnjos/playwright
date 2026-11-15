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

// Fork-only (patch 9). browser_use_profile: the conversation picks a Chrome profile of the token vault at run time
// (roadmap/2026-11-15-perfil-por-conversa.md). The switch itself lives in the agent router (mcp/agentRouter.ts),
// because it has to close every agent's backend and must not open a browser in the old profile first. This file
// holds the tool schema, the vault reading and the answer used when the router is not there.

import fs from 'fs';
import os from 'os';
import path from 'path';

import * as z from 'zod';
import { defaultUserDataDirForChannel } from '@utils/chromiumChannels';
import { defineTool } from './tool';

import type { ExtensionProfile } from './extensionSession';

export const USE_PROFILE_TOOL = 'browser_use_profile';

const TOKEN_PREFIX = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN__';
const PROFILE_PREFIX = 'PLAYWRIGHT_MCP_PROFILE_DIR_NAME__';

// A vault variant. `token` never goes into a response, a description or a log line (decision D6).
export type VaultVariant = {
  name: string;
  token?: string;
  profileDirName?: string;
};

// Every variant that has a token or a profile folder in the env (`~/.claude.json` -> mcpServers.playwright.env).
export function vaultVariants(env: NodeJS.ProcessEnv = process.env): VaultVariant[] {
  const byName = new Map<string, VaultVariant>();
  const variant = (name: string) => byName.get(name) ?? byName.set(name, { name }).get(name)!;
  for (const [key, value] of Object.entries(env)) {
    if (!value)
      continue;
    if (key.startsWith(TOKEN_PREFIX) && key.length > TOKEN_PREFIX.length)
      Object.assign(variant(key.slice(TOKEN_PREFIX.length)), { token: value });
    else if (key.startsWith(PROFILE_PREFIX) && key.length > PROFILE_PREFIX.length)
      Object.assign(variant(key.slice(PROFILE_PREFIX.length)), { profileDirName: value });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const ALLOW_ENV = 'PLAYWRIGHT_MCP_USE_PROFILE_ALLOW';

// The variants a conversation may pick and the tool lists: PLAYWRIGHT_MCP_USE_PROFILE_ALLOW (comma-separated variant
// names, set by the vault's owner) limits them, so an instruction injected in a page cannot reach every account of the
// vault. The start variant always stays, so the conversation can switch back. Unset or empty: every variant.
export function pickableVariants(env: NodeJS.ProcessEnv = process.env, all = vaultVariants(env)): VaultVariant[] {
  const allow = (env[ALLOW_ENV] ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (!allow.length)
    return all;
  const start = startVariant(env)?.name;
  return all.filter(variant => allow.includes(variant.name) || variant.name === start);
}

export const usableVariant = (variant: VaultVariant): variant is Required<VaultVariant> => !!variant.token && !!variant.profileDirName;

// What the relay needs (backend/extensionSession.ts relayScope).
export function extensionProfileOf(variant: Required<VaultVariant>): ExtensionProfile {
  const { name, ...credentials } = variant;
  return { variant: name, ...credentials };
}

// The variant the server started with (the folder table of the wrapper already picked its token): the one whose token
// is the active token. Undefined when the active token is not in the vault.
export function startVariant(env: NodeJS.ProcessEnv = process.env): VaultVariant | undefined {
  const active = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  return active ? vaultVariants(env).find(variant => variant.token === active) : undefined;
}

// The user data dir the extension relay uses (extensionContextFactory.ts), to read the names of its profiles.
export function extensionUserDataDir(userDataDir: string | undefined, channel: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return userDataDir ?? env.PWTEST_EXTENSION_USER_DATA_DIR ?? defaultUserDataDirForChannel(channel ?? 'chrome');
}

// The names Chrome shows for its profiles (`Local State` -> profile.info_cache[folder].name). Best effort: an empty
// map when the file is missing or unreadable.
export function chromeProfileNames(userDataDir: string | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!userDataDir)
    return names;
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    for (const [folder, info] of Object.entries(localState?.profile?.info_cache ?? {})) {
      const name = (info as { name?: unknown })?.name;
      if (typeof name === 'string' && name)
        names.set(folder, name);
    }
  } catch {
  }
  return names;
}

// Who each variant is, in the user's words (`~/.claude/playwright-apelidos.json`, local, never versioned;
// PLAYWRIGHT_MCP_PROFILE_ALIASES overrides the path), e.g. { "jacira": ["minha mãe", "mother"] }. Keys starting with
// "_" are comments. Decision D1 reverted on 15/11/2026: the name Chrome gives a profile can be an e-mail address, which
// does not tell the model whose profile it is. Best effort: an empty map when the file is missing or unreadable.
export function profileAliases(env: NodeJS.ProcessEnv = process.env): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  try {
    const file = env.PLAYWRIGHT_MCP_PROFILE_ALIASES || path.join(os.homedir(), '.claude', 'playwright-apelidos.json');
    for (const [variant, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) ?? {})) {
      const words = (Array.isArray(value) ? value : [value]).filter((word): word is string => typeof word === 'string' && !!word.trim());
      if (!variant.startsWith('_') && words.length)
        aliases.set(variant, words.map(word => word.trim()));
    }
  } catch {
  }
  return aliases;
}

// What the description and the answers say about a profile.
export type ProfileLabels = {
  // Chrome's name, by profile folder.
  chromeNames: Map<string, string>;
  // The user's words, by variant.
  aliases: Map<string, string[]>;
};

// `jacira (also called "minha mãe"; folder "Profile 6")` or `padrao (Chrome name "Gabriel"; folder "Profile 13")`.
// Never the token. Chrome's name only helps when the user gave no alias, and one that looks like an e-mail address is
// personal data the model does not need (it goes into every conversation's tools/list): both are left out.
export function describeVariant(variant: VaultVariant, labels: ProfileLabels): string {
  const aliases = labels.aliases.get(variant.name);
  const chromeName = variant.profileDirName && !aliases ? labels.chromeNames.get(variant.profileDirName) : undefined;
  const parts = [
    aliases ? `also called ${aliases.map(alias => JSON.stringify(alias)).join(', ')}` : undefined,
    chromeName && !chromeName.includes('@') ? `Chrome name ${JSON.stringify(chromeName)}` : undefined,
    variant.profileDirName ? `folder "${variant.profileDirName}"` : undefined,
  ].filter(Boolean);
  return parts.length ? `${variant.name} (${parts.join('; ')})` : variant.name;
}

export function useProfileDescription(variants: VaultVariant[], labels: ProfileLabels, start: VaultVariant | undefined): string {
  const usable = variants.filter(usableVariant);
  const list = usable.length
    ? usable.map(variant => describeVariant(variant, labels) + (variant.name === start?.name ? ' - in use when this conversation started' : '')).join('; ')
    : 'none (no PLAYWRIGHT_MCP_EXTENSION_TOKEN__<name> with its PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<name> in the server env)';
  return [
    'Switch this conversation\'s browser to another Chrome profile, for example when the user says "use my mother\'s profile" or names a person, an account or a profile.',
    'Call it before the first browser call of that task. It closes the tabs that the agents of this conversation opened in the current profile; the next browser call opens in the chosen profile. Other conversations are not affected.',
    `Profiles: ${list}.`,
    'Only has an effect when connected via --extension; a harmless no-op otherwise.',
  ].join(' ');
}

export function notApplicableText(): string {
  return 'No Chrome profile to switch: this session is not running with --extension (it has a browser of its own). Continuing in the same browser.';
}

// `variants`: the pickable ones; `all`: the whole vault.
export function unusableVariantError(name: string, variants: VaultVariant[], all = variants): string {
  const found = variants.find(variant => variant.name === name);
  const why = !found && all.some(variant => variant.name === name) ? `profile "${name}" is not in ${ALLOW_ENV}`
    : !found ? `there is no profile named "${name}"`
      : !found.token ? `profile "${name}" has no extension token (${TOKEN_PREFIX}${name})`
        : `profile "${name}" has no Chrome profile folder registered (${PROFILE_PREFIX}${name})`;
  const valid = variants.filter(usableVariant).map(variant => variant.name);
  return `Cannot switch: ${why}. Nothing changed. Valid profiles: ${valid.length ? valid.join(', ') : 'none'}.`;
}

export const useProfileSchema = z.object({
  profile: z.string().min(1).describe('Name of the profile, one of the names listed in this tool\'s description, e.g. "padrao".'),
});

const useProfile = defineTool({
  capability: 'core',

  schema: {
    name: USE_PROFILE_TOOL,
    title: 'Use another Chrome profile',
    // Replaced by the agent router with the list of profiles (mcp/agentRouter.ts withAgentRouting).
    description: useProfileDescription([], { chromeNames: new Map(), aliases: new Map() }, undefined),
    inputSchema: useProfileSchema,
    type: 'action',
  },

  // Only runs without the agent router, which handles the tool itself.
  handle: async (context, params, response) => {
    if (!context.config.extension) {
      response.addTextResult(notApplicableText());
      return;
    }
    // --extension with routing off (PLAYWRIGHT_MCP_AGENT_ROUTING=off, --shared-browser-context): this backend already
    // holds the connection, and only the router can drop it before reconnecting.
    throw new Error(`${USE_PROFILE_TOOL}: switching profiles needs the agent router, which is off in this session (PLAYWRIGHT_MCP_AGENT_ROUTING=off or --shared-browser-context). Nothing changed.`);
  },
});

export default [
  useProfile,
];
