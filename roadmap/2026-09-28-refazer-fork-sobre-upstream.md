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

- [ ] 1. Tags de segurança (guardrails). `git fetch upstream`.
- [ ] 2. `git switch -c fork-v2 upstream/main`; build limpo e testes de
  `tests/extension/` e `tests/mcp/` do upstream passando, **antes** de portar
  qualquer coisa (linha de base).
- [ ] 3. Portar o wrapper (`scripts/run-mcp-server.cjs`, `background-build.cjs`,
  `.gitignore` do stamp/lock/log) e refazer a remoção dos workflows de CI
  (listar `.github/workflows/` do upstream; tirar os que disparam sozinhos).
  Atualizar o pin do fallback npx.
- [ ] 4. Portar `browser_set_group_label`: tool do servidor, repasse no relay,
  handler na extensão (`session.setGroupLabel`), no-op fora do modo extensão.
  Adaptar ao `uniqueGroupStyle`/`_connections` do upstream.
- [ ] 5. Portar o fechamento de abas: ownership agente × usuário no
  `connectedTabGroup.ts` do upstream, decidido no ponto em que a aba entra no
  grupo **e** no `_addTabToGroup` (a corrida de `cb20e93da`), fechar a semente
  do agente que ainda estiver no `connect.html`. Teste: a sonda de
  `cerebro/temas/playwright-mcp.md` § Semente órfã (zero sobras).
- [ ] 6. Perfil: apagar o `PLAYWRIGHT_MCP_PROFILE_DIRECTORY` nosso e migrar para
  o nativo `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` em
  `C:\Dev\controle-gastos\coleta_billing_v4.py` (`sessao()`) e no `env` do
  `mcpServers.playwright` do `~/.claude.json`. Conferir se o nativo usa o nome
  da **pasta** (`Profile 13`) ou o nome exibido.
- [ ] 7. Portar o tema escuro (`connect.css`/`status` e o que `cb9c2f5f3`,
  `b7e034d3e`, `2172490cd` mudaram), sobre a UI atual do upstream. Subir a
  versão do `manifest.json`.
- [ ] 8. Validação ao vivo com o Gabriel: recarregar a extensão nos perfis 13 e
  7, reiniciar o Claude Code, rodar `C:\Dev\controle-gastos\run_billing.bat`
  (duas contas, zero abas sobrando) e uma sessão comum com o rótulo de grupo.
  Só então `main` passa a apontar para `fork-v2` (a antiga fica na tag).
- [ ] 9. Rotina de sincronização: documentar no `CLAUDE.md` do fork (fetch
  upstream → rebase de `fork-v2` → build → testes). **Proposta a decidir com o
  Gabriel:** uma Action semanal gratuita que só **avisa** (issue no fork) quando
  o upstream andou N commits ou o rebase conflita. Sincronizar sozinha não dá,
  porque o fork carrega patches.
- [ ] 10. Docs: seção "This fork" do `CLAUDE.md`, `cerebro/temas/playwright-mcp.md`,
  hub `cerebro/projetos/playwright.md`, diário.

## O que o pedido não dizia

- a remoção dos workflows **volta** com o upstream e precisa ser refeita.
- o controle-gastos e o `~/.claude.json` usam a flag de perfil nossa: trocar a
  flag sem migrar os dois quebra a coleta do dia 6.
- o fechamento de abas é o que impede o coletor de deixar abas soltas; ele
  precisa estar portado **antes** de a main mudar.
