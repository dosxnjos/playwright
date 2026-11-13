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

Extensão (`npm run test-extension`, headless, Windows), na ponta da branch (depois das correções da revisão):

```
  6 failed
  94 passed (2.4m)
```

Os 6 vermelhos, todos de ambiente e todos vermelhos também na linha de base (upstream puro + correção do stub,
`68 passed / 7 failed`, o 7º era instável):
`extension.spec.ts:324`, `:336`, `:356`, `:368` (usam um executável falso que não roda no Windows) e
`tab-dragging.spec.ts:35`, `tab-management.spec.ts:123` (título de `chrome://version` em português:
`"Sobre a versão"` em vez de `"About Version"`).

Specs do fork no harness novo (todos verdes): `group-label` (3), `popup-source` (3), `focus-zero` (6),
`capture-reveal` (4), `tab-ownership` (7), `cookies` (2). Upstream intocado: os specs dele rodam com
`PLAYWRIGHT_MCP_AGENT_TABS=keep` que o `harness.ts` liga por padrão.

- `popup-source` mediu antes de refazer: na extensão do upstream puro os 2 testes de popup de aba em segundo plano
  ficavam vermelhos (`['Opener']` em vez de `['Opener','Opened']`), o que confirmou que o `openerTabId` ainda aponta
  a aba ativa no Chromium 158.

MCP (`npm run ctest-mcp -- group-label capabilities tabs core agent-routing agent-silent screenshot cookies`, estado
final):

```
  121 passed (1.6m)
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
- **`worker-death.spec.ts` não migrou como arquivo**: dos 4 casos, só "aba do agente fecha, a do usuário fica, a aba
  na frente fica" vive em `tab-ownership.spec.ts:86`. Sem teste: o teto de 3 s da limpeza, "sem registro (worker de
  versão velha) só solta" e a semente na página de conexão (no modelo novo a semente vira a aba em branco, que é
  registrada como do agente).
- **Tomada pelo usuário** (Cancelar na barra do depurador rebaixa a aba do agente para "do usuário") e **aba criada
  depois do fechamento**: implementadas, sem teste (o headless não tem barra do depurador; a corrida é difícil de
  provocar). Como no fork velho.
- **Mutantes**: um só, no guarda "aba do agente na frente da janela com foco não fecha quando o worker morre"
  (`agentTabs.ts`, condição trocada por `false`): `tab-ownership.spec.ts:86` ficou vermelho 3/3 (`Alpha` fechada);
  restaurado, 3/3 verde. A origem do popup já tinha sido "mutada" de graça: o upstream puro deixava os testes vermelhos.

## Revisão adversarial do diff (subagente sem contexto, 13/11)

1 bloqueante, 7 "deveria corrigir", 5 detalhes. Tratamento (commit de correções depois de `a53e9d028`):

| # | achado | tratamento |
| --- | --- | --- |
| 1 (bloqueante) | o portador podia fechar a página de conexão depois que ela virou a aba em branco de outro cliente (passava pela exceção sem checar dono) | corrigido: a exceção só vale enquanto **nenhum** cliente é dono da aba; teste novo `focus-zero.spec.ts` "a carrier cannot close the connect page it opened once a client owns it" |
| 2 | `FocusMemory` acorda o worker a cada troca de aba do usuário (o upstream evita isso) | **mantido de propósito** (sem isso o "devolver a aba" do Chrome 157 não sabe qual era a aba); custo registrado aqui e vai para o `FORK.md` na Fase 5. Some quando o Chrome do Gabriel chegar no 158 e o `--open-in-background` funcionar |
| 3 | popup de uma aba do usuário era marcado como do agente (fechava ao sair) | corrigido: o popup herda a origem da aba que o abriu; e o `claim` que chega depois de outro caminho também marca. Teste novo em `tab-ownership.spec.ts:80` |
| 4 | o fechamento normal não poupava a aba na frente do usuário (código 2FA) | corrigido: a aba ativa de janela com foco vira do usuário e fica (mesmo guarda do worker morto). Mesmo teste |
| 5 | um Cancelar na barra do depurador rebaixa todas as abas do agente (todas desanexam com `canceled_by_user`) | **aceito e registrado**: é o mesmo comportamento do fork velho; o usuário cancelou o controle, deixar as abas abertas é o lado seguro |
| 6 | "não limpar tudo" não era garantido: lendo todos os cookies e vencendo um a um dava para deslogar de tudo; `Network.setCookie(s)`/`deleteCookies` não estavam recusados | corrigido: cookie vencido só passa se for de um site onde o cliente tem aba (`cookieSitesOutside`); os três métodos `Network.*` de cookie recusados (o Playwright não os usa). Testes em `cookies.spec.ts` |
| 7 | revelação sem prazo: uma resposta que nunca chega travava todo print em segundo plano do processo | corrigido: revelar e devolver têm prazo de 5 s (`withDeadline`) |
| 8 | testes que passariam com a função quebrada (subagente em segundo plano mascarado pelo token do principal; metade servidor da revelação sem teste) | corrigido: o teste do subagente roda com `PLAYWRIGHT_MCP_FOCUS=on` no principal e confere o log do portador; o mesmo teste tira print do subagente com a janela sem foco e confere `revealed=true` vindo do servidor |
| 9 | passos do fechamento em sequência sem `finally`; registro esquecido antes de fechar | corrigido: `try/finally` em `_closeSession`; o registro sai depois do fechamento |
| 10 | dedup compara com o título padrão de um grupo adotado | detalhe, fica |
| 11 | aba em branco sem token marcada como do agente | **intencional** (o fork velho fazia igual: sem aba escolhida, a semente é do agente) |
| 12 | comentário "uma por vez" com `Promise.all`; `design.md` sem os comandos do fork | comentário corrigido; `design.md`/`FORK.md` na Fase 5 |
| 13 | um listener de `exit` por roteador (aviso de MaxListeners no modo HTTP) | corrigido: um listener por processo |
