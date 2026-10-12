# Roadmap de melhoria — TEMP próprio por sessão de IA no wrapper do MCP (2026-10-12)

Pedido: central-autonoma | central autônoma 24/7 | de: interno | desde: 2026-10-01 | origem: gabriel
Base: playwright `20c6f2154` (2026-10-12) · central `b34e73d6` (2026-10-12, só leitura)
Risco: dado (a varredura apaga pastas no `%TEMP%`: régua errada apaga o perfil de uma sessão viva)
Card: `c40ff28b01d02` (arquitetura) · achado de origem: card `cc44810c2c259` (faxina do Temp da central)
Cards de fase: Fase 1 `cde7c5dc61118` · Fase 2 `cffad2d29c092` (agendada 14/10) · laterais: `cbf3ffaf58ead`
(central, faxina enxergar `pw-ia`) · `c7e20c66d6f0b` (unclick, perfis da suíte e2e)

## Contexto e motivação

O disco da máquina da central chegou perto do piso em 11/10/2026 (17 GB livres, `%TEMP%` de 33 GB). A faxina
da central (`C:\Dev\central\roadmap\2026-10-11-melhoria-faxina-do-temp.md`) apaga lixo de 2+ dias por casamento
de nome; o Gabriel pediu, além da faxina, **blindar na origem**. Uma das origens é o servidor MCP do Playwright
nas sessões abertas por IA.

Como o alvo se encaixa:

- Toda sessão do Claude Code sobe o MCP `playwright` por `node C:\Dev\playwright\scripts\run-mcp-server.cjs
  --extension --browser chrome` (config viva em `~/.claude.json`, compartilhada por todas as sessões).
- Quando a sessão nasce com `CENTRAL_ORIGEM=ia:*` (maestro, board), o wrapper troca o argv por
  `--browser chromium --isolated --headless` (`scripts/run-mcp-server.cjs:144`, `argvForAiSession`).
- Em modo isolado, o servidor chama `browserType.launch()` (`packages/playwright-core/src/tools/mcp/browserFactory.ts:113`),
  que cria `playwright_chromiumdev_profile-XXXXXX` e `playwright-artifacts-XXXXXX` em `os.tmpdir()`
  (`packages/playwright-core/src/server/browserType.ts:161` e `:171`).
- Quem apaga essas pastas é o próprio processo do servidor, ao fechar o navegador ou no `'exit'`
  (`packages/utils/processLauncher.ts:148` e `:250`). O fechamento limpo já existe: o servidor fecha o navegador
  quando o stdin fecha (`packages/playwright-core/src/tools/mcp/watchdog.ts:34`). **Morte dura** (o processo é
  terminado sem rodar handler, o que no Windows é o normal para `kill`) não roda nada e a pasta fica.

Ler antes de começar:

- `C:\Dev\playwright\CLAUDE.md` § "This fork" e `C:\Dev\playwright\FORK.md` § "Running the server from this fork"
  (o wrapper é config viva: um erro de sintaxe derruba o MCP de **todas** as sessões, humanas inclusive).
- `scripts/run-mcp-server.cjs` inteiro (358 linhas) e `scripts/run-mcp-server.test.cjs` (convenção de teste sem
  runner e de mutantes via `RUN_MCP_SERVER_PATH`).
- Hub: `C:\Dev\cerebro\projetos\playwright.md`; tema: `C:\Dev\cerebro\temas\playwright-mcp.md` § sessão aberta por IA.
- O projeto não tem `docs/ARMADILHAS.md`; as armadilhas vivem em `FORK.md` § "Testing gotchas".
- ⚠️ O `git status` do repo tem arquivos de outras sessões (`roadmap/*-draft.md`, `packages/playwright-ct-core/`,
  dois roadmaps de 17/07 modificados). Commit **por pathspec**, só os arquivos desta fase.

## O que o pedido não dizia

- `correção:` o card diz "1 a 7 perfis por dia, do MCP". Medido em 12/10: dos 18 perfis órfãos no `%TEMP%`, **7**
  são do MCP (perfil completo, ~11 MB cada, casam com sessão `ia:*` em worktree do `unclick` no mesmo minuto) e
  **11** são da suíte e2e do `unclick` (`@playwright/test`, só `Default/` sobrou, 75–600 KB, servidor
  `127.0.0.1:<porta>/assets/`). Em bytes, o MCP é ~70 dos 72 MB; em contagem, é minoria. O wrapper não está no
  caminho da suíte, então esta fase não a resolve: card lateral no `unclick`, sem urgência (proposto abaixo).
- `+` **varredura dos mortos no arranque**, não só redirecionar o TEMP: redirecionar sozinho só aninha o
  vazamento numa subpasta.
- `+` **limpeza da própria pasta ao sair** (servidor terminou normalmente): o caso comum fica sem resto nenhum,
  sem esperar a próxima largada.
- `+` **TEMP indisponível nunca bloqueia o MCP**: disco cheio é exatamente o cenário que motivou o card; se a pasta
  não puder ser criada, o servidor sobe com o TEMP padrão e o motivo vai ao stderr.
- `+` **desligável** por `PLAYWRIGHT_MCP_SESSION_TEMP=0`, no mesmo idioma de `PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS=0`.
- `+` **prova fim a fim com navegador de verdade** (sessão `ia:*` que navega, morre dura e não deixa perfil na raiz
  do `%TEMP%`), que é o critério de fechamento do card.
- `+` **medição em produção dois dias depois** (Fase 2): a prova sintética não cobre o jeito real como as rodadas
  morrem.
- proposto (card lateral `central`, sem urgência): a faxina casa nomes na **raiz** do `%TEMP%`
  (`^playwright_chromiumdev_profile-…$`) e não enxerga `%TEMP%\pw-ia\<pid>\…`. Se a varredura do wrapper falhar,
  o lixo fica invisível para ela. Recomendo `^pw-ia$` na allowlist; a regra D4 da faxina (mtime mais novo da
  árvore) poupa sessão viva.
- proposto (card lateral `unclick`, sem urgência): a suíte e2e deixa perfis parciais quando o runner morre ou o
  `rmSync` perde a corrida no Windows. Ruído em disco (<1 MB por perfil); a faxina já cobre com 2 dias.
- descartado: patch em `processLauncher.ts`/`browserType.ts` (ver § O que NÃO fazer).

## Alvo e estado atual

- `scripts/run-mcp-server.cjs:325` (`main`): reescreve argv e env para sessão `ia:*`, escolhe fork ou fallback
  npx (`runAndExit`, `:121`) e agenda a poda de `.playwright-mcp` depois do spawn (`schedulePrune`, `:298`).
- `envForAiSession` (`:167`): já remove `PLAYWRIGHT_MCP_EXTENSION` e liga `PLAYWRIGHT_MCP_AGENT_ROUTING=off`; é
  o lugar natural para o TEMP.
- `runAndExit` (`:121`): faz `spawn` com `stdio: 'inherit'` e sai com o código do filho; não devolve o `child`.
- O servidor herda o env do wrapper; `os.tmpdir()` no Windows lê `TEMP` e depois `TMP`. **Medido nesta sessão:**
  `TEMP=<x> TMP=<x> node -e "os.tmpdir()"` imprime `<x>` e `mkdtemp` cria o perfil dentro de `<x>`.
- Liveness por pid no Windows: `process.kill(pid, 0)` devolve sem erro para pid vivo, `ESRCH` para morto e `EPERM`
  para vivo de outro dono (pid 4). **Medido nesta sessão.**
- Teste existente: `node scripts/run-mcp-server.test.cjs` → `12/12 passed` (medido nesta sessão).

## Diagnóstico

### O que está bom (não mexer)

- O desvio `ia:*` → chromium isolado headless (resolve a sessão noturna pendurada na extensão; ARMADILHAS #62 da
  central).
- O fechamento limpo do servidor no fim do stdin (`watchdog.ts`): no caminho normal, perfil e artefatos somem.
- A poda de `.playwright-mcp` (`schedulePrune`): o padrão "depois do spawn, assíncrono, promessa que nunca rejeita"
  é o molde da varredura nova.

### O que está frágil ou custando

1. **Morte dura deixa o perfil inteiro na raiz do `%TEMP%`.** Evidência: 7 perfis de ~11 MB entre 10/10 13:21 e
  11/10 23:52, cada um criado no mesmo minuto de uma chamada `browser_*` de sessão `ia` em
  `C:\Dev\unclick\.claude\worktrees\<card>` (logs `%LOCALAPPDATA%\claude-cli-nodejs\Cache\*\mcp-logs-playwright\*.jsonl`).
  Nenhum tem `lockfile` e não há `chrome.exe` vivo com perfil temporário: são órfãos. *Medido.*
2. **Nenhum cleanup dentro do processo resolve morte dura.** `TerminateProcess` não roda handler de `'exit'`; quem
  mata é o Claude Code ou o maestro, fora do nosso controle. Só quem **sobrevive** à sessão (a próxima largada)
  consegue limpar. *Lido no código; consistente com os 7 órfãos.*
3. **Os órfãos misturam-se ao lixo de todo mundo na raiz do `%TEMP%`**: hoje não se distingue perfil de sessão
  viva de perfil morto sem cruzar logs (foi o que esta investigação teve de fazer). *Medido.*
4. **Suíte e2e do `unclick` deixa perfis parciais** (só `Default/`, `chrome_debug.log` com `127.0.0.1:<porta>`), em
  rajadas (10/10 18:07–18:12, 11/10 17:57–19:03). Corrida de `rmSync` com o Chromium ainda soltando arquivo.
  Fora do wrapper. *Medido.*

Conceitos do acervo aplicados: **via-negativa** (o desenho não acrescenta cleanup novo no processo que morre;
tira o lixo do caminho de todo mundo, isolando-o numa pasta que só o wrapper varre) e **falacia-da-previsao**
(não se tenta prever *como* a sessão morre; a varredura vale para qualquer jeito de morrer).

## Decisões tomadas pelo fable

(sessão opus com advisor fable, régua v3)

| # | decisão | motivo | confiança | o que reverteria |
| --- | --- | --- | --- | --- |
| D1 | consertar **no wrapper** (TEMP por sessão + varredura), não no servidor | o servidor é código sincronizado com o upstream; nenhum cleanup in-process sobrevive a kill duro | alta | upstream passar a limpar perfis órfãos no arranque |
| D2 | pasta `%TEMP%\pw-ia\<pid do wrapper>-<Date.now() em base36>` + `owner.json` com os pids do wrapper **e** do servidor; nunca se reusa nem se limpa pasta existente no arranque | o wrapper pode morrer antes do servidor (o servidor só sai quando o stdin fecha); pid do wrapper sozinho apagaria a pasta de um servidor vivo e o próximo `mkdtemp` daria `ENOENT`; o sufixo de tempo impede que um wrapper novo com pid reciclado caia na pasta de um servidor ainda vivo | média | medir que o servidor nunca sobrevive ao wrapper: aí basta o pid |
| D3 | pasta "morta" = **todos** os pids do `owner.json` com `ESRCH`; `EPERM` conta como vivo | reuso de pid só atrasa a limpeza (lado seguro), nunca apaga pasta viva | alta | pasta presa por reuso de pid aparecer na Fase 2 (aí somar teto de idade) |
| D4 | `EBUSY`/`EPERM` no `rm` = pula e loga; a próxima largada tenta de novo | arquivo aberto no Windows = alguém ainda usa; nunca forçar | alta | — |
| D5 | só nome `^\d+-[0-9a-z]+$` dentro de `pw-ia` é candidato; resto é ignorado | nunca apagar o que o wrapper não criou | alta | — |
| D6 | pasta sem `owner.json` só sai com 10+ min de idade | a largada vizinha pode estar entre o `mkdir` e a escrita do `owner.json` | alta | — |
| D7 | só sessão `ia:*` ganha TEMP próprio | sessão humana usa a extensão, não lança Chromium; menor raio | alta | sessão humana passar a usar `--isolated` |
| D8 | uma fase de execução (código + testes + docs) e uma de medição agendada | redirecionar sem varrer só aninha o vazamento; separar deixaria o sistema pior entre fases | alta | — |
| D9 | `TMPDIR` também é exportado, além de `TEMP` e `TMP` | ferramentas POSIX filhas (Git Bash, npx) leem `TMPDIR` | média | — |

## Roadmap

### Fase 1 — TEMP próprio por sessão de IA, varredura dos mortos e limpeza na saída

**Critério de aceite:**

- Uma sessão aberta por IA que usa o navegador e morre sem fechar **não deixa perfil nem pasta de artefatos na raiz
  do `%TEMP%`**; o resto dela fica numa subpasta da própria sessão, que some na próxima largada de qualquer sessão
  de IA. Se a fase falhasse: `playwright_chromiumdev_profile-*` novo na raiz depois do teste, ou `pw-ia\<pid>` morto
  sobrevivendo à largada seguinte.
- Uma sessão de IA que termina normalmente não deixa nada, nem a subpasta. Se falhasse: `pw-ia\<pid>` sobrando.
- Sessão humana (extensão) e sessão de IA com disco cheio continuam subindo o MCP como antes. Se falhasse: MCP
  `playwright` sem conectar, ou com erro no stderr do wrapper.

1. [ ] Em `scripts/run-mcp-server.cjs`, criar `sessionTempRoot(env)` → `path.join(<TEMP do wrapper>, 'pw-ia')`
   (usar `os.tmpdir()`; acrescentar `const os = require('os')` em `:28`) e
   `prepareSessionTemp(root, pid, { env, log, now })`: pasta `root\<pid>-<now em base36>` (D2: nunca reusa nem
   limpa pasta existente); `mkdirSync({ recursive: true })`; grava `owner.json`
   `{ "wrapper": <pid>, "server": null, "createdAt": <iso> }`; devolve o caminho. Qualquer erro →
   `log("session temp: ... using the default TEMP")` e devolve `null` (nunca lança).
   `env.PLAYWRIGHT_MCP_SESSION_TEMP === '0'` → devolve `null` sem tocar o disco. Exportar as duas.
   — **prova:** `node -e "const w=require('./scripts/run-mcp-server.cjs');const os=require('os'),p=require('path'),fs=require('fs');const r=fs.mkdtempSync(p.join(os.tmpdir(),'pwia-'));const d=w.prepareSessionTemp(r,4242,{env:{},log(){}});console.log(/^4242-[0-9a-z]+$/.test(p.basename(d)), JSON.parse(fs.readFileSync(p.join(d,'owner.json'))).wrapper, w.prepareSessionTemp(r,4242,{env:{PLAYWRIGHT_MCP_SESSION_TEMP:'0'},log(){}}))"` → `true 4242 null`
   **reprova se:** `false`, `null` no lugar do caminho, lança, ou o último valor não for `null` (desligamento ignorado).
2. [ ] Mudar `envForAiSession(env, origem, sessionTemp)` (`:167`): com `sessionTemp` não nulo e origem `ia:*`,
   devolve também `TEMP`, `TMP` e `TMPDIR` = `sessionTemp`; sem ele, ou origem humana, o env sai como hoje.
   — **prova:** `node -e "const w=require('./scripts/run-mcp-server.cjs');const a=w.envForAiSession({TEMP:'T'},'ia:x','S');const b=w.envForAiSession({TEMP:'T'},'humano:x','S');const c=w.envForAiSession({TEMP:'T'},'ia:x',null);console.log(a.TEMP,a.TMP,a.TMPDIR,b.TEMP,c.TEMP)"` → `S S S T T`
   **reprova se:** a primeira tripla não for `S S S` ou o humano/nulo trocar o TEMP.
3. [ ] `runAndExit` (`:121`) passa a devolver o `child` e aceita `onExit` opcional, chamado (síncrono, dentro de
   `try/catch`) antes do `process.exit`/`process.kill` nos dois ramos de `'exit'`. Em `main` (`:325`): só quando
   `argv !== rawArgv` (sessão `ia:*`), `prepareSessionTemp` **antes** do spawn; env com o `sessionTemp`; depois do
   spawn, regrava o `owner.json` com `"server": child.pid` (sync, `try/catch`); `onExit` faz
   `fs.rmSync(sessionTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })` em `try/catch`.
   — **prova:** `node --check scripts/run-mcp-server.cjs && node scripts/run-mcp-server.test.cjs` → termina em `12/12 passed` (antes dos testes novos)
   **reprova se:** erro de sintaxe ou qualquer `FAIL` nos 12 testes atuais.
4. [ ] Criar `sweepSessionTemps(root, { ownDir, now, isAlive, log })` (async, nunca rejeita) e
   `scheduleSessionTempSweep(...)` no molde de `schedulePrune` (`:298`: `setImmediate`, `safeLog`, `.catch`).
   Regra (D3–D6): para cada entrada de `root` que é pasta, nome `^\d+-[0-9a-z]+$` e não é `ownDir`: lê `owner.json`
   (ilegível ou ausente → pids = `[Number(nome.split('-')[0])]` e exige `mtime` de 10+ min); se algum pid `isAlive`, pula; senão
   `fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 })`; `EBUSY`/`EPERM` → pula e loga, sem contar
   erro fatal. `isAlive` padrão: `process.kill(pid, 0)` → `true`; `ESRCH` → `false`; `EPERM` → `true`. Ao fim, se
   removeu algo: `log("session temp sweep: removed N dead session folder(s), X MB")`. Chamar em `main` logo depois
   de `schedulePrune`, só em sessão `ia:*`. Exportar as duas.
   — **prova:** `node scripts/run-mcp-server.test.cjs` → `N/N passed` com os casos do passo 5
   **reprova se:** algum `FAIL`.
5. [ ] Em `scripts/run-mcp-server.test.cjs`, casos novos (um `test(...)` cada, `isAlive` injetado, raiz em
   `tempDir()`):
   a) pid morto → pasta sai; b) pid vivo → fica; c) wrapper morto mas `server` vivo no `owner.json` → fica;
   d) nome fora do padrão (`foo`, `123`, `123abc`) com pid morto → fica; e) `ownDir` → fica mesmo morto; f) sem
   `owner.json` com 1 min → fica, com 11 min → sai; g) `log` que lança não rejeita a varredura;
   h) `prepareSessionTemp` com `root` que é arquivo → `null`, sem lançar; i) duas chamadas de `prepareSessionTemp`
   com o mesmo pid e `now` diferente → duas pastas distintas, a primeira intacta (com um arquivo dentro);
   j) `env: { PLAYWRIGHT_MCP_SESSION_TEMP: '0' }` → `null` e nada criado; k) `envForAiSession` (os três casos do
   passo 2). **Mutantes:** para cada guarda (D3 `server` vivo, D5 regex, `ownDir`, D6 idade, `EPERM` = vivo),
   copiar o wrapper para `temp/`, apagar a guarda e rodar com `RUN_MCP_SERVER_PATH=<cópia>`: tem de dar `FAIL`.
   — **prova:** `node scripts/run-mcp-server.test.cjs` → `23/23 passed`
   **reprova se:** menos de 23 casos ou algum `FAIL`; e, por mutante, `RUN_MCP_SERVER_PATH=temp/<mutante>.cjs node scripts/run-mcp-server.test.cjs` sair com exit 0.
6. [ ] Prova fim a fim com navegador de verdade: `scripts/run-mcp-server.smoke.cjs` (novo, fora do teste unitário
   porque lança Chromium). Pré-condição: fork compilado e carimbo em dia (`isForkStale()` falso; senão `npm run
   build` e `touch scripts/.build-stamp`, FORK.md § Running). Roteiro:
   (1) anota a hora e a lista de `playwright_chromiumdev_profile-*` na raiz do `%TEMP%`;
   (2) `spawn(process.execPath, ['scripts/run-mcp-server.cjs','--extension','--browser','chrome'], { env: {...process.env, CENTRAL_ORIGEM: 'ia:prova'}, stdio: ['pipe','pipe','pipe'] })`;
   (3) JSON-RPC por linha no stdin: `initialize`, `notifications/initialized`, `tools/call` `browser_navigate`
   `{ "url": "about:blank" }` (só precisa lançar o navegador; `data:` esbarra na navegação restrita, ver
   `roadmap/pr-issue-navigate-restricted-draft.md`); espera a resposta do `id` da chamada;
   (4) confere que a pasta `%TEMP%\pw-ia\<pid do wrapper>-*` tem um `playwright_chromiumdev_profile-*` (prova do
   redirecionamento);
   (5) **morte dura**: lê `server` do `owner.json` e faz `process.kill(server)` e `process.kill(wrapper)` (nunca
   `taskkill`: o hook `guarda-comando` bloqueia em sessão do maestro); espera 3 s;
   (6) confere que a pasta da sessão morta ainda existe (resto capturado); perfis novos na raiz do `%TEMP%` desde
   (1) viram **aviso** com os nomes, não falha (uma suíte e2e de outro projeto rodando junto cria perfil lá sem
   culpa do wrapper);
   (7) relança o wrapper do mesmo jeito, espera 5 s, fecha o stdin (saída limpa) e espera o processo sair;
   (8) confere: a pasta da sessão morta sumiu (varredura) **e** a pasta da sessão nova sumiu (limpeza na saída).
   Imprime `smoke ok` ou `smoke FAIL <passo>`; exit 0/1.
   — **prova:** `node scripts/run-mcp-server.smoke.cjs` → `smoke ok`
   **reprova se:** `smoke FAIL 4` (TEMP não redirecionado) ou `FAIL 8` (varredura ou limpeza na saída sem efeito).
   Contraprova obrigatória: com `PLAYWRIGHT_MCP_SESSION_TEMP=0` no env do spawn, o mesmo script tem de dar
   `smoke FAIL 4`.
7. [ ] Sessão humana intacta: o mesmo spawn sem `CENTRAL_ORIGEM` só até o `initialize` (sem navegar, a extensão
   não conecta sem humano).
   — **prova:** `node -e "const {spawn}=require('child_process');const c=spawn(process.execPath,['scripts/run-mcp-server.cjs','--extension','--browser','chrome'],{env:{...process.env,CENTRAL_ORIGEM:''}});let e='';c.stderr.on('data',d=>e+=d);setTimeout(()=>{c.kill();console.log(/pw-ia|session temp/.test(e)?'tocou':'intacta')},4000)"` → `intacta`
   **reprova se:** `tocou`.
8. [ ] Docs: `FORK.md` § "Running the server from this fork", parágrafo novo depois de "AI-opened sessions never use
   the extension": **"AI-opened sessions get their own TEMP."** (pasta, `owner.json`, regra da varredura, limpeza na
   saída, `PLAYWRIGHT_MCP_SESSION_TEMP=0`, smoke); na tabela de patches, linha 1, citar `run-mcp-server.smoke.cjs`.
   `FORK.md` § "Testing gotchas": uma linha "o smoke lança Chromium de verdade e exige o carimbo em dia". Hub
   `C:\Dev\cerebro\projetos\playwright.md`: bullet novo de 1 linha com link para este md. Tema
   `C:\Dev\cerebro\temas\playwright-mcp.md` § sessão aberta por IA: 1 linha. `Edit` ancorado, nunca `Write`.
   — **prova:** `grep -c "pw-ia" FORK.md C:/Dev/cerebro/projetos/playwright.md C:/Dev/cerebro/temas/playwright-mcp.md` → cada arquivo com 1 ou mais
   **reprova se:** algum arquivo com `0`.
9. [ ] Commit por pathspec (`scripts/run-mcp-server.cjs scripts/run-mcp-server.test.cjs scripts/run-mcp-server.smoke.cjs
   FORK.md`), mensagem `feat(wrapper): AI sessions get their own TEMP, swept when their processes are gone (fork)`.
   `npm run flint` não cobre `scripts/*.cjs` de forma útil aqui; o gate desta fase são os passos 5–7. Levar à
   `main` e push seguem o `/executar` (worktree → `integrar.py`), não este passo.
   — **prova:** `git log -1 --format=%s -- scripts/run-mcp-server.cjs` → `feat(wrapper): AI sessions get their own TEMP, swept when their processes are gone (fork)`
   **reprova se:** outra mensagem (a mudança não foi commitada).
10. [ ] Propagar: `anotar_card cc44810c2c259` (faxina) com "origem MCP blindada: perfis do MCP de sessão `ia:*`
    agora nascem em `%TEMP%\pw-ia\<pid>` e somem na próxima largada; ver card lateral `cbf3ffaf58ead`". Buscar roadmaps
    abertos que citam o vazamento: `grep -rln "chromiumdev_profile" C:/Dev/central/roadmap C:/Dev/playwright/roadmap`
    e anotar no card dono de cada md encontrado (nunca editar md de outra sessão).
    — **prova:** `mcp__central__ver_card("cc44810c2c259")` → `detalhe` contém `pw-ia`
    **reprova se:** não contém.

### Fase 2 — medição em produção (agendada para 14/10/2026)

**Critério de aceite:**

- Dois dias de rodadas reais do maestro sem nenhum perfil novo do MCP na raiz do `%TEMP%`. Se falhasse: perfil
  completo (com `Last Version`) criado depois do commit da Fase 1 e casando com sessão `ia:*`.
- `%TEMP%\pw-ia` contém só pastas de sessões vivas. Se falhasse: pasta com todos os pids mortos sobrevivendo.

1. [ ] Contar perfis completos na raiz criados depois do commit da Fase 1 (`<T>` = data/hora do commit):
   — **prova:** `powershell -c "(Get-ChildItem $env:TEMP -Directory -Filter 'playwright_chromiumdev_profile-*' | Where-Object { $_.CreationTime -gt [datetime]'<T>' -and (Test-Path (Join-Path $_.FullName 'Last Version')) }).Count"` → `0`
   **reprova se:** maior que 0; aí cruzar com os logs `mcp-logs-playwright` (método do § Diagnóstico item 1) para
   saber se veio de sessão `ia:*` (bug da Fase 1) ou de outra fonte (lateral).
2. [ ] Conferir que `pw-ia` só tem vivos: para cada subpasta, ler `owner.json` e testar os pids.
   — **prova:** `node -e "const fs=require('fs'),p=require('path'),os=require('os');const r=p.join(os.tmpdir(),'pw-ia');const alive=x=>{try{process.kill(x,0);return true}catch(e){return e.code==='EPERM'}};let m=0;for(const d of fs.existsSync(r)?fs.readdirSync(r):[]){let o;try{o=JSON.parse(fs.readFileSync(p.join(r,d,'owner.json')))}catch{o={wrapper:+d.split('-')[0]}};if(![o.wrapper,o.server].filter(Boolean).some(alive))m++}console.log('mortas',m)"` → `mortas 0`
   **reprova se:** `mortas` maior que 0 (varredura não roda ou é vetada sempre; ler o stderr `session temp sweep` no log do MCP).
3. [ ] Registrar os números no sidecar e fechar o card pai.
   — **prova:** `ls C:/Dev/playwright/roadmap/2026-10-12-melhoria-temp-por-sessao-ia.d/` → contém o relatório da Fase 2
   **reprova se:** pasta ausente ou sem relatório.

## Priorização (impacto × esforço × risco)

| item | impacto | esforço | risco | veredito |
| --- | --- | --- | --- | --- |
| TEMP por sessão + varredura + limpeza na saída (Fase 1) | alto (~11 MB por sessão morta, origem de ~97% dos bytes medidos) | baixo (1 arquivo + testes) | médio (config viva; varredura apaga) | fazer agora |
| medição em produção (Fase 2) | médio (fecha o card com dado real) | baixo | nenhum | agendar 14/10 |
| `^pw-ia$` na faxina da central | baixo (defesa em profundidade) | baixo | baixo | lateral, sem urgência |
| perfis parciais da suíte e2e do `unclick` | baixo (<1 MB cada; a faxina cobre) | baixo | baixo | lateral, sem urgência |
| patch no `processLauncher` (retry no Windows) | baixo | médio | médio (diverge do upstream) | não fazer |

## O que NÃO fazer

- **Patch em `processLauncher.ts`/`browserType.ts`/`watchdog.ts`**: é código sincronizado com o upstream, e
  nenhum cleanup dentro do processo sobrevive a `TerminateProcess`. O timing do kill é do Claude Code e do maestro.
- **`--user-data-dir` em modo isolado**: `createIsolatedBrowser` (`browserFactory.ts:113`) chama `launch()`, que não
  aceita a opção; o persistente quebraria sessões concorrentes no `ProcessSingleton` (motivo do `--isolated`,
  comentário em `run-mcp-server.cjs:142`).
- **Varrer a raiz do `%TEMP%` pelo nome `playwright_chromiumdev_profile-*` no wrapper**: o wrapper não sabe se o
  perfil é de uma suíte de teste viva de outro projeto; isso é da faxina (por idade). O wrapper só varre o que ele
  mesmo criou (`pw-ia\<número>`).
- **Teto de idade que apaga pasta com pid vivo**: o reuso de pid só atrasa a limpeza; apagar por idade arrisca um
  servidor vivo. Reabrir só se a Fase 2 mostrar pasta presa.
- **TEMP próprio para sessão humana**: não lança Chromium (extensão); mexer nela é mexer por mexer.
- **`taskkill` na prova**: o hook `guarda-comando` bloqueia em modo maestro; `process.kill(pid)` do Node basta e
  reproduz a morte dura.

## Riscos e pré-requisitos

- **Config viva**: o wrapper roda em toda sessão do Claude Code; erro de sintaxe derruba o MCP de todas. Mitigação:
  passo 3 roda `node --check` e os testes antes de qualquer outro passo; as escritas novas estão todas em
  `try/catch` e degradam para o TEMP padrão.
- **Premissa: o servidor e o Chromium herdam o TEMP do wrapper.** Node (`os.tmpdir()`): medido. Chromium
  (`GetTempPath` lê `TMP` antes de `TEMP`): por isso os dois são exportados; o passo 6 confere o perfil dentro de
  `pw-ia\<pid>`.
- **Premissa: o Chromium sai quando o servidor morre** (transporte por pipe). Se não sair, o `rm` da varredura
  pega `EBUSY` e pula (D4), e o Chromium órfão vira outro problema (processo, não disco). O passo 6 (6) expõe isso:
  `pw-ia\<pid>` ainda existe, mas o (8) só passa se o Chromium tiver saído.
- **Reuso de pid** pode segurar uma pasta morta até o pid reutilizado morrer; a Fase 2 mede.
- **Fallback npx** (fork desatualizado): o env vai igual ao `npx` (`shell: true`), então o TEMP também vale lá.
- O smoke exige o fork compilado; se a sessão executora achar `isForkStale()` verdadeiro, compila antes
  (`npm run build`, ~25 s) e toca o carimbo.
- Sessões concorrentes no mesmo repo: arquivos desta fase (`scripts/run-mcp-server*.cjs`, `FORK.md`) não estão
  modificados no `git status` de 12/10 02:40; conferir de novo antes do primeiro `Edit`.

## Crítica do advisor

Modelo consultado: fable (advisor da sessão opus), duas vezes: antes de escrever e com o md gravado.

- 1ª consulta: separar as duas populações (MCP × suíte e2e do `unclick`) e mandar a segunda para card lateral;
  medir `os.tmpdir()` com `TEMP` trocado antes de escrever (medido); TEMP indisponível nunca bloqueia; laterais
  `^pw-ia$` na faxina e `unclick`. **Aplicado.**
- Pasta só com o pid + `rmSync` no arranque apagaria a pasta de um servidor vivo quando o Windows recicla o pid.
  **Aplicado:** nome `<pid>-<base36>`, sem reuso nem limpeza no arranque (D2, D5, passos 1, 4, 5).
- `PLAYWRIGHT_MCP_SESSION_TEMP=0` sem entrada de `env` na assinatura. **Aplicado** (passo 1, teste j).
- Smoke com `data:` esbarra na navegação restrita; `about:blank` basta. **Aplicado.**
- Contagem na raiz do `%TEMP%` no smoke é corrida com suíte de outro projeto. **Aplicado:** virou aviso; a prova
  do redirecionamento é o roteiro (4).
- Política de push dentro do passo 9. **Aplicado:** removida, é do `/executar`.
- `desde:` do pedido alinhado ao md da faxina (2026-10-01). **Aplicado.**
- Nada recusado.

## Sidecar

Relatórios de execução, decisões respondidas e veredito: `2026-10-12-melhoria-temp-por-sessao-ia.d/`.
