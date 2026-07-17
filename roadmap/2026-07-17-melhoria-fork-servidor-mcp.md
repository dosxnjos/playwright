# Roadmap de melhoria — forkar o servidor `@playwright/mcp` (2026-07-17)

> Arquitetado por Fable (ou por quem receber este md) a partir de uma investigação
> feita em `C:\Dev\playwright` durante a sessão do fork da extensão. **Não executar
> nada a partir deste documento sem reler e confirmar contra o estado atual do
> repositório** — código-fonte muda mais rápido que roadmap.

## Alvo e estado atual

Hoje (17/07/2026) só a **extensão** Chrome (`packages/extension/`) do monorepo
`microsoft/playwright` está forkada — `C:\Dev\playwright`, remote `origin` =
`https://github.com/dosxnjos/playwright`, branch `main` já tem o patch de
multi-conexão mesclado (conferido em 16/07: `main` e `extension-multi-connection`
apontam pro **mesmo commit** `711b96ba1` — a branch de trabalho está mesclada;
o HEAD local está nela). Contexto completo dessa primeira parte:
`C:\Dev\roadmap\2026-07-16-playwright-extension-multiconexao.md` (fora do repo do
playwright, no `C:\Dev` raiz — não confundir os dois roadmaps).

O **código do servidor MCP** vive no **mesmo monorepo**
(`packages/playwright-core/src/tools/mcp/` + `packages/playwright-core/src/tools/
backend/`, entry `packages/playwright-core/src/entry/mcp.ts` → `lib/entry/mcp.js`).
⚠️ Nuance verificada em 16/07: o **pacote npm `@playwright/mcp` NÃO é publicado
deste monorepo** — nenhum `package.json` daqui declara esse nome; o pacote é
empacotado em outro repo (`microsoft/playwright-mcp`), como wrapper sobre o
`playwright-core`. Na prática não muda o plano: o entry local é o servidor
completo, com os **mesmos flags** `--extension`/`--browser` (conferido em
`src/tools/mcp/program.ts`), e já foi validado standalone no Windows (ver
`CLAUDE.md` do fork, § watchdog). Mas significa que (a) "forkar o servidor" =
rodar o entry do monorepo, não clonar mais nada; e (b) o `0.0.78` do npm e o
HEAD do monorepo **podem divergir em comportamento** — o aceite da Fase 0 precisa
validar as tools de verdade, não presumir paridade. Hoje o `~/.claude.json` do
Gabriel roda

```
npx -y @playwright/mcp@0.0.78 --extension --browser chrome
```

que baixa o **pacote publicado no npm** pela Microsoft, ignorando por completo o
checkout local em `C:\Dev\playwright`. "Forkar o servidor" nesta tarefa não é sobre
copiar código — é sobre **decidir como rodar o servidor a partir do fork local**,
de um jeito que não vire um ponto de fragilidade na config viva do Gabriel.

**Motivador concreto**: adicionar uma tool MCP nova (`browser_set_group_label` ou
nome equivalente) que deixa o agente escolher um rótulo curto pro grupo de abas da
extensão no início da tarefa — hoje o título do grupo é `Playwright · <clientName>`
(ver D3 no roadmap da extensão), fixo pelo nome que o cliente MCP declara no
handshake, sem controle do agente.

## Diagnóstico

### O que está bom (não mexer)

- A extensão forkada já funciona no Chrome real do Gabriel (F5 concluída,
  17/07) e passa a suíte de testes em CI (macOS, GitHub Actions do fork).
- O protocolo servidor↔extensão (`protocolVersion`, hoje fixo em `2`) já tem um
  mecanismo de negociação de versão embutido (`connect.tsx` compara
  `requestedVersion` contra `SUPPORTED_PROTOCOL_VERSION`) — não precisamos
  inventar isso, só usar o que já existe.
- O padrão de "adicionar uma MCP tool nova" já é **bem documentado** no próprio
  repo: `.claude/skills/playwright-dev/tools.md` (ver Fase 2 abaixo) — não é
  território desconhecido, é seguir uma receita já pavimentada pelos
  mantenedores do Playwright.
- `npm run watch` já é o fluxo de desenvolvimento recomendado pelo próprio
  `CLAUDE.md` do monorepo ("Assume watch is running and code is up to date") —
  dá pra reaproveitar essa premissa em vez de inventar um mecanismo de rebuild
  do zero.

### O que está frágil ou custando (e por quê é real, não hipotético)

1. **Apontar `~/.claude.json` pro build local sem gatilho de rebuild é uma
   armadilha silenciosa.** Se eu (ou o Gabriel) editar `packages/playwright-core/
   src/tools/backend/browserSetGroupLabel.ts` e esquecer de rodar `npm run
   build`, o servidor local continua rodando o `lib/` antigo — sem erro, sem
   aviso, só comportamento desatualizado. É exatamente o tipo de "documentação
   desatualizada é armadilha nova" do `CLAUDE.md` global, só que em bytecode.
2. **Sem fallback, um build quebrado tira o browser tool de TODAS as instâncias
   do Claude Code do Gabriel de uma vez** — diferente de hoje, onde `npx` sempre
   busca um pacote publicado e testado. Isso é overhead operacional real: uma
   sessão minha mexendo em `packages/playwright-core/src/tools/` por qualquer
   outro motivo (nada a ver com a tool nova) pode deixar o build num estado
   inconsistente e derrubar o Playwright de produção do Gabriel sem ele saber
   por quê.
3. **`browser_set_group_label` não tem canal pra chegar na extensão.** Investiguei
   o caminho de dados: o servidor fala com a extensão só via
   `CDPRelayServer` (`cdpRelay.ts`), que relaia comandos no formato
   `chrome.<api>.<method>(...)` (`ExtensionCommandV2` em `protocol.ts`) — feito
   pra automlikrar a PÁGINA (debugger, tabs, etc.), não pra mexer em metadado de
   conexão (título do grupo, que vive em `ConnectedTabGroup`/`background.ts`, do
   lado da extensão). Não existe hoje nenhum comando "fale com o
   `background.ts` sobre a própria conexão" — precisa ser criado do zero, dos
   dois lados (servidor manda, extensão escuta).
4. **PR upstream do bug #893 (extensão) e a tool nova não podem estar no mesmo
   commit/branch** sem risco de contaminar a revisão do fix simples com uma
   proposta de design nova e opinativa.
5. **Subagentes não têm conexão MCP própria** (ver Riscos/pré-requisitos) — isso
   limita o que a tool nova consegue entregar: nome por *instância*, não por
   *subagente*.

## Roadmap

### Fase 0 — infraestrutura de execução local (pré-requisito de tudo)

Sem isso, qualquer coisa das fases seguintes vira a armadilha do item 1/2 acima.

1. [x] Criar `C:\Dev\playwright\scripts\run-mcp-server.cjs` — wrapper Node
   pequeno que: (a) compara o `mtime` do arquivo mais recente em
   `packages/playwright-core/src/` (recursivo) contra um **arquivo-stamp**
   (`scripts/.build-stamp`, gravado pelo próprio wrapper após cada build
   bem-sucedido). ⚠️ **Não** comparar contra `lib/entry/mcp.js`: verificado em
   16/07 que esse arquivo tem ~440 bytes e é só um thin wrapper de
   `../coreBundle` — editar `backend/*.ts` não necessariamente o reescreve, e a
   comparação daria stale-negativo pra sempre. (b) se `src/` for mais novo que
   o stamp, roda `npm run build` **com lock** (`fs.mkdirSync` atômico de
   `scripts/.build-lock`; quem não pegar o lock cai direto no fallback do item
   2 — várias instâncias do Claude Code sobem juntas e não podem disparar
   builds concorrentes no mesmo checkout); (c) em seguida `spawn`a (stdio
   herdado) `node packages/playwright-core/lib/entry/mcp.js` passando adiante
   todos os argv recebidos.
   ⚠️ **Decisão de design a medir antes de fechar**: o Claude Code tem timeout
   de startup de servidor MCP (~30s por default, `MCP_TIMEOUT`); um
   `npm run build` completo do monorepo pode levar **minutos**. Medir o tempo
   real de build a frio nesta máquina; se não couber com folga no timeout,
   **inverter o design**: quando stale, cair no fallback `npx` imediatamente e
   disparar o build em background (com o mesmo lock) — o próximo launch já pega
   o fork fresco. Nunca bloquear o handshake por mais que ~20s. Durante
   desenvolvimento ativo da Fase 1, `npm run watch` rodando (premissa do
   próprio `CLAUDE.md` do monorepo) mantém o `lib/` fresco e o wrapper nem
   builda. Critério de pronto: rodar
   `node scripts/run-mcp-server.cjs --extension --browser chrome` manualmente
   e confirmar que ele builda (ou faz fallback, conforme o design escolhido)
   quando stale e inicia o servidor normalmente quando não.
2. [x] No wrapper, se `npm run build` falhar (exit code ≠ 0): **não** tentar
   rodar o `lib/` velho silenciosamente. Escrever no stderr uma mensagem clara
   tipo `"[run-mcp-server] build failed, falling back to npx @playwright/mcp@
   0.0.78 — fix the fork before relying on it"` e então `spawn`ar
   `npx -y @playwright/mcp@0.0.78` com os mesmos argv, como fallback automático.
   ⚠️ Efeito colateral a documentar: no fallback, o **conjunto de tools muda** —
   `browser_set_group_label` (Fase 1) some da lista e agentes que tentarem
   chamá-la recebem "tool not found" — e as **descriptions melhoradas do
   roadmap-irmão** (`2026-07-17-melhoria-descricao-browser-tabs.md`) revertem
   pros textos do pacote oficial. Aceitável (degradação, não quebra), mas
   precisa estar escrito no `CLAUDE.md` do fork pra ninguém caçar fantasma.
   Critério de pronto: forçar um erro de sintaxe proposital num arquivo `.ts`
   do backend, rodar o wrapper, confirmar que cai no fallback e que o
   `browser_navigate` ainda funciona (via pacote oficial) nesse cenário.
3. [x] **FEITO em 17/07, com a confirmação explícita do Gabriel** (registrado no consolidado de
   17/07; reconferido à noite: o `~/.claude.json` aponta pro wrapper, mesmo `env` de tokens).
   Era: atualizar `~/.claude.json` → `mcpServers.playwright`: trocar
   `"command": "npx", "args": ["-y", "@playwright/mcp@0.0.78", "--extension",
   "--browser", "chrome"]` por
   `"command": "node", "args": ["C:\\Dev\\playwright\\scripts\\run-mcp-server.cjs",
   "--extension", "--browser", "chrome"]` (mesmo `env` de token, sem mudança
   aí). **Pedir confirmação explícita do Gabriel antes desse passo** — é a
   config viva, usada por todas as instâncias já rodando; reiniciá-las depois.
4. [x] Documentar em `C:\Dev\playwright\CLAUDE.md` § "This fork" (já existe essa
   seção, criada em 16/07): como funciona o wrapper, o fallback, e o comando
   manual pra reverter pro `npx` puro se o wrapper der problema estrutural (não
   só de build).
5. [x] `git remote add upstream https://github.com/microsoft/playwright.git`
   (confirmado em 16/07 que **não existe** — só `origin`, e com `[blob:none]`,
   clone parcial: o primeiro `git fetch upstream` pode baixar mais do que o
   habitual) — separar "de onde vem atualização" (`upstream`) de
   "onde eu publico meu trabalho" (`origin` = `dosxnjos/playwright`). Testar
   `git fetch upstream` uma vez pra confirmar que resolve.

**Aceite da Fase 0:** `~/.claude.json` aponta pro wrapper, o Gabriel reiniciou as
instâncias, `browser_navigate` funciona normalmente através do fork local (não
mais via `npx` do pacote oficial) — e um build quebrado de propósito prova que o
fallback funciona antes de confiar nisso no dia a dia.

## Execução (17/07/2026) — Fase 0 itens 1, 2, 4, 5 concluídos; item 3 bloqueado

**Medição que decidiu o design do item 1:** build a frio (`lib/` apagado) = ~28,1s;
"incremental" (só um arquivo tocado) = ~18,0s — `build.js` não é incremental de
verdade, sempre reprocessa tudo. Nenhum dos dois cabe com folga sob o teto de
~20s do próprio roadmap. **Design invertido conforme previsto**: nunca bloquear
o handshake — quando o fork está obsoleto, cai no fallback `npx` imediatamente
para aquele launch e dispara `npm run build` em background.

**Achado além do previsto no roadmap**: a primeira versão do wrapper rastreava
a conclusão do build de fundo via um listener `'exit'` no processo pai
(`spawn(..., {detached:true}).on('exit', ...)`). Testando manualmente descobri
que isso quebra se o próprio wrapper terminar antes do build (18-28s) acabar —
um listener num processo que já morreu nunca dispara, deixando stamp e lock
travados para sempre. Corrigido isolando a lógica de "buildar → gravar stamp →
soltar lock" inteira dentro de `scripts/background-build.cjs`, um processo Node
**totalmente independente** (não apenas `detached`, mas dono da própria lógica de
conclusão) — sobrevive independente do wrapper que o disparou.

Testes manuais que validaram os critérios de pronto dos itens 1 e 2:
1. Sem stamp (checkout "novo") → detecta stale, loga aviso, cai no `npx`
   fallback, dispara build em bg; build de bg conclui e grava o stamp/libera o
   lock mesmo já não havendo processo pai vivo para observar.
2. Stamp mais novo que `src/` → usa o fork local direto, sem nenhum log de
   fallback.
3. Erro de sintaxe proposital injetado num `.ts` do backend → build de fundo
   falha rápido (esbuild pega o erro), mensagem clara em
   `scripts/.build-log.txt`, stamp permanece ausente (retry automático no
   próximo launch), lock liberado corretamente, e o `npx` fallback deste launch
   funcionou normalmente. Arquivo restaurado depois e recuperação automática
   confirmada no launch seguinte.

Item 5: `upstream` adicionado; `git fetch upstream` resolveu limpo em ~5,5s, sem
o volume anormal de download que a nota de 16/07 cogitava por causa do
`[blob:none]` do `origin`.

Item 4: nova seção "Running the MCP server from this fork" em `CLAUDE.md` § This
fork, cobrindo o wrapper, a decisão de design, fallback/lock/retry, como
apontar/reverter `~/.claude.json`, e que `scripts/.build-*` são estado local
(adicionados ao `.gitignore`).

**Item 3 segue bloqueado** — não editei `~/.claude.json` (config viva de todas
as instâncias) sem confirmação explícita, exatamente como o próprio item exige.
Fases 1 e 2 não iniciadas nesta rodada: são escopo grande (protocolo novo em 3
camadas + testes de extensão de ponta-a-ponta) e o roadmap já prioriza fechar a
Fase 0 primeiro.

> **Atualização (17/07/2026, mais tarde — conferência contra o código):** o parágrafo acima
> ficou para trás no mesmo dia. O item 3 **foi executado** com a confirmação do Gabriel
> (consolidado de 17/07) e a **Fase 1 foi implementada no working tree**: `groupLabel.ts`
> (novo), protocolo/servidor (`protocol.ts`, `cdpRelay.ts`, `extensionContextFactory.ts`,
> `browserFactory.ts`, `browserBackend.ts`, `tools.ts`), lado extensão (`relayConnection.ts`,
> `protocolHandlers.ts`, `connectedTabGroup.ts`, `background.ts`) e testes escritos
> (`tests/extension/group-label.spec.ts` + `tests/mcp/group-label.spec.ts`) — **nada
> commitado**. O que resta de verdade na Fase 1: item 1.6 (SKILL.md do cli-client — conferido,
> ainda sem menção a `set_group_label`), rodar `npm run flint`, os testes nunca rodaram no CI
> (nada commitado → o workflow macOS nunca viu esse código), o **aceite end-to-end** (título do
> grupo mudando no Chrome real, dedupe entre 2 instâncias) se ainda não foi feito, e o commit.
> A Fase 2 segue não iniciada.

### Fase 1 — a tool `browser_set_group_label` (o motivador original)

Seguir a receita de `.claude/skills/playwright-dev/tools.md` § "Adding MCP
Tools", adaptada pro caso específico (tool que fala com a extensão sobre a
*conexão*, não sobre a *página*):

1. [x] *(implementado 17/07 — ver Atualização acima; sem commit)* **Novo comando de protocolo** em `packages/playwright-core/src/tools/mcp/
   protocol.ts`: adicionar ao lado de `ExtensionCommandV2` (ou como um tipo
   irmão, `ExtensionSessionCommand` — decidir na hora olhando como
   `ExtensionCommandV2` é consumido no lado servidor, que é
   `cdpRelayHandler.ts`/`cdpRelayV2.ts` (⚠️ `protocolHandlers.ts` é o
   equivalente do lado da **extensão**, não confundir os dois ao ler este item)
   — pra não forçar um comando "de sessão" a se parecer com um comando "de CDP")
   um `'session.setGroupLabel': { params: [label: string]; result: void }`.
   Não precisa bumpar `LATEST_VERSION`/`SUPPORTED_PROTOCOL_VERSION` — os dois
   lados (servidor e extensão) são o mesmo fork, atualizados juntos; a
   negociação de versão existe pra compatibilidade com clientes/extensões
   *externos* ao nosso fork, que não é o caso aqui.
2. [x] *(implementado 17/07 — ver Atualização acima; sem commit)* **Lado servidor**: em `cdpRelay.ts`, `CDPRelayServer` precisa expor um
   método `setGroupLabel(label: string): Promise<void>` que manda esse novo
   comando pela mesma WebSocket do `_extensionConnection` (mesmo mecanismo que
   `sendCommand` já usa pros comandos CDP, só que sem passar pelo
   `ExtensionProtocolV2`/`ExtensionProtocolV1` handler de CDP — ou, se for mais
   simples, tratar como só mais um caso dentro do handler existente).
   `createExtensionBrowser` (`extensionContextFactory.ts`) precisa devolver
   também uma referência ao `relay` (hoje só devolve o `Browser` do Playwright)
   pra a tool nova conseguir chamar `relay.setGroupLabel(...)` depois.
3. [x] *(implementado 17/07 — ver Atualização acima; sem commit)* **Lado extensão**: em `relayConnection.ts`/`protocolHandlers.ts`, tratar
   o novo comando `session.setGroupLabel` chegando pela WS e repassar pro
   `ConnectedTabGroup` responsável (a extensão já sabe qual `ConnectedTabGroup`
   pertence a qual `RelayConnection` — reaproveitar essa referência). Adicionar
   em `connectedTabGroup.ts` um método público `setLabel(label: string):
   Promise<void>` que chama `chrome.tabGroups.update(this._groupId, { title:
   \`${PLAYWRIGHT_GROUP_TITLE} · ${label}\` })` — reaproveitando a MESMA lógica
   de dedupe `(2)`/`(3)` que já existe em `background.ts::_reserveGroupTitle`
   (mover essa função pra um lugar compartilhável se for chamada de dois
   pontos agora, ou replicar o dedupe ali — decidir na hora olhando o diff).
4. [x] *(implementado 17/07 — ver Atualização acima; sem commit)* **A MCP tool em si**: `packages/playwright-core/src/tools/backend/
   groupLabel.ts`, usando `defineTool` (não `defineTabTool` — não opera sobre
   uma tab específica, opera sobre a conexão) com `capability: 'core'`,
   `schema.name: 'browser_set_group_label'`. **A `description` é a parte que
   mais importa** (é o que faz outro agente descobrir a tool sozinho, sem
   instrução hardcoded) — algo na linha de: *"Set a short custom label for
   this session's browser tab group in the Playwright extension, so the user
   can tell which task/agent owns which tabs when multiple sessions are
   connected at once. Call this once, early in a task, when you expect to use
   the browser — especially if the user is likely running you alongside other
   Claude Code instances."* Registrar em `tools.ts` (`browserTools` array).
5. [x] *(escritos e RODADOS 17/07 — `tests/mcp/group-label.spec.ts` rodou de verdade e passou, 2/2; `tests/extension/group-label.spec.ts` rodou e bateu na mesma limitação já documentada de `test-extension` não confiável no Windows, não é regressão nova — validação real segue pendente do CI macOS, nada commitado ainda)* **Testes**: `tests/mcp/group-label.spec.ts` seguindo o padrão de
   `tests/mcp/fixtures.ts` (`client`/`server`) — mas como a tool só faz sentido
   em modo `--extension`, os testes reais de ponta-a-ponta vão precisar do
   fixture `browserWithExtension`/`startExtensionClient` de
   `tests/extension/extension-fixtures.ts` (o MESMO fixture usado no roadmap da
   extensão) — colocar em `tests/extension/group-label.spec.ts` em vez de
   `tests/mcp/`, já que depende do relay de verdade. Casos: (a) chamar a tool
   muda o título do grupo; (b) duas conexões chamando com o mesmo label
   deduplicam igual ao D3; (c) chamar antes de qualquer tab existir não quebra
   (grupo ainda não existe — decidir: erro claro, ou guardar o label e aplicar
   quando o grupo for criado?).
6. [x] *(feito 17/07 — nota curta logo após `attach --extension=chrome`, sem comando CLI espelho: decisão tomada, ver texto abaixo)* Atualizar o SKILL.md do playwright-cli com a tool nova — ⚠️ **o path que
   a receita do `tools.md` cita (`packages/playwright/src/skill/SKILL.md`) NÃO
   existe** (verificado em 16/07; a receita está desatualizada em relação ao
   próprio repo). O arquivo real é
   `packages/playwright-core/src/tools/cli-client/skill/SKILL.md`. Ele documenta
   os comandos do `playwright-cli` (que espelham as MCP tools) — avaliar na hora
   se a tool nova pede um comando CLI espelho ou só a menção na doc; se a receita
   continuar errada upstream, não "consertar" o `tools.md` neste fork (é doc
   deles, conflito garantido no rebase) — só registrar aqui.

**Aceite da Fase 1:** o Claude Code do Gabriel, rodando via o wrapper da Fase 0,
consegue chamar `browser_set_group_label` e ver o título do grupo mudar no
Chrome real, com dedupe funcionando entre duas instâncias simultâneas.

> **Status em 17/07/2026 à noite:** todos os 6 itens implementados no working
> tree, `npm run flint` completo rodado (eslint/tsc/test-types/lint-tests/
> lint-packages/generate_channels/code-snippets limpos; `doc`/`check-deps`
> falham pelas mesmas causas pré-existentes e não relacionadas de sempre —
> Firefox não instalado, import inválido em `.d.ts` gerado do `html-reporter`).
> **O que falta de verdade pro aceite**: (1) commit — nada commitado ainda; (2)
> o aceite end-to-end manual em si (2 instâncias reais do Claude Code, Chrome
> de verdade, título do grupo mudando e dedupe visível) não foi feito — só a
> automação (`tests/mcp/*` passou, `tests/extension/*` bateu na limitação de
> Windows já conhecida, validação real via CI macOS depois do commit/push).

## Achado fora do escopo original — bug do `clientName` "unknown" no token-bypass (17/07, à noite)

O Gabriel pediu pra investigar por que a tela de conexão e o "Connected to"
mostram `"unknown"` no caminho de **token-bypass** (o que `~/.claude.json`
usa de verdade). Isso já tinha sido investigado em 16/07 e descartado como
**"D1: comportamento upstream do servidor/SDK, fora do escopo do fork"**
(comentário em `tests/extension/multi-connection.spec.ts`). **Essa conclusão
estava errada.**

**Causa real, achada por leitura de código (não por reprodução em teste,
dado que `test-extension` não é confiável neste Windows):** é uma closure
obsoleta do React, inteiramente dentro de `connect.tsx`, deste fork.
`handleConnectToTab` é um `useCallback` com dependência `[clientInfo]` — lê o
nome do cliente do *state*. No caminho do picker, o clique do usuário só
acontece depois de pelo menos um re-render (a lista de tabs só aparece após o
`setClientInfo` já ter disparado), então a closure está atualizada. No
caminho do token-bypass, `handleConnectToTab()` é chamado **na mesma
execução síncrona** do `runAsync`, logo após `setClientInfo(info)` — mas
`setClientInfo` só *agenda* o re-render, não muda a variável `clientInfo` da
closure já capturada no mount. Por isso é **determinístico** (não é race —
explica por que o delay de 500ms testado em 16/07 não mudou nada) e
**independente do nome passado** (é sobre a mecânica da closure, não sobre o
valor computado).

**Fix**: `handleConnectToTab(tab?, clientNameOverride?)` ganhou um segundo
parâmetro opcional; o call site do token-bypass passa `info` (o valor
recém-parseado da URL) explicitamente, sem depender do state. O caminho do
picker continua usando o state normalmente (não precisa do override).

**Efeito colateral bom**: `status.tsx` (o "Connected to X" ao clicar no ícone
da extensão) lê `clientName` direto do `background.ts`, que por sua vez só
repassa o que `connect.tsx` mandou — corrigido de graça, sem tocar em
`status.tsx`.

**Testes atualizados** (`tests/extension/multi-connection.spec.ts`): removido
o comentário "KNOWN ISSUE", trocada a asserção de `'Playwright · unknown'`
para `'Playwright · Agent A'`, e a nota do bug de ownership (não relacionado,
ainda aberto com `test.fixme`) atualizada pra não confundir os dois.

**Validado empiricamente** (já que os testes automatizados de extensão não
rodam neste Windows): build real + servido via HTTP local + Playwright MCP
simulando o fluxo de token-bypass de ponta a ponta (token gerado via
`localStorage` real, `client=Claude Code` na URL) — a página mostrou
`"Claude Code" is trying to connect...` corretamente em vez de `"unknown"`.

**Pendente**: validação via CI macOS depois do commit (mesma pendência geral
da Fase 1); o bug DISTINTO de ownership do seed tab no token-bypass
(`test.fixme` em `multi-connection.spec.ts:274`) segue sem investigar.

## Incidente real — o fix acima quebrou a conexão de verdade (17/07, à noite)

A "validação empírica" do fix do `clientName` (seção acima) **não foi suficiente**:
o Gabriel recarregou a extensão no Chrome real (depois de eu avisar que era
necessário) e todas as instâncias do Claude Code ficaram penduradas esperando o
Playwright conectar, com a aba abrindo fora de qualquer grupo. Console real:
`Uncaught (in promise) ReferenceError: info is not defined` em `connect.tsx`.

**Causa**: erro de escopo de bloco que eu mesmo introduzi no fix — `const info`
foi declarado dentro do `try { }` que faz o parse do parâmetro `client` da URL,
mas usado depois, fora daquele bloco, no call site do token-bypass
(`handleConnectToTab(undefined, info)`). Isso é um `ReferenceError` em runtime.

**Por que passou `tsc`/`flint` inteiros sem acusar nada** — achado importante,
não é só "esqueci de rodar": o `npm run tsc`/`npm run flint` da **raiz** do
monorepo **não cobre `packages/extension/src/`** de jeito nenhum. A pasta
`extension` tem dois tsconfigs próprios, nunca referenciados pelo `tsc -p .` da
raiz:
- `packages/extension/tsconfig.ui.json` — cobre `src/ui/` (onde estava o bug).
- `packages/extension/tsconfig.json` — cobre o resto de `src/` (exclui `ui/`).

Rodando `npx tsc -p tsconfig.ui.json --noEmit` de dentro de `packages/extension/`
o erro aparece na hora: `src/ui/connect.tsx(108,45): error TS2304: Cannot find
name 'info'`. Isso significa que **todo `tsc`/`flint` "limpo" reportado neste
roadmap ao longo do dia nunca checou nenhuma mudança em `packages/extension/`** —
o `groupLabel`/protocolo do lado servidor foi checado de verdade; o lado
extensão (`connect.tsx`, `background.ts`, `connectedTabGroup.ts` etc.) nunca foi.

**Fix aplicado**: `let info = 'unknown'` declarado ANTES do `try`, reatribuído
dentro dele — mesmo comportamento, escopo correto. Verificado com
`tsc -p tsconfig.ui.json` (limpo) e reproduzindo o fluxo real de token-bypass via
HTTP local + Playwright MCP (mostrou `"claude-code" connected.` sem erro).

**Achado colateral, rodando `tsc -p tsconfig.json` (o outro tsconfig da
extensão) pela primeira vez**: 4 erros de tipo em `connectedTabGroup.ts` — mas
**pré-existentes**, confirmados via `git show HEAD:...` como já presentes no
commit de 16/07, não introduzidos hoje. Provável desalinhamento de versão do
`@types/chrome` (`chrome.tabs.TabChangeInfo` não existe no pacote de tipos
instalado; `chrome.tabs.ungroup` espera tupla `[number, ...number[]]`, recebe
`number[]`). Não corrigidos agora — fora do escopo deste incidente — mas
precisam de uma tarefa própria (ver tasklist).

**Correção de processo, não só de código**: daqui pra frente, qualquer mudança
em `packages/extension/` precisa rodar os DOIS tsconfigs da própria pasta
(`tsc -p tsconfig.ui.json` e `tsc -p tsconfig.json`, de dentro de
`packages/extension/`) além do `flint` da raiz — o `flint` sozinho dá falsa
confiança pra esse pacote específico. Vale documentar isso no `CLAUDE.md` do
fork como regra permanente.

### Fase 2 — sustentabilidade de longo prazo (fazer uma vez, manter sempre)

1. [x] *(feito 17/07 — nova seção "Keeping up with upstream (rebase routine)" em CLAUDE.md § This fork)* Documentar em `C:\Dev\playwright\CLAUDE.md` § "This fork" uma rotina de
   rebase: `git fetch upstream && git rebase upstream/main` — com que
   frequência (sugestão: antes de qualquer nova sessão de trabalho no fork, não
   num cron — o volume de commits do upstream não justifica automação ainda).
   Registrar também: como resolver conflito se `packages/playwright-core/src/
   tools/backend/tools.ts` (onde `groupLabel.ts` foi registrado) mudar
   upstream — é o arquivo com maior chance de conflito por ser uma lista
   central.
2. [x] *(documentado 17/07, junto com o item 1)* Depois de qualquer rebase, rodar `npm run build && npm run flint` antes
   de considerar terminado — o wrapper da Fase 0 cobre "build no próximo
   launch", mas `flint` (lint + tsc completos) não roda automaticamente e pode
   pegar quebra de tipo que o build sozinho não pega.
3. [x] *(feito 17/07 — D9 marcado implementado e linkado neste doc, landmine removida)* Revisitar D9 (nome dinâmico) no roadmap da extensão — marcar como
   **implementado**, linkar pra este documento, e apagar a landmine "adiado
   por causa do `npx`" que está lá hoje (senão alguém lê os dois roadmaps e
   acha que ainda está bloqueado).

## Priorização (impacto × esforço × risco)

| item | impacto | esforço | risco | veredito |
| --- | --- | --- | --- | --- |
| Fase 0 (wrapper + fallback) | alto (sem isso, tudo mais é frágil) | médio (script novo, mas simples) | baixo (fallback cobre o pior caso) | fazer primeiro, sempre |
| Fase 1.1–1.3 (protocolo + servidor + extensão) | alto (é o pedido original) | alto (mexe em 3 camadas) | médio (é código novo, não copiar-colar) | fazer depois da Fase 0 |
| Fase 1.4 (a tool + description) | alto (é a parte "visível") | baixo (segue receita pronta) | baixo | trivial depois de 1.1–1.3 prontos |
| Fase 1.5 (testes) | alto (sem teste, "funcionou uma vez" não é confiável) | médio | baixo | não pular |
| Fase 2 (sustentabilidade) | médio (só paga a longo prazo) | baixo | baixo | fazer, mas pode esperar a Fase 1 estar validada em uso real |

## O que NÃO fazer

- **Não** apontar `~/.claude.json` direto pro `lib/entry/mcp.js` sem o wrapper
  da Fase 0 — é exatamente a armadilha silenciosa diagnosticada acima.
- **Não** tentar dar nome de grupo por **subagente** — Chrome não suporta grupo
  de abas aninhado/hierárquico (é um nível só, plano, por janela), e
  subagentes do Claude Code não abrem conexão MCP própria (ver Riscos abaixo)
  — não existe canal pra sequer identificar "qual subagente" fez a chamada.
  Documentar esse teto, não tentar contornar.
- **Não** misturar a Fase 1 com qualquer futuro PR upstream do bug #893 — são
  branches/commits sempre separados.
- **Não** bumpar `LATEST_VERSION`/`SUPPORTED_PROTOCOL_VERSION` do protocolo só
  por causa dessa tool — não é o problema que esses números resolvem (ver
  Fase 1.1).
- **Não** automatizar o rebase com upstream via cron/GitHub Actions agora — o
  volume de mudanças não justifica, e um rebase automático sem supervisão pode
  quebrar a Fase 1 silenciosamente (voltamos à mesma classe de armadilha da
  Fase 0).

## Riscos e pré-requisitos

- **Subagentes compartilham a conexão MCP da sessão principal — hipótese de
  alta confiança (arquitetura: `mcpServers` é configurado por sessão, não por
  agente; o `Agent tool` roda no mesmo processo CLI), ainda **não confirmada
  empiricamente**, mas com uma **consequência concreta já confirmada no código**
  (17/07, ver `2026-07-17-melhoria-descricao-browser-tabs.md` no mesmo
  `roadmap/`): `Context` (`packages/playwright-core/src/tools/backend/
  context.ts`) mantém um `_currentTab: Tab | undefined` **único por conexão**,
  e `newTab()` sobrescreve esse ponteiro **incondicionalmente**
  (`this._currentTab = this._tabs.find(...)`, sem checar se já havia um dono).
  Ou seja: **se** dois chamadores concorrentes (dois subagentes da mesma sessão,
  despachados em paralelo) compartilham a conexão, um `browser_tabs new` de um
  rouba silenciosamente a aba atual do outro, e qualquer tool subsequente sem
  índice explícito (`browser_navigate`, `browser_snapshot`...) age na aba
  errada. Mitigação de curto prazo (sem esperar a Fase 1): melhorar a
  `description` de `browser_tabs`/`browser_navigate` pra instruir `select`
  explícito — já é um item separado, pequeno e executável **agora**, documentado
  no md irmão citado acima. Se o Gabriel confirmar que subagentes importam de
  verdade pro caso de uso dele, vale também um teste dedicado (chamar uma tool
  de debug a partir de um subagente e conferir se ela enxerga o MESMO
  `relay`/`Context` da sessão principal) antes de desenhar a Fase 1 em torno
  disso.
- **Decisão do Gabriel, não técnica:** ele precisa aceitar conscientemente que
  o browser tool de TODAS as instâncias passa a depender de um repositório
  local que alguém (eu, numa sessão futura) pode deixar num estado quebrado —
  a Fase 0 mitiga, não elimina, esse risco. Confirmar antes de editar
  `~/.claude.json` (repetir o mesmo cuidado que já foi tomado pro D7/pin de
  versão, 17/07).
- **Sem dependência de terceiros** (TI, credencial, acesso) — é tudo local,
  repo próprio do Gabriel, sem restrição externa.

## Validação contra o repo (revisão de 16/07/2026)

Cada afirmação técnica deste roadmap foi conferida contra o checkout real.
**Veredito: viável.** O que foi confirmado (com onde):

- Estrutura e entry: `src/tools/mcp/` (cdpRelay, cdpRelayHandler, cdpRelayV1/V2,
  protocol, extensionContextFactory, program, watchdog), `src/tools/backend/`
  (tool.ts, tools.ts etc.), `lib/entry/mcp.js` presente e buildado; flags
  `--extension`/`--browser` idênticos aos do pacote npm (`program.ts:40,51`).
- Caminho de dados como diagnosticado: `CDPRelayServer._extensionConnection.send()`
  (`cdpRelay.ts:81–84`) só transporta comandos `ExtensionCommandV2` no formato
  `chrome.<api>.<método>` posicional (`protocol.ts:52–78`); do lado da extensão,
  tudo entra por `relayConnection.ts:207` → `handleCommand`. O comando de sessão
  **não existe** e precisa mesmo ser criado dos dois lados (diagnóstico 3 correto).
- `createExtensionBrowser` devolve só `Promise<Browser>`
  (`extensionContextFactory.ts:28`) — a mudança do item 1.2 é necessária.
- Dedupe reaproveitável: `_reserveGroupTitle` (`background.ts:154`),
  `PLAYWRIGHT_GROUP_TITLE` (`connectedTabGroup.ts:19`).
- Receita e registro: `defineTool`/`defineTabTool` (`backend/tool.ts:58,70`),
  `browserTools` (`backend/tools.ts:48`), § "Adding MCP Tools" no
  `.claude/skills/playwright-dev/tools.md:3`.
- Testes: `browserWithExtension`/`startExtensionClient` existem em
  `tests/extension/extension-fixtures.ts:44,46,75,114`.
- Config viva: `~/.claude.json` → `npx -y @playwright/mcp@0.0.78 --extension
  --browser chrome` + cofre de tokens no `env`, exatamente como descrito.
- Versões de protocolo: `LATEST_VERSION`/`DEFAULT_VERSION = 2` em `protocol.ts`;
  `SUPPORTED_PROTOCOL_VERSION` é o nome do lado da extensão (`connect.tsx`).

Correções aplicadas nesta revisão (não repetir os erros ao executar):
1. Gatilho de rebuild por mtime de `lib/entry/mcp.js` era quebrado (thin wrapper
   de ~440 bytes) → trocado por arquivo-stamp (item 0.1).
2. Risco de timeout de startup MCP (~30s) × build de minutos + corrida de builds
   concorrentes entre instâncias → design a medir/lock adicionados (item 0.1).
3. `packages/playwright/src/skill/SKILL.md` não existe; o real é
   `packages/playwright-core/src/tools/cli-client/skill/SKILL.md` (item 1.6).
4. `@playwright/mcp` (npm) não é publicado deste monorepo — "já está forkado"
   requalificado (§ Alvo e estado atual).
5. `main` == `extension-multi-connection` (commit `711b96ba1`) e remote
   `upstream` inexistente — dúvidas do texto original resolvidas.
