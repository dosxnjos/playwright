#!/usr/bin/env node
// Unit test for scripts/gravar-token-perfil.cjs (fork only). Plain node: exit 0 = all green.
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { cleanToken, isToken, updateClaudeJson } = require('./gravar-token-perfil.cjs');

const T_OLD = 'a'.repeat(43);
const T_NEW = 'b'.repeat(40) + '-_x';
const base = () => JSON.stringify({ projects: { 'C:/Dev': {}, 'C:/dev': {} }, mcpServers: { playwright: { env: {
  PLAYWRIGHT_MCP_EXTENSION_TOKEN: T_OLD,
  PLAYWRIGHT_MCP_EXTENSION_TOKEN__padrao: T_OLD,
  PLAYWRIGHT_MCP_EXTENSION_TOKEN__jacira: 'c'.repeat(43),
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME__padrao: 'Profile 13',
  PLAYWRIGHT_MCP_PROFILE_DIR_NAME__jacira: 'Profile 6',
} } } }, null, 2);
const envOf = text => JSON.parse(text).mcpServers.playwright.env;

const cases = {
  'the whole line copied from the extension, quotes and spaces are accepted'() {
    assert.strictEqual(cleanToken(`  PLAYWRIGHT_MCP_EXTENSION_TOKEN=${T_NEW}\r\n`), T_NEW);
    assert.strictEqual(cleanToken(`"${T_NEW}"`), T_NEW);
    assert.ok(isToken(T_NEW));
    assert.ok(!isToken('hello world'), 'free text is not a token');
    assert.ok(!isToken(''), 'empty is not a token');
  },
  'a variant swap changes only its key; the active and the others stay; case-twin project keys survive'() {
    const { text, activeFollows } = updateClaudeJson(base(), 'jacira', T_NEW);
    const env = envOf(text);
    assert.strictEqual(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN__jacira, T_NEW);
    assert.strictEqual(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, T_OLD);
    assert.strictEqual(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN__padrao, T_OLD);
    assert.strictEqual(activeFollows, false);
    assert.deepStrictEqual(Object.keys(JSON.parse(text).projects), ['C:/Dev', 'C:/dev']);
  },
  'the active token follows when it was the swapped variant (padrao)'() {
    const { text, activeFollows } = updateClaudeJson(base(), 'padrao', T_NEW);
    assert.strictEqual(envOf(text).PLAYWRIGHT_MCP_EXTENSION_TOKEN, T_NEW);
    assert.strictEqual(activeFollows, true);
  },
  'a new variant needs its profile folder; with it, both lines are added'() {
    assert.throws(() => updateClaudeJson(base(), 'nova', T_NEW), /pass the Chrome profile folder/);
    const env = envOf(updateClaudeJson(base(), 'nova', T_NEW, 'Profile 8').text);
    assert.strictEqual(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN__nova, T_NEW);
    assert.strictEqual(env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME__nova, 'Profile 8');
  },
  'the change messages never carry the token'() {
    const { changes } = updateClaudeJson(base(), 'padrao', T_NEW);
    assert.ok(!changes.join(' ').includes(T_NEW) && !changes.join(' ').includes(T_OLD));
  },
  'the CLI refuses a bad variant or a non-token before touching anything, and prints no token'() {
    const run = (variant, token) => spawnSync(process.execPath, [path.join(__dirname, 'gravar-token-perfil.cjs'), variant], { encoding: 'utf8', env: { ...process.env, PW_TOKEN_NOVO: token } });
    const bad = run('Jacira!', T_NEW);
    assert.strictEqual(bad.status, 2);
    const notToken = run('jacira', 'not a token at all');
    assert.strictEqual(notToken.status, 2);
    assert.ok(!(bad.stdout + bad.stderr + notToken.stdout + notToken.stderr).includes(T_NEW));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(error && error.message || error).split('\n')[0]}`);
  }
}
console.log(`\n${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exitCode = failed ? 1 : 0;
