# Fase 2: patches refeitos sobre o upstream novo (12–13/11/2026)

Worktree `C:\Dev\pw-sync-1112`, branch `sync-2026-11` (empurrada para `origin`, sem force), base `upstream/main`
`8534271f0`. Tag de segurança `fork-pre-sync-2026-11` = `78989ed37` (empurrada). A `main` do fork andou depois da tag
(`d8a1a567e`, só `roadmap/`). O checkout `C:\Dev\playwright` não foi tocado (nem build, nem `npm ci`, nem troca de branch).

## Estado de cada patch

| # | patch | estado | commits |
| --- | --- | --- | --- |
| — | docs do fork (`FORK.md`, `roadmap/`, `CLAUDE.md` que importa `@AGENTS.md`) | carregado | `7b4d8be27` |
| 1 | wrapper + pre-commit + CI só manual | **refeito igual**; pin do fallback `0.0.83` → `0.0.85`; 15 workflows automáticos fora | `4589bbfad` |
| — | testes de extensão no Windows (o relé roda um executável `.js` com o `node`) | **novo**, 2 linhas | `618878745` |
| 6 | roteamento por agente | **refeito igual** + correção: o servidor stdio do upstream deixou de chamar `dispose` no fim do stdin, a pasta da sessão sai no `exit` do processo | `227f9a25b`, `b993885b4` |
| 2 | `browser_set_group_label` | **redesenhado**: comando `extension.setGroupLabel` → `ClientSession` → `TabGroupManager.setLabel` (dedup " (2)"); sem grupo (`--no-tab-group`) responde texto, não erro | `6d1d5df0b`, `15dd7f336` |
| 7 | foco zero | **encolhido**: o que o upstream cobre saiu (abas `active:false`, `bringToFront` local, não focar ao conectar, token fora da URL, `ownTabsOnly`); ficou quem é background (`relayScope` + token), portador, `FocusMemory`, emulação de foco, origem do popup (`webNavigation`), popup silencioso, revelação para print, teto de 60 s | `3f0497936` |
| 3 | abas do agente fecham ao desconectar (+ worker morto, teto de 3 s) | **redesenhado** no modelo de posse: `OwnedTab.agent`, `TabRegistry.closeAgentTabs`, registro em `chrome.storage.session` (`agentTabs.ts`); interruptor `PLAYWRIGHT_MCP_AGENT_TABS=keep` (comportamento do upstream) | `5d21865a1` |
| 8 | apagar cookie por nome/domínio no modo extensão (D4) | **novo**: `Storage.setCookies` passa só com todo cookie já vencido | `0e441b2c2` |
| 4 | tema escuro e UI própria | **some** a parte escura (a UI nova já segue o sistema: `ui/colors.css:457`); **adiado** o visual próprio (D6) | — |
| — | lint | ordem de import | `91666b99e` |

Manifest: `0.5.0.3` (`0.5.0` do upstream + 3 mudanças da extensão: 7, 3, 8); permissão nova `webNavigation` (o Chrome
pode pedir para aceitar "ler seu histórico de navegação" no Reload). `storage` o upstream já tinha.

Diff do fork em `packages/` e `tests/`: 38 arquivos, +2051 −43 (o velho tinha 61 arquivos, +5914 −1819, contando
workflows e docs).

## Decisões aplicadas e o que mudou em relação ao roadmap

- **D1–D2, D5, D7**: seguidas.
- **D3** seguida, com um interruptor novo: `PLAYWRIGHT_MCP_AGENT_TABS=keep` (env do servidor) devolve o comportamento
  do upstream (grupo cinza retomável também para abas do agente). Motivo: os testes do upstream (`client-lifecycle`,
  `protocol`, `tab-management`) pressupõem que a aba em branco do token sobrevive; com o interruptor eles rodam como
  vieram (o `harness.ts` liga `keep` por padrão, os specs do fork pedem `close`), e o "reverte se" do D3 vira uma
  variável de ambiente em vez de um patch.
- **D4** seguida: o patch ficou pequeno (16 linhas em `cdpPolicy.ts`), sem acionar o "reverte se".
- **D6**: a premissa ("a UI foi reescrita sem tema escuro") estava errada: a UI nova já tem tema escuro pelo sistema.
  Visual próprio adiado.
- **Testes de extensão no Windows** (roadmap: "conferir se rodam no Windows"): **não rodavam** no upstream puro
  (69 de 75 vermelhos: o relé fazia `spawn('chrome-stub.js')`). Com o commit `618878745` rodam: 92 de 98 verdes; os 6
  vermelhos são do ambiente e também vermelhos no upstream puro com a mesma correção (abaixo).

## Provas (saída real)

Build: `npm run build` → `BUILD 0` (último: depois de `91666b99e`).
Extensão: `npx tsc -p tsconfig.json --noEmit` e `npx tsc -p tsconfig.ui.json --noEmit` em `packages/extension` → sem
saída, código 0.

`npm run flint` (depois de `0e441b2c2`): `eslint` 1 erro (ordem de import, corrigido em `91666b99e`, `npm run eslint`
→ 0); `tsc` 0 (agora inclui a extensão); `check-deps` 0; `lint-tests` 0; `test-types` 0; `lint-packages` 0;
`generate_channels` 0; snippets 0; `check-dependency-age` 0; `doc` 1 = ambiente (`firefox-1578\firefox.exe` não
instalado, igual ao `FORK.md`).

Extensão (`npm run test-extension`, headless, Windows), na ponta da branch:

```
  6 failed
  92 passed (2.1m)
```

Os 6 vermelhos, todos de ambiente e todos vermelhos também na linha de base (upstream puro + correção do stub,
`68 passed / 7 failed`, o 7º era instável):
`extension.spec.ts:324`, `:336`, `:356`, `:368` (usam um executável falso que não roda no Windows) e
`tab-dragging.spec.ts:35`, `tab-management.spec.ts:123` (título de `chrome://version` em português:
`"Sobre a versão"` em vez de `"About Version"`).

Specs do fork no harness novo (todos verdes): `group-label` (3), `popup-source` (3), `focus-zero` (5),
`capture-reveal` (4), `tab-ownership` (6), `cookies` (2).

- `popup-source` mediu antes de refazer: na extensão do upstream puro os 2 testes de popup de aba em segundo plano
  ficavam vermelhos (`['Opener']` em vez de `['Opener','Opened']`), o que confirmou que o `openerTabId` ainda aponta
  a aba ativa no Chromium 158.

MCP (`npm run ctest-mcp -- group-label capabilities tabs core agent-routing agent-silent screenshot`):

```
  104 passed (1.3m)
```

`agent-routing.spec.ts:214` ficou vermelho 1 vez numa rodada com 7 workers em paralelo com outra suíte e passou 4/4
sozinho (`--repeat-each=4`): instável sob carga (sondagem de 10 s da pasta de marcadores), não regressão.

Wrapper: `node scripts/run-mcp-server.test.cjs` → `27/27 passed`. Smoke com Chromium real:
`node scripts/run-mcp-server.smoke.cjs` → `smoke ok`; contraprova com `PLAYWRIGHT_MCP_SESSION_TEMP=0` →
`smoke FAIL 4` (o esperado).

## O que ficou de fora e por quê

- **Patch 4, visual próprio** (D6): a UI nova já tem tema escuro; refazer o visual do fork em `common.css`/`colors.css`
  não muda função. Se o Gabriel sentir falta, é patch só de CSS.
- **`tests/mcp/agent-silent.spec.ts` velho (799 linhas, extensão falsa)**: encolheu para os 3 testes do teto do print.
  O resto (portador, quem é background, emulação de foco, revelação) passou a ser testado contra a extensão real nos
  specs de `tests/extension/`, que agora rodam no Windows. Sem teste ficaram: portador que não responde/atrasa/falha
  (os 3 casos de "volta para o chrome.exe"), relés conectando ao mesmo tempo (fila dos primeiros), espera de 15 s da
  revelação e duas revelações cruzadas na mesma janela. O código é o mesmo do fork velho, que tinha esses testes.
- **Tomada pelo usuário** (Cancelar na barra do depurador rebaixa a aba do agente para "do usuário") e **aba criada
  depois do fechamento**: implementadas, sem teste (o headless não tem barra do depurador; a corrida é difícil de
  provocar). Como no fork velho.
- **Mutantes**: não rodei mutantes desta vez; o guarda "aba na frente da janela com foco não fecha" foi provado pelo
  próprio teste (a aba `Beta` do mesmo agente fecha e a `Alpha` na frente fica).
