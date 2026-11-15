#!/usr/bin/env node
/**
 * Helper of scripts/gravar-token-perfil.ps1 (fork only). Saves a new extension token of one vault variant in
 * the Doppler vault (harness/prd, PLAYWRIGHT_MCP_EXTENSION_TOKEN_<VARIANT>) and in ~/.claude.json
 * (mcpServers.playwright.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variant>). The token arrives ONLY through the
 * environment variable PW_TOKEN_NOVO and is never printed, logged or passed on a command line of ours
 * (the Doppler CLI gets it as `NAME=value`, the same way `doppler secrets set` is documented).
 *
 * Usage: PW_TOKEN_NOVO=<token> node scripts/gravar-token-perfil.cjs <variant> [<Chrome profile folder>]
 * Exit 0 = both saved; anything else = see the message (nothing is half-written in ~/.claude.json).
 *
 * Why node and not PowerShell: ~/.claude.json has project keys that differ only in case ("C:/Dev" and
 * "C:/dev"), and Windows PowerShell 5.1's ConvertFrom-Json refuses such a file.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN';

function cleanToken(raw) {
  return String(raw || '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(new RegExp('^\\s*' + PREFIX + '\\s*=\\s*'), '')
      .trim()
      .replace(/^["']|["']$/g, '');
}

function isToken(value) {
  return /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

// Pure: returns the new ~/.claude.json text and what changed. Never returns or logs the token itself.
function updateClaudeJson(text, variant, token, profile) {
  const data = JSON.parse(text);
  const server = data.mcpServers && data.mcpServers.playwright;
  if (!server || !server.env)
    throw new Error('~/.claude.json has no mcpServers.playwright.env');
  const env = server.env;
  const key = `${PREFIX}__${variant}`;
  const profileKey = `PLAYWRIGHT_MCP_PROFILE_DIR_NAME__${variant}`;
  const old = env[key];
  if (!env[profileKey] && !profile)
    throw new Error(`variant "${variant}" has no ${profileKey} yet: pass the Chrome profile folder (e.g. -Perfil "Profile 8")`);
  const changes = [];
  env[key] = token;
  changes.push(old === undefined ? `${key} added` : old === token ? `${key} already had this value` : `${key} updated`);
  if (profile && env[profileKey] !== profile) {
    changes.push(`${profileKey} = ${profile}`);
    env[profileKey] = profile;
  }
  // The active token follows when it was this variant's old value: otherwise the active one would point at a
  // token the extension no longer accepts.
  const activeFollows = old !== undefined && env[PREFIX] === old && old !== token;
  if (activeFollows) {
    env[PREFIX] = token;
    changes.push(`${PREFIX} (the active one) updated too: it was this variant`);
  }
  return { text: JSON.stringify(data, null, 2), changes, activeFollows };
}

function doppler(args, input) {
  return spawnSync('doppler', args, { encoding: 'utf8', input, windowsHide: true });
}

function main() {
  const variant = (process.argv[2] || '').trim();
  const profile = (process.argv[3] || '').trim() || undefined;
  if (!/^[a-z][a-z0-9_]*$/.test(variant)) {
    console.error('Variante invalida. Use letras minusculas, numeros e _, por exemplo: padrao, gabriel_pessoal, jacira, andressa.');
    return 2;
  }
  const token = cleanToken(process.env.PW_TOKEN_NOVO);
  if (!isToken(token)) {
    console.error('Isso nao parece um token. Nada foi gravado.');
    return 2;
  }
  const secret = `${PREFIX}_${variant.toUpperCase()}`;
  const where = ['--project', 'harness', '--config', 'prd'];

  const file = path.join(os.homedir(), '.claude.json');
  let update;
  try {
    update = updateClaudeJson(fs.readFileSync(file, 'utf8'), variant, token, profile);
  } catch (error) {
    console.error(`Nada foi gravado: ${error.message}`);
    return 3;
  }

  const set = doppler(['secrets', 'set', `${secret}=${token}`, ...where, '--silent']);
  if (set.status !== 0) {
    console.error(`O Doppler recusou (codigo ${set.status}). Nada foi gravado no ~/.claude.json.`);
    return 4;
  }
  const back = doppler(['secrets', 'get', secret, ...where, '--plain']);
  if (back.status !== 0 || back.stdout.trim() !== token) {
    console.error('O Doppler aceitou, mas a releitura nao bateu. Nada foi gravado no ~/.claude.json.');
    return 4;
  }
  console.log(`Doppler: ${secret} gravado em harness/prd (releitura confere).`);

  // Read again right before writing: Claude Code writes this file all the time and the Doppler round trip
  // took seconds, so the text read above may be stale.
  update = updateClaudeJson(fs.readFileSync(file, 'utf8'), variant, token, profile);
  const tmp = `${file}.tmp-gravar-token`;
  fs.writeFileSync(tmp, update.text, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
  for (const change of update.changes)
    console.log(`~/.claude.json: ${change}.`);

  if (variant === 'padrao')
    console.log('ATENCAO: padrao e o token ativo de todas as conversas. Atualize tambem EXTENSION_TOKEN no .env do controle-gastos.');
  if (variant === 'andressa')
    console.log('ATENCAO: atualize tambem EXTENSION_TOKEN_PERFIL7 no .env do controle-gastos.');
  console.log('Vale para conversas abertas daqui para a frente; nas abertas: /mcp -> playwright -> Reconnect.');
  return 0;
}

if (require.main === module)
  process.exitCode = main();

module.exports = { cleanToken, isToken, updateClaudeJson };
