# Abas por agente no Playwright MCP: roteador no servidor e carimbo por hook (03/10/2026)

> **Status:** roadmap de melhoria (`/melhore`, sessão `9f526eb4`); nada implementado. Pedido do Gabriel (03/10/2026):
> "cada agente e subagente gere as próprias abas sem que os outros fiquem trocando de página; liberdade total;
> talvez tratá-los como novas conversas, com grupo de abas próprio". Pode reconstruir extensão, servidor e harness.
> **Base:** `C:\Dev\playwright` `62a2dc067` (03/10/2026) · `C:\Dev` `787aa74` (03/10/2026).
> **Risco:** dado (o patch 3 fecha abas; um roteador errado pode fechar aba de outro agente ou do Gabriel).
> **Leia antes:** a pesquisa [2026-10-02-abas-por-subagente.md](2026-10-02-abas-por-subagente.md) (seções "Como funciona
> hoje" e "Perigos" são o diagnóstico deste roadmap), `FORK.md` inteiro, `C:\Dev\cerebro\temas\playwright-mcp.md`.
> **Como nasceu:** workflow `playwright-isolamento-por-agente` (5 frentes com spikes medidos, 4 desenhos por lentes
> diferentes, 3 juízes, síntese). O vencedor foi o "mínimo", com enxertos e as correções da § 3.
> **Legenda:**
> - **[medido]**: rodado nesta máquina em 02/10/2026 (claude 2.1.288 em `-p`, haiku 4.5, salvo indicação). Evidência
>   copiada para `C:\Dev\playwright\temp\2026-10-02-spike-abas-agente\` (fora do git; `spike/` no texto = essa pasta).
>   O carimbo chegou ao servidor em `hookid/run1` (subagente) e `hookid/run2` (agente de Workflow, `workflow-subagent`).
> - **[código]**: lido no HEAD `62a2dc067`.
> - **[doc]**: code.claude.com/docs/en/hooks e /sub-agents.
> - **[inferido]**: dedução não testada.
>
> **Atalhos:** `pc/` = `packages/playwright-core/src/tools/` · `ext/` = `packages/extension/src/` · fork = `C:\Dev\playwright`.

## O problema, para quem chega agora

Cada sessão do Claude Code sobe **um** processo do servidor Playwright do fork. Esse processo tem uma conexão com a extensão, um grupo de abas e um ponteiro de "aba corrente".

Subagente da Agent tool e agente de Workflow usam esse mesmo processo [medido: mesmo pid na mãe, no subagente e nos agentes do Workflow]. Daí vêm três problemas:
- um agente que abre aba desloca a aba do outro;
- o `browser_close` de um subagente fecha as abas de todos;
- o `browser_set_group_label` de um subagente renomeia o grupo da mãe.

Objetivo: cada agente tem liberdade total sobre as próprias abas (criar, trocar, fechar), e nenhum outro muda a página dele. Aba compartilhada é opcional.

## 1. Desenho final

1. **Carimbo (harness).** Um hook PreToolUse (`~/.claude/hooks/playwright-agente.cjs carimbo`, matcher `mcp__playwright__.*`) reescreve os argumentos de toda chamada de browser com `_meta = {...o _meta que veio, agenteTipo, sessao: session_id, agente: agent_id || 'main'}`.
   - O hook roda depois do modelo, então um agente não consegue se passar por outro.
   - [medido] O `agent_id` chega na Agent tool e no Workflow. É distinto por agente paralelo e ausente na mãe.
   - [medido] O `updatedInput` chega ao servidor, e o Claude Code não o valida contra o schema.
2. **Roteador (fork).** O processo continua um por sessão. Dentro dele, um arquivo novo, `pc/mcp/agentRouter.ts`, ligado em `pc/mcp/program.ts:189`, guarda `Map<agente, backend>`.
   - O backend de cada agente nasce na 1ª chamada dele, pela mesma fábrica que o modo HTTP já usa por cliente.
   - Em `--isolated` isso foi medido: 3 chaves sem cruzamento. No `--extension`, só [código].
3. **No Chrome**, cada agente ganha relay, conexão e grupo próprios, com título como "Playwright · <rótulo da mãe> · wf-1a2b".
   - Aba corrente, refs `eN`, snapshot, `browser_close` e rótulo são só dele.
   - Chamada sem carimbo cai em `main`, que é o comportamento de hoje.
   - Nenhum agente precisa de instrução nova.
4. **Ciclo de vida.** O grupo de um agente fecha:
   - quando ele fica 30 min sem usar o browser (nunca com chamada em voo);
   - quando ele mesmo chama `browser_close`;
   - no fim da sessão;
   - a partir da Fase 3, quando ele termina: um hook SubagentStop deixa um arquivo-marca e o roteador fecha o grupo.
5. **Fase 4, sem roubo de foco.** Da 2ª conexão em diante, um relay já conectado abre a página de conexão com `chrome.tabs.create({active:false})`. As abas dos subagentes nascem e ficam em 2º plano.

```
claude.exe (1 sessão)                    hook PreToolUse "carimbo" (node, fora do modelo)
 ├─ mãe ──────────────┐                  _meta.agente = agent_id | 'main'
 ├─ subagente (gp) ───┼── tools/call ──► _meta.sessao = session_id
 └─ agente WF (wf) ───┘        │
                               ▼  stdio: 1 conexão MCP, 1 processo (run-mcp-server.cjs → mcp.js)
                   AgentRouter (pc/mcp/agentRouter.ts)
                    'main'   → BrowserBackend → CDPRelayServer #1 ─┐
                    'a…1a2b' → BrowserBackend → CDPRelayServer #2 ─┼─► extensão: 1 service worker,
                    'a…3c4d' → BrowserBackend → CDPRelayServer #3 ─┘   N conexões = N grupos de abas
 hook SubagentStop "fim" ─► ~/.playwright-mcp/agentes-fim/<sessao>/<agent_id> ─► roteador fecha aquele grupo
```

## 2. Resposta à hipótese do Gabriel

> "Talvez eles deveriam ser interpretados como se fossem novas conversas para que tenham essa liberdade de criar novos
> grupos de aba?"

**Sim no efeito, não no mecanismo literal.**

- **O efeito.** Para o browser, cada subagente e cada agente de Workflow passa a ser exatamente uma conversa nova: grupo de abas próprio, aba corrente própria, `browser_close` e rótulo próprios. É o mesmo isolamento que duas conversas do Claude Code já têm hoje entre si (multiconexão do upstream, #42259).
- **O mecanismo literal falha.** Dar a cada subagente uma conexão MCP de verdade (servidor `playwright` inline no frontmatter do agente) foi medido:
  - instâncias simultâneas com a mesma configuração dividem um único processo [medido: `spike/out4.json`, `spike/out6.json`];
  - quando a primeira termina, o processo morre com a chamada da irmã em voo (`Connection closed`) [medido: `spike/out6.json`, uma vez]. Com o patch 3, isso fecharia as abas da irmã [inferido];
  - com o nome `playwright`, o processo inline sobe e não recebe nenhuma chamada [medido: `spike/out3.json`].
- **Por isso a "conversa nova" é virtual.** Ela vive dentro do único processo da sessão. Quem diz qual agente está chamando é o harness (hook), não a memória do modelo.
- **Aba compartilhada não faz falta.** Todos os grupos usam o mesmo perfil do Chrome (mesmos logins), então passar a URL basta.
  - Passar uma aba de um agente para outro fica na Fase 5, só se aparecer uso.
  - Arrastar à mão já funciona, mas a aba vira "do usuário".

## 3. O que mudou em relação aos desenhos julgados

Os 4 desenhos convergiram no mesmo núcleo: carimbo por hook e roteador no processo. Este plano parte do "mínimo", que tem o menor delta em arquivos quentes do upstream.

Enxertos que ficam:
- ociosidade por chave;
- Fase 0 com prova;
- teste dedicado de `disconnected`;
- hook em `~/.claude/hooks/`, chamado com `node` direto;
- kill switch por env;
- três decisões para o Gabriel (§ 8).

Correções que mudam o desenho:

1. **correção:** liberar o agente por hook `mcp_tool` no SubagentStop **não** é inofensivo num servidor sem roteador.
   - No fork, `pc/utils/mcp/server.ts:84-113` cria o backend **antes** de procurar a tool. No `--extension`, criar o backend abre a página de conexão e puxa o foco (`pc/mcp/program.ts:143` → `pc/mcp/extensionContextFactory.ts:38-43` → `pc/mcp/cdpRelay.ts:183`) [código].
   - O npx 0.0.78 em cache também cria o backend antes de procurar a tool (`coreBundle.js`: `initializeServer` antes de `backend.callTool`) [código].
   - Que isso abra a página de conexão no npx, e que o pin 0.0.83 do wrapper (`scripts/run-mcp-server.cjs:38`) faça igual, é [inferido].
   - Consequência: na janela de fallback (depois de um `git pull`, com stamp velho), toda sessão que nunca usou o browser abriria uma página de conexão a cada subagente que termina.
   - Trocado por arquivo-marca, que servidor sem roteador ignora (Fase 3).
2. **correção:** o keepalive relay→extensão e a posse persistida em `chrome.storage.session` partem de uma premissa que o próprio Gabriel retratou na issue #41846.
   - Com uma aba anexada, o service worker **não** é suspenso nem depois de muitos minutos. A suspensão de ~30 s só vale sem aba anexada [doc: comentário de fechamento da #41846, teste controlado dele].
   - Toda conexão viva tem aba anexada (a semente), e a que fica sem nenhuma se fecha sozinha (`ext/relayConnection.ts:172-175`).
   - Os dois saem do plano.
3. **correção:** não dá para "reverter o commit do patch 5". O `c7e014680` também pôs `browser_set_group_label` na lista de `tests/mcp/capabilities.spec.ts` [código: `git show --stat`]. Os textos voltam ao upstream à mão.
4. **correção:** rotear no modo persistente (sem `--isolated` nem `--extension`) quebra. O 2º backend falha com "use --isolated" (`pc/mcp/browserFactory.ts:191-192`; o upstream testa isso em `tests/mcp/http.spec.ts:362-385`) [código]. O roteador só liga em `--extension` e `--isolated`.
5. **correção (âncoras):**
   - `pc/mcp/program.ts` tem 191 linhas: fábrica em :108, `create` em :113, `start` em :189.
   - O texto do patch 5 está em `pc/backend/tabs.ts:27,30` e `pc/backend/navigate.ts:26`.
   - `ext/pendingConnection.ts` tem 60 linhas, com `openRelayConnection` em :46.
   - `browserModel.ts` e `cdpRelayV2.ts` ficam em `pc/mcp/`, no servidor, não na extensão.
6. **correção:** abrir aba em 2º plano e ignorar `Page.bringToFront` são mudanças **só do servidor** [código]:
   - `pc/mcp/browserModel.ts:142` manda `chrome.tabs.create` só com `{url}`;
   - `TabCreateProperties.active` já existe em `pc/mcp/protocol.ts:27`;
   - `Page.bringToFront` passa por `pc/mcp/cdpRelay.ts:280-297`.

   A conexão silenciosa também dispensa comando novo (`extension.openSibling`). `chrome.tabs.create` já está na allowlist (`ext/relayConnection.ts:45`), então um relay já conectado pode abrir a próxima página de conexão com `active:false`. Na extensão, sobra pular `ext/background.ts:129-132` nesse caso [inferido; spike 4.0].

Saem também:
- o teto duro de agentes, que fere "liberdade total" e vira aviso em log;
- a tool `browser_release_agent`, que vira arquivo-marca;
- as 2 linhas a mais em `server.ts:113`, porque nenhuma guarda precisa do `toolUseId`.

## 4. Fases

### Regras de execução no fork (todas as fases)

- Ler `C:\Dev\playwright\FORK.md` inteiro antes.
- **Commits:** um commit por patch (FORK.md:10), mensagem semântica (`feat(mcp): …`), por pathspec, **sem trailer de autoria** (CLAUDE.md do fork).
- **Push:** o CLAUDE.md do fork é mais específico que a exceção da casa (`/executar` pusha ao fechar fase verde). Neste repo, push só com OK explícito do Gabriel, mesmo sob `/executar`.
- **Worktree.** O código vai num worktree, chamado `<worktree>` abaixo, pela convenção da casa:
  - criar com `C:\Dev\cerebro\scripts\worktree.ps1 novo playwright <nome>` (ver `C:\Dev\cerebro\temas\harness\sessoes-e-task-system.md` § Worktree por sessão);
  - se o script não servir ao fork, usar `git worktree add` como em FORK.md:88-92;
  - o fork não tem `.worktree.json`, então `npm ci` roda dentro do worktree;
  - remover o worktree só pelo `integrar.py` da central.
- **Nunca `npm ci` no checkout principal:** apaga o `node_modules` de servidores que outras sessões estão rodando (FORK.md:88-92).
- **Ao levar para o checkout principal:** `npm run build && touch scripts/.build-stamp`.
  - Sem o stamp, a próxima sessão roda o npx de fallback, sem nada do fork (FORK.md:112-120).
  - Sessões já abertas seguem com o servidor antigo até reiniciar.
- **Antes de commitar ou buildar no checkout principal:** conferir se a ronda diária do card `cce21afc9f588` (10:00) está em voo e pausar o maestro (`C:\Dev\CLAUDE.md` § Git).
- **Testes:**
  - `npm run ctest-mcp` roda no Windows.
  - `tests/extension/` **não** roda sem humano no Windows (FORK.md:151-155). Mudança na extensão pede teste manual mais `npx tsc -p tsconfig.json --noEmit` e `npx tsc -p tsconfig.ui.json --noEmit` em `packages/extension/`. A linha de base é 3 erros em `connectedTabGroup.ts`; mais que 3 é regressão (FORK.md:100-102).
  - `npm run flint` falha em `doc` no Windows por ambiente (FORK.md:103-104). É a única falha aceita.
- **Token da extensão:** nunca ler `~/.claude.json` para pegá-lo; o `guarda-segredo` barra isso, e deve barrar.
  - Se `PLAYWRIGHT_MCP_EXTENSION_TOKEN` não estiver no ambiente, rodar sem token: o Gabriel clica "Allow" na própria página de conexão, uma vez por conexão.
  - Perfil: `--profile-dir-name "Profile 13"` (variante `padrao`, FORK.md:122-128).
- **Fechamento:** cada fase fecha com a doc indicada nela e com fragmento de diário em `C:\Dev\cerebro\pessoal\diario\` (skill `consolidar`).

### Fase 0: spikes que faltam (nada muda no fork nem em `~/.claude`)

**0.1 [portão] N relays no mesmo processo, no Chrome real.** O teste usa o modo HTTP do upstream, em que cada sessão MCP vira um backend com relay próprio (`pc/utils/mcp/http.ts:139-144` → `pc/mcp/program.ts:143`) [código]. É o caminho que o roteador vai usar, sem escrever uma linha. Criar `C:\Dev\playwright\temp\spike-n-relays.mjs`:

```js
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire('C:/Dev/playwright/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const MCP = process.argv[2] ?? 'C:/Dev/playwright/packages/playwright-core/lib/entry/mcp.js';
const srv = spawn(process.execPath, [MCP, '--port', '0', '--extension', '--browser', 'chrome', '--profile-dir-name', 'Profile 13'], { stdio: ['ignore', 'ignore', 'pipe'] });
process.on('exit', () => srv.kill());   // erro no meio não deixa servidor vivo segurando relays e abas no Chrome
const base = await new Promise(r => srv.stderr.on('data', d => { const m = String(d).match(/Listening on (\S+)/); if (m) r(m[1]); }));
const mk = async name => { const c = new Client({ name, version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'))); return c; };
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
const text = r => (r.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const url = async c => (text(await call(c, 'browser_snapshot')).match(/Page URL: (\S+)/) ?? [])[1];
const [A, B, C] = await Promise.all(['spikeA', 'spikeB', 'spikeC'].map(mk));
await call(A, 'browser_navigate', { url: 'https://example.com/#A' });
await Promise.all([[B, 'org', 'B'], [C, 'net', 'C']].map(async ([c, tld, k]) => {
  await call(c, 'browser_navigate', { url: `https://example.${tld}/#${k}` });
  await call(c, 'browser_tabs', { action: 'new', url: `https://example.${tld}/#${k}2` });
}));
console.log('A:', await url(A), '| B:', await url(B), '| C:', await url(C));
const shot = await call(A, 'browser_take_screenshot');
console.log('screenshot de A em 2º plano:', shot.isError ? 'ERRO ' + text(shot).slice(0, 160) : 'ok');
console.log('close B isError:', !!(await call(B, 'browser_close')).isError);
console.log('depois do close de B -> A:', await url(A), '| C:', await url(C));
await call(A, 'browser_close'); await call(C, 'browser_close'); srv.kill(); process.exit(0);
```

- **Prova:** com o Chrome aberto e o Gabriel olhando, rodar `node C:/Dev/playwright/temp/spike-n-relays.mjs`. Saída esperada:
  ```
  A: https://example.com/#A | B: https://example.org/#B2 | C: https://example.net/#C2
  screenshot de A em 2º plano: ok
  close B isError: false
  depois do close de B -> A: https://example.com/#A | C: https://example.net/#C2
  ```
  No Chrome, aparecem três grupos `Playwright · spikeA/spikeB/spikeC`, e o de B some no close (patch 3). Anotar quantas vezes a janela do Chrome tomou a frente (esperado: 3, uma por conexão).
- **Reprova se:**
  - uma URL vem da aba de outro cliente;
  - B ou C falha com `Another extension connection already established` ou `did not connect within 30s`;
  - A ou C morre no close de B.

  Nesses casos o plano para aqui e vale a regra atual (um dono do browser por vez). Exceção: se o cliente A sozinho já não conecta, o problema é o caminho HTTP + extensão (sem teste no upstream), não N relays. Aí a prova é refeita na 1.7, por stdio, com o roteador.
- O screenshot com erro **não** reprova o portão. Ler aba em 2º plano já é a condição de hoje: o modo extensão pula o focus emulation (`packages/playwright-core/src/server/chromium/crPage.ts:600-605`). O resultado do screenshot decide a 4.3 e a 3ª decisão da § 8.

**0.2 [precondição do carimbo] O npx de fallback aceita o `_meta` extra.** O hook é global e vai carimbar também as sessões que caírem no npx (`scripts/run-mcp-server.cjs:38`, `@playwright/mcp@0.0.83`). No fork, o zod descarta a chave em silêncio [medido]; no 0.0.83, isso não foi verificado. Criar `C:\Dev\playwright\temp\spike-npx-meta.mjs`:

```js
import { createRequire } from 'module';
const require = createRequire('C:/Dev/playwright/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const env = { ...process.env };
delete env.PLAYWRIGHT_MCP_EXTENSION_TOKEN; delete env.PLAYWRIGHT_MCP_EXTENSION;
const c = new Client({ name: 'spike-npx', version: '1' });
await c.connect(new StdioClientTransport({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--headless', '--isolated'], env, stderr: 'ignore' }));
try {
  for (const meta of [undefined, { agente: 'a0000000000001111', agenteTipo: 'general-purpose', sessao: '00000000-0000-4000-8000-000000000000' }]) {
    const r = await c.callTool({ name: 'browser_tabs', arguments: meta ? { action: 'list', _meta: meta } : { action: 'list' } });
    console.log(meta ? 'com _meta:' : 'sem _meta:', r.isError ? 'ERRO ' + r.content[0].text.slice(0, 160) : 'ok');
  }
} finally {
  await c.close();
}
process.exit(0);
```

- **Prova:** `node C:/Dev/playwright/temp/spike-npx-meta.mjs` imprime `sem _meta: ok` e `com _meta: ok`.
- **Reprova se:** sai `com _meta: ERRO …Invalid arguments…`.
  - Nesse caso, antes da 2.2, subir o pin `NPX_FALLBACK_ARGS` para uma versão que passe e repetir o spike. Sem isso, nada de carimbo global.
  - Se `sem _meta` também falhar, o problema é de ambiente.

**0.3 Latência do hook.** Criar `C:\Dev\playwright\temp\playwright-agente.cjs` com o conteúdo da 2.1 e medir:

```bash
IN='{"session_id":"s1","agent_id":"a1","agent_type":"general-purpose","tool_input":{"action":"list"}}'
for i in $(seq 21); do s=$(date +%s%N); echo "$IN" | bash -c 'node "C:/Dev/playwright/temp/playwright-agente.cjs" carimbo' >/dev/null; echo $(( ($(date +%s%N)-s)/1000000 )); done | sort -n | sed -n 11p
```

- **Prova:** a mediana impressa (ms) é ≤ 150.
- **Reprova se:** passa de 300 ms.
  - Testar então a forma `"command": "node"` + `"args": [...]` (campo `args` dos hooks de comando [doc]).
  - Se continuar alto, aceitar e registrar. O custo é por chamada de browser, que já leva de 100 ms a segundos.

**0.4 Arquivo-marca do SubagentStop.** O `session_id` é o mesmo no PreToolUse da mãe, no do subagente e no SubagentStop [medido: run1/run2]. Falta provar o caminho em disco. Criar `C:\Dev\playwright\temp\spike-fim\settings.json` com:

`{"hooks":{"SubagentStop":[{"hooks":[{"type":"command","command":"node \"C:/Dev/playwright/temp/playwright-agente.cjs\" fim","timeout":10}]}]}}`

```bash
cd C:/Dev/playwright/temp/spike-fim
export PLAYWRIGHT_MCP_AGENT_RELEASE_DIR="C:/Dev/playwright/temp/spike-fim/rel" CENTRAL_ORIGEM=ia:spike
run() { claude -p --model haiku --session-id "$1" --settings settings.json --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --permission-mode bypassPermissions "Use a ferramenta Agent para lançar um subagente general-purpose que responda só ok." < /dev/null; }
SID=$(node -e "console.log(require('crypto').randomUUID())"); mkdir -p "rel/$SID"; run "$SID"; ls "rel/$SID"
SID2=$(node -e "console.log(require('crypto').randomUUID())"); run "$SID2"; ls rel
```

- **Prova:**
  - o 1º `ls` mostra um arquivo `a` + 16 hex, que é o `agent_id` do subagente;
  - o `ls rel` final mostra só `$SID`: para `$SID2`, que não tinha pasta, o hook não escreveu nada.
- **Reprova se:** nenhum arquivo aparece. Logar o `input` no hook e conferir o `session_id`. Se não casar, a Fase 3 não entra e fica só a ociosidade.
- **Repetir com agente de Workflow** (o caso que motivou o pedido; `run5` só mediu `--agents`): `SID3=…; mkdir -p "rel/$SID3"`
  e o mesmo `run`, com o prompt "Use a ferramenta Workflow para rodar um script com um único agent() que responda só ok."
  - **Prova:** `ls "rel/$SID3"` mostra um arquivo `a` + 16 hex.
  - **Reprova se:** vazio. Então SubagentStop não cobre Workflow: a Fase 3 vale só para a Agent tool, e a ociosidade
    vira o mecanismo primário para Workflow (o default de 30 min da 1.2 já conta com isso; registrar no FORK.md).

**0.5 (opcional) Carimbo fora do bypass.** Repetir o run1 do spike com `--permission-mode default --allowedTools "mcp__eco__eco"`. O run1 usa um servidor eco que loga `params.arguments`; a evidência está em `spike/hookid/`.
- **Prova:** o log do eco mostra `_meta.agente`.
- **Reprova se:** não mostra. Registrar em FORK.md que o isolamento só vale em bypass, que é o modo da casa.

### Fase 1: roteador no fork (patch 6), inerte até existir carimbo

**1.1 Worktree e linha de base.** Criar o worktree no ramo `agente-router` a partir da `main` (regra acima). Dentro dele: `npm ci && npm run build`.
- **Prova:** `npm run ctest-mcp -- capabilities tabs core` passa inteiro.
- **Reprova se:** falha antes de qualquer mudança. É ambiente; resolver antes de seguir.

**1.2 `pc/mcp/agentRouter.ts`** (novo, ~110 linhas, mais o cabeçalho Apache de `pc/backend/extensionSession.ts:1-15`). Exporta `withAgentRouting(inner, config)` e `agentRoutingEnabled(config)`. Esqueleto (os comentários são o contrato):

```ts
// Fork-only (patch 6). Um backend de browser por agente que chama, dentro da mesma sessão MCP.
// Quem chama vem em arguments._meta.agente, carimbado por hook PreToolUse (FORK.md § Agent routing).
import { EventEmitter } from 'events';
import type { CallToolRequest, CallToolResult, ClientInfo, ServerBackend, ServerBackendFactory, Tool } from '../utils/mcp/server';
import type { FullConfig } from './config';

const MAIN = 'main';
const ID = /^[\w-]{1,64}$/;

export function agentRoutingEnabled(config: FullConfig): boolean {
  if (process.env.PLAYWRIGHT_MCP_AGENT_ROUTING === 'off')
    return false;
  if (config.browser.remoteEndpoint || config.browser.cdpEndpoint || config.sharedBrowserContext)
    return false;
  return !!config.browser.isolated || !!config.extension;   // persistente: o 2º backend falha ("use --isolated")
}

export function withAgentRouting(inner: ServerBackendFactory, config: FullConfig): ServerBackendFactory {
  return agentRoutingEnabled(config) ? { ...inner, create: async clientInfo => new AgentRouter(inner, clientInfo) } : inner;
}

type Entry = { promise: Promise<ServerBackend>, inFlight: number, idle?: NodeJS.Timeout };

class AgentRouter extends EventEmitter<{ disconnected: [], dynamictoolschange: [] }> implements ServerBackend {
  private _entries = new Map<string, Entry>();
  private _main: ServerBackend | undefined;
  private _mainLabel: string | undefined;
  private _idleMs = Number(process.env.PLAYWRIGHT_MCP_AGENT_IDLE_MS) || 30 * 60_000;   // Workflow com effort alto pensa muito entre chamadas

  constructor(private _inner: ServerBackendFactory, private _clientInfo: ClientInfo) {
    super();
  }

  async initialize(clientInfo: ClientInfo) {
    this._clientInfo = clientInfo;   // nenhum browser abre aqui: cada agente abre o seu na 1ª chamada
  }

  dynamicTools(): Tool[] {
    return this._main?.dynamicTools?.() ?? [];   // tools/list não tem chave: WebMCP só da aba da mãe
  }

  async callTool(name: string, args: CallToolRequest['params']['arguments'] = {}, signal: AbortSignal): Promise<CallToolResult> {
    const meta = (args as any)._meta ?? {};
    const key = typeof meta.agente === 'string' && ID.test(meta.agente) ? meta.agente : MAIN;
    const entry = this._entryFor(key, meta.agenteTipo);
    entry.inFlight++;
    clearTimeout(entry.idle);
    try {
      const result = await (await entry.promise).callTool(name, args, signal);
      if (!result.isError && name === 'browser_close')
        this._drop(key, entry, false);   // o backend já se descartou (browserBackend.ts:137-140); 'disconnected' pode não vir
      if (!result.isError && key === MAIN && name === 'browser_set_group_label')
        this._mainLabel = String((args as any).label);
      return result;
    } finally {
      entry.inFlight--;
      if (key !== MAIN && !entry.inFlight && this._entries.get(key) === entry)
        entry.idle = setTimeout(() => this._drop(key, entry, true), this._idleMs).unref();
    }
  }

  private _entryFor(key: string, tipo: unknown): Entry {
    const existing = this._entries.get(key);
    if (existing)
      return existing;
    const clientName = key === MAIN ? this._clientInfo.clientName : `${this._mainLabel ?? this._clientInfo.clientName} · ${shortType(tipo)}-${key.slice(-4)}`;
    const clientInfo = { ...this._clientInfo, clientName };   // clientName vira o título do grupo (browserFactory.ts:77)
    const entry = { inFlight: 0 } as Entry;
    entry.promise = this._inner.create(clientInfo).then(async backend => {
      await backend.initialize?.(clientInfo);
      backend.once('disconnected', () => this._drop(key, entry, true));   // NUNCA reemitir para cima (server.ts:94-98)
      if (key === MAIN) {
        this._main = backend;
        backend.on?.('dynamictoolschange', () => this.emit('dynamictoolschange'));
      }
      return backend;
    });
    entry.promise.catch(() => this._drop(key, entry, false));   // falhou: a próxima chamada tenta de novo
    this._entries.set(key, entry);   // síncrono: duas 1ªs chamadas paralelas do mesmo agente dividem um create
    return entry;
  }

  private _drop(key: string, entry: Entry, dispose: boolean) {
    if (this._entries.get(key) !== entry)
      return;
    this._entries.delete(key);
    clearTimeout(entry.idle);
    if (key === MAIN)
      this._main = undefined;
    if (dispose)
      void entry.promise.then(backend => backend.dispose?.()).catch(() => {});
  }

  async dispose() {
    const entries = [...this._entries.values()];
    this._entries.clear();
    await Promise.allSettled(entries.map(entry => entry.promise.then(backend => backend.dispose?.())));
  }
}

const shortType = (tipo: unknown) => tipo === 'general-purpose' ? 'gp' : tipo === 'workflow-subagent' ? 'wf'
  : typeof tipo === 'string' && ID.test(tipo) ? tipo.slice(0, 16) : 'agente';
```

Regras que os testes da 1.5 travam:
- **Nunca emitir `'disconnected'`.** O `server.ts:94-98` zera o `backendPromise` e descarta tudo, inclusive a mãe.
  Engolir o evento preserva a semântica de hoje: lá ele só zera a promise e chama `dispose` (conferido em
  `pc/utils/mcp/server.ts:94-98` em 03/10), e a próxima chamada recria; o roteador faz o mesmo por chave.
- **Rótulo por agente sai de graça:** o registro `Browser → relay` é `WeakMap` por `Browser`
  (`pc/backend/extensionSession.ts`), e cada backend tem o seu `Browser`; provado na 1.7 e na 2.3.
- **Promise no Map antes do 1º `await`,** no padrão de `server.ts:88-109`.
- **`browser_close` sem erro larga a chave pelo nome.** O `isClose` é apagado antes do retorno (`browserBackend.ts:137-140`).
- **Ociosidade só com `inFlight === 0`.** O `IdleTimer` do backend é cutucado no início da chamada (`browserBackend.ts:90`) e dispararia no meio de uma chamada longa.
- **`main` nunca expira.**
- **Log e aviso, sem teto.** Log `pw:mcp:router` com `create key=… clientName=…`, e uma linha de aviso quando passar de 8 chaves vivas, porque as cores de grupo repetem a partir da 9ª (`ext/connectedTabGroup.ts:44-54`).

- **Prova:** `npm run build` sem erro de tipo.
- **Reprova se:** o build falha, ou o `check-deps` (1.6) acusa import fora do `DEPS.list` de `pc/mcp/`.

**1.3 `pc/mcp/program.ts:189`.** Trocar a linha por `await mcpServer.start(withAgentRouting(factory, config), config.server);` e acrescentar `import { withAgentRouting } from './agentRouter';`.
- **Prova:** `git diff --stat upstream/main -- packages/playwright-core/src/tools/mcp/program.ts` imprime `1 file changed, 2 insertions(+), 1 deletion(-)`.
- **Reprova se:** mais linhas mudam em `program.ts`. Ele teve 34 commits upstream desde 04/2026, e cada linha a mais vira conflito de rebase.

**1.4 Texto do `browser_close`** (os textos do patch 5 em `tabs.ts`/`navigate.ts` **ficam** até o portão 2.3: são o
único freio enquanto o carimbo não existe; voltam ao upstream na 2.5).
- `pc/backend/common.ts:27` (`browser_close`): o texto de hoje, "Close the page", mente, porque a tool fecha a conexão inteira. Passa a ser `'Close your browser connection and every tab you opened (in extension mode, your tab group). Other agents keep theirs; the next browser call reconnects.'`
- **Prova:** `grep -c "Close your browser connection" packages/playwright-core/src/tools/backend/common.ts` → `1`, e `npm run ctest-mcp -- capabilities` passa.
- **Reprova se:** o grep dá `0`, ou `capabilities` falha.

**1.5 `tests/mcp/agent-routing.spec.ts`** (novo; só do fork).
- Helper: `const as = (client, agente, name, args = {}) => client.callTool({ name, arguments: { ...args, _meta: { agente } } })`.
- Servidor com `startClient({ args: ['--isolated'] })`, porque o persistente não roteia. O fixture aceita `env` por teste (`tests/mcp/fixtures.ts:54-64,140-143`). As páginas vêm do fixture `server`.

Casos:
1. mãe e `a1` em páginas diferentes; `a1` faz `browser_tabs new`; o snapshot da mãe segue na página dela;
2. `browser_close` de `a1` não afeta a mãe; a chamada seguinte de `a1` nasce limpa (`about:blank`);
3. chamada sem `_meta` é a mãe;
4. duas 1ªs chamadas paralelas de `a2` (`browser_tabs new` com URLs X e Y): a lista de `a2` tem X e Y (um backend só);
5. modo persistente (`startClient()` padrão): `a1` vê as abas da mãe, sem erro;
6. `env: { PLAYWRIGHT_MCP_AGENT_ROUTING: 'off' }` com `--isolated`: `a1` vê as abas da mãe;
7. `env: { PLAYWRIGHT_MCP_AGENT_IDLE_MS: '500' }`: depois de 1,5 s parado, `a1` volta limpo e a mãe não;
8. depois do caso 2 (`disconnected` de uma chave), a mãe responde e `a3` cria normalmente.

- **Prova:** `npm run ctest-mcp -- agent-routing` imprime `10 passed` (a revisão da Fase 1 somou os casos 9 e 10:
  nada expira em voo; `browser_close` larga a chave com backend falso).
- **Reprova se:** qualquer caso falha.

**1.6 Não regressão.**
- **Prova:**
  - `npm run ctest-mcp -- capabilities tabs core group-label http idle-timeout roots` passa;
  - `npm run flint` só tem a falha conhecida de `doc`. O `check-deps` dele cobre o `DEPS.list` de `pc/mcp/`.
- **Reprova se:** aparece qualquer outra falha.

**1.7 Prova no Chrome real, sem Claude Code** (stdio, com `_meta` à mão). Criar `C:\Dev\playwright\temp\spike-router-stdio.mjs`:

```js
import { createRequire } from 'module';
const require = createRequire('C:/Dev/playwright/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const MCP = process.argv[2];   // o lib/entry/mcp.js do worktree
const c = new Client({ name: 'spike-router', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [MCP, '--extension', '--browser', 'chrome', '--profile-dir-name', 'Profile 13'], env: process.env, stderr: 'inherit' }));
const as = (agente, name, args = {}) => c.callTool({ name, arguments: { ...args, _meta: { agente, agenteTipo: agente === 'main' ? 'main' : 'general-purpose' } } }, undefined, { timeout: 120_000 });
const url = async agente => ((await as(agente, 'browser_snapshot')).content[0].text.match(/Page URL: (\S+)/) ?? [])[1];
const [K1, K2] = ['a0000000000001111', 'a0000000000002222'];
try {
  await as('main', 'browser_navigate', { url: 'https://example.com/#main' });
  await Promise.all([[K1, 'org'], [K2, 'net']].map(async ([k, tld]) => {
    await as(k, 'browser_navigate', { url: `https://example.${tld}/#${k}` });
    await as(k, 'browser_tabs', { action: 'new', url: `https://example.${tld}/#${k}-2` });
  }));
  console.log('main:', await url('main'), '| 1111:', await url(K1), '| 2222:', await url(K2));
  console.log('rotulo 2222 isError:', !!(await as(K2, 'browser_set_group_label', { label: 'rotulo-2222' })).isError);
  console.log('close 1111 isError:', !!(await as(K1, 'browser_close')).isError);
  console.log('depois -> main:', await url('main'), '| 2222:', await url(K2));
} finally {
  await c.close();   // fecha o stdin: o servidor cai e o patch 3 fecha as abas dos agentes
}
process.exit(0);
```

- **Prova:** `node C:/Dev/playwright/temp/spike-router-stdio.mjs <worktree>/packages/playwright-core/lib/entry/mcp.js` imprime:
  ```
  main: https://example.com/#main | 1111: https://example.org/#a0000000000001111-2 | 2222: https://example.net/#a0000000000002222-2
  rotulo 2222 isError: false
  close 1111 isError: false
  depois -> main: https://example.com/#main | 2222: https://example.net/#a0000000000002222-2
  ```
  No Chrome aparecem `Playwright · spike-router`, `Playwright · spike-router · gp-1111` e `… · gp-2222`; depois do
  rótulo, **só** o grupo de 2222 vira `Playwright · rotulo-2222` (o da mãe não muda). O de 1111 some no close. Os outros dois somem quando o script fecha o cliente, porque o servidor cai pelo stdin (FORK.md:163).
- **Reprova se:** igual à 0.1. Se a 0.1 tinha falhado só pelo caminho HTTP, esta é a prova que vale.

**1.8 Levar ao checkout principal.**
1. No worktree, commit por pathspec com a mensagem `feat(mcp): route each calling agent to its own browser backend (fork)`. Arquivos:
   - `packages/playwright-core/src/tools/mcp/agentRouter.ts`
   - `…/mcp/program.ts`
   - `…/backend/common.ts`
   - `tests/mcp/agent-routing.spec.ts`
   - `scripts/run-mcp-server.cjs`: em `envForAiSession` (~`:167`), `PLAYWRIGHT_MCP_AGENT_ROUTING: 'off'`. Sessão `ia:*`
     nasce **sem** roteador: em `--isolated` cada agente seria um chromium novo, o maestro roda várias sessões em
     paralelo e lá não há incidente. Liga depois de medir processos/memória numa rodada (§ Decisões técnicas).
     **Prova:** `grep -c "PLAYWRIGHT_MCP_AGENT_ROUTING" scripts/run-mcp-server.cjs` → `1`.
2. No checkout principal, com o maestro pausado se a ronda estiver em voo. O ramo real é `wt/agente-router`
   (worktree `C:\Dev\playwright\.claude\worktrees\agente-router`, commit `f22f40c74`), e a `main` andou depois
   dele (commits de docs), então rebase antes do ff:
   `git -C C:/Dev/playwright/.claude/worktrees/agente-router rebase main` e depois
   `git -C C:/Dev/playwright merge --ff-only wt/agente-router`.
3. Depois: `npm run build && touch scripts/.build-stamp`.

- **Prova:** em `C:/Dev/playwright`, `find packages/playwright-core/src -newer scripts/.build-stamp | head -1` sai vazio.
- **Reprova se:** o `find` imprime algo. A próxima sessão cairia no npx (FORK.md:118).
- **Efeito em produção:** nenhum até a Fase 2, porque sem carimbo tudo é `main`.
- **Reversão:** `git revert` + build + stamp, ou `PLAYWRIGHT_MCP_AGENT_ROUTING=off` no `env` do servidor `playwright` em `~/.claude.json` e reiniciar as sessões.

**1.9 Docs (`FORK.md`).**
- A linha do patch 5 **fica** até a 2.5.
- Entra o patch 6: `mcp/agentRouter.ts`, `mcp/program.ts:189`, texto de `backend/common.ts` e `tests/mcp/agent-routing.spec.ts`. Status no upstream: recusou caminho parecido em #39703 e #42961.
- Seção nova "Agent routing (patch 6)", com:
  - contrato `_meta.agente/agenteTipo/sessao`;
  - modos em que o roteador liga;
  - `PLAYWRIGHT_MCP_AGENT_ROUTING` e `PLAYWRIGHT_MCP_AGENT_IDLE_MS`;
  - limitações: riscos R2, R6 e R7, e "fechar a última aba reconecta".
- "Likely conflicts" ganha `program.ts:189` e `common.ts:27`.

### Fase 2: carimbo no harness e portão ao vivo (aqui o pedido é entregue)

**2.1 `~/.claude/hooks/playwright-agente.cjs`** (novo). O espelho em `C:\Dev\cerebro\harness-espelho\` é feito pelo hook `stop-backup-push.sh`. É o mesmo arquivo dos spikes 0.3 e 0.4:

```js
// Hooks do Playwright MCP do fork. Contrato: C:\Dev\playwright\FORK.md § Agent routing.
//   carimbo: PreToolUse (matcher mcp__playwright__.*) diz ao servidor qual agente chamou.
//   fim:     SubagentStop marca o agente encerrado para o servidor fechar o grupo dele.
// Falha aberta: qualquer erro -> exit 0 sem stdout (a chamada segue sem carimbo, como hoje).
const fs = require('fs'), os = require('os'), path = require('path');
const ID = /^[\w-]{1,64}$/;
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(buf);
    if (process.argv[2] === 'carimbo') {
      const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
      const meta = ti._meta && typeof ti._meta === 'object' ? ti._meta : {};
      // agente por último: sobrescreve o que o modelo tenha mandado. Nada de chave de topo (vaza para as tools
      // WebMCP, browserBackend.ts:113-117) nem de permissionDecision (fora do bypass aprovaria tudo sozinho).
      const updatedInput = { ...ti, _meta: { ...meta, agenteTipo: input.agent_type || 'main', sessao: input.session_id, agente: input.agent_id || 'main' } };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
    } else if (process.argv[2] === 'fim' && ID.test(input.session_id) && ID.test(input.agent_id)) {
      const root = process.env.PLAYWRIGHT_MCP_AGENT_RELEASE_DIR || path.join(os.homedir(), '.playwright-mcp', 'agentes-fim');
      const dir = path.join(root, input.session_id);
      if (fs.existsSync(dir))   // a pasta só existe se o servidor desta sessão usou o browser
        fs.writeFileSync(path.join(dir, input.agent_id), '');
    }
  } catch {}
  process.exit(0);
});
```

- **Prova:**
  ```bash
  H="$HOME/.claude/hooks/playwright-agente.cjs"
  echo '{"session_id":"s1","agent_id":"a1","agent_type":"general-purpose","tool_input":{"url":"https://x.y"}}' | node "$H" carimbo
  # → {"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"url":"https://x.y","_meta":{"agenteTipo":"general-purpose","sessao":"s1","agente":"a1"}}}}
  echo '{"session_id":"s1","tool_input":{"_meta":{"agente":"falso"}}}' | node "$H" carimbo
  # → ...{"_meta":{"agente":"main","agenteTipo":"main","sessao":"s1"}}... (o "falso" foi sobrescrito)
  echo 'lixo' | node "$H" carimbo; echo "exit=$?"
  # → exit=0, sem nada antes
  ```
- **Reprova se:** qualquer saída diferente.

**2.2 `~/.claude/settings.json`: a lista `hooks.PreToolUse` ganha uma entrada** (Edit ancorado; a skill `update-config` serve):

```json
{ "matcher": "mcp__playwright__.*", "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/playwright-agente.cjs\" carimbo", "timeout": 10 } ] }
```

Convenção de caminho conferida em 03/10: todos os hooks atuais usam `"$HOME/.claude/hooks/<x>"` (ex.:
`bash "$HOME/.claude/hooks/guarda-segredo.sh"`), então `$HOME` expande no shell de hook desta máquina.

- **Precondições:** 0.2 verde e Fase 1 no checkout principal.
- **Por que `timeout: 10`:** o padrão é 600 s [doc]. Que a chamada siga sem carimbo quando o hook estoura é [inferido].
- **Sem concorrência:** nenhum PreToolUse atual casa com `mcp__playwright__`, logo não há `updatedInput` concorrente [medido: leitura do `settings.json` em 02/10].
- **Vale ao vivo:** edição de hook em settings é lida na hora [doc: "picked up automatically by the file watcher"].
- **Prova (a entrada existe):** `node -e "const s=require(require('os').homedir()+'/.claude/settings.json');console.log(JSON.stringify(s.hooks.PreToolUse.filter(h=>/playwright/.test(h.matcher))))"` imprime a entrada acima.
- **Prova (o hook dispara de verdade, antes da 2.3):** numa sessão humana, a mãe chama
  `browser_tabs action:list` e, de dentro de um subagente, `browser_tabs action:list` de novo. Com
  `DEBUG=pw:mcp:router` no `env` do servidor (ou o log do roteador em arquivo), aparecem duas linhas `create key=…`:
  uma `main` e uma `a` + 16 hex.
  **Reprova se:** só aparece `key=main`, ou nenhuma linha: o hook não disparou ou não carimbou (caminho, `$HOME`,
  matcher). Corrigir antes de chamar o Gabriel para a 2.3.
- **Reversão** (a mais rápida do plano): apagar a entrada. Vale na hora, e tudo volta a `main`.

**2.3 Portão ao vivo.** Precisa de uma sessão **humana** nova, porque sessão aberta por IA usa chromium headless isolado, sem a extensão (FORK.md:130-133). O Gabriel abre uma sessão em `C:\Dev` e cola:

> Teste do roteador de abas (Fase 2.3). Siga à risca e me mostre cada resultado. Você e cada agente carregam antes as
> tools do Playwright com ToolSearch (`select:mcp__playwright__browser_navigate,mcp__playwright__browser_tabs,mcp__playwright__browser_snapshot,mcp__playwright__browser_close,mcp__playwright__browser_set_group_label`).
> 1) `browser_set_group_label` "teste-mae" e `browser_navigate` https://example.com/#mae. 2) Rode um Workflow com 2
> agentes em paralelo, rótulos wfA e wfB; cada um faz `browser_navigate` https://example.org/#<rótulo>, `browser_tabs` action "new" url https://example.net/#<rótulo>-2,
> `browser_snapshot`, e devolve a linha "Page URL" e a lista de abas. 3) Você (a mãe): `browser_tabs` action "list" e
> `browser_snapshot`. 4) Lance um subagente general-purpose que faz `browser_navigate` https://example.com/#sub e depois
> `browser_close`; ao fim, você faz `browser_snapshot` de novo. 5) Lance outro subagente que faz `browser_navigate`
> https://example.org/#rot e `browser_set_group_label` "rotulo-sub", e termina sem fechar.

- **Prova (esperado):**
  - wfA devolve `https://example.net/#wfA-2` e lista só `#wfA` e `#wfA-2`; wfB devolve o análogo;
  - a lista da mãe tem uma aba, `https://example.com/#mae`, antes e depois do passo 4;
  - no Chrome aparecem `Playwright · teste-mae`, dois `Playwright · teste-mae · wf-xxxx` e, no passo 4, um `… · gp-xxxx` que some no close;
  - a janela do Chrome toma a frente uma vez por conexão nova (mãe, wfA, wfB, subagente);
  - no passo 5, só o grupo desse subagente vira `Playwright · rotulo-sub`; `Playwright · teste-mae` continua igual.
- **Reprova se:**
  - a URL de um agente aparece na lista ou no snapshot de outro;
  - o grupo da mãe é renomeado;
  - o close do subagente fecha a aba da mãe;
  - algum agente erra com `Another extension connection already established` ou `did not connect within 30s`;
  - todos os grupos saem com o mesmo nome: o carimbo não chegou em sessão interativa (premissa P2).

  Em qualquer desses casos, apagar a entrada da 2.2.
- Os grupos `wf-xxxx` ficam abertos até 30 min depois do Workflow. Isso é esperado até a Fase 3.

**2.4 Docs.**
- `C:\Dev\cerebro\temas\playwright-mcp.md:172-178`, § "Subagentes dividem o browser da sessão" (Edit ancorado), vira "Cada agente tem o próprio grupo":
  - cada agente e subagente tem grupo, aba corrente, `browser_close` e rótulo próprios (roteador do fork + hook `playwright-agente.cjs`);
  - compartilhar = passar a URL;
  - a regra "um único dono do browser" sai;
  - a 1ª ação de qualquer agente segue sendo navegar (nunca `browser_tabs new`), e o rótulo é opcional para subagente.
- `C:\Dev\cerebro\projetos\playwright.md:27` passa a apontar para este roadmap.
- Em `roadmap/2026-10-02-abas-por-subagente.md` § Decisões técnicas, entra uma linha "níveis 0, 1 e 2 superados por <este roadmap>".
- `FORK.md` § "Setting this up on another machine" ganha o passo 4: instalar o hook (arquivo do espelho + o JSON da 2.2). Sem ele, os agentes de uma sessão voltam a dividir a aba.

**2.5 Textos do patch 5 de volta ao upstream** (só depois da 2.3 verde: até lá eles são o único freio).
- À mão, sem `git revert` (o `c7e014680` também pôs `browser_set_group_label` no `capabilities.spec.ts`):
  - `pc/backend/tabs.ts:27` → `'List, create, close, or select a browser tab.'`;
  - `pc/backend/tabs.ts:30` → `'Tab index, used for close/select. If omitted for close, current tab is closed.'`;
  - `pc/backend/navigate.ts:26` → `'Navigate to a URL'`.
- `pc/backend/common.ts:27` (`browser_close`) ganha de volta a frase que a revisão da Fase 1 tirou, porque só vale
  com o carimbo ligado: `'… your tab group). Other agents keep theirs; the next browser call reconnects.'`
- Commit `chore(mcp): drop the shared-current-tab warning, agents are routed now (fork)`; levar como na 1.8.
- `FORK.md`: sai a linha do patch 5 da tabela (a linha de `browser_set_group_label` no `capabilities.spec.ts` fica,
  é do patch 2).
- **Prova:** `git diff upstream/main -- packages/playwright-core/src/tools/backend/tabs.ts packages/playwright-core/src/tools/backend/navigate.ts` → (vazio), e `npm run ctest-mcp -- capabilities` passa.
- **Reprova se:** o diff não sai vazio, ou `capabilities` falha por `browser_set_group_label` ausente.

### Fase 3: fechar o grupo do subagente quando ele termina

**3.1 `pc/mcp/agentRouter.ts`: ler `_meta.sessao` e varrer marcas** (~40 linhas).

```ts
private _sessions = new Set<string>();
private _sweepTimer: NodeJS.Timeout | undefined;
private _releaseRoot = process.env.PLAYWRIGHT_MCP_AGENT_RELEASE_DIR || path.join(os.homedir(), '.playwright-mcp', 'agentes-fim');

// no início de callTool, antes de escolher a chave:
//   if (typeof meta.sessao === 'string' && ID.test(meta.sessao)) this._watch(meta.sessao);
//   this._sweep();

private _watch(sessao: string) {
  if (this._sessions.has(sessao))
    return;
  this._sessions.add(sessao);
  try { fs.mkdirSync(path.join(this._releaseRoot, sessao), { recursive: true }); } catch {}   // pasta = "esta sessão usa o browser"
  this._sweepTimer ??= setInterval(() => this._sweep(), 5000).unref();
}

private _sweep() {
  for (const sessao of this._sessions) {
    const dir = path.join(this._releaseRoot, sessao);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const agente of names) {
      try { fs.unlinkSync(path.join(dir, agente)); } catch {}
      const entry = this._entries.get(agente);
      if (agente !== MAIN && entry)
        this._drop(agente, entry, true);   // chave desconhecida: só apaga a marca, nunca cria browser
    }
  }
}
// dispose(): clearInterval(this._sweepTimer) e fs.rmSync(dir, { recursive: true, force: true }) de cada sessão vista.
```

**3.2 Testes**, no mesmo spec, com `env: { PLAYWRIGHT_MCP_AGENT_RELEASE_DIR: testInfo.outputPath('rel') }` e `_meta.sessao: 's1'`:

9. a marca `rel/s1/a1` faz `a1` voltar limpo em ≤ 10 s (`expect.poll`), e a mãe não muda;
10. a marca de agente desconhecido some e nada quebra;
11. chamada sem `sessao` não cria `rel/`.

- **Prova:** `npm run ctest-mcp -- agent-routing` imprime `11 passed`.
- **Commit:** commit novo no mesmo ramo, `feat(mcp): release an agent's browser when its SubagentStop marker appears (fork)`, sem amend (CLAUDE.md do fork). Os dois commits do patch 6 se fundem no próximo sync com o upstream. Levar ao checkout principal como na 1.8.
- **Reprova se:** algum dos 11 casos falha.

**3.3 `~/.claude/settings.json`: chave nova `hooks.SubagentStop`.**

```json
"SubagentStop": [ { "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/playwright-agente.cjs\" fim", "timeout": 10 } ] } ]
```

- **Síncrono de propósito.** O `async: true` [doc] pode perder a escrita quando a sessão sai logo depois. O custo do modo síncrono é ~100 ms no fim de cada subagente [inferido].
- **Sai sempre com 0,** então nunca bloqueia o fim do subagente (exit 2 bloquearia [doc]).
- **Prova (sessão humana):** pedir "lance um subagente general-purpose que navega para https://example.com/#fim e termina sem fechar o browser".
  - o grupo `… · gp-xxxx` some em até ~6 s depois do fim;
  - `ls ~/.playwright-mcp/agentes-fim/` mostra a pasta da sessão, vazia;
  - numa sessão que não usa o browser, não aparece pasta nova.
- **Reprova se:** o grupo fica. Conferir o `session_id` (0.4) e o log `pw:mcp:router`; enquanto isso, a ociosidade continua cobrindo.

**3.4 Docs.**
- `FORK.md` § Agent routing: marca de fim e `PLAYWRIGHT_MCP_AGENT_RELEASE_DIR`.
- `cerebro/temas/playwright-mcp.md`: "o grupo de um subagente fecha quando ele termina; abas que o Gabriel arrastou para ele só desagrupam (patch 3)".

### Fase 4: conexão silenciosa, sem roubo de foco (patch 7)

**4.0 Spike do portador, antes do código final.** No worktree do ramo `agente-silencioso`, implementar só a 4.2 e rodar:

`DEBUG=pw:mcp:relay node C:/Dev/playwright/temp/spike-router-stdio.mjs <worktree>/packages/playwright-core/lib/entry/mcp.js 2>&1 | grep -c "via portador"`

- **Prova:** imprime `2`, ou seja, a 2ª e a 3ª conexão foram abertas pelo relay da mãe, sem `chrome.exe` novo. A 1.7 dá a mesma saída de antes.
- **Reprova se:** a conexão pelo portador não completa em 30 s. Manter o spawn (é o fallback) e parar a fase.

**4.1 Escopo do agente até o relay.**
- `pc/backend/extensionSession.ts` (arquivo só do fork) exporta `relayScope = new AsyncLocalStorage<{ background: boolean }>()` e um `Set` dos relays conectados, para achar o portador.
- Em `pc/mcp/agentRouter.ts::_entryFor`, chave diferente de `main` cria dentro de `relayScope.run({ background: true }, () => this._inner.create(clientInfo))`.
- Nenhuma assinatura do upstream muda: `pc/mcp/browserFactory.ts:77` segue passando só o `clientName`.

**4.2 Portador.**
- `pc/mcp/extensionContextFactory.ts:38` passa `{ background: relayScope.getStore()?.background ?? false }` ao `CDPRelayServer`.
- Em `pc/mcp/cdpRelay.ts:131-189`, separar a montagem da URL do spawn.
- Em `establishExtensionConnection`, havendo relay conectado no processo, mandar por ele `chrome.tabs.create [{ url, active: !this._background }]`, com log `via portador`. Sem portador, ou com erro, usar o spawn atual.
- O relay entra no `Set` em `_handleExtensionConnection` (`:249-262`) e sai em `stop()` (`:198-201`).
- Kill switch: `PLAYWRIGHT_MCP_AGENT_SILENT=off` desliga a 4.2 e a 4.3.

**4.3 Segundo plano (só relays `background`).**
- `pc/mcp/cdpRelay.ts:88-92` (`sendCommand`): `chrome.tabs.create` ganha `active:false`. Vale para `browser_tabs new` e para popups do agente.
- `pc/mcp/cdpRelay.ts:280-292` (`_handleCDPCommand`): `Page.bringToFront` responde `{}` sem ir à extensão. Assim o `select` deixa de trocar a aba visível (`pc/backend/context.ts:195`).
- Só aplicar se o screenshot em 2º plano passou na 0.1. Senão, vale a opção B da 3ª decisão da § 8.

**4.4 Extensão.**
- Em `ext/background.ts:73-87` e `:108-140`, definir `silent = !message.tab && sender.tab?.active === false`, isto é: token sem escolha de aba e página de conexão aberta em 2º plano.
- Com `silent`, pular o `chrome.tabs.update(active)` + `chrome.windows.update(focused)` de `:129-132`.
- Bump de `packages/extension/manifest.json`: `0.4.0.1` → `0.4.0.2`.
- Extensão velha com servidor novo continua conectando, só que puxa o foco: degrada, não quebra.

**4.5 Checagens.**
- **Prova automática:**
  - em `packages/extension/`, `npx tsc -p tsconfig.json --noEmit` e `npx tsc -p tsconfig.ui.json --noEmit` dão 3 erros (a linha de base);
  - `npm run ctest-mcp -- agent-routing capabilities tabs core group-label` passa;
  - `npm run flint` só falha em `doc`.
- **Prova manual (com o Gabriel olhando):**
  1. Build da extensão e "Reload" em cada perfil que usa a cópia unpacked. Se voltar versão velha, reiniciar o Chrome (FORK.md:138-145).
  2. Rodar a 1.7. Só a 1ª conexão puxa a janela.
  3. As abas de `1111` e `2222` nascem em 2º plano.
  4. `browser_tabs select` de um agente não muda a aba visível; o da mãe muda.
  5. O screenshot da aba de um agente em 2º plano dá `ok`.
  6. Com a extensão antiga (antes do Reload), tudo conecta, com foco.
- **Reprova se:**
  - alguma conexão pelo portador não completa;
  - sobra `connect.html` aberta depois da conexão;
  - o screenshot em 2º plano falha.

  Reversão: `PLAYWRIGHT_MCP_AGENT_SILENT=off`.

**4.6 Docs.**
- `FORK.md`: patch 7 na tabela, com os arquivos acima e a data do teste manual. "Likely conflicts" ganha `cdpRelay.ts`, `extensionContextFactory.ts` e `ext/background.ts`.
- `cerebro/temas/playwright-mcp.md`: "subagente não toma mais a frente".

### Fase 5 (só sob demanda): passar uma aba de um agente para outro

- **O que é:** comando `extension.transferTab [tabId, conexão destino]` + `browser_tabs action:'give' to:<agente>`.
- **O que precisa:**
  - id estável Page→targetId;
  - posse `agent` no grupo de destino;
  - guarda para o doador não fechar ao perder a última aba (`ext/relayConnection.ts:172-175`).
- **Tamanho:** ~200 linhas [inferido].
- **Gatilho:** o Gabriel querer que a mãe assuma a aba logada de um subagente. Até lá, compartilhar = passar a URL.

## 5. Premissas não verificadas e como cada fase se protege

| # | premissa | estado | proteção |
| --- | --- | --- | --- |
| P1 | N relays num processo conectam no Chrome real, um grupo cada | [código] `pc/mcp/cdpRelay.ts:95-121` (uuid e porta por instância), `:249-253` (só recusa a 2ª extensão do mesmo relay); `ext/background.ts:119-127` (Map sem teto); `ext/ui/connect.tsx:96-100` (token conecta sem clique) | portão 0.1; refeito na 1.7 |
| P2 | carimbo vale em sessão interativa | [medido] só em `-p` | portão 2.3; se falhar, tudo é `main` (hoje) |
| P3 | `updatedInput` sem `permissionDecision` vale fora do bypass | [medido 03/10] em bypass e em `default` (0.5); o `updatedInput` é aplicado antes da checagem de permissão e não a concede | — |
| P4 | npx 0.0.83 descarta `_meta` extra | [medido 03/10] (0.2): descarta chave desconhecida em silêncio e recusa enum inválido | — |
| P5 | custo do hook por chamada é tolerável | [medido 03/10] (0.3): mediana ~100 ms via `bash -c`, ~60 ms com node direto; p90 150–300 ms com a máquina carregada | plano B: `"command":"node"` + `args` |
| P6 | hook e servidor chegam à mesma pasta de marcas | [medido 03/10] (0.4) | — |
| P7 | SubagentStop dispara em Esc ou crash | fim normal [medido 03/10] para Agent tool **e Workflow** (`workflow-subagent`); Esc/crash não medidos (ver #92716) | ociosidade de 30 min (Fase 1) |
| P8 | `agent_id` estável na retomada e o mais interno em aninhamento | não testado | chave nova = grupo novo; o velho sai por ociosidade |
| P9 | `disconnected` vem depois do `browser_close` no modo extensão | [inferido] | o roteador larga a chave pelo nome da tool |
| P10 | screenshot de aba em 2º plano funciona com a extensão | não medido; o modo extensão pula focus emulation (`crPage.ts:600-605`) | 0.1 mede; decide 4.3 e a 3ª decisão da § 8 |
| P11 | página de conexão aberta em 2º plano por um portador conecta sem clique | [inferido] (`ext/relayConnection.ts:45`, `ext/ui/connect.tsx:96-100`) | 4.0 |
| P12 | hook que estoura o timeout deixa a chamada seguir sem carimbo | [inferido] | `timeout: 10`; falha aberta |
| P13 | o Claude Code segue sem validar `updatedInput` contra o schema | [medido] em 2.1.288 (`eco_strict`) | se mudar: apagar a entrada da 2.2 e aplicar `io:'input'` em `pc/utils/mcp/tool.ts:34` |
| P14 | 2–3 `chrome.exe` simultâneos (antes da Fase 4) não travam o Chrome | [inferido] | 0.1 e 2.3 abrem conexões juntas |

## 6. Descartado e impraticável (o que NÃO fazer, com motivo e decisor)

- **Servidor `playwright` inline no frontmatter (processo por subagente).** Instâncias simultâneas dividem o processo, a 1ª que termina mata a da irmã, e com o mesmo nome o processo fica sem uso [medido: `spike/out3.json`, `out4.json`, `out6.json`]. Decisor: medição de 02/10.
- **Liberar pelo hook `mcp_tool` no SubagentStop.** Abre página de conexão em servidor sem roteador (correção 1). Decisor: código (`server.ts:84-113`, `coreBundle.js` do npx).
- **`git revert c7e014680`.** Leva junto a linha de `browser_set_group_label` do `capabilities.spec.ts` (correção 3).
- **`permissionDecision` no hook.** Fora do bypass, aprovaria sozinho toda tool do Playwright. Decisor: semântica do PreToolUse [doc].
- **Chave de topo no `updatedInput` (`_agente`).** Vaza para as tools WebMCP da página (`browserBackend.ts:113-117`).
- **Roteador emitir `'disconnected'`.** `server.ts:94-98` zera e descarta tudo: um subagente que fecha a última aba derrubaria a mãe e os irmãos.
- **Criar backend no SubagentStart ou ao liberar chave desconhecida.** Abre página de conexão e puxa o foco para quem nunca navega (`cdpRelay.ts:148-189`).
- **Rotear em modo persistente, `--cdp-endpoint`, remoto ou `--shared-browser-context`.** No persistente o 2º backend falha (correção 4); nos outros, os backends dividem o mesmo contexto e o isolamento seria parcial. Decisor: código.
- **Context único com mapa agente→aba (alternativa B).** São ~300–450 linhas em ~13 arquivos quentes (`context.ts`, `response.ts`…), e rotas, vídeo, `bringToFront`, close e rótulo continuariam compartilhados. Decisor: código.
- **id de aba em toda tool (estilo chrome-devtools-mcp).** Dá atomicidade, não isolamento: um agente ainda fecha a aba do outro com o id errado. O upstream recusou duas vezes (#39703, #42961).
- **Rota pelo transcript (`claudecode/toolUseId` → jsonl).** Exige polling de 3 a 1543 ms e depende de formato não documentado [medido].
- **Keepalive relay→extensão e posse persistida em `chrome.storage.session`.** A premissa foi retratada (correção 2), e fechar abas a partir de um mapa velho pode fechar aba do Gabriel. Decisor: issue #41846.
- **Comando novo `extension.openSibling`.** O `chrome.tabs.create` já permitido faz o mesmo com menos protocolo (correção 6).
- **Teto duro de agentes.** Fere "liberdade total"; vira aviso em log a partir de 8. Decisor: pedido do Gabriel.
- **Mutex global em `callTool`.** Serializa subagentes lentos e não isola nada. Decisor: pesquisa de 02/10.
- **Proxy fora do processo (A2) como base.** Perde roots/cwd (`server.ts:128-142` → outputDir e checkFile), soma um salto HTTP e uma porta, e HTTP + extensão não tem teste no upstream. Fica de plano B se o rebase de `program.ts:189` doer.
- **`playwright cli -s=<nome> attach --extension` pelo Bash.** Contraria "sempre MCP Playwright" (CLAUDE.md global) e exige exportar o perfil à mão.
- **`--silent-debugger-extension-api`.** Silencia um sinal de segurança do browser inteiro (FORK.md:165-169).
- **`npm ci` no checkout principal, ou ler `~/.claude.json` para pegar o token.** Ver FORK.md:91-92 e o `guarda-segredo`.

## 7. Riscos

- **R1. Roubo de foco.** Até a Fase 4, cada subagente que navega puxa a janela do Chrome (`cdpRelay.ts:183`, `ext/background.ts:129-132`).
  - Acontece de novo quando um agente fecha a própria última aba: a conexão fecha (`ext/relayConnection.ts:172-175`) e a chamada seguinte reconecta.
  - Mitigação: Fase 4, e registrar em FORK.md "navegue na última aba em vez de fechá-la".
- **R2. `unhandledRejection` cruzado.** Cada Context registra `process.on` (`pc/backend/context.ts:141`), então a rejeição de um agente aparece na próxima resposta de todos. Já acontece no modo HTTP; aceito e documentado.
- **R3. Mudança no Claude Code** (`agent_id`, `updatedInput`). Falha aberta para `main`. Se o Claude Code passar a validar o schema, as chamadas de browser falham até apagar a entrada da 2.2 (plano B: `io:'input'`, P13).
- **R4. Latência por chamada** (boot do node no hook). Medida na 0.3: ~100 ms na mediana, cauda de até ~1 s com a máquina ocupada.
- **R5. Ociosidade** fecha as abas de um agente que passa mais de 30 min sem usar o browser. É configurável e nunca dispara com chamada em voo.
- **R6. Sessões de IA (`--isolated`).** Cada agente teria um **contexto** próprio no browser compartilhado (não um
  chromium novo: `useSharedBrowser` em `program.ts`, conferido na Fase 1), sem cookies em comum entre eles. Hoje o
  roteador nasce desligado lá (`ROUTING=off`). O timer de ociosidade do browser compartilhado é um só: quando
  dispara, todas as chaves caem limpas.
- **R13. `agent_id` ocasionalmente inconsistente no PreToolUse** (anthropics/claude-code#90662): uma chamada de um
  subagente vivo pode chegar com outro id e abrir um grupo órfão. Limpa pela ociosidade e pela Fase 3.
- **R7. WebMCP.** `tools/list` só mostra as tools da aba da mãe. O agente ainda chama a tool da própria aba, porque o lookup vai ao backend dele (`browserBackend.ts:110-117`).
- **R8. Rebase.** `program.ts:189` (34 commits upstream desde 04/2026, mas é uma linha) e `common.ts:27`; na Fase 4, também `cdpRelay.ts`, `extensionContextFactory.ts` e `ext/background.ts`. É patch só do fork, para sempre.
- **R9. Muitos agentes com browser.** As cores repetem a partir do 9º grupo (`ext/connectedTabGroup.ts:44-54`) e o Chrome pesa. Sem teto, só aviso.
- **R10. Reconexões silenciosas de causa não caracterizada** (#41846, comentário de fechamento). Passam a atingir um agente por vez; quando acontecem, o patch 3 fecha as abas daquele agente.
- **R11. Janela de fallback** (npx ou stamp velho). Sem roteador, volta a disputa de hoje. Carimbo e marcas são ignorados, sem efeito colateral, desde que a 0.2 passe.
- **R12. Faixa "started debugging".** É global e segue igual (FORK.md:165-169).

## 8. Decisões

**Para o Gabriel:**

- [[DECISAO]] Ligar o isolamento no seu Chrome já na Fase 2, sabendo que até a Fase 4 cada subagente que navega abre uma aba de conexão e puxa a janela do Chrome para a frente uma vez? | opções: A ligar já / B rodar o portão 2.3 e desligar (apagar a entrada do hook) até a Fase 4 fechar | recomendo: A (a disputa de aba é o problema relatado; reverte na hora apagando uma entrada) | dono: gabriel
- [[DECISAO]] Quando um subagente termina, o grupo de abas dele fecha? | opções: A fecha (abas que você arrastou para o grupo só desagrupam, patch 3) / B fica aberto até 30 min sem uso | recomendo: A | dono: gabriel
- [[DECISAO]] Onde nascem as abas dos subagentes na Fase 4? | opções: A na mesma janela, em 2º plano, sem trocar a aba que você está vendo / B numa janela própria, sem foco | recomendo: A (menos código; o Chrome estrangula mais janela minimizada ou coberta), desde que o screenshot em 2º plano passe na 0.1 | dono: gabriel

## Decisões técnicas

Quem: opus 5.5 com advisor (fable), sessão `9f526eb4`, 03/10/2026.

| decisão | confiança | o que reverteria |
| --- | --- | --- |
| roteador no processo, um backend por agente (A1) | alta | rebase de `program.ts:189` virar dor recorrente → proxy A2 |
| identidade por `updatedInput` em `_meta` | alta [medido] | o Claude Code validar o schema → `io:'input'`; o hook perder o `agent_id` → rota toolUseId→transcript |
| liberação por arquivo-marca, hook síncrono | média-alta | a 0.4 falhar → só ociosidade |
| ociosidade de 30 min, nunca `main` (subiu de 15 pela crítica do advisor: Workflow com effort alto pensa muito) | média | agente perdendo abas enquanto pensa → `PLAYWRIGHT_MCP_AGENT_IDLE_MS` |
| sessões de IA (`ia:*`, `--isolated`) nascem **sem** roteador (`ROUTING=off` em `envForAiSession`, 1.8) | média; motivo mais fraco depois da Fase 1 (é um contexto por agente, não um chromium) | medir contextos/conexões numa rodada do maestro com subagentes navegando; se houver disputa lá, tirar o `off` |
| textos do patch 5 só saem depois do portão 2.3 (2.5), não na Fase 1 | alta | — |
| textos do patch 5 de volta ao upstream; `browser_close` com texto do fork | alta | — |
| sem teto de agentes, aviso a partir de 8 | média | Chrome pesando com muitos grupos → teto por env |

## 9. Impacto × esforço × risco

| fase | impacto | esforço [inferido] | risco | reversão |
| --- | --- | --- | --- | --- |
| 0 spikes | alto: decide se o plano segue | ~2 h + ~10 min do Gabriel no Chrome | nulo | — |
| 1 roteador (patch 6) | alto: habilita tudo | ~110 linhas + ~120 de teste + 3 textos | baixo: inerte sem carimbo | env `…_ROUTING=off` ou `git revert` |
| 2 carimbo + portão | alto: entrega o pedido | ~25 linhas + 1 entrada no settings | médio: foco por subagente até a Fase 4; P1/P2 | apagar 1 entrada (ao vivo) |
| 3 fim do subagente | médio: grupos não se acumulam | ~40 linhas + 3 testes + 1 entrada | baixo | apagar a entrada SubagentStop |
| 4 conexão silenciosa (patch 7) | médio-alto: acaba o roubo de foco | ~60 linhas no servidor + ~6 na extensão + teste manual | médio: extensão sem suíte no Windows; arquivos do upstream | `…_SILENT=off`; extensão velha só degrada |
| 5 passar aba | baixo: o Gabriel disse que não precisa | ~200 linhas | médio | não fazer |

## 10. O que o pedido não dizia

- **completei:** `browser_close` e `browser_set_group_label` passam a valer só para quem chama. Hoje um subagente fecha as abas de todos e renomeia o grupo da mãe. O texto do `browser_close` também deixa de dizer "Close the page".
- **completei:** o roteador desliga sozinho nos modos em que dois backends não convivem, em vez de quebrar.
- **completei:** a liberação no fim do subagente é imune ao npx de fallback e não cria nada em sessão que nunca usou o browser.
- **completei:** o roteador também funciona nas sessões abertas por IA (chromium headless isolado), mas nasce
  desligado lá (`ROUTING=off`, 1.8) até medir o custo de um chromium por agente; ligar é tirar uma linha.
- **completei:** rio abaixo, a regra "um dono do browser por vez" sai do cérebro, o FORK.md ganha contrato e passo de instalação, e o roadmap de pesquisa passa a apontar para este.
- **proposta (feita em 03/10/2026, autorizada pelo Gabriel):** pedir à Anthropic que repasse o id do agente a
  servidores MCP do usuário, com opt-in: [anthropics/claude-code#99135](https://github.com/anthropics/claude-code/issues/99135)
  (conta `dosxnjos`; sem duplicata, relacionadas #84638 e #90662).
  - A maquinaria já existe no `claude.exe`, restrita a um servidor interno [código, confiança média].
  - Com ela, o hook de carimbo some.
  - Custa uma issue na conta do Gabriel (dono: gabriel).
## Pendente (decisão do Gabriel)

Respondidas no chat em 03/10/2026 (sessão `9f526eb4`), as três da § 8:
1. foco até a Fase 4: **A, ligar já** (o recomendado);
2. grupo do subagente fecha quando ele termina: **sim** (A);
3. onde nascem as abas na Fase 4: **mesma janela, em 2º plano** (A), condicionado ao screenshot da 0.1.

## Execução em lote (03/10/2026)

Pedido do Gabriel, 03/10/2026: *"pode fazer até onde não depende de mim, porque vou dormir agora. mas aí amanhã
fazemos esse teste."* Autoriza rodar as Fases 0 e 1 numa invocação, com as travas:
- um commit por fase (no ramo do worktree), nunca um commit no fim;
- **paradas obrigatórias:** 0.1 e 1.7 (Chrome real, com o Gabriel olhando) não rodam sem ele; a 1.8 (levar ao
  checkout principal) e tudo da Fase 2 em diante esperam a 0.1 e a 1.7 verdes;
- nada em `~/.claude/settings.json` nem no checkout principal do fork nesta rodada; push nenhum.

## Tasklist de execução

Marcar `[x]` ao fechar cada passo (o detalhe e a prova de cada um estão na § 4).

- Fase 0: [x] 0.1 · [x] 0.2 · [x] 0.3 · [x] 0.4 (+ Workflow) · [x] 0.5
- Fase 1: [x] 1.1 · [x] 1.2 · [x] 1.3 · [x] 1.4 · [x] 1.5 (10 casos) · [x] 1.6 · [x] 1.7 · [x] 1.8 · [x] 1.9
- Fase 2: [x] 2.1 · [x] 2.2 · [x] 2.3 · [x] 2.4 · [x] 2.5
- **4.7 (novo, achado na 2.3):** [x] token fora da URL da página de conexão
- Fase 3: [x] 3.1 · [x] 3.2 · [x] 3.3 · [x] 3.4
- Fase 4: [x] 4.0 (coberto pelo teste ao vivo) · [x] 4.1 · [x] 4.2 · [x] 4.3 · [x] 4.4 · [x] 4.5 · [x] 4.6
- **4.8 (novo, proposto):** [ ] popup aberto pela página de um subagente (`window.open`) ainda vem para a frente
  (o Chrome cria com `active:true`); cura possível: a extensão devolve o foco à aba anterior quando o popup é de
  conexão silenciosa. Só se incomodar no uso.
- Fase 5: só sob demanda.

## Crítica do advisor

Consultado: fable 5.1 (advisor), com o md já gravado (`87a32df63`), 03/10/2026. Achados e destino:

| achado | destino |
| --- | --- |
| tirar os textos do patch 5 na Fase 1 deixa a disputa sem freio até a 2.3 | aplicado: virou a 2.5, depois do portão |
| rótulo por agente sem prova | aplicado: conferido `WeakMap` por `Browser` em `extensionSession.ts`; prova na 1.7 e no passo 5 da 2.3 |
| 0.4 não testa SubagentStop em agente de Workflow | aplicado: 0.4 ganha o caso Workflow; ociosidade sobe para 30 min |
| prova da 2.2 só confere o JSON, não o disparo | aplicado: prova de disparo por log do roteador antes da 2.3; `$HOME` conferido nos hooks atuais |
| `disconnected` engolido muda a semântica? | conferido: não muda (`server.ts:94-98` só zera e descarta); nota na 1.2 |
| rotear em `ia:*` por padrão não é o mais reversível | aplicado: nasce `off` em `envForAiSession` (1.8) |
| dois mds no mesmo alvo sem link | aplicado: o de 02/10 aponta para este |
| passos sem `[ ]` | aplicado: § Tasklist de execução |
| cabeçalho de decisões fora do padrão do índice | aplicado: `## Decisões técnicas` |

## Relatório de execução — Fase 0 (03/10/2026, sessão 9f526eb4)

Rota: workflow `roteador-abas-fase0-fase1` (um agente por spike, em paralelo com a Fase 1). Frescor: ok (0 dia,
0 commit no fork desde a `Base`). Sem Chrome real, sem `~/.claude`, sem checkout principal fora de `temp/`.
Artefatos em `C:\Dev\playwright\temp\` (fora do git): `spike-npx-meta.mjs`, `playwright-agente.cjs`, `spike-fim/`, `spike-05/`.

- **0.1** não rodou: parada obrigatória (Chrome real com o Gabriel).
- **0.2 verde.** `node temp/spike-npx-meta.mjs` → `sem _meta: ok` / `com _meta: ok`. Controle: `{action:"bogus"}` →
  `Invalid arguments … expected one of list|new|close|select` (validação ativa); `_meta` em string e chave de topo → ok.
  O 0.0.83 foi baixado para o cache do npx agora.
- **0.3 verde.** Provas da 2.1 contra `temp/playwright-agente.cjs`: as 3 saídas idênticas ao esperado (o `"falso"`
  foi sobrescrito por `main`; `lixo` → exit 0 sem saída). Loop literal: medianas 239 (fria) / 122 / 119 ms.
  Decomposição (61 rodadas, p50/p90/máx): `bash -c`+hook 97/297/985; node direto 57/154/497; só boot do node 49/116/330.
- **0.4 verde, inclusive Workflow.** Agent tool: `ls rel/$SID` → `a78d037d566b013f4`. Sem pasta prévia (`SID2`): nada
  escrito. Workflow (`SID3`): `ls rel/$SID3` → `a332452d7b4976b04`, `agent_type: workflow-subagent`, mesmo `session_id`.
  A Fase 3 cobre os dois; a ociosidade fica como rede.
- **0.5 verde.** `--permission-mode default --allowedTools mcp__eco__eco`: o eco recebeu `_meta.agente` da mãe
  (`main`) e do subagente (`af25d22461c2c1bed`). Controle sem allowlist: chamada negada, e o input negado já vinha
  carimbado (o `updatedInput` roda antes da permissão e não a concede). Armadilha do comando: `--allowedTools` é
  variádica e engole o prompt posicional que vem depois dela; passar o prompt antes da flag ou por stdin.

completei: controle negativo na 0.2 e na 0.5 (para o "ok" não vir de validação desligada); decomposição da latência.
Commits: só docs (este md). Pendências: 0.1 com o Gabriel.

## Relatório de execução — Fase 1 (03/10/2026, sessão 9f526eb4)

Código no worktree `C:\Dev\playwright\.claude\worktrees\agente-router`, ramo **`wt/agente-router`**, commit
`f22f40c74` (sem trailer; sem push). Este md fica na `main` do fork, como o resto da sessão: a trava "nada no
checkout principal" era de código e de build. Frescor: ok (0 commit em `packages/` desde a `Base`).

- **1.1 verde.** `npm ci` (626 pacotes, 22 s) + `npm run build`; `ctest-mcp -- capabilities tabs core` → `64 passed`.
  Linha de base do conjunto da 1.6: `http.spec.ts:515` já falhava antes de qualquer mudança (modo persistente).
- **1.2 verde.** `agentRouter.ts` criado; âncoras conferidas no código de hoje. Prova de tipo: `npm run tsc` exit 0
  (o build é esbuild e não checa tipo). Os 2 `as any` do esqueleto barraram no eslint e viraram tipo preciso.
- **1.3 verde.** `git diff --stat upstream/main -- …/mcp/program.ts` → `1 file changed, 2 insertions(+), 1 deletion(-)`.
- **1.4 verde, com desvio.** `grep -c "Close your browser connection" …/common.ts` → `1`. O texto saiu **sem** "Other
  agents keep theirs": é falso enquanto o roteador está inerte (sem carimbo, `ia:*`, persistente). Decisão técnica:
  a frase volta na 2.5; confiança alta; reverte reescrevendo uma string.
- **1.5 verde.** TDD: com o roteador escrito e desligado → `4 failed, 4 passed` (casos 1, 2, 7, 8 vermelhos, como
  esperado). Ligado → `8 passed`; `--repeat-each=4` → `32 passed`. A revisão somou o caso 9 (nada expira em voo),
  endureceu o 7 (prova o `dispose` pela contagem de contextos: 2 → 1) e somou o 10 (backend falso: `browser_close`
  larga a chave; close com erro mantém). Mutantes: tirar `!entry.inFlight &&` e o drop por nome → casos 9 e 10
  vermelhos; ocioso sem `dispose` → caso 7 vermelho (`recebeu 2, esperado 1`). Final: `10 passed`;
  `--repeat-each=5` → `50 passed`. Para o caso 10 alcançar o roteador, `tools/index.ts` exporta `withAgentRouting`.
- **1.6 verde.** `ctest-mcp -- agent-routing capabilities tabs core group-label http idle-timeout roots` →
  `107 passed, 1 skipped`. `npm run flint` exit 0, inclusive `doc` (contradiz FORK.md:103; uma rodada não reescreve a
  armadilha). Suíte MCP inteira: `792 passed, 20 skipped, 1 failed` (`config.spec.ts:88`, firefox ausente, modo
  persistente). Observado uma vez, sem linha de base: `http.spec.ts:330` (persistente, onde o roteador devolve a
  fábrica intacta) falhou numa rodada e passou sozinho e na seguinte.
- **1.7 não rodou** (parada obrigatória). **1.8:** só o item do wrapper. `grep -c PLAYWRIGHT_MCP_AGENT_ROUTING
  scripts/run-mcp-server.cjs` → `1`; `envForAiSession(…,'ia:maestro')` → `off`; `humano:x` e sem marca → indefinido.
  Merge no principal espera 0.1 e 1.7; o passo 1.8 foi corrigido (ramo `wt/…` e rebase antes do ff).
- **1.9 verde** no ramo: linha do patch 6 (inclui `tools/index.ts`), seção "Agent routing (patch 6)", "Likely
  conflicts" com `program.ts:189`, `common.ts:27` e `tools/index.ts`. A linha do patch 5 fica até a 2.5.

Desvios do md (categoria dominante: mecanismo): ramo `wt/agente-router`, não `agente-router`; `--isolated`
compartilha um browser (um contexto por agente, não um chromium: R6 e a decisão de `ia:*` corrigidas); esqueleto com
`as any`; "build sem erro de tipo" não provava tipo; o caso 8 original não testava `disconnected` de verdade (agora
fecha o contexto com `browser_run_code_unsafe`).
Revisão adversarial: 3 revisores de contexto zero, 5 achados médios (1 duplicado), 4 aplicados acima, nenhum recusado
no mérito. advisor (fable 5.1): nada bloqueia; `Risco: dado` coberto até onde `--isolated` alcança, e o que fecha
aba do Gabriel só a 1.7 prova. Pediu conferir o listener de `unhandledRejection` (`context.ts:145` o remove no
`dispose`: não acumula) e corrigir a 1.8 (feito).
completei: casos 9 e 10, contagem de contextos no 7, log `drop key=…`, suíte MCP inteira, prova do wrapper nos 3 casos.
Arquivos (ramo): `mcp/agentRouter.ts` (novo), `mcp/program.ts`, `backend/common.ts`, `tools/index.ts`,
`scripts/run-mcp-server.cjs`, `tests/mcp/agent-routing.spec.ts` (novo), `FORK.md`.

## Pendências e decisões pendentes (execução 03/10/2026)

Nenhuma decisão em aberto (as três foram respondidas). Esperam o Gabriel no Chrome, nesta ordem (~15 min):
0.1 → 1.7 → 1.8 (rebase + ff + build + stamp) → Fase 2 (2.1 a 2.3, o portão ao vivo).

## Relatório de execução — Fases 0.1, 1.7, 1.8 e 2 (03/10/2026, sessão 9f526eb4)

Assistida, com o Gabriel no Chrome (perfil `Profile 13`). Maestro desligado e nada em voo no playwright
(`maestro_estado` às 01:53), então sem pausa. Sem token no ambiente desta sessão (não se lê o `~/.claude.json`):
nos testes 0.1 e 1.7 o Gabriel autorizou cada conexão à mão, escolhendo uma aba "Welcome" (a semente).

- **0.1 verde.** `node temp/spike-n-relays.mjs` → `A: …example.com/#A | B: …example.org/#B2 | C: …example.net/#C2`,
  `screenshot de A em 2º plano: ok`, `close B isError: false`, `depois do close de B -> A: …#A | C: …#C2`.
  N relays num processo funcionam (P1) e o screenshot em 2º plano funciona (P10): vale a decisão 3 (mesma janela).
- **1.7 verde.** `DEBUG=pw:mcp:router node temp/spike-router-stdio.mjs <worktree>/…/mcp.js` → três `create key=…`
  (`main`, `…1111` com `spike-router · gp-1111`, `…2222`), `main: …#main | 1111: …#a…1111-2 | 2222: …#a…2222-2`,
  `rotulo 2222 isError: false`, `drop key=a…1111 dispose=true`, `close 1111 isError: false`,
  `depois -> main: …#main | 2222: …#a…2222-2`. 2ª rodada com `PAUSA_S=40`: o Gabriel viu os grupos `router`,
  `router · gp-1111` e `router · gp-2222` separados.
- **1.8 verde.** `git -C <worktree> rebase main` + `git merge --ff-only wt/agente-router` → `4c6581dda`;
  `npm run build && touch scripts/.build-stamp`; `find packages/playwright-core/src -newer scripts/.build-stamp` vazio.
- **2.1 verde.** `~/.claude/hooks/playwright-agente.cjs` = cópia de `temp/playwright-agente.cjs`; as 3 provas da 2.1
  idênticas ao esperado.
- **2.2 verde.** Entrada no topo de `hooks.PreToolUse` (com `"shell": "bash"`, como os hooks vizinhos); o `node -e`
  da prova imprime a entrada. **Prova de disparo** antes da 2.3: `claude -p` com o settings real e um eco chamado
  `playwright` (`temp/spike-22/`) recebeu `_meta.agente: "main"` da mãe e `"a3276d3ff4daf195f"` do subagente.
- **2.3 verde** (sessão humana nova, roteiro colado pelo Gabriel). wfA e wfB em paralelo viram só as próprias 2 abas;
  `tabs list` da mãe mostrou só `example.com/#mae`; o `browser_close` do subagente do passo 4 fechou só a aba dele e
  a mãe seguiu em `#mae` sem reconectar; o subagente do passo 5 rotulou `rotulo-sub`. No Chrome o Gabriel viu
  `teste-mae`, dois `teste-mae · wf-…`, um grupo que sumiu (passo 4) e um renomeado para `rotulo-sub`.
- **2.4 verde.** `cerebro/temas/playwright-mcp.md`: § "Subagentes dividem…" virou "Cada agente tem o próprio grupo"
  (regra do dono único saiu); hub e o md de 02/10 atualizados; FORK.md ganhou o passo de outra máquina.
- **2.5 verde.** `git diff upstream/main -- …/backend/tabs.ts …/backend/navigate.ts` → 0 linhas; o `browser_close`
  ganhou "Other agents keep theirs"; linha do patch 5 saiu da tabela do FORK.md;
  `ctest-mcp -- agent-routing capabilities tabs core` → `74 passed`. Commit `f27df3224`, no principal com build e stamp.

**Achado de segurança (sessão da 2.3):** a resposta da 1ª ferramenta trazia a URL da página de conexão com
`token=…`. Causa: o relay põe o token na URL (`mcp/cdpRelay.ts:159-160`, upstream) e, enquanto a semente está nela,
toda resposta mostra `Page URL`; a regra da casa (1ª ação = `browser_set_group_label`) cai exatamente aí. Medido:
39 transcripts locais com a URL e o token; 0 em cérebro, central e playwright versionados. Registrado em
`cerebro/temas/playwright-mcp.md`. Cura vira o passo **4.7**:
- `packages/extension/src/ui/connect.tsx` (onde lê `params.get('token')`, ~`:97`): logo depois de ler, apagar o
  `token` da própria URL com `history.replaceState`, antes de conectar; a conexão só nasce depois, então nenhuma
  resposta de ferramenta vê o token. Vai junto com a 4.4 (um só "Reload" da extensão).
- **Prova:** depois do Reload, `browser_set_group_label` numa sessão nova e conferir que a `Page URL` da resposta não
  tem `token=`; **reprova se** tiver.
- Rotacionar o token: decisão do Gabriel (credencial). Recomendação: não é preciso, a exposição é local, a mesma do
  `~/.claude.json`.

Commits do fork: `4c6581dda` (patch 6, rebase do `f22f40c74`), `f27df3224` (2.5), este md. Sem push.

## Relatório de execução — Fases 3, 4 e correções (03/10/2026, sessão 9f526eb4)

Implementação por workflows no worktree `wt/agente-router` (executor + revisores de contexto zero + corretor), provas
reconferidas nesta sessão, merge `--ff-only` na `main` com build e stamp. Testes ao vivo com o Gabriel no Chrome.

- **Fase 3 verde.** Roteador lê `_meta.sessao` e varre as marcas do `SubagentStop` (a cada 5 s e no início de cada
  chamada); chave desconhecida só apaga a marca; `main` nunca é largada; agente que chama de novo depois da própria
  marca mantém o browser (achado da revisão). `ctest-mcp -- agent-routing` → `14 passed`; 5 mutantes mortos.
  **3.3:** entrada `SubagentStop` no `~/.claude/settings.json` (hook `playwright-agente.cjs fim`).
- **Fase 4 + 4.7 verde.** Portador (relay já conectado abre a página de conexão do próximo subagente em 2º plano,
  fallback para o spawn em 10 s), abas de subagente em 2º plano com foco emulado, `Page.bringToFront` local,
  extensão pula o foco na conexão silenciosa, página de conexão apaga o token da própria URL. Kill switch
  `PLAYWRIGHT_MCP_AGENT_SILENT=off`. `tests/mcp/agent-silent.spec.ts`. Commit `9b6147924` (rebase de `f22f40c74`…).
- **1º teste ao vivo (11:16-11:18):** isolamento ok e token fora da URL, mas (a) uma aba sobrada do teste 1.7
  (`#a…2222-2`) entrou na conexão de um subagente novo e (b) o print em aba de subagente estourou 5 s.
- **2º teste ao vivo, Chrome limpo e em câmera lenta (11:28-11:43):** isolamento, fim de subagente (grupos somem)
  e sem roubo de foco ok; nenhuma aba de fora; print falhou 3/3.
- **Correções (`87119884a`):** relay de subagente só anexa aba própria ou popup de aba própria
  (`browserModel.ts`, `ownTabsOnly`); a extensão entrega o popup à conexão dona da aba de origem
  (`webNavigation.onCreatedNavigationTarget`: o `openerTabId` do Chrome segue a aba ativa, e a mãe sequestrava o
  popup do subagente; manifest **0.4.0.3**, permissão `webNavigation`); abas do agente fecham uma a uma no
  disconnect; aba aberta de aba ignorada é do usuário; print em relay de 2º plano com `max(action, 30 s)` e log
  `pw:mcp:shot`. Primeiro teste de extensão que roda no Windows sem humano: `npm run test-extension -- popup-source`
  → `4 passed`. `ctest-mcp -- agent-routing agent-silent screenshot tabs capabilities` → `67 passed`.
- **3º teste ao vivo (13:14-13:24), extensão 0.4.0.3:** 6/6 etapas sem erro, sem aba de fora, sem token, sem sobra.
  Print: mãe 2,4 s; wfA 14,6 s (uma vez); wfB e wfC juntos ~4 s cada. O popup do wfA nasceu dentro do grupo dele e
  não vazou para a mãe, mas veio para a frente (vira o 4.8).
- **Causa da sobra do teste 1.7 não fechada:** a aba de `browser_tabs new` devia ter fechado quando o spike morreu.
  Endurecido (fechamento aba a aba), sem prova da causa; com a guarda, uma sobra não entra mais em subagente.

Pendências: 4.8 (popup rouba o foco, proposto); `C:\Dev\.playwright-mcp\` acumula snapshots e PNGs de toda sessão
(1257 arquivos): limpeza periódica ou `--output-dir` em temp, fora deste roadmap.
