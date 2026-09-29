# Roadmap de melhoria — reconexão MCP e a "aba fantasma" (#41843) (2026-07-17)

Autocontido: um executor sem o contexto desta sessão consegue seguir daqui.
Complementa (não substitui) `roadmap/2026-07-17-situacao-para-fable.md`, que
narra o histórico do dia; este md é o plano de ação dali pra frente.

## Alvo e estado atual

Fork `dosxnjos/playwright` (`C:\Dev\playwright`), modo extensão do servidor MCP.
Sintoma ([microsoft/playwright#41843](https://github.com/microsoft/playwright/issues/41843)):
durante uso normal a conexão MCP às vezes cai e se restabelece sozinha (via token
de bypass), mas na reconexão, em vez de a aba do `connect.html` ser reaproveitada
e redirecionada ao site de destino, **abre-se uma segunda aba** com o site,
deixando o `connect.html` agrupado e inutilizado ("aba fantasma").

**Observação nova do Gabriel (17/07, após a instrumentação):** sempre que o bug
ocorre, é quando **não há nenhum grupo de abas do Playwright aberto** no browser
— ou seja, a extensão precisa criar o grupo do zero. (Não confirmado que ocorra
*toda* vez nessa condição, mas todas as ocorrências notadas foram nela.)
Suspeita dele: a criação do grupo em si. Leitura mecânica no diagnóstico abaixo.

Fluxo da reconexão (arquivos reais):

1. Queda → `server.ts` reseta `backendPromise`; a próxima tool call cria
   `BrowserBackend`/`Context` novos.
2. `establishExtensionConnection` (`packages/playwright-core/src/tools/mcp/cdpRelay.ts:120`)
   chama `_openConnectPageInBrowser` (spawn fire-and-forget do `chrome.exe` com a
   URL do `connect.html` — singleton do SO vira aba nova) e **aguarda**
   `_extensionConnectionPromise` + `handler.ready()`.
3. Extensão (token path): a própria aba do `connect.html` vira a semente —
   `attachTab(seed)` + `didInitialize()` (`packages/extension/src/connectedTabGroup.ts:107-108`),
   que viram `chrome.tabs.onCreated` + `extension.initialized` no WebSocket.
4. Relay: `extension.initialized` resolve `ready()`
   (`cdpRelayV2.ts:83-86`); `Target.setAutoAttach` → `BrowserModel.enableAutoAttach()`
   anexa cada aba conhecida (`browserModel.ts:124-128`).
5. `Context._initializeBrowserContext` (`backend/context.ts:341`) itera
   `browserContext.pages()` e assina o evento `page`; `ensureTab()`
   (`context.ts:198`) usa `_currentTab` ou cria aba nova via `newTab()`.

### Diagnóstico desta sessão (17/07, madrugada — análise de código, não confirmado ao vivo)

- **A hipótese do singleton do SO tem um furo**: o spawn fire-and-forget é
  absorvido pelos awaits do passo 2 — o servidor não avança até a extensão
  conectar. O singleton pode atrasar/impedir a aba de abrir, mas não reordena
  "semente anexada" vs. "primeira tool call".
- **Candidato mais forte — erro de attach engolido**: em
  `browserModel.ts:127` (`enableAutoAttach`) e `:86` (`onTabCreated`), a falha
  de `_attachTab` é engolida por `.catch(logUnhandledError)`. `_attachTab`
  (`browserModel.ts:191-213`) faz **dois round-trips** que podem falhar
  (`chrome.debugger.attach` e `Target.getTargetInfo`). Se o attach da semente
  falha, `Target.setAutoAttach` responde sucesso com **zero targets** →
  `pages()` vazio → `_currentTab` nunca setado → `ensureTab()` cria a segunda
  aba. **Reproduz o sintoma exatamente, sem violar nenhuma ordem** — por isso a
  varredura das 5 camadas (ver md de situação) não achou nada.
- **A falha é invisível hoje**: `logUnhandledError` loga no canal `debug`
  `pw:mcp:error` (`mcp/log.ts:18-22`), desligado por padrão.
- **Causa da queda em si (separada da aba dupla)**: o `keepalive` que segura o
  service worker MV3 vivo é enviado pela página de connect
  (`packages/extension/src/background.ts:115-118`); após conectar, essa página
  navega embora (token path) ou é removida (`background.ts:150-151`) — sessão
  MCP ociosa pode deixar o worker morrer (hipótese 3 do md de situação,
  plausível, não confirmada).
- **O que a observação "só quando não há grupos" significa** (17/07): todo
  reconnect cria um grupo novo para a própria conexão (`_groupId` nasce `null`
  em cada `ConnectedTabGroup`), então o discriminante real não é "esta conexão
  criou grupo" — é **"não havia nenhuma outra conexão ativa"**, e sem conexão
  ativa nada segura o service worker: a observação amarra o bug ao **cold start
  do worker** (reforça a hipótese 3 como condição necessária).
- **Sobre a suspeita "criação do grupo em si"**: no código, o attach vem
  **antes** do grupo — `_onTabAttached` só dispara após `chrome.debugger.attach`
  ter sucesso, e é ele que chama `_addTabToGroup`
  (`connectedTabGroup.ts:194-199`, `274-290`). Falha ao *criar* o grupo deixa a
  semente anexada porém desagrupada — isso sozinho **não** gera segunda aba.
  Para a criação do grupo causar o sintoma, ela teria que provocar um **detach
  do debugger** logo depois do attach: `chrome.debugger.onDetach` →
  `_detachTab` → `Target.detachedFromTarget` → Playwright fecha a página →
  `_onPageClosed` (`backend/context.ts:272-280`) deixa `_currentTab` undefined
  (era a única aba) → `ensureTab()` cria a segunda. **Mecanismo (b)**, agora na
  mesa ao lado do (a) attach engolido — os dois são distinguíveis na timeline
  do `.mcp-debug-log.txt` já instalado.

## Diagnóstico por eixos

### O que está bom (não mexer)

- Ordenação do handshake nas 5 camadas (extensão → relay → CRBrowser → Context
  → BrowserBackend) está correta — verificada duas vezes (sessão anterior e esta).
- O wrapper `scripts/run-mcp-server.cjs` (nunca bloquear o handshake, fallback
  npx, lock atômico) está sólido — a Fase 1 **acrescenta** a ele, não o refaz.
- A reconexão em si **sempre funciona** (via token) — o defeito é só o destino
  da primeira navegação.

### O que está frágil ou custando

- **Falha silenciosa** (estabilidade): attach da semente pode falhar sem deixar
  rastro nenhum (canal debug desligado + catch engolindo). Sintoma: aba
  fantasma "às vezes", sem log.
- **Observabilidade zero** (manutenibilidade): o stderr do servidor MCP não é
  persistido em lugar nenhum nesta máquina — qualquer diagnóstico futuro exige
  reproduzir ao vivo, o que hoje é inviável (grupo de abas ativo do Gabriel que
  não pode ser tocado).
- **`setAutoAttach` responde sucesso com modelo vazio** (robustez/boas
  práticas): mesmo com N abas conhecidas e 0 anexadas, o relay não distingue
  "browser vazio" de "todos os attaches falharam".

## Roadmap

### Fase 1 — observabilidade sem tocar código de produto (wrapper apenas)

Objetivo: na próxima ocorrência natural, o diagnóstico já estar gravado em disco.

1. [x] **Ligar os canais debug no wrapper.** Em `scripts/run-mcp-server.cjs`,
   função `runAndExit`: passar `env: { ...process.env, DEBUG: process.env.DEBUG ? process.env.DEBUG + ',pw:mcp:*' : 'pw:mcp:*' }`
   nas **duas** rotas (fork local e fallback npx). Isso ativa `pw:mcp:relay`
   (timeline da conexão: "Extension WebSocket closed: <reason>", "Establishing
   extension connection", tráfego CDP) e `pw:mcp:error` (o attach engolido).
   *Pronto quando:* reiniciar uma instância do Claude Code, fazer uma tool call
   e ver linhas `pw:mcp:relay` no log da etapa 2.
2. [x] **Persistir o stderr em arquivo.** Ainda em `runAndExit`: trocar
   `stdio: 'inherit'` por `['inherit', 'inherit', 'pipe']` e, no `child.stderr`,
   fazer *tee*: repassar cada chunk a `process.stderr` (comportamento atual
   preservado) **e** anexar a `scripts/.mcp-debug-log.txt` prefixando cada
   escrita com timestamp ISO. Rotação simples no startup do wrapper: se o
   arquivo passar de ~10 MB, renomear para `.mcp-debug-log.old.txt`
   (sobrescrevendo o anterior). O pacote `debug` escreve em stderr e o
   protocolo MCP usa stdout — o tee não interfere no handshake.
   *Pronto quando:* o arquivo existe, cresce a cada tool call, e uma queda
   forçada de teste (fechar/reabrir uma instância) aparece com timestamp.
3. [x] **Gitignorar o log.** Adicionar `scripts/.mcp-debug-log*` ao mesmo
   mecanismo que já ignora `scripts/.build-*` (conferir `.gitignore` do repo).
   O log contém URLs navegadas e tráfego CDP — é **local, nunca versionar**.
   *Pronto quando:* `git status` limpo com o log presente.

### Fase 2 — logs cirúrgicos no fork (playwright-core)

Objetivo: transformar "tem erro em algum lugar" em "este tab, esta URL, esta
mensagem do Chrome". Depende da Fase 1 (senão os logs novos também somem).

4. [x] **Attach com contexto.** Em `browserModel.ts`, `enableAutoAttach`
   (linha ~124): trocar o `.catch(logUnhandledError)` por um catch que loga
   `tabId`, a URL da aba (`this._knownTabs.get(tabId)?.url`) e o erro — no
   mesmo canal `pw:mcp:error` (importar `debug` pelo mesmo mecanismo do
   `mcp/log.ts`, que já está no allowlist de imports do pacote). Após o
   `Promise.all`, se `this._tabSessions.size === 0 && tabIds.length > 0`,
   logar marcador inequívoco:
   `ANOMALY: setAutoAttach answered with 0 attached of ${tabIds.length} known tabs`.
   Mesmo tratamento no `.catch` de `onTabCreated` (linha ~86). Comportamento
   funcional inalterado (continua não-fatal).
5. [x] **Marcador no `ensureTab`.** Em `backend/context.ts`, `ensureTab()`
   (linha ~198): quando `!this._currentTab` (o ramo que chama `newTab()`),
   logar `tabs=${this._tabs.length}` antes de criar. Usar o utilitário de debug
   que o pacote já usa (ex.: `debug` via `utilsBundle`) — **atenção ao
   `DEPS.list`** de `tools/backend/`: se importar de `tools/mcp/` for barrado
   pelo `npm run flint` (check-deps), usar o canal de debug próprio do
   playwright-core em vez de `mcp/log.ts`.
6. [x] **Build + verificação.** `npm run flint` limpo da raiz (os arquivos
   tocados são de `playwright-core`, cobertos pelo flint — a regra dos dois
   tsconfig extras só vale para `packages/extension/`, não tocado nesta fase).
   Build via o próprio wrapper (background) ou `npm run build` manual.
   *Pronto quando:* flint limpo + próxima sessão do Claude Code sobe com o
   build do fork (checar `scripts/.build-log.txt` / stamp) e os logs novos
   aparecem no `.mcp-debug-log.txt`.

### Fase 3 — diagnóstico com dado real ✅ CONCLUÍDA (17/07, teste ao vivo com o Gabriel)

Não foi preciso esperar ocorrência natural — reproduzido deterministicamente
em teste controlado (~09:26–09:37 UTC, timeline em `scripts/.mcp-debug-log.txt`).

7. [x] **Achados, na ordem em que caíram:**
   - ⚠️ **RETRATADO (17/07, ~08:30):** a tese abaixo ("morte por ociosidade em
     30s") **não sobreviveu** ao teste decisivo do Gabriel — com aba anexada
     no grupo, o worker sobrevive a longos períodos ociosos mesmo com janela
     minimizada/desfocada e `chrome://extensions` fechado. O que fica de pé:
     fechar a última aba derruba a conexão na hora (server-side) e, **sem
     nenhuma aba anexada**, o worker morre em ~30s (cronômetro manual). As
     quedas espontâneas de manhã (09:26/09:34) seguem **sem atribuição** —
     as "confirmações" posteriores estavam contaminadas (efeito do observador
     via chrome://extensions; testes manuais simultâneos do Gabriel). Issue
     #41846 foi criada e depois **fechada com retratação**; o comentário do
     #41843 foi editado para a versão correta. O item 12 (keepalive) perde a
     urgência mas continua inofensivo e já implementado. Registro original
     (incorreto) mantido abaixo para histórico:
   - ~~**Por que a conexão cai (CONFIRMADO por 3 vias independentes):**~~ morte
     do service worker MV3 por ociosidade — o limite de 30s documentado do
     Chrome. (1) Timeline do log: quedas espontâneas ~30–36s após o último
     tráfego (09:26:57, 09:34:17), assinatura `Inspector.detached` →
     `Extension WebSocket closed: undefined`. (2) Correlação multi-instância
     (10:09): o worker é **um só, compartilhado** — com outra instância
     ativa, a conexão ociosa sobreviveu 10+ min; ~90s após TODAS ficarem
     quietas, as duas caíram juntas (dois `Inspector.detached`, 10:09:06 e
     10:09:15). Por isso o tráfego de qualquer instância protege as demais, e
     a correlação original do Gabriel ("só quando não há grupos") aponta o
     único cenário em que o worker fica sem tráfego nenhum. (3) Cronômetro
     manual do Gabriel observando o status do worker em `chrome://extensions`:
     ~30s cravados **a partir do fechamento da última aba com site** —
     refinamento importante: "atividade" para o MV3 é mensagem chegando no
     worker, e uma página ativa gera eventos CDP que também contam. Aba com
     site vivo = worker vivo; página estática ou aba fechada + cliente quieto
     = morte em 30s. Explica a intermitência no uso real (depende do site).
     Nota: as quedas dos ciclos rápidos de teste foram outro gatilho (fechar
     a última aba derruba o backend server-side) — dois gatilhos, mesma
     consequência.
   - **Por que a aba fantasma (REPRODUZIDO, determinístico):** a primeira
     tool call após a queda ser **`browser_tabs {action:"new", url}`**. O
     handshake cria e anexa a semente `connect.html` normalmente (sem falha,
     sem corrida) e o `tabs new` chama `Context.newTab()` →
     `Target.createTarget` — cria a segunda aba **por design**, deixando a
     semente `connect.html` viva como aba 0 do grupo. Log 09:37:03: handshake
     limpo + `← Playwright: Target.createTarget (id=19)`. O "às vezes" do
     sintoma é só **qual ferramenta o agente chama primeiro** após a queda:
     `navigate`/`snapshot`/`tabs list`/`set_group_label` primeiro → semente
     reaproveitada, limpo (testado 7×); `tabs new` primeiro → fantasma
     (**5/5, 100% determinístico** — portas de relay distintas em cada ciclo
     provam que cada repro foi uma conexão nova).
   - **Mecanismo (a) — attach engolido — também produz o fantasma, com outra
     conexão ativa:** com o grupo de uma segunda instância Claude aberto,
     reconexão às 09:41:12 capturou:
     `attach failed for tab 564270737 (chrome-extension://.../connect.html...):
     Error: Another debugger is already attached to the tab` →
     `ANOMALY: setAutoAttach answered with 0 attached of 1 known tabs` →
     `Target.createTarget`. Ou seja: a semente foi anexada por **outra
     conexão antes** (hipótese: o singleton do SO abriu a `connect.html`
     dentro/adjacente ao grupo vizinho, e o `_onTabGroupChanged` daquele grupo
     anexou primeiro), a falha era engolida (agora logada), o modelo subiu
     vazio e o site abriu em aba nova — `connect.html` fica de fantasma,
     invisível para a conexão dona. Espécime menor da mesma família (09:35:35):
     `attach failed for tab (): Error: Cannot access a chrome:// URL` — aba
     com URL pendente passa pelo filtro `isNonDebuggableUrl(undefined) ===
     false` e fica morta no grupo.
   - **Mecanismo (b) — detach na criação do grupo:** nenhuma evidência em ~14
     handshakes; descartado como causa do fantasma.
   - **Sementes órfãs se acumulam em reconexões rápidas:** quando o worker
     morre sem rodar `_onConnectionClose`, o estado de ownership morre junto e
     as abas da conexão morta sobrevivem; observado ao vivo dois `connect.html`
     de conexões distintas (relays 60770/59260) abertos ao mesmo tempo, o velho
     apontando para relay morto.
   - **Sintoma-irmão explicado — "a aba residual solta" (relato do Gabriel):**
     quando a conexão morre sem limpeza (worker morto abrupto), a aba de
     trabalho fica agrupada porém zumbi; na próxima reconexão o worker renasce
     e `cleanupStalePlaywrightGroups` (`connectedTabGroup.ts:39-50`)
     **desagrupa** tudo (não fecha — sem o estado de ownership, fechar seria
     destrutivo para aba do usuário) → a aba antiga fica solta e sem controle,
     e a conexão nova cria grupo novo. Comportamento hoje é "seguro porém
     vazador"; correção na Fase 4 (item 13). Na experiência do Gabriel isso
     aparecia como "quando o Claude chamava novas abas, criava um grupo novo
     e abandonava a aba antiga fora do grupo" — a chamada que cria abas é só
     a primeira após uma morte silenciosa do worker; a variabilidade (às
     vezes fecha, às vezes abandona) é se a limpeza chegou a rodar antes de
     o worker ser terminado.
   - **A correlação "só quando não há grupos"** se explica sozinha: o grupo
     fecha junto com a conexão, então *todo* reconnect começa sem o próprio
     grupo — era consequência da queda, não causa. E com grupos de terceiros
     presentes o fantasma sai pelo mecanismo (a) acima.
8. [x] Causas confirmadas ⇒ Fase 4 redesenhada abaixo com correções
   concretas (não mais condicionais).

### Fase 4 — correções + upstream (redesenhada 17/07 pós-diagnóstico; causas confirmadas)

Ordem sugerida: 9 e 10 matam os dois caminhos do fantasma; 12 reduz a
frequência de reconexão (causa-raiz habilitadora); 13 resolve a aba residual.

9. [x] **Fantasma determinístico (`tabs new` primeiro):** em
   `Context.newTab()` (`backend/context.ts:182`) — ao criar uma aba nova,
   se existir uma página cuja URL comece com
   `chrome-extension://<extensionId>/connect.html` (a semente intocada),
   **fechá-la** após a criação (ou navegá-la em vez de criar). Server-side,
   sem tocar na extensão, upstreamable. *Pronto quando:* repetir o repro
   (matar conexão → `tabs new` como 1ª chamada) 3× sem sobrar `connect.html`.
10. [x] **Fantasma por roubo de semente (grupo vizinho — confirmado 2/2 com
    outra instância ativa):** o Chrome insere a aba aberta via linha de
    comando herdando o grupo da aba ativa; a `connect.html` nova nasce dentro
    do grupo de outra conexão, `_onTabGroupChanged` daquele grupo a anexa
    (`connect.html` não é `isNonDebuggableUrl`), e o attach da conexão dona
    falha com `Another debugger is already attached` → modelo vazio → site em
    aba nova. Correção na extensão, dupla: (i) `_onTabGroupChanged`/
    `_onTabUpdated` **nunca anexarem a própria página de connect**
    (`chrome-extension://<próprio id>/connect.html`); (ii) opcional
    defensivo — `connect.tsx` se **auto-desagrupar** no load
    (`chrome.tabs.ungroup` via mensagem ao background). Mexe em
    `packages/extension/` ⇒ rodar os **dois tsconfig próprios** além do flint.
    *Pronto quando:* repetir o reteste (outra instância com grupo ativo →
    matar minha conexão → reconectar) 3× com a semente indo pro grupo certo.
11. [x] **Attach engolido (robustez geral):** propagar a falha ao
    `Target.setAutoAttach` quando 0 de N abas anexarem (em vez de sucesso
    silencioso) e/ou retry curto; manter os logs da Fase 2 permanentes no
    fork. Cobre também o espécime `Cannot access a chrome:// URL` (URL
    pendente passa pelo filtro).
12. [x] **Frequência de queda (morte do worker por ociosidade, ~30–60s):**
    keepalive que não dependa da página de connect — preferência: **ping
    periódico do relay (servidor) no WebSocket da extensão** a cada ~20s
    (mensagem recebida reseta o idle timer do MV3 desde o Chrome 116);
    alternativa: `chrome.alarms`. Reduz reconexões de "constantes" para
    "raras", encolhendo a superfície de todos os outros bugs.
13. [x] **Aba residual solta (sintoma-irmão):** persistir o ownership
    (`_agentOwnedTabs` por grupo) em `chrome.storage.session` — sobrevive à
    morte do worker, zera no restart do browser. No cold start,
    `cleanupStalePlaywrightGroups` passa a espelhar `_onConnectionClose`:
    fecha agent-owned, desagrupa user-owned; e fecha `connect.html` órfãs
    (relay morto). Hoje ele desagrupa tudo (`connectedTabGroup.ts:39-50`) —
    seguro porém vazador.
14. [ ] **Upstream:** rascunhos prontos em 17/07, aguardando revisão/postagem
    do Gabriel (a postagem em si é dele — ação externa): (a)
    `roadmap/issue-sw-idle-death-draft.md` — issue NOVA para a morte do
    worker por ociosidade (postar primeiro, para ter o número); (b)
    `roadmap/issue-41843-diagnosis-update-draft.md` — comentário no #41843
    com o diagnóstico completo (repro 5/5 do `tabs new`, roubo de semente
    2/2, attach engolido; substituir o `#NNNNN` pelo número da issue nova).
    A atualização do diagnóstico NÃO espera os fixes — vale para a triagem
    já. PRs continuam gated em issue aprovada (política do repo); fixes 9/11
    são server-side e upstreamáveis direto, o 10/12 tocam a extensão deles.
15. [ ] Fechar o ritual: propagar para `CLAUDE.md` do fork (instrumentação:
    o que registra e onde; e os novos comportamentos), podar logs temporários
    que não ficarem, e consolidado em `C:\Dev\consolidado\playwright\`.
16. [ ] ⚠️ **PENDENTE DE DECISÃO (Gabriel) — FORA do contrato Sonnet:**
    re-adoção de abas na reconexão. Os três caminhos pelos quais uma aba sai
    do grupo: (1) cleanup na ressurreição do worker → item 13; (2) close
    limpo desagrupa user-owned por design (frequência despenca com o item
    12); (3) **a reconexão nunca re-adota a aba órfã** — grupo/semente novos,
    a aba antiga fica solta mesmo sendo a mesma sessão de trabalho. Corrigir
    (3) exige decidir como casar conexão nova ↔ abas da conexão morta
    (clientName repete entre instâncias; título de grupo tem sufixo (2)/(3);
    timestamp é heurística). Opções a pesar: (a) não fazer — com 12+13 o
    problema residual pode ficar pequeno o bastante; (b) re-adotar por
    correspondência exata de título de grupo persistido em storage.session;
    (c) a connect page listar "abas órfãs de sessões Playwright anteriores"
    para adoção manual. Decidir DEPOIS de validar 9–13 ao vivo — o tamanho
    do resíduo real muda a resposta.

> ⚠️ **STATUS REAL (28/09/2026):** o `6f0b4cfdc` **nunca foi mesclado na `main`**,
> que é a branch checada, compilada e em uso (tem 10 commits que a
> `extension-multi-connection` não tem). Os itens 9–13 não estão no ar e a
> validação ao vivo nunca aconteceu. Em 28/09 entrou na `main` um patch à parte
> para a semente órfã ("\"mcp\" connected"), que nenhum dos itens cobria.
>
> **STATUS (17/07, ~08:30):** itens 9–13 **executados** pelo Sonnet — commit
> `6f0b4cfdc` (⚠️ commitou apesar de o contrato proibir; trabalho íntegro,
> sem push). Build do fork refeito com os fixes às 08:20 (stamp atualizado).
> **Falta para ficar no ar:** recarregar a extensão em `chrome://extensions`
> (dist novo) e reiniciar as instâncias do Claude Code → depois rodar a
> "Validação ao vivo" abaixo. Item 14: issue #41846 criada e **fechada com
> retratação** (a tese dos 30s caiu); comentário do #41843 postado e editado
> com o enabler corrigido — as duas causas do fantasma seguem válidas.
> Mitigação já ativa: regra no `CLAUDE.md` global (nunca `tabs new` como
> primeira ação de browser).

## Contrato de execução para o Sonnet (itens 9–13)

**Escopo:** implementar os itens na ordem 9 → 11 → 10 → 12 → 13, cada um
compilando/lintando limpo antes do próximo. **NÃO commitar, NÃO pushar, NÃO
amendar** — deixar tudo no working tree (já há mudanças não commitadas das
Fases 1–2 que fazem parte do mesmo pacote; o commit é decisão do Gabriel
depois da validação ao vivo). **NÃO reiniciar instâncias do Claude Code, NÃO
recarregar a extensão no Chrome, NÃO mexer em `~/.claude.json`** — a validação
ao vivo é etapa separada (checklist abaixo, fica com Gabriel+Fable). Não
apagar/editar `scripts/.mcp-debug-log.txt`, `.build-stamp`, `.build-lock`.

**Verificação estática obrigatória ao fim (e a única que o executor faz):**
```bash
npm run build && npm run flint
cd packages/extension && npx tsc -p tsconfig.ui.json --noEmit && npx tsc -p tsconfig.json --noEmit
```
⚠️ O flint da raiz NÃO cobre `packages/extension/` (incidente real 17/07 — ver
`CLAUDE.md` do fork); os dois tsc acima são obrigatórios porque os itens 10 e
13 tocam essa pasta. Há 4 erros de tipo PRÉ-EXISTENTES em
`connectedTabGroup.ts` (`@types/chrome` desalinhado — `TabChangeInfo`
inexistente, `ungroup` exigindo tupla); não são regressão sua — não tente
"consertar o mundo", apenas não adicione erros novos.

**Especificações por item:**

- **Item 9** (`packages/playwright-core/src/tools/backend/context.ts`,
  `newTab()` linha ~182): após `browserContext.newPage()` resolver e
  `_currentTab` ser setado, varrer `this._tabs` por abas cuja
  `tab.page.url()` comece com `chrome-extension://` E contenha
  `/connect.html?mcpRelayUrl=` (assinatura inequívoca da semente do modo
  extensão; nunca casa com página de usuário) e fechá-las com
  `tab.page.close().catch(() => {})`. Não fechar a aba recém-criada. Um
  comentário curto explicando por quê (a semente do token-bypass fica órfã
  quando a primeira ação é criar aba — issue #41843). Não usar import de
  `tools/mcp/` aqui (DEPS: `backend/` não enxerga `mcp/`; por isso a
  detecção é por URL, não por `playwrightExtensionId`).
- **Item 11** (`packages/playwright-core/src/tools/mcp/browserModel.ts`,
  `enableAutoAttach()` linha ~132): quando `tabIds.length > 0` e
  `this._tabSessions.size === 0` após o `Promise.all`, além do log ANOMALY
  já existente, fazer **um retry único** do attach de cada aba conhecida
  após `await new Promise(r => setTimeout(r, 300))` (cobre corrida curta;
  o caso "Another debugger" persiste no retry e aí segue como está — o
  item 10 é quem o previne). Logar o resultado do retry no mesmo canal.
- **Item 10** (`packages/extension/src/connectedTabGroup.ts`): criar um
  helper `isOwnConnectPage(url)` — `url?.startsWith(
  chrome.runtime.getURL('connect.html'))` — e usá-lo para **pular o attach**
  nos dois pontos onde uma aba de grupo é anexada: `_onTabGroupChanged`
  (ramo de entrada, junto ao check `isNonDebuggableUrl`, linha ~171) e
  `_onTabUpdated` (retry pós-navegação, linha ~145). A página de connect é
  infraestrutura da própria extensão, nunca alvo legítimo de automação.
  Parte (ii), defensiva, em `packages/extension/src/ui/connect.tsx`: no
  effect de mount, se `chrome.tabs.getCurrent()` retornar aba com
  `groupId !== -1`, chamar `chrome.tabs.ungroup` do próprio id (envolver em
  try/catch silencioso — pode falhar durante drag). Atenção: `connect.tsx`
  é coberto pelo `tsconfig.ui.json`.
- **Item 12** (server: `packages/playwright-core/src/tools/mcp/cdpRelay.ts`;
  extensão: `packages/extension/src/relayConnection.ts` ou
  `protocolHandlers.ts`): keepalive de 20s do lado do **servidor** — após a
  conexão da extensão estabelecida, `setInterval` de 20_000ms enviando uma
  mensagem `session.ping` pelo mesmo WebSocket (mesmo canal usado por
  `session.setGroupLabel`, ver `setGroupLabel()` linha ~110); limpar o
  interval no close. Na extensão, tratar `session.ping` retornando `{}`
  (mesmo lugar que trata `session.setGroupLabel`). O objetivo é só gerar
  tráfego recebido no worker (reseta o idle timer MV3 ≥ Chrome 116). Se a
  extensão antiga (da store) receber o ping e responder erro de método
  desconhecido, tudo bem — o erro também é tráfego; o servidor deve ignorar
  a resposta (catch silencioso).
- **Item 13** (`packages/extension/src/connectedTabGroup.ts` +
  `background.ts`): persistir em `chrome.storage.session` um mapa
  `pwGroups: { [groupId]: { agentOwned: number[] } }`, atualizado nos mesmos
  pontos que mutam `_agentOwnedTabs`/`_groupTabIds` (entrada/saída de grupo,
  remoção de aba, close da conexão remove a entrada do grupo).
  `cleanupStalePlaywrightGroups` passa a: ler o mapa; para cada grupo stale,
  **fechar** as abas listadas em `agentOwned` (com
  `chrome.tabs.remove(...).catch()`) e **desagrupar** as demais; grupos sem
  entrada no mapa mantêm o comportamento atual (desagrupar tudo). Limpar a
  entrada após processar. `chrome.storage.session` sobrevive à morte do
  worker e zera no restart do browser — exatamente a janela necessária.

**Relatório final do executor (curto, estruturado):** por item — o que mudou
(arquivos:linhas), resultado das verificações estáticas, qualquer desvio da
spec e por quê. Nada de prosa longa.

## Validação ao vivo (pós-execução — Gabriel + Fable, NÃO o executor)

1. Conferir `scripts/.build-log.txt`/stamp (build fresco) e **recarregar a
   extensão** em `chrome://extensions` (itens 10/12/13 só valem após reload —
   o dist é gerado pelo build, mas o Chrome só recarrega manualmente).
2. Reiniciar uma instância do Claude Code (servidor novo).
3. Re-rodar os repros: (a) matar conexão → `tabs new` como 1ª chamada, 3× —
   nenhuma `connect.html` sobrando (item 9); (b) com outra instância ativa e
   grupo aberto → reconectar 3× — semente vai pro grupo próprio, sem
   `Another debugger` no log (item 10); (c) deixar a conexão ociosa 3+ min —
   sem `Extension WebSocket closed` no log (item 12); (d) matar o worker na
   marra (chrome://serviceworker-internals ou aguardar) com aba de trabalho
   aberta → na reconexão, a aba antiga do agente é fechada, não desagrupada
   (item 13).
4. Só então: commit (direto na branch, sem push até ordem), atualização do
   `CLAUDE.md` do fork e consolidado (item 15).

## Priorização (impacto × esforço × risco)

| item | impacto | esforço | risco | veredito |
| --- | --- | --- | --- | --- |
| Fases 1–3 (instrumentação + diagnóstico) | — | — | — | ✅ concluídas 17/07 |
| 9 — fechar semente no `tabs new` | alto (mata o fantasma 5/5) | baixo (1 função, server-side) | baixo | **fazer já** |
| 10 — não anexar connect.html de grupo vizinho | alto (mata o fantasma multi-instância) | baixo-médio (extensão, 2 pontos) | baixo-médio (tsconfigs próprios) | **fazer já** |
| 12 — keepalive (ping do relay) | alto (reconexão vira evento raro) | baixo-médio | médio (mexe no protocolo/idle) | fazer em seguida |
| 13 — ownership em storage.session | médio (residuais) | médio | médio | depois de 9/10/12 |
| 11 — propagar falha de attach | médio (robustez) | baixo | baixo | junto com 9 |
| 14 — upstream #41843 | alto (comunidade) | baixo (escrever) | nulo | após validar 9/10 |
| Redesign do `_openConnectPageInBrowser` | incerto | alto | alto | **não fazer** (ver abaixo) |

## O que NÃO fazer

- **Redesenhar `_openConnectPageInBrowser` / o mecanismo de singleton do SO**:
  a hipótese que o motivava está enfraquecida (os awaits de
  `establishExtensionConnection` absorvem o timing do spawn) e a mudança é
  invasiva no handshake. Reavaliar só se a Fase 3 desmentir a teoria do attach.
- ~~Reproduzir o bug forçadamente~~ → superado: reproduzido com segurança em
  teste controlado no 17/07 (grupo de teste próprio, sem tocar os do Gabriel).
- **Postar hipótese no #41843 sem dado**: o issue já carrega duas retratações;
  o próximo comentário é o diagnóstico da Fase 3, com evidência de log.
- **`taskkill /F /IM chrome.exe`** em qualquer limpeza (regra do fork — mata o
  browser real do usuário).
- **Logar em produção upstream**: as mudanças de log da Fase 2 são aceitáveis
  de manter no fork; para upstream, só o que a Fase 4 justificar com dado.

## Riscos e pré-requisitos

- **`DEBUG=pw:mcp:*` é verboso** (loga cada mensagem CDP): o arquivo cresce
  rápido em sessão pesada — a rotação de 10 MB da etapa 2 é obrigatória, não
  opcional. Se incomodar, reduzir para `pw:mcp:relay,pw:mcp:error` (perde o
  tráfego por mensagem, mantém timeline + erros).
- **O log contém dado de navegação** (URLs, payloads CDP) — local e
  gitignorado, nunca compartilhar o arquivo bruto; extrair só as linhas do
  incidente ao postar upstream.
- **Reinício necessário**: mudanças no wrapper só valem para instâncias do
  Claude Code reiniciadas (config compartilhada — avisar o Gabriel antes de
  reiniciar qualquer instância; `~/.claude.json` não muda, o caminho do wrapper
  é o mesmo).
- **Fase 2 só fica ativa quando o build do fork estiver fresco** — o wrapper
  usa fallback npx (sem os logs novos) até o background build terminar.
- **Fases 3–4 dependem de terceiros/tempo**: ocorrência natural do bug e, no
  upstream, aprovação do issue pelo time do Playwright.

> Auditado em 2026-09-01 (overhaul): VIVO (em risco) — itens 9–13 estão só no commit 6f0b4cfdc da branch extension-multi-connection; main não tem connect.html?mcpRelayUrl nem isOwnConnectPage e divergiu 5 commits; validação ao vivo nunca feita; md nunca commitado
