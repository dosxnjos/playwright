# Fase 1: mapa dos patches do fork sobre o upstream pós-#44047 (12/11/2026)

Base nova: `upstream/main` `8534271f0` (12/11, 1 commit de teste WebKit depois do `622b3db4c` que o roadmap cita).
Fork velho: `main` `78989ed37` (tag `fork-pre-sync-2026-11`, empurrada para `origin`). A `main` andou depois da tag:
`d8a1a567e` (só `roadmap/`, a regra "zero servidores MCP rodando do checkout" da Fase 4). A tag não foi movida;
o comando de reversão da Fase 4 tem de citar o SHA que a `main` tiver na hora da virada.

Fonte: `git diff 87291ca60 main` (61 arquivos fora de `roadmap/`, a base comum real do fork) contra a árvore nova.
Todo arquivo do diff cai numa linha abaixo ou em "some".

## Fatos do ambiente que mudam a classificação

- **Chrome do Gabriel: 157.0.8103.51** (`C:\Program Files\Google\Chrome\Application`). O `--background` do upstream
  (#43864 `8195aabcf`) abre a página de conexão em segundo plano com `--open-in-background`, que só existe a partir
  do **Chrome 158.0.8127.2** (README da extensão). No 157 a página abre na frente. O Chromium dos testes do worktree é
  **158.0.8127.18** (revisão 1254): o ensaio da Fase 3 roda num navegador que já tem o que o Chrome dele não tem.
  Por isso o portador (abrir a página de conexão de dentro do Chrome) e o "devolver a aba do usuário" ficam.
- **Testes de extensão headless** desde o #44063 (`392ab0f0d`): `tests/extension/chrome-stub.js` faz o papel do
  `chrome.exe` e abre a página no navegador já aberto. **No Windows não rodam como vêm**: o relé faz
  `spawn('chrome-stub.js')` e o Windows não executa `.js` (medido no upstream puro, 12/11: **69 de 75 falham**, a
  página de conexão nunca aparece; só os 6 que não conectam passam). Correção do fork, commit próprio: o relé roda um
  executável `.js` com o `node` (`cdpRelay.ts`, 2 linhas). Com ela o `tab-grouping.spec.ts:26` passa. O harness velho
  do fork (stub de `child_process.spawn` no processo) deixa de ser necessário: os specs migram para `harness.ts`.
- **`npm run flint` cobre a extensão** desde o #43072 (`a3c5084d3`): `npm run tsc` roda os dois tsconfigs dela.
- **O upstream renomeou `CLAUDE.md` para `AGENTS.md`** (#43167 `e3fa3cefb`). O Claude Code só lê `CLAUDE.md`: o fork
  passa a ter um `CLAUDE.md` que importa `@AGENTS.md` e traz a seção do fork.
- A base nova não tem `roadmap/` nem `FORK.md`: vão num commit de docs, senão o `reset --keep` da Fase 4 apagaria
  esses arquivos do checkout.

## Tabela

| # | o que faz | onde caía (velho) | onde cai (novo) | o que o upstream já cobre | classe |
| --- | --- | --- | --- | --- | --- |
| 1 | wrapper `run-mcp-server.cjs` (+ `background-build`, `prune-mcp-output`, smoke, teste), `.pre-commit-config.yaml`, `.gitignore`, CI só manual | `scripts/`, `.github/workflows/` | mesmos caminhos; `lib/entry/mcp.js` continua existindo | nada | **refaz igual** |
| 6 | roteamento por agente (`_meta.agente`), texto do `browser_close`, marcador de fim de subagente | `mcp/agentRouter.ts`, `mcp/program.ts:189`, `backend/common.ts`, `tools/index.ts`, `tests/mcp/agent-routing.spec.ts`, `envForAiSession` no wrapper | mesmos; `program.ts` passa a ter `mcpServer.start(factory, …)` na linha ~201; `ServerBackendFactory` só ganhou `ignoreRoots` (#43532) | nada (upstream recusou caminho parecido, #39703/#42961) | **refaz igual** |
| 2 | `browser_set_group_label` (rótulo do grupo em tempo de execução, por agente) | `backend/groupLabel.ts`, `backend/extensionSession.ts`, `mcp/{cdpRelay,protocol,extensionContextFactory}.ts`, `extension/src/{background,connectedTabGroup,relayConnection}.ts` | servidor igual; o relay manda o comando pela `BrowserModel` (o `cdpRelayV2.ts` sumiu no #43893 `9c1ec954c`); extensão: comando novo em `clientSession.ts` → `TabGroupManager` (dono de `chrome.tabGroups`) | só nome **fixo por servidor**: `--session-name`/`--session-color` (#44047 `acd6629c1`); título explícito sem o prefixo `Playwright · ` | **redesenha** (D2) |
| 7 | foco zero e conexão silenciosa | ver "Patch 7 por pedaço" | ver abaixo | parte (abaixo) | **encolhe** (D5) |
| 3 | abas criadas pelo agente **fecham** ao desconectar; abas do usuário só soltam | `extension/src/{connectedTabGroup,background}.ts` (`TabOwner`, `_pendingOwner`, `_onConnectionClose`) | `ownedTab.ts` (origem da aba), `clientSession.ts` e `tabRegistry.ts` (os três lugares que reivindicam aba para o cliente: `chrome.tabs.create`, popup, aba em branco do token), `connectionBroker.ts` (`onClose` fecha as do agente antes do `releaseAll`) | o oposto por desenho: grupo cinza retomável (#44047) | **redesenha** (D3) |
| 3b | morte do service worker: o worker seguinte fecha as abas do agente (registro em `chrome.storage.session`), menos a aba ativa da janela com foco; limpeza com teto de 3 s | `connectedTabGroup.ts` (`cleanupStalePlaywrightGroups`), `background.ts` (`Promise.race` 3 s), `tests/extension/worker-death.spec.ts`, manifest `0.4.0.6` | registro ao lado do `clientGroupIds` (`tabGroupManager.ts`); limpeza no `ready` do `Extension` (`background.ts`), que já segura as mensagens até acabar | só deixa o grupo cinza e solta os debuggers (#44047 `_orphanGroupsOfPreviousServiceWorker`, `detachDebuggersOfPreviousServiceWorker`) | **redesenha** junto do 3 |
| 8 | apagar cookie de um domínio no modo extensão | (novo) | `extension/src/cdpPolicy.ts` + `clientSession.ts` (a política passa a ver os parâmetros) | o upstream recusa `Storage.setCookies` inteiro (#44047); o `clearCookies(filtro)` expira com `expires: 0` via `addCookies` (`server/browserContext.ts:313`) | **novo** (D4) |
| 4 | tema escuro e UI redesenhada, manifest `0.4.0.x` | `extension/src/ui/{connect.css,authToken.css,copyToClipboard.css,connect.tsx,tabItem.tsx}` | `connect.css` e `status.tsx` sumiram; UI nova em `ui/{common,colors}.css`, `ui/manage.tsx` | tema escuro **sim**: a UI nova segue o sistema (`ui/colors.css:457` `prefers-color-scheme: dark`, `ui/common.css:18`; corrigido pela revisão, a 1ª versão deste mapa dizia o contrário); o visual próprio do fork, não (recusado, #41841) | **some** (tema escuro) + **adiado** (visual próprio, D6) |

### Patch 7 por pedaço

| pedaço | velho | upstream novo | classe |
| --- | --- | --- | --- |
| token sai da URL da página de conexão | `ui/connect.tsx` | `ui/connect.tsx` já faz `history.replaceState` sem o token (#43258 `af362f2b0`) | **some** |
| relé em segundo plano: abas novas com `active:false`, `Page.bringToFront` respondido no relé | `cdpRelay.ts` (`sendCommand`, `case 'Page.bringToFront'`) | `BrowserModel` com `background` (#43864): `chrome.tabs.create` com `active: !background`, `Page.bringToFront`/`Target.activateTarget` respondidos localmente | **some** (o fork só decide **quem** é background) |
| quem é background: subagente sempre; agente principal com token salvo `PLAYWRIGHT_MCP_FOCUS=on`; desliga com `PLAYWRIGHT_MCP_AGENT_SILENT=off` | `relayScope` (`backend/extensionSession.ts`), construtor do relé | o upstream só tem `--background` por servidor | **encolhe**: `relayScope` e a regra do token viram um OU no parâmetro `background` que o upstream já passa (`extensionContextFactory.ts`) |
| não ativar a aba conectada nem focar a janela | `background.ts` (`silent`) | `connectionBroker.ts` `_show` pula com `background` (#43864) | **some** |
| página de conexão em segundo plano no 1º contato | (não havia: o `chrome.exe` abria na frente) | `--open-in-background` (Chrome ≥ 158) | **fica** a parte de baixo |
| portador: um relé já conectado abre a página de conexão do próximo por `chrome.tabs.create` (`active:false`), prazo de 10 s, fila dos primeiros relés | `cdpRelay.ts` (`connectedRelays`, `_openConnectPageViaCarrier`, `_waitForEarlierRelay`) | nada; no modelo novo o `chrome.tabs.create` reivindica a aba para o portador e o `connectionRequested` dela a reserva e solta (`connectionBroker.request` → `reserve` → `release` + `ungroup`): a medir no ensaio | **refaz** (Chrome 157) |
| devolver a aba do usuário quando a 1ª página de conexão abriu na frente (`FocusMemory`, `silent=1`) | `focusMemory.ts`, `background.ts` (`putBack`), `connect.tsx` (`silent`) | nada | **refaz**, com o `background=true` que a URL já leva no lugar do `silent=1` |
| emulação de foco por aba em segundo plano (`Emulation.setFocusEmulationEnabled` depois do attach) | `cdpRelay.ts` `_attachWithFocusEmulation` | nada (README do upstream: "Chrome throttles timers and animation frames in background tabs") | **refaz** (na `BrowserModel._attachTab`) |
| só as próprias abas no relé do subagente (`ownTabsOnly`) | `browserModel.ts`, `cdpRelayV2.ts` | modelo de posse (#44047): aba só entra num cliente por escolha, arrasto (`transfer`), `chrome.tabs.create`, popup de aba dele | **some**; custo: arrastar aba para o grupo de um subagente volta a entregá-la (comportamento do upstream) |
| origem real do popup (`webNavigation.onCreatedNavigationTarget.sourceTabId`, porque o `openerTabId` aponta a aba **ativa**) | `relayConnection.ts` (`popupSourceEvents`, `_onPopupCreated`) | `TabRegistry._onTabCreated` reivindica pelo `openerTabId` | **refaz** em `tabRegistry.ts`. Medido 12/11 com `tests/extension/popup-source.spec.ts` na extensão do upstream puro (Chromium 158, headless): cliente `--background` clica `window.open` na aba dele com a aba do usuário na frente → o popup **não chega** ao cliente (2/2 vermelhos: `['Opener']` em vez de `['Opener','Opened']`). O teste do upstream (`tab-management.spec.ts:61`) só cobre o popup da aba ativa |
| popup silencioso não fica na frente | `relayConnection.ts` `_onPopupCreated` | nada | **refaz** junto do item acima |
| print: teto de 60 s e log `pw:mcp:shot` | `backend/screenshot.ts` | nada | **refaz igual** |
| revelar a aba para o print só sem plateia | `cdpRelay.ts` `_captureRevealed`, `protocol.ts`, `captureReveal.ts`, `relayConnection.ts` | nada | **refaz**: comando em `clientSession.ts` (dono confere com o `TabRegistry`), revelação pendente devolvida antes de fechar as abas |

### Outros arquivos do diff

| arquivo | destino |
| --- | --- |
| `backend/context.ts` (`extension?: boolean` no `ContextConfig`) | patch 2 (o tool erra se `--extension` foi pedido e não há relé) |
| `backend/tools.ts` (lista de tools) e `tests/mcp/capabilities.spec.ts` | patch 2 |
| `tests/mcp/group-label.spec.ts`, `tests/extension/group-label.spec.ts` | patch 2, no harness novo |
| `tests/extension/tab-ownership.spec.ts` | patch 3, no harness novo |
| `tests/extension/{popup-source,focus-zero,capture-reveal}.spec.ts` | patch 7, no harness novo (`tests/extension/harness.ts`) |
| `tests/extension/worker-death.spec.ts` | patch 3b, no harness novo (`user.stopExtensionWorker()`) |
| `tests/mcp/agent-silent.spec.ts` (799 linhas, extensão falsa) | patch 7: só o que restar de lógica no servidor (portador, quem é background, revelação, teto do print); o que o upstream cobre sai |
| `extension/manifest.json` | versão `0.5.0.x` sobre o `0.5.0` do upstream; `webNavigation` só se o popup-source for refeito (`storage` o upstream já tem) |
| `extension/src/ui/tabItem.tsx`, `copyToClipboard.css`, `authToken.css`, `connect.css` | patch 4 (adiado) |
| `.claude/skills/...`, `docs/src/getting-started-*.md`, `utils/render_release_notes.mjs`, `.azure-pipelines/` | do upstream (não são do fork) |
| `.github/workflows/` | refeito: sai todo workflow com gatilho automático (`agent-review`, `agent-triage`, `check_copilot_models`, `create_test_report`, `infra`, `publish_release`, `roll_nodejs`, `tests_bidi`, `tests_docker_changes`, `tests_docker_release`, `tests_mcp`, `tests_primary`, `tests_secondary`, `tests_webview_simulator`, `update_test_results_db`); ficam `agent-task` e `publish_extension` (só manual), `copilot-setup-steps`, `tests_docker` (`workflow_call`), `tests_extension` (desligado à mão na aba Actions) e `upstream-drift` |

## Wrapper contra as opções novas

- `--session-name`/`--session-color`/`PLAYWRIGHT_MCP_SESSION_*`: o wrapper não passa nem precisa. ⚠️ Se alguém
  ligar `--session-name`, **todo** backend do roteador recebe o mesmo título (o `browserFactory.ts` usa
  `config.sessionName` como título e ignora o `clientName` que o roteador muda por agente): os grupos dos subagentes
  ficam com o mesmo nome. Registrar no `FORK.md`; o `browser_set_group_label` continua sendo o caminho.
- `--background`/`PLAYWRIGHT_MCP_BACKGROUND`: o foco zero do fork liga o mesmo parâmetro sozinho (subagente, ou
  token sem `PLAYWRIGHT_MCP_FOCUS=on`); quem passar `--background` explícito também fica em segundo plano.
- `--no-tab-group`: sem grupo, o `browser_set_group_label` responde que não há grupo (sem erro).
- `--ignore-roots`: sem relação com o fork.
- Sessões `ia:*` (`--browser chromium --isolated --headless`): nada muda.
- Pin do fallback `npx @playwright/mcp@0.0.83` → **`0.0.85`** (09/11, `playwright-core 1.66.0-alpha-2026-11-09`):
  fala o protocolo 2 da extensão e já traduz `Target.createTarget` em `chrome.tabs.create` (o que a extensão 0.5 exige);
  é o mais perto da base nova sem ser posterior ao #44047. ⚠️ **Inferido** do código-fonte do fork velho e das
  dependências publicadas, **não rodado** contra a extensão `0.5.0.3` (o fallback só roda enquanto o build local está
  velho; se falhar, o efeito é a conexão falhar até o build terminar).

## Checagem D7 (roteamento)

`agentRouter.ts` não chama CDP: só cria um backend por agente pela fábrica do upstream. `Target.createTarget`/
`closeTarget` saem do Playwright e a `BrowserModel` do upstream traduz em `chrome.tabs.create`/`remove`
(`browserModel.ts` `_createTarget`/`_closeTarget`); `attachToTarget`/`activateTarget` não são usados pelo fork.
O diagnóstico de 09/11 viu `Target.attachToBrowserTarget` recusado (`newCDPSession` num `run_code_unsafe`): continua
recusado no modelo novo, não é caminho do fork.

## Diagnóstico de 09/11 contra o upstream novo

Nenhum commit do intervalo emite progresso em chamada longa nem muda o teto de 120 s do Claude Code: a hipótese 1
(chamada > 120 s derruba o servidor de todos) continua de pé. A hipótese 2 (extensão presa ao relé velho) muda de
cara: o worker novo deixa os grupos cinza e solta os debuggers no início; o patch 3b fecha as abas dos agentes.
Hipótese 3 (print lento) continua: é o que a revelação e o teto de 60 s tratam.

## Revisão adversarial (subagente sem contexto, 12/11) e o que mudou no mapa

15 achados, nenhum bloqueante sozinho. Como cada um foi tratado:

| # | achado | tratamento |
| --- | --- | --- |
| 1 | portador: no modelo novo o `chrome.tabs.create` reivindica a página para o portador; o `connectionRequested` a reserva e solta; o portador perde o direito de fechar uma página que não conectou (token inválido vira sobra escondida); corrida `claim` × `reserve` | **redesenhado**: `ClientSession` não reivindica uma `chrome.tabs.create` cuja URL é o `connect.html` da extensão e guarda o id; só esse id pode ser fechado pelo portador sem ser dono. Sem grupo do portador, sem `onDetach`, sem corrida |
| 2 | `FocusMemory` não enxerga nada com os listeners do upstream (ligados só com sessão ou página pendente); `background=true` vai até sem token | `FocusMemory` com listeners próprios, sempre ligados (custo: o worker acorda a cada troca de aba, como no fork velho); a página de conexão manda `token: true` no `connect` e o "devolver" só vale com `background` **e** token |
| 3 | o teto de 3 s da limpeza do worker morto sumiria se a limpeza entrasse no `ready` | patch 3b mantém o teto (a limpeza das abas do agente corre ao lado, com `Promise.race` de 3 s) |
| 4 | tomada pelo usuário (Cancelar na barra do depurador) e aba criada depois do fechamento | patch 3: `onDetach` com motivo ≠ `target_closed` rebaixa a aba para "do usuário"; `chrome.tabs.create` que volta com o canal fechado fecha a aba |
| 5 | testes do upstream esperam a aba em branco do token sobrevivendo num grupo cinza (`client-lifecycle.spec.ts:76`, `:198`, `:256`) | patch 3 edita esses testes de forma explícita (D3) e diz no commit |
| 6 | **a UI nova já tem tema escuro** (`ui/colors.css:457` `@media (prefers-color-scheme: dark)`, `ui/common.css:18` `color-scheme: light dark`) | patch 4: a parte "tema escuro" **some**; sobra só o visual próprio do fork, **adiado** (D6) |
| 7 | o servidor stdio deixou de chamar `dispose` no fim do stdin (#43174): a pasta de sessão do roteador ficava | confirmado (`agent-routing.spec.ts:214` vermelho 3/3); corrigido em `b993885b4` (a pasta sai no `exit` do processo) |
| 8 | o texto do `browser_close` só é verdade com o patch 3 | fica; vale depois do patch 3 (D3) |
| 9 | a metade servidor da revelação não estava no mapa | vai para `BrowserModel.handleCDPCommand` (`_captureRevealed`, fila por processo e espera de 15 s); a metade extensão (`captureReveal.ts`, estado por janela) igual |
| 10 | `--session-color` também é global por servidor | registrar no `FORK.md` junto do `--session-name` |
| 11 | deduplicação do rótulo | refeita em `TabGroupManager.setLabel` (" (2)", " (3)") |
| 12 | keepalive de 20 s do upstream deixa a morte do worker mais rara; cliente que fecha a última aba continua conectado | registrar no `FORK.md` (Fase 5); a limitação "fechar a última aba fecha a conexão" sai |
| 13 | a linha "do upstream" da tabela "Outros arquivos" cita arquivos fora do diff; faltam `triage_*.yml` | corrigido abaixo: `triage_linux/mac/win.yml` o upstream já apagou |
| 14 | o fallback `0.0.85` é anterior ao #44047 e não esquece a aba no `onDetach` | baixo impacto (só roda enquanto o build local está velho); fica registrado |
| 15 | o upstream tira o token da URL só depois do `connectionRequested`; páginas com erro mantêm o token na URL | nenhuma dessas páginas é aba de cliente, o token não volta em resposta de tool; fica como está |

Correção da tabela "Outros arquivos": `.claude/skills/...`, `docs/src/getting-started-*.md`, `utils/render_release_notes.mjs` e
`.azure-pipelines/` **não** estão no diff do fork (erro de leitura deste mapa); `triage_{linux,mac,win}.yml` estavam
apagados no fork e o upstream também já não os tem.
