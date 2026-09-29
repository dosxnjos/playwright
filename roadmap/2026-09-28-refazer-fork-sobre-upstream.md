# Plano — refazer o fork em cima do upstream atual (2026-09-28)

## Entendimento do pedido

O Gabriel quer o fork `dosxnjos/playwright` **alimentado pelo original**
(`microsoft/playwright`) e atualizado, ficando só com o que o original não tem.
Ele autorizou reestruturar servidor e extensão por completo, com uma condição:
**nada que pese na conta financeira dele**. O fork é **público**, então Actions
e sincronização custam zero.

**Correção de premissa (já dita a ele):** as Actions apagadas em `f9beeac1b` eram
CI da Microsoft (testes, publicação) e não alimentavam o fork. Não se religam.
O que alimenta um fork é **sincronizar com o `upstream`**, e isso não é feito
desde 16/07 (merge-base `98b2ffebd`).

## Estado medido em 28/09/2026

- A `main` é a branch **em uso**: checada, compilada e rodada pelo
  `scripts/run-mcp-server.cjs` (`~/.claude.json` → `mcpServers.playwright`).
  Está **496 commits atrás** do `upstream/main` e 29 à frente.
- `extension-multi-connection` tem um commit que nunca entrou na main
  (`6f0b4cfdc`, itens 9–13 de `2026-07-17-melhoria-reconexao-aba-fantasma.md`).
- Um merge simulado (`git merge-tree`) dá **13 arquivos em conflito**, quase
  todos no código de múltiplas conexões que o upstream reescreveu (PR #42259).

### O que o upstream já resolve e o que só o fork faz

| item do fork | upstream | destino |
| --- | --- | --- |
| múltiplas conexões simultâneas (`5b9b14a22` e testes) | **resolve** (PR #42259, 15/08; extensão 0.4.0 na Store) | **descartar** |
| nome `Playwright · <cliente>` com sufixo `(2)` | resolve (`uniqueGroupStyle`) | descartar |
| workarounds do clientName (`711b96ba1`, `fced22c56`, `8c0f9028b`/`a5204c41e`) | resolve (PR #41845) | descartar |
| escolha de perfil (`902054e1b`, `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`) | **resolve**: `--profile-dir-name` / `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` (PR #42527), timeout de 30 s com token (PR #42525) | descartar e **migrar quem usa** (passo 6) |
| `browser_set_group_label` (`e299560fd`, `0fb1d4814`) | **não** (#41840 aberta) | **portar** |
| fechar abas do agente ao desconectar + dono decidido em `_addTabToGroup` + fechar semente (`cb20e93da`) | **não**: o upstream só desagrupa, "by design" (#41864) | **portar**, reescrito sobre o `connectedTabGroup.ts` do upstream |
| tema escuro / redesign da UI (`cb9c2f5f3`, `b7e034d3e`, `2172490cd`) | **não**, recusado (#41841, NOT_PLANNED) | **portar** |
| wrapper `scripts/run-mcp-server.cjs` + modo chromium das sessões `ia:*` (`f826d9e18`, `88dc32769`) | não (conceito nosso) | **portar** (só `scripts/`, sem conflito); atualizar o pin do fallback npx de `0.0.78` para a versão corrente |
| descrições de tools sobre a aba corrente compartilhada (`396603082`) | verificar | portar se o texto do upstream não cobrir |
| remoção dos workflows de CI (`f9beeac1b`) | — | **refazer** na base nova (os arquivos voltam com o upstream) |
| docs e roadmaps (`60953d47f`, `1329ff4ff`, etc.) | — | portar `CLAUDE.md` (seção "This fork" reescrita) e a pasta `roadmap/` |
| `6f0b4cfdc` (itens 9–13 de julho) | parcial (#42259 libera semente roubada; #41966 e #42221 na reconexão) | **não portar**; guardar em tag e reavaliar só o que ainda doer |

## Decisão

**Refazer, não mesclar.** Nova branch a partir de `upstream/main`, portando os
itens "portar" um a um, em commits pequenos. Mesclar 496 commits resolvendo 13
conflitos em código que o upstream substituiu dá mais trabalho e deixa o fork
grande. Refeito, o fork vira um **conjunto pequeno de patches** que se reaplica a
cada sincronização.

Descartado: **voltar ao oficial puro** (Store 0.4.0 + `@playwright/mcp`). Perderia
o fechamento de abas (sem ele, o controle-gastos e as sessões deixam abas
soltas), o rótulo de grupo e o tema escuro.

## Guardrails

- **Nada se perde:** antes de tudo, `git tag fork-pre-refazer-2026-09-28 main`
  e `git tag fork-multi-connection-6f0b4cfdc extension-multi-connection`.
- **A `main` só é trocada no fim** (passo 8), depois da validação ao vivo. Até
  lá, o que roda continua sendo a main atual.
- **Push só com autorização do Gabriel**, a cada vez. A conta do fork é
  **`dosxnjos`**; a conta ativa do `gh` costuma ser `dados-produto-gruponomura`
  (`gh api user -q .login` antes de escrever; ver
  `C:\Dev\cerebro\temas\harness\git-contas-e-repos.md`).
- **Custo zero:** nada de Actions em repo privado, nada pago.
- Build: `npm ci && npm run build`. ⚠️ Build manual **não** atualiza
  `scripts/.build-stamp`: fazer `touch`. Checagem da extensão:
  `npx tsc -p packages/extension/tsconfig.json --noEmit` e
  `tsconfig.ui.json` (o `flint` da raiz não cobre `packages/extension/`).
- A extensão só muda no Chrome depois de **recarregar em `chrome://extensions`**
  de cada perfil que usa a versão descompactada: `Profile 13` (Dados - Produto)
  e `Profile 7` (Andressa - Merchan). Isso é ação do Gabriel.

## Passos

- [x] 1. Tags de segurança (guardrails). `git fetch upstream`.
- [x] 2. `git switch -c fork-v2 upstream/main`; build limpo e testes de
  `tests/extension/` e `tests/mcp/` do upstream passando, **antes** de portar
  qualquer coisa (linha de base).
- [x] 3. Portar o wrapper (`scripts/run-mcp-server.cjs`, `background-build.cjs`,
  `.gitignore` do stamp/lock/log) e refazer a remoção dos workflows de CI
  (listar `.github/workflows/` do upstream; tirar os que disparam sozinhos).
  Atualizar o pin do fallback npx.
- [x] 4. Portar `browser_set_group_label`: tool do servidor, repasse no relay,
  handler na extensão (`session.setGroupLabel`), no-op fora do modo extensão.
  Adaptar ao `uniqueGroupStyle`/`_connections` do upstream.
- [x] 5. Portar o fechamento de abas: ownership agente × usuário no
  `connectedTabGroup.ts` do upstream, decidido no ponto em que a aba entra no
  grupo **e** no `_addTabToGroup` (a corrida de `cb20e93da`), fechar a semente
  do agente que ainda estiver no `connect.html`. Teste: a sonda de
  `cerebro/temas/playwright-mcp.md` § Semente órfã (zero sobras).
- [x] 6. (feito 29/09: env nativa no coletor; a antiga saiu do coletor e do `~/.claude.json`; o perfil agora deriva do token ativo no wrapper) Perfil: apagar o `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` nosso e migrar para
  o nativo `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` em
  `C:\Dev\controle-gastos\coleta_billing_v4.py` (`sessao()`) e no `env` do
  `mcpServers.playwright` do `~/.claude.json`. Conferir se o nativo usa o nome
  da **pasta** (`Profile 13`) ou o nome exibido.
- [x] 7. Portar o tema escuro (`connect.css`/`status` e o que `cb9c2f5f3`,
  `b7e034d3e`, `2172490cd` mudaram), sobre a UI atual do upstream. Subir a
  versão do `manifest.json`.
- [x] 8. (feito 29/09: virada, sessão nova conectou no Profile 13 com rótulo, sonda das duas contas conectou em ~1 s, `main` = `fork-v2` local e no `origin`, tags publicadas) Validação ao vivo e virada. **Achado do advisor (28/09):** os perfis 13 e 7 carregam a extensão
  descompactada de `C:\Dev\playwright\packages\extension\dist` (medido no `Secure Preferences`), e
  `~/.claude.json` e `MCP_SCRIPT` do coletor apontam para `C:\Dev\playwright\scripts\...`. Recarregar a
  extensão hoje carregaria o build **velho**; servidor e extensão têm de virar juntos (o comando de rótulo
  mudou de `session.setGroupLabel` para `extension.setGroupLabel`). Virada = **trocar o checkout, não a ref `main`**:
  1. Fechar as instâncias do Claude Code (o `npm ci` troca 1.62 por 1.64 sob o wrapper). Gabriel confirma.
  2. Tudo commitado no worktree; `git worktree remove ../playwright-v2`.
  3. Em `C:\Dev\playwright`: `git switch fork-v2`. ⚠️ A árvore tem trabalho não commitado de outras sessões
     (`.gitignore` com a guarda do log de token, dois roadmaps modificados, rascunhos soltos): se o `switch`
     recusar, **parar e perguntar**; nunca `reset --hard`.
  4. `npm ci && npm run build && touch scripts/.build-stamp`.
  5. Gabriel recarrega a extensão em `Profile 13` e `Profile 7` (mesmo caminho, build novo, versão 0.4.0.1) e
     reinicia o Claude Code.
  6. Rodar `run_billing.bat` (duas contas, zero abas sobrando) e uma sessão comum chamando `browser_set_group_label`.
  7. Só então: apagar `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` do coletor e do `~/.claude.json` (a nativa fica), e mover
     a ref `main` (`git branch -f main fork-v2` local). Publicar (push das duas tags e depois `main` com
     `--force-with-lease`) é **push em repo público, autorização própria a cada vez**.
  **Reversão:** `git switch main`, `npm ci && npm run build && touch scripts/.build-stamp`, recarregar a extensão.
- [x] 9. (feito 29/09: `FORK.md` + `.github/workflows/upstream-drift.yml`; falta ativar as Actions no GitHub) Rotina de sincronização: documentar no `CLAUDE.md` do fork (fetch
  upstream → rebase de `fork-v2` → build → testes). **Proposta a decidir com o
  Gabriel:** uma Action semanal gratuita que só **avisa** (issue no fork) quando
  o upstream andou N commits ou o rebase conflita. Sincronizar sozinha não dá,
  porque o fork carrega patches.
- [x] 10. (feito 29/09) Docs: seção "This fork" do `CLAUDE.md`, `cerebro/temas/playwright-mcp.md`,
  hub `cerebro/projetos/playwright.md`, diário.

## O que o pedido não dizia

- a remoção dos workflows **volta** com o upstream e precisa ser refeita.
- o controle-gastos e o `~/.claude.json` usam a flag de perfil nossa: trocar a
  flag sem migrar os dois quebra a coleta do dia 6.
- o fechamento de abas é o que impede o coletor de deixar abas soltas; ele
  precisa estar portado **antes** de a main mudar.

## Relatório de execução — passos 1-7 (2026-09-28, sessão 1d0851c4)

Escopo: o roadmap não tem "fases"; o Gabriel pediu para executá-lo inteiro. Executados os passos 1-7 e a parte
de repo dos 9-10. **Parados no 8** (ação dele + virada de config viva). Nada foi enviado ao GitHub.

**Por passo (prova = comando e o que veio)**
1. Tags `fork-pre-refazer-2026-09-28` (main) e `fork-multi-connection-6f0b4cfdc` (`6f0b4cfdc`) criadas; `git fetch
   upstream`: `upstream/main` = `e8149b825`, 496 commits à frente da `main` antiga.
2. Decisão: worktree `C:\Dev\playwright-v2` (`git worktree add -b fork-v2 upstream/main`) em vez de trocar o checkout,
   porque a `main` em uso roda o MCP de todas as sessões. `npm ci` + `npm run build` 25 s. Linha de base:
   `ctest-mcp core click tabs` = 65 verdes; `tsc` da extensão = 3 erros de `@types/chrome` (já no upstream), UI limpa.
3. `a9d0bde01`. Wrapper copiado, pin npx `0.0.78` -> `0.0.83` (`npm view @playwright/mcp` = latest). Workflows: mantidos
   só os manuais, `pr-ci-triage` (workflow_call) e `tests_extension.yml`; removidos 16 com push/cron/pull_request/issues.
   Prova: `argvForAiSession(['--extension','--browser','chrome'],'ia:x')` -> `["--browser","chromium","--isolated","--headless"]`;
   `'humano:x'` -> argv intacto.
4. `96c9dbb4c`. Prova: `ctest-mcp group-label` 3/3 verdes (no-op sem `--extension`, erro com `--extension --isolated`,
   label vazio); `tsc -p .` e `eslint` limpos; sonda do wrapper a partir do `fork-v2` (handshake MCP, `tools/list`
   com a tool, `tools/call` -> "No tab group to label ..."). O lado extensão **não foi exercitado** (ver Pendências).
5. `0f05f06af` + `b0028fbd8` (ajustes da revisão). `tsc` da extensão = os mesmos 3 erros de base.
6. Parcial: o fork v2 não carrega mais a env antiga; `coleta_billing_v4.py` passa `PLAYWRIGHT_MCP_PROFILE_DIR_NAME`
   lado a lado com a antiga (commit `7be083b` em `controle-gastos`, `py_compile` ok). Conferido no código do
   upstream: `--profile-dir-name` é a **pasta** (`Profile 13`), vai direto para `--profile-directory=`.
7. `9844d7cce`. CSS por merge de 3 vias (0 conflitos), `connect.tsx` só ganhou o `stage-mark`/`ghost-light`;
   `status.tsx` do fork descartado (o upstream tem o dele). Manifest `0.4.0.1`. Todas as classes usadas têm CSS;
   `dist/` contém `ghost-light`. **Visual não conferido** (sem `file://`).

**Decisões técnicas (régua v3)**
- Registro `Browser -> relay` (`backend/extensionSession.ts`) em vez de passar o relay por 6 arquivos: menos diff
  contra o upstream, menos conflito a cada rebase. Primeiro em `utils/`, a checagem de DEPS reprovou, movido para
  `backend/` (`e01277f3a`). Confiança alta; reverte-se trazendo o relay por `browserFactory`. Limite conhecido:
  `--shared-browser-context` (FORK.md § Known limitations).
- Env de perfil lado a lado em vez de trocar: a `main` antiga só entende a antiga, o `fork-v2` só a nativa; trocar antes
  da virada quebraria a coleta. Confiança alta.
- Workflows: manter `tests_extension.yml` (única validação macOS da extensão, push-only, grátis em repo público) e
  adicionar `fork-v2` aos ramos de push. Reverte-se removendo o arquivo.
- Manifest `0.4.0.1` para o `chrome://extensions` mostrar o build do fork. Confiança média-alta.
- Regra do opener: aba aberta a partir de aba já no grupo é do agente. Casa com o contrato antigo (popup/`browser_tabs
  new`), mas é a direção que pode fechar uma aba do usuário aberta por ctrl+click numa aba escolhida por ele.
  Confiança média; alternativa: herdar o dono do opener (`_agentOwnedTabs.has(openerTabId)`).
- Atalho do usuário (Cancel na barra do debugger, DevTools) rebaixa a aba para "do usuário" (nunca fechada). Decisão
  minha a partir do achado 3 da revisão; reverte-se apagando `ontabtakenover`.
- `flint` completo: `doc` (`getBrowserVersions`) e `check-deps` (html-reporter/playwright, caminhos `../../C:/...`)
  falham por ambiente Windows; a checagem de DEPS só do `playwright-core` (cópia de `utils/check_deps.js` sem as outras
  linhas) passa. `eslint`, `tsc`, `lint-tests`, `test-types`, `lint-packages` = 0.

**Revisão adversarial (subagente `revisor-diff`, contexto zero)**: 7 achados. Corrigidos em `b0028fbd8`: (1) dono de aba
herdada do grupo dependia da ordem dos eventos; (2) escolher a própria `connect.html` no seletor virava "do usuário" e
vazava; (3) Cancel do debugger fechava a aba do agente; (4) `_addTabToGroup` em voo terminava depois do close; (6)
`_pendingOwner` sobrevivia a um grupo que falhou. Registrados em FORK.md: (5) `--shared-browser-context`; (7) wrapper
(lock sem expiração, carimbo no fim do build, args com espaço no fallback npx; herdados do fork antigo, fora do escopo).
Nenhum dos corrigidos tem teste automático (a suíte de extensão não roda no Windows).

advisor: fable (28/09). Procederam e foram feitos: (1) virada tem de trocar checkout e extensão juntos, porque os perfis
carregam de `C:\Dev\playwright\packages\extension\dist` (confirmado no `Secure Preferences`); passo 8 reescrito com
procedimento e reversão; (2) o pré-voo do upstream (`isExtensionInstalledInProfile`) aceita a instalação descompactada
(registro em `Secure Preferences`: conferido nos perfis 13 e 7, sem imprimir token); (3) `tests_extension.yml` não rodava
em `fork-v2`: ramo adicionado; (4) push das tags e `--force-with-lease` da `main` listados como autorizações próprias;
(6) suíte MCP completa rodada: 775 verdes, 19 skipped, 2 falhas sem relação com o diff (`config.spec.ts` `browserName`: Firefox não instalado nesta máquina; `http.spec.ts` "one idle timer across clients": temporização, passa isolado em 7,5 s); (7) este relatório. Ponto 5 (regra do opener) registrado como decisão acima, não mudado.

**completei:** teste `tests/extension/tab-ownership.spec.ts` (o fork antigo tinha o caso marcado `fixme`); doc `FORK.md`
(o `CLAUDE.md` ficou em mapa de 10 linhas); casos de borda de posse da revisão; guarda de `.gitignore` do log de token
(`/scripts/.mcp-debug-log*`) já na base nova; aviso de que o token real exportado no shell derruba o teste de extensão
("Invalid token provided.", causa da tentativa que abriu janela com pedido manual de "Allow & select").

**Arquivos (fork-v2):** `scripts/{run-mcp-server,background-build}.cjs`, `.gitignore`, `.github/workflows/` (16 removidos,
`tests_extension.yml` editado), `packages/playwright-core/src/tools/backend/{groupLabel,extensionSession,tools,context,tabs,navigate}.ts`,
`packages/playwright-core/src/tools/mcp/{cdpRelay,protocol,extensionContextFactory}.ts`,
`packages/extension/src/{background,connectedTabGroup,relayConnection}.ts`, `packages/extension/src/ui/*`,
`packages/extension/manifest.json`, `tests/mcp/{group-label,capabilities}.spec.ts`,
`tests/extension/{group-label,tab-ownership}.spec.ts`, `FORK.md`, `CLAUDE.md`, `roadmap/`.
Fora do repo: `controle-gastos/coleta_billing_v4.py`.

**Pendências e decisões pendentes**
- `dono: gabriel` Passo 8: confirmar a virada (fechar as instâncias do Claude Code), recarregar a extensão nos perfis
  13 e 7, rodar `run_billing.bat`. Recomendo fazer numa janela sem sessões abertas.
- `dono: gabriel` Publicar: push das tags e `main` (`--force-with-lease`) num repo público; autorização a cada vez.
- `dono: gabriel` Passo 9: Action semanal que só avisa (issue) quando o upstream andou. Recomendo criar (custo zero).
- Sem dono humano, para a próxima sessão: diário e hubs do cérebro (passo 10) depois da virada; apagar a env antiga
  (passo 6/8); eventual teste real dos ajustes de posse.
- Nenhuma decisão de negócio (Andressa).

## Relatório de execução — passos 8-10 (2026-09-29, sessão 1d0851c4)

- Virada com o Gabriel: sessões fechadas, backup do `.gitignore` sujo (`temp/gitignore-sujo-2026-09-29.patch`),
  `git worktree remove`, `git switch fork-v2` em `C:\Dev\playwright`, `npm ci` + build + stamp. Sonda do wrapper ok.
- Falha achada ao vivo e corrigida: o `~/.claude.json` só tinha a env de perfil antiga, que o v2 não lê; a
  conexão foi para o perfil errado (o Gabriel barrou a chamada). Sistematizado: `PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variante>`
  ao lado de cada token do cofre e `envForActiveProfile` no wrapper (6 casos testados; commit `b2057ab91`). Env antiga apagada
  do `~/.claude.json` (backup no scratchpad) e do coletor (`ae46a5f`, `50aae28` no controle-gastos).
- Prova ao vivo: sessão nova, `browser_set_group_label` -> "Tab group label set", `browser_navigate`, `browser_tabs new`;
  sonda das duas contas do coletor (`Profile 7` e `Profile 13`): rótulo aplicado e listagem de abas ok, 1,3 s e 1,1 s.
  Visual (grupo no perfil certo, tema escuro) e "zero abas sobrando" dependem da conferência do Gabriel.
- Não rodado: `run_billing.bat` (produção, exige o Gabriel no console por causa da guarda de identidade).
- Publicado (autorizado pelo Gabriel): tags, `fork-v2` e `main` com `--force-with-lease` sobre `88dc32769`. O `origin/main` antigo
  ficou preservado na tag `fork-pre-refazer-2026-09-28`.
- Pendências: ativar as Actions do fork no GitHub (só ele); conferir "zero abas sobrando"; `run_billing.bat` no dia 6.
