# Melhoria de descrição — `browser_tabs` e vizinhos (2026-07-17)

> ✅ **EXECUTADO em 17/07/2026** (2ª aplicação — a 1ª foi revertida por engano de alvo, ver
> `C:\Dev\consolidado\playwright\CONSOLIDADO-2026-07-17.md`). Conferido no código em 17/07 à
> noite: `tabs.ts` (description longa + describe novo do `index`) e `navigate.ts:26` estão como
> proposto abaixo. O efeito está ATIVO: o `~/.claude.json` já roda o wrapper da Fase 0 (fork
> local). Pendente: **commit** (nada commitado no fork) e a decisão sobre a via upstream
> (PR doc-only) citada na nota abaixo.

> Complementa `C:\Dev\playwright\roadmap\2026-07-17-melhoria-fork-servidor-mcp.md`
> (o roadmap principal do fork do servidor). Isto é um item pequeno e isolado:
> só texto de `description`/`.describe()`, não protocolo novo nem tool nova.
>
> ⚠️ **Correção (revisão de 16/07): "executável imediatamente" só vale para o
> *editar*, não para o *efeito*.** As descriptions vivem no código do SERVIDOR
> (`backend/tabs.ts`) e chegam ao Claude Code pelo servidor que está rodando —
> que hoje é o pacote npm `@playwright/mcp@0.0.78` via `npx`, não o fork.
> Editar o fork sem a Fase 0 (wrapper) do roadmap principal muda **zero** no
> comportamento observável: a mudança fica dormente até o `~/.claude.json`
> apontar pro build local. Na prática, portanto, **depende da Fase 0 de lá**
> para surtir efeito. Alternativa que eliminaria a dependência: propor a
> melhoria **upstream** (é doc-only, candidata plausível a PR aceito) — mas aí
> o texto final é deles, o timing de publicação do pacote npm é deles, e vale
> a mesma regra do roadmap principal: PR upstream em branch separada, nunca
> misturado com o resto do fork.

## O achado (evidência, não suspeita)

Investigando por que múltiplas *instâncias* do Claude Code não colidem mas
*subagentes dentro de uma mesma instância* potencialmente colidem, encontrei o
mecanismo exato em `packages/playwright-core/src/tools/backend/context.ts`:

```ts
private _currentTab: Tab | undefined;   // um ponteiro ÚNICO por conexão MCP

async newTab(): Promise<Tab> {
  const browserContext = await this.ensureBrowserContext();
  const page = await browserContext.newPage();
  this._currentTab = this._tabs.find(t => t.page === page)!;  // sobrescreve sem condição
  return this._currentTab;
}

async selectTab(index: number) {
  const tab = this._tabs[index];
  if (!tab) throw new Error(`Tab ${index} not found`);
  await tab.page.bringToFront();
  this._currentTab = tab;
  return tab;
}
```

`Context` = uma conexão MCP = (com o fork da extensão) um grupo de abas. **Duas
instâncias diferentes do Claude Code nunca compartilham um `Context`** — cada
uma tem seu próprio processo de servidor, então zero risco de colisão aí; foi
isso que garantiu o teste de fumaça funcionar em 17/07 (F5 do roadmap
principal), não "sorte" de seleção correta.

**Dentro de uma mesma instância**, se dois chamadores concorrentes (ex.: dois
subagentes despachados em paralelo pela mesma sessão, que compartilham o mesmo
`Context` porque `mcpServers` é configurado por sessão, não por agente — ver
riscos do roadmap principal) usam ferramentas de browser sem fixar
explicitamente qual aba é sua, o cenário é literal:

1. Subagente A chama `browser_tabs` com `action: 'new'` → essa aba vira
   `_currentTab`.
2. Subagente B, concorrente, também abre uma aba nova (ou já tinha aberto
   antes) → **rouba** `_currentTab` de A sem aviso nenhum — `newTab()` não
   verifica se já havia um dono.
3. Subagente A chama `browser_navigate`/`browser_snapshot`/etc. sem passar um
   índice explícito → age na aba do B por engano.

`browser_navigate` e as outras tools de ação (click, type, snapshot...) operam
implicitamente sobre `context.currentTab()`/`ensureTab()` — nenhuma delas
recebe "qual aba" como parâmetro do LLM; é sempre esse ponteiro global.

## O problema com a descrição atual

`packages/playwright-core/src/tools/backend/tabs.ts`:

```ts
description: 'List, create, close, or select a browser tab.',
...
action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
```

Não fala nada sobre: (a) a existência de um ponteiro de "aba atual" único e
compartilhado; (b) que criar uma aba nova rouba esse ponteiro incondicionalmente;
(c) que múltiplos agentes/subagentes concorrentes precisam se coordenar
explicitamente. Um agente lendo só essa descrição não tem como saber que existe
esse risco — a descoberta de tool via MCP não vem com um "manual" além do
texto que está aqui.

## Mudança proposta

### 1. `packages/playwright-core/src/tools/backend/tabs.ts` — descrição principal

Trocar:
```ts
description: 'List, create, close, or select a browser tab.',
```
por algo como:
```ts
description: 'List, create, close, or select a browser tab. There is a single '
  + '"current tab" per connection, shared by every caller using this connection '
  + '(including concurrent sub-agents of the same session) — opening a new tab '
  + 'always makes it current, silently displacing whatever tab another caller '
  + 'was using. If more than one agent/sub-agent may be acting through this '
  + 'connection at the same time, call `list` and `select` your own tab '
  + 'explicitly by index before every action instead of assuming the current '
  + 'tab is yours.',
```
(ajustar o texto final na hora — o ponto é o conteúdo: nomear o mecanismo do
ponteiro único, avisar que `new` rouba silenciosamente, e instruir a prática
segura de `select` explícito antes de agir.)

### 2. `index` (campo do schema) — reforçar no parâmetro também

Trocar:
```ts
index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
```
por:
```ts
index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, the shared current tab is closed — pass an explicit index whenever another caller might be using a different tab on this same connection.'),
```

### 3. `packages/playwright-core/src/tools/backend/navigate.ts` — ponteiro curto, não duplicar o texto todo

`browser_navigate` é provavelmente a tool mais chamada e a que mais silenciosamente
cria/usa a aba atual via `ensureTab()`. Não vale duplicar o parágrafo inteiro
aqui (polui todo tool call), mas vale uma frase curta apontando pro mecanismo:
```ts
description: 'Navigate to a URL. Acts on this connection\'s current tab (see browser_tabs) — if none exists yet, creates one and makes it current.',
```

### 4. Não mexer em mais nada além desses três pontos

`browser_click`, `browser_snapshot`, etc. herdam o mesmo mecanismo mas não
precisam repetir a explicação — o objetivo é que o agente aprenda o conceito
UMA vez (em `browser_tabs`, reforçado brevemente em `browser_navigate`) e
aplique o hábito (`select` explícito) em qualquer tool subsequente. Se ainda
assim aparecer confusão na prática depois de rodar um tempo, aí sim revisitar.

## Critério de pronto

- `npm run build` limpo depois da mudança (é só string, não deveria quebrar
  nada, mas confirmar).
- Reler o texto final em voz alta perguntando "um agente que nunca viu este
  documento entenderia o risco só pela description, sem contexto extra?" — se
  não, reescrever antes de considerar pronto.
- Opcional, não bloqueante: testar na prática pedindo pra duas sessões (ou dois
  subagentes concorrentes de propósito) usarem `browser_tabs`/`browser_navigate`
  ao mesmo tempo na mesma conexão e observar se a nova descrição realmente muda
  o comportamento (chamam `select` antes de agir) — vale mais como validação
  qualitativa do que como teste automatizado formal.

## Fora de escopo aqui

- Resolver o problema *de verdade* (ex.: dar a cada subagente seu próprio
  `Context`/conexão) — isso é o que o roadmap principal já mapeia como não
  resolvível no nível da extensão/servidor (Chrome não suporta grupo de abas
  aninhado, e subagentes não abrem conexão própria). Este md só mitiga via
  melhor instrução, não resolve a causa raiz.
- Qualquer mudança de protocolo ou tool nova — isso é o roadmap principal.

## Validação contra o repo (revisão de 16/07/2026)

Todos os trechos de código citados conferem com o checkout real:
`_currentTab` único por `Context` (`context.ts:99`), `newTab()` sobrescrevendo
incondicionalmente (`context.ts:165–169`), `selectTab` (`context.ts:172–177`),
e as descriptions atuais exatamente como citadas (`tabs.ts:27–31`,
`navigate.ts:26` — hoje é só `'Navigate to a URL'`). O diagnóstico do ponteiro
único está correto. Duas interações com o roadmap principal registradas nesta
revisão:

1. A dependência real da Fase 0 (nota corrigida no topo).
2. **O fallback `npx` do wrapper reverte estas descriptions também**: quando o
   build do fork quebra e o wrapper cai no pacote oficial, os agentes voltam a
   ver os textos antigos (além de perderem `browser_set_group_label`) — mesma
   classe de degradação, registrada lá no item 0.2.
3. Editar `tabs.ts`/`navigate.ts` no fork cria mais uma superfície de conflito
   de rebase com upstream (mesma classe do `tools.ts` registrado na Fase 2.1 de
   lá) — mais um argumento a favor de tentar o caminho upstream para ESTA
   mudança específica, já que é doc-only.
