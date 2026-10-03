# Abas do Playwright entre agente principal e subagentes — 02/10/2026

> Pesquisa somente leitura (workflow `playwright-abas-subagentes`, 95 agentes: 5 frentes de investigação, cada
> afirmação contestada por um cético, síntese). Nada no código do fork mudou. Gatilho: o Gabriel perguntou se os
> subagentes de Workflow dividem o grupo de abas do agente da conversa, se ficam disputando a mesma aba, se dá para
> cada agente ter "suas" abas + uma lista compartilhada, ou um grupo por subagente com mover aba entre grupos, e como
> os agentes podem se comunicar melhor.

Legenda: **[código]** lido na fonte · **[doc]** doc oficial do Claude Code · **[medido]** processos desta máquina em
02/10/2026 · **[inferido]** dedução não testada. Caminhos curtos relativos a `packages/playwright-core/src/tools/`;
os da extensão, a `packages/extension/src/`.

## Como funciona hoje

**Subagente (Agent tool) e agente de Workflow usam a conexão MCP da sessão-mãe.**
- [doc] "Subagents inherit the ... MCP tools available in the main conversation"; referência por nome no frontmatter
  "reuses an already-configured server" (code.claude.com/docs/en/sub-agents § `mcpServers`). Só servidor declarado
  **inline** no frontmatter do subagente abre conexão própria, ligada no início e desligada no fim do subagente.
- [medido] cada `claude.exe` tem exatamente um filho `run-mcp-server.cjs` → um `mcp.js`; o shell de um agente de
  Workflow sobe até o mesmo `claude.exe`. Fecha a hipótese em aberto em
  `roadmap/2026-07-17-melhoria-fork-servidor-mcp.md:463-466`.

Logo, por sessão: **1 processo, 1 conexão com a extensão, 1 grupo de abas, 1 ponteiro de "aba corrente"**
([código] `backend/browserBackend.ts:67-75`, `backend/context.ts:113-114`; extensão `background.ts:119-127`,
`connectedTabGroup.ts:84`).

| cenário | disputa? |
| --- | --- |
| sessões diferentes do Claude Code (humanas, `--extension`) | não: processo, grupo e aba corrente próprios (upstream #42259) |
| subagentes / agentes de Workflow na mesma sessão humana | **sim**, no Chrome real do Gabriel |
| sessão aberta por IA (`CENTRAL_ORIGEM=ia:*`) | não toca o Chrome dele (chromium headless isolado); os subagentes dela disputam entre si [inferido] |

### O que acontece quando dois subagentes navegam juntos [código]

1. Nenhuma tool diz em que aba age: todas usam a aba corrente (`backend/tool.ts:70-74`, `navigate.ts:34`). O único
   endereço é o `index` de `browser_tabs` (`tabs.ts:28-32`), uma **posição** na lista, não um id.
2. `browser_tabs new` torna a nova aba corrente (`context.ts:184-189`), deslocando quem estava em outra.
3. Não há fila: o SDK MCP despacha pedidos sem esperar o anterior, e o servidor não tem trava
   (`browserBackend.ts:89-142`; `setRunningTool` é só marcação, ninguém lê `isRunningTool()`).
4. O patch 5 (aviso na descrição de `browser_tabs`, `tabs.ts:27`) manda `list` + `select` antes de cada ação: são
   duas chamadas, outro agente pode trocar a aba no meio (corrida já anotada em
   `roadmap/2026-10-01-upstream-melhorias.md:51`).
5. Índices andam: aba fechada sai da lista e as seguintes mudam de posição (`context.ts:321-325`).
6. Fechou a aba corrente, o ponteiro cai em silêncio na vizinha, que pode ser de outro agente (`context.ts:327-328`).
7. O snapshot da resposta é tirado da aba corrente **depois** da ação (`response.ts:293`): pode vir da aba de outro.
8. Refs `eN` são numeradas por página sem marca da aba: `e7` da aba A usada com B corrente pode clicar em B
   [código; não testado ao vivo].

### Perigos que a pergunta não cobria [código]

- **`browser_close` derruba a conexão inteira**, não só a página: a descrição diz "Close the page"
  (`backend/common.ts:27`), mas `setClose` → `dispose` (`browserBackend.ts:137-140`) → a extensão fecha todas as abas
  do agente no grupo (`connectedTabGroup.ts:233-247`). Um subagente que dá `close` fecha as abas dos irmãos e da mãe.
- **`browser_set_group_label` de um subagente renomeia o grupo da mãe** (rótulo é por conexão,
  `backend/groupLabel.ts:35-51`).
- **`select` traz a aba para a frente** (`context.ts:195` → `bringToFront`): seguir o conselho do patch 5 faz os
  subagentes disputarem também a aba visível na janela do Gabriel.

**Nenhum incidente registrado** até 02/10/2026 (nada em `cerebro/`, `central/ARMADILHAS.md` nem roadmaps): o risco
é de leitura de código. O incidente real de julho foi entre sessões, já resolvido pela multiconexão.

## Opções avaliadas

**(a) Mesmo grupo, sublista por agente + lista compartilhada.** No Chrome/extensão: impossível (grupo não aninha;
uma aba pertence a uma conexão, `background.ts:112-113`). No servidor: viável só "por palavra de honra", porque o
servidor não sabe quem chama (`ClientInfo` é um por processo, `utils/mcp/server.ts:36-39`; nenhum id de subagente no
`_meta` [doc, por ausência]). Exigiria parâmetro `owner` declarado pelo próprio agente.

**(b) Grupo por subagente + mover aba entre grupos.** Grupo por subagente **já funciona** se cada subagente tiver
processo próprio: servidor inline no frontmatter de um agente em `~/.claude/agents/<nome>.md` [doc]; o Workflow
aceita esse tipo via `agentType` [doc; herdar o `mcpServers` é inferido]. Custos: um node e uma aba-semente por
subagente, roubo de foco do Chrome a cada conexão, disputa do `scripts/.build-lock`, faixa "started debugging"
global. Ganho de brinde: ao terminar o subagente, as abas dele fecham sozinhas (patch 3). Mover aba **por comando**
não é "só uma tool": precisa de comando novo na extensão (a allowlist em `relayConnection.ts:41-47` não tem
`chrome.tabs.group`), roteamento no `background.ts`, regra de dono (hoje aba movida vira "do usuário",
`connectedTabGroup.ts:190-191`), cuidado com a conexão de origem se fechar quando perde a última aba
(`relayConnection.ts:172-175`) e teste manual (suíte da extensão não roda no Windows). Arrastar à mão já funciona.

**(c) Id estável de aba + parâmetro `tab` opcional em toda tool** (num ponto só, `defineTabTool`), com snapshot da
aba onde a ação ocorreu. Torna "escolher a aba e agir" atômico; a ideia (a) pode ser montada em cima. Patch só do
fork: o upstream recusou (`#39703`, pavelfeldman: "Give it two browsers").

## Decisões técnicas

> Continuado em 03/10/2026 por [2026-10-03-melhoria-abas-por-agente.md](2026-10-03-melhoria-abas-por-agente.md):
> o Gabriel pediu isolamento de verdade; os níveis 1 e 2 abaixo foram superados (servidor inline medido e descartado;
> carimbo por hook + roteador no processo). O nível 0 vale até a Fase 2 de lá fechar.

- **Nível 0 agora, sem código** (quem: opus 5.5 com advisor; confiança alta; reverte apagando a regra): numa sessão
  humana, **um único dono do browser por vez**; subagente que não é o dono recebe URL/conteúdo pronto e não chama
  `mcp__playwright__*`; subagente nunca chama `browser_close` nem `browser_set_group_label`. Registrado em
  `C:\Dev\cerebro\temas\playwright-mcp.md` § Subagentes dividem o browser da sessão.
- **Nível 1 só se o Gabriel precisar de subagentes navegando em paralelo**: agente `~/.claude/agents/navegador.md`
  com servidor playwright **inline**, nome diferente de `playwright` (evita colidir em `mcp__playwright__*`), mesmo
  wrapper, token por `${PLAYWRIGHT_MCP_EXTENSION_TOKEN}` se a expansão de env valer ali (não colar token em mais um
  arquivo). Antes, responder as perguntas 2, 3, 9 e 10 abaixo. Reverte apagando o arquivo.
- **Nível 2 só se o paralelismo na mesma conexão virar uso real e o nível 1 não bastar**: patch 6 no fork (id de
  aba + `tab`, dono/compartilhada por cima, `close` restrito ao dono). Mover aba por comando por último.
- **Próximo passo barato no fork, proposto e não feito**: corrigir a descrição de `browser_close` no estilo do
  patch 5 ("fecha a conexão inteira e todas as abas do agente"). Não feito nesta sessão porque exige build, stamp e
  `ctest-mcp` num checkout de onde outras sessões rodam o servidor.

## Descartado e impraticável

- Sublista dentro do grupo de abas do Chrome: grupo não aninha e aba não fica em duas conexões (decisor: código do
  Chrome/extensão).
- `--isolated` como isolamento por agente: tem precedência sobre `--extension` (`mcp/browserFactory.ts:72-77`) e
  tira o agente do Chrome do Gabriel.
- Modo HTTP (`--port`) sozinho: subagentes continuam na conexão da mãe [doc]; só valeria com servidor inline `http`
  por subagente, não testado, e sem teste upstream de HTTP + extensão.
- Mutex em `callTool` sozinho: não cobre o par `select` + ação (duas chamadas) e serializa subagentes lentos.

## Comunicação entre agentes

- `SendMessage` / `ListAgents`: texto entre subagente nomeado, teammate e outras sessões locais. Mensagem de subagente
  sai em nome da sessão-mãe e a resposta cai na mãe; sessão na nuvem recebe e não responde; mensagem entre uma ponta
  em bypass e outra pedindo permissão pode ficar retida. A casa nunca documentou esse canal.
- Agentes de um **mesmo Workflow não se enxergam** (`ListAgents` dentro do Workflow mostra só `main` e outras
  sessões [medido]): entre eles tudo passa pelo valor de retorno, que o script repassa.
- Central: `mcp__central__conversa` só lê o que outra sessão faz; cards + sinais `[[FEITO]]`/`[[DECISAO]]`/… são
  caixa postal assíncrona com volta (`card.resposta`); fragmentos com `sid8` para arquivo compartilhado.
- `CLAUDE_CODE_TASK_LIST_ID` dá lista de tarefas comum a sessões comuns [doc]; agent teams estão desligados aqui e o
  modo split-pane não funciona no Windows Terminal [doc].
- **O que resolve o caso das abas**: mensagem carrega intenção ("usa a aba X"), mas hoje não existe aba X estável
  (índice anda). Sem id de aba (nível 2) ou servidor por subagente (nível 1), comunicação não conserta o ponteiro
  compartilhado; a coordenação que funciona é estrutural: o orquestrador define o dono do browser.

## Perguntas que só teste real responde

1. O Claude Code manda id do subagente no `_meta` do `tools/call`? (logar `_meta` em `browserBackend.ts:89`). Se sim,
   posse de aba deixa de ser palavra de honra.
2. Duas instâncias simultâneas do mesmo subagente com servidor inline sobem um processo cada?
3. Servidor inline chamado `playwright` colide com o da mãe em `mcp__playwright__*`?
4. Hook `PreToolUse` com `updatedInput` vale em tool MCP e dispara dentro de agente de Workflow? (injetaria `_meta`).
5. Teammate in-process de agent team usa a conexão do líder?
6. Ref `eN` velha acerta o elemento errado em outra aba, como o código sugere?
7. Agente de Workflow consegue `SendMessage` para `main` e receber resposta antes de terminar?
8. Servidor inline aceita `type: http` apontando para servidor `--port` com extensão?
9. Com 3–5 subagentes conectando juntos (sementes, foco, `.build-lock`), o Chrome continua usável? (upstream #42973).
10. **Para o Gabriel:** ele roda de fato subagentes navegando em sessão humana? Zero incidente registrado; a resposta
    decide se vale sair do nível 0.
