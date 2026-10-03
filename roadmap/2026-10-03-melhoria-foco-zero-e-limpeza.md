# Roadmap de melhoria: foco zero por padrão e limpeza do `.playwright-mcp` (03/10/2026)

> **Base:** `C:\Dev\playwright` `a36a1873c` (03/10/2026). **Risco:** dado (a limpeza apaga arquivos; foco errado pode
> esconder uma página que o Gabriel precisava ver). Continua
> [2026-10-03-melhoria-abas-por-agente.md](2026-10-03-melhoria-abas-por-agente.md) (patches 6 e 7, leia o FORK.md
> § Agent routing e § Silent connect antes).

## Contexto e motivação

Pedido do Gabriel, 03/10/2026: *"Por padrão, eu não quero que as páginas e grupos de abas fiquem ganhando foco. A
limpeza da pasta do playwright também é bem interessante."*

Hoje, depois do patch 7, só os **subagentes** conectam e abrem abas em 2º plano. Ainda puxam o foco:
- a 1ª conexão de cada sessão: o servidor lança `chrome.exe <connect page>` e o Windows traz a janela do Chrome para a
  frente; a extensão também ativa a aba e foca a janela (`packages/extension/src/background.ts`, `_connectTab`);
- toda ação da conversa principal: `browser_tabs new` cria com `active:true`, `select` faz `bringToFront`;
- popup aberto pela página de qualquer agente (`window.open`): o Chrome cria ativo (item 4.8 do roadmap anterior).

A pasta `.playwright-mcp` recebe um snapshot `.yml` ou um log `console-*.log` por chamada, em toda sessão, na pasta
onde a sessão roda (`backend/context.ts::outputDir`, `<cwd>/.playwright-mcp`). Medido em 03/10:

| pasta | arquivos | tamanho | mais velho |
| --- | --- | --- | --- |
| `C:\Dev` | 1264 | 29 MB | 16/08 |
| `C:\Dev\unclick` | 605 | 110 MB | 17/07 |
| `C:\Dev\nitg\temp` | 1673 | 34 MB | 21/09 |
| `C:\Dev\central` | 55 | 8,8 MB | 29/08 |
| outras 5 | <300 | <2 MB | — |

`~/.playwright-mcp/agentes-fim/` (marcas do roteador) mora na home e **não** é lixo.

## O que o pedido não dizia

- **completei (proposto aqui):** a conversa principal ganha uma saída explícita para quando o Gabriel QUER ver:
  `PLAYWRIGHT_MCP_FOCUS=on` no ambiente do servidor volta ao comportamento antigo. Sem isso, "nunca focar" seria uma
  porta de mão única.
- **completei:** a limpeza só apaga arquivo com nome gerado (`page-<data>.yml`, `console-<data>.log`, `page-<data>.png`
  e afins), nunca subpasta nem arquivo com nome escolhido (print salvo de propósito).
- **completei:** retenção de 7 dias, não "apagar tudo": o agente lê o snapshot da própria sessão por caminho.

## Fase 1: foco zero por padrão

1. [ ] **Todos os relays em modo silencioso com token.** Em `packages/playwright-core/src/tools/mcp/cdpRelay.ts` e
   `extensionContextFactory.ts`: o modo "background" (aba nova `active:false`, `Page.bringToFront` local, foco
   emulado, timeout de print de 30 s) passa a valer também para a `main` quando há token, salvo
   `PLAYWRIGHT_MCP_FOCUS=on`. O `PLAYWRIGHT_MCP_AGENT_SILENT=off` continua desligando tudo.
   **Prova:** teste em `tests/mcp/agent-silent.spec.ts`: relay da `main` com token → `chrome.tabs.create` com
   `active:false` e `Page.bringToFront` não chega à extensão; com `PLAYWRIGHT_MCP_FOCUS=on` → como hoje.
   **Reprova se:** o relay da `main` ainda manda `active:true` com token.
2. [ ] **A 1ª conexão não deixa o Chrome na frente.** Na extensão (`background.ts`): antes de conectar, guardar se o
   Chrome estava focado e qual aba estava ativa na janela; com conexão silenciosa (token, sem aba escolhida), depois
   de conectar, reativar a aba anterior e, se o Chrome não estava focado, devolver o foco
   (`chrome.windows.update(id, {focused:false})`). Spike antes do código final: medir no Chrome real se o
   `focused:false` devolve o foco ao terminal no Windows.
   **Prova:** manual (roteiro abaixo); automática: `tests/extension` headless confere que a aba ativa volta a ser a
   anterior.
   **Reprova se:** a aba visível muda depois da conexão.
3. [ ] **Popup não vem para a frente (4.8).** Na extensão (`relayConnection.ts`, onde o popup é entregue à conexão
   dona da aba de origem): se a conexão é silenciosa, reativar a aba que estava ativa antes do popup.
   **Prova:** `tests/extension/popup-source.spec.ts` ganha o caso: popup de aba em 2º plano → a aba ativa continua a
   mesma. **Reprova se:** a aba ativa vira o popup.
4. [ ] **Docs:** FORK.md (§ Silent connect vira "foco zero"), `cerebro/temas/playwright-mcp.md`.

## Fase 2: limpeza do `.playwright-mcp`

1. [ ] **Poda no início de cada servidor.** Em `scripts/run-mcp-server.cjs`: antes de lançar o servidor, apagar de
   `<cwd>/.playwright-mcp/` (e de `PLAYWRIGHT_MCP_OUTPUT_DIR`, se definido) os arquivos **de primeiro nível** cujo nome
   casa `^(page|console|network|trace|video)-\d{4}-\d{2}-\d{2}T[\d-]+Z?(\.\w+)+$` e com mtime > 7 dias. Nunca
   subpasta, nunca outro nome. Assíncrono, sem atrasar o start; erro só vai para o log. Retenção por
   `PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS` (0 desliga).
   **Prova:** teste de unidade do wrapper com pasta temporária: arquivo gerado de 8 dias some; de 6 dias fica;
   `meu-print.png` de 30 dias fica; subpasta fica. **Reprova se:** qualquer um desses inverte.
2. [ ] **Poda única agora**, com a mesma regra, nas 9 pastas medidas acima. Registrar quantos arquivos e MB saíram.
   **Prova:** contagem antes/depois por pasta.
3. [ ] **Docs:** FORK.md (§ wrapper), `cerebro/temas/playwright-mcp.md`.

## Roteiro do teste ao vivo (Fase 1, com o Gabriel)

Sessão nova; extensão recarregada. Mãe: rótulo + navigate (OLHE: a aba que você vê e a janela em foco não mudam;
o grupo aparece em 2º plano); mãe `browser_tabs new` e `select` (OLHE: nada vem para a frente); subagente com popup
(OLHE: o popup nasce no grupo dele sem virar a aba ativa). Câmera lenta, mesmas regras dos roteiros de 03/10.

## O que NÃO fazer

- Apagar `.playwright-mcp` inteiro ou arquivo de nome escolhido: o agente e o Gabriel podem precisar de um print
  salvo de propósito.
- Mudar o `outputDir` padrão para uma pasta temporária: o agente lê o snapshot pelo caminho relativo da resposta, e
  outros projetos já ignoram `.playwright-mcp` no git.
- Tirar o foco também quando não há token: sem token, o clique em "Allow" precisa da página na frente.

## Decisões técnicas

Quem: opus 5.5, sessão `9f526eb4`, 03/10/2026. Retenção de 7 dias (média; reverte por env); foco zero inclui a `main`
com saída `PLAYWRIGHT_MCP_FOCUS=on` (alta, pedido explícito); poda no wrapper e não no servidor (alta: o wrapper é só
do fork e não conflita com o upstream).

## Relatório de execução — Fases 1 e 2 (03/10/2026, sessão 9f526eb4)

Workflow `foco-zero-e-limpeza` (2 executores em paralelo, 3 revisores de contexto zero, corretor) no worktree
`wt/foco-zero`; provas reconferidas nesta sessão; merge `--ff-only` na `main` com build e stamp.

- **Fase 1 (`ab6d9aebb`).** Relay da `main` silencioso com token (`cdpRelay.ts`: `subAgent` separado de
  `_background`; `PLAYWRIGHT_MCP_FOCUS=on` desliga). A página de conexão recebe `silent=1`; a extensão guarda a aba
  ativa e o foco (`focusMemory.ts`, em `chrome.storage.session`) e os devolve depois da 1ª conexão. Popup de conexão
  silenciosa volta para a aba anterior, salvo se nasceu da aba que o Gabriel está olhando. Extensão **0.4.0.4**
  (permissão `storage`). Provas: `ctest-mcp -- agent-routing agent-silent screenshot tabs capabilities core` →
  `129 passed`; `test-extension -- popup-source focus-zero` → `12 passed`; tsc da extensão na base (3 erros).
- **Fase 2 (`cbf9314b9`).** Poda assíncrona no wrapper e CLI `scripts/prune-mcp-output.cjs`;
  `node scripts/run-mcp-server.test.cjs` → `12/12 passed`, 15 mutantes mortos. **Poda única (2.2):** simulação →
  1192 arquivos, 59,6 MB em 10 pastas; amostra conferida (só `page-`/`console-` com data; as `.xlsx` do `unclick`
  ficam); real → `removed 1192 file(s), 59.6 MB`; nova simulação → `would remove 0`. `~/.playwright-mcp/agentes-fim`
  intacta.
- **Teste ao vivo (14:43-14:54, extensão 0.4.0.4):** sem erro de ferramenta, sem aba de fora, sem sobra. `new` e
  `select` da `main` não puxaram foco; popup do subagente em 2º plano; grupo do subagente sumiu no fim.
  - **Pisca na 1ª conexão:** o Chrome vem à frente por poucos ms (lançamento do `chrome.exe`) e a extensão o devolve
    para trás. **Decisão do Gabriel (03/10): aceito**; fica em limitações.
  - **Print em 2º plano lento:** ~12 s (subagente) e ~28-31 s (`main`, no teto de 30 s). **Decisão do Gabriel
    (03/10): "mostrar só sem plateia"**: com o Chrome sem foco, a aba aparece ~1 s para o print e volta; com o Chrome
    em foco, print lento sem piscar e teto de 60 s. Em execução (Fase 3).
  - Leitura certa do achado 3 do teste: a URL da conexão vem sem token porque a página o apaga (4.7 do roadmap
    anterior); `silent=1` é esperado.

## Relatório de execução — Fase 3: print "sem plateia" (03/10/2026, sessão 9f526eb4)

Decisão do Gabriel (03/10): com o Chrome sem foco, revelar a aba do agente ~1 s para o print e devolver; com o
Chrome em foco, print lento sem piscar, teto de 60 s. Workflow `print-sem-plateia` (executor morreu às 15:16 com
"Login expired" depois da troca de senha do Google; o parcial foi guardado no WIP `8a3119334` e um 2º executor
continuou dali) + 2 revisores + corretor. Commit `ebb346b0f` (rebase: WIP `cf933602e`).

- **Como funciona:** o relay em 2º plano intercepta `Page.captureScreenshot` (`mcp/cdpRelay.ts`, `_captureRevealed`)
  e pede à extensão `extension.revealForCapture`/`restoreAfterCapture` (`extension/src/captureReveal.ts`): revela só
  se a janela não está em foco e a aba não é a ativa; devolve no `finally`, quando o hold de 15 s expira e quando a
  conexão cai (`relayConnection.ts::_onClose`). Estado compartilhado por janela entre conexões (duas sessões
  imprimindo ao mesmo tempo devolvem a aba do usuário). Extensão antiga cai no print lento sem erro. Extensão **0.4.0.5**.
- **Provas:** `ctest-mcp -- agent-routing agent-silent screenshot tabs capabilities core` → `141 passed`;
  `test-extension -- popup-source focus-zero capture-reveal` → `22 passed`; 13 mutantes mortos; tsc da extensão
  na base (3 erros).
- **Teste ao vivo:** o 1º (16:17) rodou com a extensão ainda em 0.4.0.4, então tudo caiu no caminho lento (13,6 /
  30,1 / 11,1 s): é o fallback desenhado. O 2º, com 0.4.0.5 (16:29), medido pelo transcript: Chrome parcialmente
  atrás **1,0 s** (pisca visível ~1 s); totalmente coberto **0,4 s** (sem pisca visível; o Windows desenha a janela
  coberta); Chrome em foco **27,2 s**, sem piscar. Nenhum erro.
- **Em aberto:** com o Chrome parcialmente visível o Gabriel vê o pisca (a extensão só sabe de foco, não de
  visibilidade na tela). Pergunta feita a ele em 03/10.
