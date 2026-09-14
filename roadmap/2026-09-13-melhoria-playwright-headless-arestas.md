# Roadmap de melhoria — arestas do Playwright MCP em sessão headless (2026-09-13)

**Alvo:** fork `C:\Dev\playwright` (tool `browser_set_group_label` + wrapper
`scripts/run-mcp-server.cjs`) e a config `mcpServers.playwright` do
`~/.claude.json`.
**Status:** pronto para execução (Fases 1–3, nesta ordem).
**Dono da decisão:** fable (tudo aqui é técnico e reversível).

## Contexto e motivação

A central (`C:\Dev\central`) abre sessões headless do Claude Code pelo maestro.
Desde 21/08/2026 elas não usam a extensão do Chrome: o wrapper
`scripts/run-mcp-server.cjs` vê `CENTRAL_ORIGEM=ia:*` e troca o argv para
`--browser chromium --isolated --headless`. Antes disso, a primeira tool call
ficava muda por 1800 s e derrubava a rodada do maestro junto (duas perdidas na
madrugada de 21/08 — `central/ARMADILHAS.md` § 62).

**A migração funcionou.** Medição de 13/09/2026 sobre os transcripts locais
(`~/.claude/projects/**/*.jsonl`, janela 21/08→13/09):

| o que | número |
| --- | --- |
| sessões headless com uso de browser | 58 (51 confirmadas em chromium isolado) |
| chamadas `mcp__playwright__*` | 1.605 |
| falhas de conexão/timeout | 16 (1,0%) |
| travas de 1800 s depois do wrapper | 0 |

Sobraram duas arestas — nenhuma derruba rodada, as duas queimam trabalho:

1. **`browser_set_group_label` erra 1× por sessão headless.** É a tool que o
   `CLAUDE.md` global manda chamar primeiro (ordem anti-aba-fantasma), e no
   modo chromium ela lança `only works when connected via --extension`. Toda
   sessão headless gasta uma tool call num erro certo, e o texto do erro entra
   no contexto como se algo tivesse dado errado.
2. **`timeout: 30000` no servidor MCP aborta trabalho legítimo.** As 16 falhas
   medidas são todas `evaluate`/`run_code_unsafe`/`navigate`/`snapshot`
   passando de 30 s — nenhuma é desconexão.

### O que ler antes de começar

- `C:\Dev\cerebro\temas\playwright-mcp.md` — dono do "como" do MCP Playwright
  (cofre de tokens, aba fantasma, o modo chromium de sessão IA).
- `C:\Dev\central\ARMADILHAS.md` § 62 — o incidente que criou o modo chromium.
- `C:\Dev\roadmap\2026-08-21-playwright-chromium-sessoes-ia.md` — a decisão do
  wrapper (fechada em 03/09).
- `C:\Dev\playwright\CLAUDE.md` § *This fork* — o que este fork mudou e o que
  sai antes de um PR upstream.
- `C:\Dev\cerebro\projetos\playwright.md` — hub do projeto, pendências abertas.

## O que o pedido não dizia

**Feito** (técnico, reversível — virou passo marcado `+` abaixo):

- `+` **Medir a distribuição de duração antes de escolher o teto novo.** O
  pedido dizia "sobe o timeout"; sem dado, o número seria chute
  (`falacia-da-previsao`). Medido: p50 1,3 s · p95 18,6 s · p99 43,6 s ·
  p99,9 120,2 s sobre 3.750 chamadas bem-sucedidas em 30 dias.
- `+` **Passo de build obrigatório na Fase 1.** Editar
  `packages/playwright-core/src/**` deixa o fork *stale* para o wrapper, que
  então lança o `npx @playwright/mcp` oficial — **sem** as tools do fork
  (multi-conexão, `browser_set_group_label`). Sem este passo, a melhoria
  degrada toda sessão nova até o build de fundo terminar.
- `+` **Atualizar o teste que afirma o contrário.**
  `tests/mcp/group-label.spec.ts` hoje exige `isError` no caminho sem
  extensão; ele é o guarda da mudança, não um detalhe.
- `+` **Corrigir as duas docs que passam a mentir**: `playwright-mcp.md`
  (§ sessão aberta por IA) e `central/ARMADILHAS.md` § 62 — as duas afirmam,
  hoje, que a tool "falha na hora com erro claro".

**Proposto:** nada. Nenhuma decisão de negócio ou de dinheiro toca este alvo.

**Descartado** (detalhe em *O que NÃO fazer*): esconder a tool do schema fora
do modo extensão; criar flag nova no wrapper; mexer no timeout do maestro.

## Alvo e estado atual

- **`packages/playwright-core/src/tools/backend/groupLabel.ts`** (44 linhas) —
  define `browser_set_group_label`. O `handle` pega
  `context.extensionRelay()` e, sem relay, lança `Error`. A descrição da
  schema termina em *"Only has an effect when connected via --extension;
  errors otherwise."*
- **`scripts/run-mcp-server.cjs`** — `argvForAiSession()` troca o argv quando
  `CENTRAL_ORIGEM` começa com `ia:`; decide entre build local do fork e `npx`
  pelo `scripts/.build-stamp` contra o mtime de `packages/playwright-core/src`.
  Hoje o fork está **fresco** (stamp e src empatados em 18/07/2026 16:57).
- **`~/.claude.json` → `mcpServers.playwright`** — `command: node`,
  `args: [.../run-mcp-server.cjs, --extension, --browser, chrome]`,
  **`timeout: 30000`**, e o cofre de tokens da extensão em `env`.
- **Testes existentes:** `tests/mcp/group-label.spec.ts` (sem extensão, 2
  casos) e `tests/extension/group-label.spec.ts` (com extensão).

## Diagnóstico

### O que está bom (não mexer)

- **A detecção de sessão IA no wrapper.** 51 sessões headless em chromium,
  zero trava de handshake desde 21/08. `argvForAiSession` é idempotente e
  testada; o ponto único de spawn mantém o `~/.claude.json` intocado.
- **`--isolated`.** Sessões headless concorrentes com perfil persistente
  colidiriam no ProcessSingleton do chromium. Não remover.
- **A ordem `set_group_label` → `navigate`** da regra global: existe por causa
  do bug da aba fantasma no modo extensão (6/6 reproduzido em 17/07) e segue
  valendo para sessão humana.

### O que está frágil ou custando

| # | achado | evidência | status |
| --- | --- | --- | --- |
| 1 | `set_group_label` erra 1×/sessão headless | 51 sessões em chromium, uma falha cada, sempre `only works when connected via --extension` | **medido** (transcripts, 21/08→13/09) |
| 2 | teto de 30 s aborta trabalho legítimo | 20 chamadas abortadas em 30 dias: 16 no teto de 30 s, 2 no antigo de 1800 s, 1 em 32 s, 1 em 79 s | **medido** |
| 3 | o teto morde onde o trabalho é real | das abortadas: `evaluate` 9 · `run_code_unsafe` 4 · `navigate` 3 · `wait_for` 1 · `snapshot` 1 | **medido** |
| 4 | 1,6% do tráfego bem-sucedido passa de 30 s | 60 de 3.750 chamadas; acima de 120 s são só 18 (0,48%), todas humanas e anteriores a 20/08 | **medido** |
| 5 | duas docs afirmam o comportamento que a Fase 1 muda | `playwright-mcp.md` § sessão IA; `central/ARMADILHAS.md` § 62 (linhas ~1500) | **medido** |
| 6 | editar `src/` sem buildar degrada toda sessão nova | regra `isForkStale()` do wrapper: cai no `npx` oficial, que não tem as tools do fork | **medido** (leitura do wrapper) |

## Roadmap

### Fase 1 — `browser_set_group_label` vira no-op fora do modo extensão

1. [x] **Trocar o `throw` por resposta de sucesso** em
   `packages/playwright-core/src/tools/backend/groupLabel.ts`, no `handle`:
   sem `relay`, responder com `response.addTextResult(...)` dizendo que não há
   grupo de abas neste modo e que a sessão pode seguir — e **retornar**.
   — **prova:** `grep -n "extensionRelay" -A 4 …/groupLabel.ts` → nenhum
   `throw` no ramo sem modo extensão. `+` **Bifurcado na revisão:** com
   `config.extension` verdadeiro e sem relay, continua erro (ver passo 7).
2. [x] **Alinhar a descrição da schema** na mesma tool: trocar
   *"errors otherwise"* por *"no-op otherwise"*, para o agente não ler que vai
   quebrar.
   — **prova:** `grep -c "errors otherwise" …/groupLabel.ts` → `0`; o bundle
   construído (`lib/coreBundle.js`) já carrega `a harmless no-op otherwise`.
3. [x] **Atualizar `tests/mcp/group-label.spec.ts`**: o caso
   `errors when not connected via --extension` vira
   `no-ops when not running with --extension` — espera resposta **sem**
   `isError`, com texto citando `--extension`. O caso do label vazio (erro de
   schema) fica como está.
   — **prova:** `npm run ctest-mcp group-label` → **3 passed** (o terceiro veio
   da revisão, passo 7). `+` A checagem de `isError` é feita na resposta crua:
   `toHaveResponse()` apaga toda chave que o objeto esperado não menciona, então
   `{result: …}` sozinho **nunca** falharia por erro.
4. [x] **Rebuildar o fork e atualizar o stamp**, no mesmo passo da edição
   (achado 6): `node scripts/background-build.cjs` (roda `npm run build` e
   escreve `scripts/.build-stamp`).
   — **prova:** src 22:48:08 · stamp 22:48:11 → não-stale (rodado de novo após
   as correções da revisão).
5. [x] **Prova de ponta a ponta, no modo que importa:** subir o servidor com
   `CENTRAL_ORIGEM=ia:teste`, handshake MCP por stdio, chamar
   `browser_set_group_label` e conferir que volta **sem** `isError`; em
   seguida `browser_navigate` para `about:blank` respondendo normalmente.
   — **prova:** `<scratchpad>/prova-nolabel.cjs`, 3 cenários — saídas no
   relatório de execução.
6. [x] **Commitar por pathspec** (`groupLabel.ts` e o spec) na `main` local,
   sem push.
   — **prova:** `0fb1d48` com 4 arquivos (os dois do contrato + `context.ts` e
   o wrapper, ambos exigidos pela revisão) e nada além.
7. [x] `+` **Fechar o que a revisão adversarial derrubou** (passo que não
   existia no contrato; detalhe no relatório):
   - `context.ts` ganhou `extension?: boolean` em `ContextConfig`, e o no-op
     passou a valer só quando **não há modo extensão**; `--extension` pedido
     sem relay volta a ser erro — senão a mudança escondia dois bugs reais
     (`createConnection({extension:true})` e `--extension` perdido na
     precedência do `browserFactory`).
   - teste novo `errors when --extension was asked for but no relay arrived`,
     porque o ramo do erro não tinha nenhum teste: apagá-lo deixava a suíte
     inteira verde.
   - `scripts/run-mcp-server.cjs`: sessão `ia:*` também perde
     `PLAYWRIGHT_MCP_EXTENSION` do ambiente — a variável alimenta o mesmo
     `config.extension`, então sem isso bastava alguém exportá-la para o erro
     voltar em toda sessão headless.
   — **prova:** `<scratchpad>/unit-env.cjs` 6/6 e o cenário
   `ia-com-env-extension` da prova de ponta a ponta.

### Fase 2 — teto do MCP de 30 s para 120 s

1. [ ] **Backup do `~/.claude.json`** antes de tocar (arquivo vivo do harness,
   com o cofre de tokens): copiar para
   `<scratchpad>/claude.json.bak-2026-09-13`.
   — **prova:** backup existe com o mesmo tamanho do original.
2. [ ] **Trocar `mcpServers.playwright.timeout` de `30000` para `120000`.**
   O valor vem do p99,9 medido (120,2 s), não de chute: cobre 99,5% das
   chamadas bem-sucedidas e fica 15× abaixo do teto de 1800 s que derrubou
   rodada em 21/08.
   — **prova:** reler a chave → `120000`, com o JSON ainda parseável.
3. [ ] **Conferir que a mudança sobreviveu** ao processo do Claude Code, que
   reescreve o mesmo arquivo: reler a chave ao fim da sessão.
   — **prova:** segunda leitura, ≥ 5 min depois da primeira, ainda `120000`.
   Se voltou a `30000`, aplicar de novo com o app fechado e anotar a corrida
   em `central/ARMADILHAS.md`.
4. [ ] **Registrar que o efeito só vale para sessão nova** (o servidor MCP lê
   a config no start): uma linha no relatório de execução e na doc da Fase 3,
   para ninguém medir na sessão errada.
   — **prova:** a linha existe nos dois lugares.

### Fase 3 — docs que passariam a mentir

1. [ ] **`C:\Dev\cerebro\temas\playwright-mcp.md`** § *Sessão aberta por IA*:
   a frase sobre `browser_set_group_label` falhar "na hora com erro claro"
   vira o comportamento novo (no-op com aviso), com a data.
   — **prova:** `grep -n "no-op" cerebro/temas/playwright-mcp.md` → 1+ linha.
2. [ ] **`C:\Dev\central\ARMADILHAS.md`** § 62 (linhas ~1500): mesma correção,
   por `Edit` ancorado — arquivo compartilhado entre sessões, nunca `Write`.
   — **prova:** `grep -n "no-op" central/ARMADILHAS.md` → 1+ linha na § 62.
3. [ ] **`C:\Dev\playwright\CLAUDE.md`** § *This fork* → *What changed*: uma
   linha sobre o no-op, junto das outras mudanças do fork (é o que sai do PR
   upstream, se um dia ele acontecer).
   — **prova:** `grep -n "no-op" CLAUDE.md` → 1 linha na seção do fork.
4. [ ] **Hub e diário:** `cerebro/projetos/playwright.md` ganha a linha do
   comportamento novo; o diário do dia
   (`cerebro/pessoal/diario/2026-09-13.md`) recebe o consolidado com os
   números medidos.
   — **prova:** os dois arquivos citam `2026-09-13` e o no-op.

## Priorização (impacto × esforço × risco)

| item | impacto | esforço | risco | veredito |
| --- | --- | --- | --- | --- |
| Fase 1 — no-op | médio: ~51 erros/mês a menos e some o ruído de "algo falhou" no contexto de toda sessão headless | baixo: 2 linhas de código, 1 teste, 1 build | baixo: só o ramo sem relay muda; extensão intocada | fazer primeiro |
| Fase 2 — teto 120 s | alto: 16 abortos/30 dias viram trabalho concluído, sem retrabalho do agente | mínimo: 1 chave | médio-baixo: trava real passa a custar 120 s em vez de 30 s | fazer |
| Fase 3 — docs | médio: doc desatualizada é armadilha nova (regra da casa) | baixo | nenhum | fazer ao fechar |

## O que NÃO fazer

- **Esconder a tool do schema quando não há extensão.** Some o erro, mas cria
  divergência de superfície entre sessão humana e headless (mesma versão do
  servidor, lista de tools diferente), quebra a regra do `CLAUDE.md` global que
  manda chamá-la primeiro e é mais difícil de testar. O no-op resolve o mesmo
  sintoma sem bifurcar o contrato.
- **Criar flag nova no wrapper** (`--no-group-label` e afins). O wrapper já
  sabe o modo pelo argv; flag nova é superfície a manter sem ganho
  (`via-negativa`).
- **Mexer no timeout de 1800 s do maestro** (`maestro.py`). É o deadline da
  rodada inteira e não tem relação com o teto por tool call.
- **Voltar a extensão para sessão headless.** Foi exatamente o que derrubou
  duas rodadas em 21/08.
- **Reescrever `~/.claude.json` inteiro** por conveniência: é o arquivo vivo do
  harness, com o cofre de tokens; mexer só na chave, com backup.

## Riscos e pré-requisitos

- **Corrida no `~/.claude.json`.** O processo do Claude Code reescreve o
  arquivo (histórico de sessões). A Fase 2 tem passo explícito de reconferir a
  chave depois; se a corrida se provar real, o plano B é exportar
  `MCP_TOOL_TIMEOUT` no `_env_limpo` do maestro — resolve a sessão headless,
  que é onde dói, e fica versionado no repo da central.
- **Teto maior atrasa a detecção de trava real.** Se uma chamada pendurar de
  verdade, o custo sobe de 30 s para 120 s. Aceito: 120 s é 6,7% do deadline
  de 1800 s da rodada, e o modo chromium não depende de ninguém conectar.
  Sintoma a vigiar: abortos em 120 s aparecendo em série.
- **Janela de build.** Entre editar `src/` e o build terminar, sessão nova cai
  no `npx` oficial sem as tools do fork. Por isso o build é passo da Fase 1 e
  não "depois"; não deixar a fase pela metade.
- **O maestro precisa estar pausado** durante a execução (regra da casa para
  quem commita): `python C:\Dev\central\tools\janela.py abrir` antes,
  `fechar` ao fim — religa quem pausou.
- **Conceitos do acervo aplicados:** `falacia-da-previsao` (o teto novo saiu de
  3.750 chamadas medidas, não de estimativa) e `via-negativa` (duas soluções
  que *adicionavam* superfície — tool condicional e flag no wrapper — foram
  descartadas em favor de mudar um ramo que já existe).

## Decisões tomadas pelo fable

| decisão | motivo | confiança | o que reverteria |
| --- | --- | --- | --- |
| No-op em vez de esconder a tool | mantém a mesma lista de tools nos dois modos e não conflita com a regra global de chamá-la primeiro | alta | agente headless passar a chamar a tool repetidamente por achar que "funcionou" |
| Teto em 120 s (não 60 s) | 60 s deixaria ~30 chamadas/30 dias estourando; 120 s cobre até o p99,9 medido | alta | série de abortos em 120 s, que indicaria trava real e não lentidão |
| Editar a chave no `~/.claude.json` em vez de `MCP_TOOL_TIMEOUT` no maestro | uma chave cobre sessão humana e headless; o env do maestro só cobriria headless | média | a corrida de escrita do arquivo se confirmar |
| Roadmap no `playwright/`, não na central | o alvo principal é o fork; a central só entra pela doc | alta | — |
| **(execução)** o gatilho do no-op é `config.extension`, não a ausência de relay | sem isso o no-op mente em duas configurações erradas reais e apaga o único detector delas | alta | aparecer caminho legítimo em que `config.extension` é true e a ausência de relay é esperada |
| **(execução)** o wrapper também limpa `PLAYWRIGHT_MCP_EXTENSION` na sessão `ia:*` | a variável alimenta o mesmo `config.extension` que agora decide erro × no-op; limpar só a argv deixaria a porta aberta | alta | alguém precisar de extensão numa sessão marcada `ia:*` (hoje impossível: não há quem conecte) |
| **(execução)** não criar teste que suba modo extensão de verdade | a suíte de extensão só roda no CI macOS (`CLAUDE.md` do fork); o ramo do erro é coberto com `--extension --isolated`, que não abre Chrome | média | o CI passar a ter extensão real disponível |

---

## Relatório de execução — Fase 1 (2026-09-13, sessão 06d057b1)

**Resultado:** fase fechada, commit `0fb1d48`. Maestro pausado durante toda a
execução (`janela.py abrir`, holder `janela:06d057b1`).

### Por passo, com a saída das provas

| passo | prova rodada | saída |
| --- | --- | --- |
| 1–2 no-op + descrição | `git diff --staged`, `grep` | `throw` só no ramo `config.extension`; `errors otherwise` → `a harmless no-op otherwise` |
| 3 teste | `npm run ctest-mcp group-label` | `3 passed (7.9s)` — `no-ops when not running with --extension`, `errors when --extension was asked for but no relay arrived`, `requires a non-empty label` |
| 4 build | stamp × mtime de `packages/playwright-core/src` | src `22:48:08` · stamp `22:48:11` → não-stale; `lib/coreBundle.js` com as strings novas |
| 5 ponta a ponta | `node prova-nolabel.cjs --modo=…` (servidor real por stdio) | `ia`: `isError:false`, "No tab group to label: this session is not running with --extension…" (1,0 s) · `ext-sem-relay`: `isError:true`, "…no extension relay is connected to this session" (0,3 s) · `ia-com-env-extension`: `isError:false` (0,9 s). `browser_navigate about:blank` OK nos três (0,2–0,3 s) |
| 7 correções da revisão | `node unit-env.cjs` | `6/6` (ia limpa a variável e preserva o cofre de tokens; humano e sem-marca preservam; `argvForAiSession` intacta) |
| lint | `npm run flint` | eslint, tsc, test-types, lint-tests, lint-packages, code-snippets **verdes**; reprova só em `doc` (Firefox não instalado nesta máquina) e `check-deps` (imports em `types/*.d.ts` e `html-reporter`) — **pré-existentes**, não citam nenhum arquivo tocado |

Baseline antes da mudança, no mesmo script: `set_group_label` → `isError:true`
em 838 ms. É a única diferença medida no comportamento da sessão headless.

### Revisão adversarial (subagente com contexto zero, 2 rodadas)

Rodada 1 — 4 achados, 3 acatados e corrigidos dentro da fase:

1. **[alto] o teste não podia falhar por `isError`.** `toHaveResponse()`
   (`tests/mcp/fixtures.ts:246-264`) apaga toda chave ausente do objeto
   esperado **antes** da guarda de erro; com `{result: …}` a guarda morre. Uma
   unhandled rejection drenada em `browserBackend.ts:86-88` entraria como
   `isError: true` com o teste verde. → checagem no objeto cru.
2. **[médio] o silêncio escondia bug de fiação.**
   `tools/mcp/index.ts:42` cria o `BrowserBackend` **sem** relay mesmo com
   `extension: true` — extensão conectada de verdade, `extensionRelay()`
   indefinido, e o no-op responderia "não está em modo extensão", falso.
3. **[médio-baixo] `--extension` perdido na precedência.**
   `browserFactory.ts:59-77` deixa `cdpEndpoint`/`isolated` ganharem de
   `extension` sem avisar; o erro da tool era o único detector.
4. **[baixo] doc contradiz o código** (`CLAUDE.md` do fork) → é a Fase 3.

Rodada 2 (sobre as correções) — confirmou o fechamento de 1–3, verificou que
`config.extension` chega nos dois caminhos que alcançam a tool, e trouxe 2
achados novos, os dois acatados: o ramo do erro **não tinha teste** (apagá-lo
deixaria a suíte verde) e `PLAYWRIGHT_MCP_EXTENSION` no ambiente reabria o
problema por fora da argv.

### completei:

- **prova em 3 cenários, não 1** — o contrato pedia só o caminho da sessão de
  IA; sem `ext-sem-relay` e `ia-com-env-extension` as duas regressões que a
  revisão apontou não teriam prova executável.
- **`context.ts` + teste do ramo do erro + saneamento do env no wrapper** —
  passos 7 acima; entraram porque a mudança do contrato, sozinha, apagava
  detectores de configuração errada.
- **unit do `envForAiSession`** (`<scratchpad>/unit-env.cjs`) — o wrapper não
  tem suíte versionada; o unit de 21/08 foi ad-hoc e se perdeu. Mantido no
  scratchpad, com o mesmo alcance do anterior.

### Arquivos tocados

`packages/playwright-core/src/tools/backend/groupLabel.ts` ·
`packages/playwright-core/src/tools/backend/context.ts` ·
`tests/mcp/group-label.spec.ts` · `scripts/run-mcp-server.cjs` · este md.

Ficaram **fora** do commit, por serem de outra frente: `.gitignore` (03/08) e
`CLAUDE.md` (bloco do modo chromium, escrito em 21/08 e nunca commitado — o
commit `88dc327` levou o código e esqueceu a doc). O `CLAUDE.md` entra na
Fase 3, junto da correção da frase que esta fase tornou falsa.

### Pendências e decisões pendentes

Nenhuma. As decisões técnicas da execução estão em *Decisões tomadas pelo
fable*.
