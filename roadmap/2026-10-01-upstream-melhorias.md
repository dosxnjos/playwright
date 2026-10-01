# O que do fork vale mandar ao upstream (microsoft/playwright) — 01/10/2026

> Pesquisa somente leitura (workflow `upstream-melhorias-playwright`, 15 melhorias: 9 conhecidas + 6 achadas na
> varredura, cada uma avaliada e contestada por um cético). Nada foi enviado ao GitHub. Gatilho: o PR #43037
> (check-deps no Windows) entrou em horas, e o Gabriel perguntou se vale abrir issue/PR para todas as melhorias.

## Correções da sessão sobre a síntese abaixo

- **group-label (#41840):** o Gabriel **já comentou** em 29/09 (update citando o #42259). Um 2º comentário dois dias
  depois soa como cobrança. Recomendação corrigida: **esperar**; reavaliar só se a #43038 ("option to disable the Chrome
  tab group", natenho, 01/10) ganhar tração de mantenedor, aí uma linha ligando as duas.
- **sw-idle-death:** "o fork não tem a correção do upstream em `relayConnection.ts`" é quase certamente só atraso
  (fork 34 commits atrás em 01/10), não regressão. Conferir no próximo sync.
- **Estado das branches:** resolvido na mesma sessão: `main` é a única branch local; a `fork-v2` remota fica para o
  Gabriel apagar pelo GitHub (o `push --delete` é bloqueado pela permissão).

## Síntese do workflow

## 1. Tabela

| melhoria | estado no upstream | recomendação final | chance | esforço | ganho pro Gabriel |
|---|---|---|---|---|---|
| group-label (patch 2) | #41840 aberta, atribuída ao yury-s, label v1.64. PR #42360 do yury-s foi aprovado e fechado sem merge num lote de "archiving" de 08/09 | comentar_issue_existente (1 comentário curto citando o #42360) | média | pequeno | **alto**: é o maior patch do fork e a origem dos conflitos recorrentes (backend/tools.ts, capabilities.spec.ts). O rótulo passaria a funcionar com a extensão oficial |
| fechar-abas (patch 3) | sem issue/PR. #41864 fechada pelo yury-s ("working as intended… full control over the tab group") | nao_enviar | baixa | médio | nenhum realista. O patch fica e segue com conflito em connectedTabGroup.ts |
| tema-escuro (patch 4) | #41841 CLOSED/NOT_PLANNED pelo yury-s em 12/08 | nao_enviar | baixa | médio | nenhum. Se o rebase doer, dá para encolher o patch (CSS em arquivo separado) |
| aviso-aba-compartilhada (patch 5) | sem issue/PR. pavelfeldman recusou o tema (#39703 "give it two browsers", playwright-mcp#893) | nao_enviar | baixa | pequeno | pouco: são só strings e conflitam pouco. Acompanhar a #42961 sem comentar |
| multi-conexão | #41838 fechada pelo PR #42259 (merge em 15/08) | ja_resolvido_upstream | alta | pequeno | já colhido: o patch saiu do fork em 28/09 |
| sw-idle-death | #41846 fechada pelo próprio Gabriel com retratação | nao_enviar | baixa | médio | nenhum: não há patch no fork |
| clientname | #41839 fechada pelo PR #41845 (merge em 20/07) | ja_resolvido_upstream | alta | pequeno | já colhido |
| navigate-restrito | #41843 CLOSED/NOT_PLANNED ("spam", dgozman) | nao_enviar | baixa | pequeno | nenhum. Basta a regra local de não navegar para chrome:// com --extension |
| aba-welcome-fantasma | #41843 "spam". #41864 "working as intended" para a causa 1. Causa 2 resolvida pelo #42259 (`_isTabReserved`) | nao_enviar | baixa | pequeno | nenhum: nada disso está na main do fork |
| extension-typecheck | sem issue/PR. 3 erros de tsc no upstream/main desde #40429 + #41497 | abrir_issue (A = corrigir os erros; B = perguntar se ligam o tsc no `npm run tsc`) | alta (A), média (B) | pequeno | zera a linha de base de 3 erros do FORK.md. Com B, o flint passa a cobrir packages/extension |
| flag-extension-silenciada | sem issue/PR. Bug presente em browserFactory.ts:63-82 | abrir_issue (sem PR) | alta | pequeno | quase nenhum direto, só reputação. Custo: o teste group-label.spec.ts:50-61 do fork quebra se a correção entrar |
| teste-herda-env-mcp | sem issue/PR. `inheritAndCleanEnv` e `runCli` não limpam PLAYWRIGHT_MCP_* | abrir_issue | média, que o cético rebaixou para média/baixa | pequeno | some a armadilha do token exportado no shell ("Invalid token", "Allow & select" na mão). Nenhum patch sai do fork |
| skill-dev-caminhos-velhos | sem issue/PR. Precedentes #42045 e #40942 mergeados sem issue | na prática **PR direta** só com troca de caminhos (o enum diz abrir_issue). Issue de 1 linha opcional | alta | pequeno | pequeno: agentes param de seguir caminho morto, e conta mais um PR mergeado |
| attach-falha-silenciosa | código igual no upstream (browserModel.ts:138). Gatilho tirado pelo #42259. Sem issue aberta | nao_enviar (reavaliar só com repro "0 of N" na main atual) | baixa | médio | zero hoje: o fix mora só na tag fork-multi-connection-6f0b4cfdc |
| testes-extensao-windows | sem issue/PR. Upstream exclui Windows/Linux de propósito (CI só macOS desde o playwright-mcp) | nao_enviar | baixa | grande | nenhum no upstream. A solução é local: reativar o tests_extension.yml (macOS) no Actions do fork |

## 2. Ordem sugerida de envio

1. **Comentário na #41840 (group-label).** É o único caso em que o patch some do fork, e é o patch maior e mais conflituoso. Custa um comentário curto que reconhece o #42360 e sugere reabri-lo, sem pedir atribuição de novo. Chance média, mas ganho máximo. Se não houver resposta em 2 a 3 semanas, tratar como recusado e manter o patch.
2. **Issue extension-typecheck.** Chance alta, segue o formato que já funcionou (#42988 → #43037) e zera a linha de base do tsc que o fork vigia à mão. A issue deve perguntar se B serve, sem anunciar PR para B.
3. **PR de caminhos da skill playwright-dev.** Chance alta, custo mínimo, cabe na exceção de "minor documentation fixes" do CONTRIBUTING. Só troca de caminho, incluindo tools.md L485-489.

Depois, com espaço entre um envio e outro para não parecer spam: as issues flag-extension-silenciada e teste-herda-env-mcp. Nenhuma das duas tira patch do fork.

## 3. O que NÃO enviar e por quê

- **fechar-abas, aba-welcome-fantasma:** o mantenedor já disse por escrito que o comportamento é intencional (#41864), e a conta já levou um "spam" do dgozman na #41843.
- **tema-escuro:** recusa explícita do yury-s (NOT_PLANNED) depois de ver os screenshots.
- **aviso-aba-compartilhada:** contraria a posição do pavelfeldman sobre vários agentes numa mesma conexão. O conselho do texto ainda tem corrida entre select e navigate.
- **navigate-restrito:** fechada como spam. O fix proposto quebraria o tests/mcp/crash.spec.ts do upstream.
- **sw-idle-death:** a tese foi retratada publicamente pelo próprio Gabriel e não há patch.
- **attach-falha-silenciosa:** não há repro no código atual, e o tema já foi encaminhado a uma issue que fechou com outro fix.
- **testes-extensao-windows:** limitação deliberada do upstream, causa não provada e fix grande.
- **multi-conexão, clientname:** já resolvidos no upstream. Os rascunhos podem ser arquivados.

## 4. Divergências entre avaliador e cético

Nenhuma recomendação foi derrubada: em todos os itens o cético manteve a recomendação. As divergências são de fato ou de nuance:

- **group-label:** o cético alerta que um 2º comentário 2 dias depois do 1º pode soar como cobrança, e sugere citar a #43038 numa linha e comentar na issue, não no PR fechado.
- **teste-herda-env-mcp:**
  - O #40653 não serve de precedente: tirou o uso de `inheritAndCleanEnv`, não mexeu na lista. Não citar.
  - O fork-v2 não contém o upstream/main (está 34 commits atrás).
  - O "diff vazio" vale só para os 3 arquivos de teste.
  - A chance cai para média/baixa, e o repro deve ser feito em Linux/mac.
- **skill-dev-caminhos-velhos:**
  - A varredura deixou de fora tools.md L485-489.
  - O enum abrir_issue não bate com a recomendação real, que é PR direta.
  - A troca de protocol.yml para spec/*.yml muda texto, não só caminho, e fica no limite do "minor".
- **fechar-abas:** o patch tem ~157 linhas com o teste, não 116. O título da #41843 não é "aba órfã".
- **attach-falha-silenciosa:** `_onTabUpdated` está em connectedTabGroup.ts:158-170, não em browserModel 119-129. O cético também data o fechamento da #41843 em 18/07; os demais avaliadores dizem 17/07.
- **aba-welcome-fantasma, navigate-restrito:** a #41864 tem stateReason COMPLETED, não NOT_PLANNED; o texto continua sendo "working as intended". O teste citado pelo Gabriel na #41843 (cli-navigation.spec.ts) não tem chrome://; a prova válida é o crash.spec.ts.
- **extension-typecheck:** o #40429 foi mergeado em 28/04, não 27/04. Sobre B, perguntar e não anunciar PR.
- **flag-extension-silenciada:** o cético acrescenta um 4º precedente (config.ts:324) e recomenda espaçar as issues.
- **sw-idle-death:** possível regressão de rebase. O fork-v2 não tem a correção do upstream em relayConnection.ts (`if (this._closed) detachDebugger`). Vale checar no próximo rebase.
- **Estado das branches** (vários itens): os avaliadores dizem que a main é a única branch. O cético mostra que a fork-v2 já foi incorporada na main (9e34cf5bc, 01/10), mas a ref ainda existe no local (2b2a23a09) e no origin (8b202a43). É sobra a apagar.
- **Os dados não fecham entre si sobre a main local:**
  - multi-conexão diz 18 commits à frente de upstream/main.
  - attach diz que fica logo acima de 87291ca60.
  - navigate-restrito diz que upstream/main está 34 commits à frente.
  - extension-typecheck diz que a main não bate com upstream/main.

  Não resolvi isso; precisa conferir com git antes do próximo rebase.
  **Resolvido na sessão (01/10, `git rev-list --left-right --count upstream/main...main`):** `main` está 18 commits à frente (os 5 patches + docs/roadmaps do fork + o cherry-pick do #43037) e 34 atrás do upstream. Todas as leituras acima são verdadeiras ao mesmo tempo.

## Plano de execução (01/10, autorizado pelo Gabriel: "faz tudo o que achar pertinente", maestro segue pausado)

1. Preparar em paralelo (workflow, sem publicar nada): (a) issue dos erros de tsc da extensão, com os erros
   reproduzidos em `upstream/main`; (b) PR de caminhos velhos da skill `playwright-dev`, branch a partir de
   `upstream/main` em worktree próprio, cada caminho novo conferido; (c) rascunhos das 2 issues espaçadas
   (`--extension` silenciado; testes herdando `PLAYWRIGHT_MCP_*`), para enviar dias depois; (d) ensaio do sync
   do fork (rebase da `main` sobre `upstream/main` num worktree descartável: conflitos, build, testes).
   Cada peça passa por revisor cético.
2. Publicar pela conta `dosxnjos` (troca e volta do `gh` no mesmo comando): (a) issue; (b) PR.
3. Testar o `upstream-drift.yml` agora que as issues do fork estão ligadas (`workflow_dispatch`).
4. Sync real do fork: só se o ensaio (d) sair limpo e sem risco à extensão carregada nos perfis do Chrome;
   senão, fica proposto com o relatório do ensaio.
5. Fora do alcance: apagar branches remotas (`push --delete` bloqueado pela permissão) → Gabriel pelo GitHub.

## Relatório de execução (01/10)

Preparo: workflow `upstream-preparo-playwright` (8 agentes, executor + revisor cético por frente).

- **(a) issue tsc → [#43050](https://github.com/microsoft/playwright/issues/43050).** 3 erros reproduzidos em
  `upstream/main` 87291ca60 (`TabChangeInfo` ×2, tupla do `ungroup`), causa #41497 (`@types/chrome` 0.2.0) + exclude do
  #40429; sem duplicata. Revisor aprovou; ajustes aplicados (o eslint carrega os tsconfigs mas não faz typecheck; o
  exclude foi deliberado, citado em vez de suposto). Fix pronto e **não publicado**: worktree `C:\Dev\pw-up-tsc`, branch
  `fix-ext-tsc`, commit `54a61ffa1` (+5/−3). Só vira PR depois que a issue for atribuída; rebasear antes.
- **(b) PR skill → [#43051](https://github.com/microsoft/playwright/pull/43051)** (branch `docs-playwright-dev-paths`,
  worktree `C:\Dev\pw-up-docs`). Revisor reprovou a 1ª versão (`exports.ts` foi renomeado para `index.ts`, não apagado;
  `CLAUDE.md` dizia `channels.d.ts` no pacote protocol; gramática; corpo omitia 2 typos); corrigido em commit novo
  `0eb140be3` (sem amend). Ficou de fora de propósito: `PageGotoParams` como exemplo conceitual no `library.md`.
- **(c) rascunhos espaçados:** `roadmap/issue-extension-isolated-draft.md` (A, **não antes de 08/10**, bug reproduzido:
  `--extension --isolated` lança Chromium headless sem aviso) e `roadmap/issue-mcp-tests-env-draft.md` (B, **não antes de
  15/10**, reproduzido com `PLAYWRIGHT_MCP_CAPS=vision`). Correções do revisor aplicadas (o "Allow & select" é outra
  causa; Steps deve ser refeito num worktree de `upstream/main` no dia). Repro do A em `roadmap/upstream-repro/`.
- **(d) sync → aplicado.** Ensaio em worktree: 1 conflito previsto (modify/delete de 2 workflows de docker, `git rm`),
  cherry-pick do #43037 descartado sozinho, 67/67 MCP, tsc da extensão = linha de base de 3, `check_deps` ok. Somado:
  `check_copilot_models.yml` removido (gatilho `pull_request`, fura a política do patch 1) e `FORK.md` com a rota sem
  stash. Checkout real movido com `git reset --keep` (edits de `roadmap/` de outra sessão preservados), `npm install`
  no lugar (lockfile só trocou `electron`/`ip-address`; `npm ci` apagaria o `node_modules` sob servidores MCP vivos),
  build ok, `.build-stamp` tocado. Validação no checkout real: `check_deps` 0, 66/67 + a 67ª era artefato do `--output`
  em caminho 8.3 (falha igual no upstream puro; sem `--output`, 3/3) → armadilha registrada no `FORK.md`.
  Extensão: só `relayConnection.ts` mudou (#43025, fix do upstream); protocolo igual, então a extensão carregada segue
  funcionando; o fix só vale depois de **recarregar a extensão nos perfis** (ação do Gabriel, recomendada).
- **drift:** `workflow_dispatch` ok, abriu a issue #2 do fork ("34 atrás, conflito: sim") → fechada após o sync.

> Fechado em 2026-10-01: plano executado (sync, #43050, #43051, rascunhos); o acompanhamento segue no card recorrente cce21afc9f588 com a rotina roadmap/ronda-upstream.md.
