## Relatório de execução — Fase 1 (2026-10-16, sessão d3498ef2)

Card `cde7c5dc61118` (executor headless do maestro, checkout principal `C:\Dev\playwright`, D11). Commits na `main`:
`13b319f03` (teste vermelho), `931b6e03a` (conserto + smoke + FORK.md), `09727db8b` (teste do caso o), `a77f49b45` (smoke exige artefatos).

frescor: ok (4 dias; 0 commits em `scripts/`, `FORK.md` ou `tools/mcp` desde 12/10 00:00 além dos do próprio contrato; `scripts/run-mcp-server*.cjs` sem modificação alheia no `git status`).

## O que foi feito, por passo

1. `prepareSessionTemp` / `sessionTempRoot` em `scripts/run-mcp-server.cjs`. Prova do md: `true 4242 null` (coberta pelos casos h, i, j). `+` a pasta meio-feita (ENOSPC no `owner.json`) é removida; `owner.json` é gravado por `rename` atômico.
2. `envForAiSession(env, origem, sessionTemp)`: `TEMP`/`TMP`/`TMPDIR`. Caso k: `S S S` na sessão de IA, `T` na humana e com `sessionTemp` nulo.
3. `runAndExit` devolve o `child` e aceita `options.onExit` (síncrono, uma vez, antes do `process.exit`/`kill`, nos ramos `exit` e `error`, dentro de `try/catch`). `main` só mexe quando `argv !== rawArgv`; `recordServerPid` regrava o `owner.json` depois do spawn. Os 12 testes antigos seguem `ok`.
4. `sweepSessionTemps` / `scheduleSessionTempSweep` / `isPidAlive` (todos exportados) e a asserção estrutural estendida.
5. Teste: 27/27 (os 24 do contrato mais `+` m liveness, n `onExit`, o falha após o mkdir). Detalhe das provas abaixo.
6. Acervo `run-mcp-server-test-*`: já estava em **0** quando a fase começou (alguém limpou antes); a prova do md dá `0`. Nada apagado por esta sessão.
7. `scripts/run-mcp-server.smoke.cjs`: `smoke ok` (~13 s). Contraprova `PLAYWRIGHT_MCP_SESSION_TEMP=0` → `smoke FAIL 4`.
8. Sessão humana: `intacta`.
9. FORK.md feito (parágrafo "AI-opened sessions get their own TEMP.", linha 1 da tabela, "Testing gotchas"). Hub e tema do cérebro **não** feitos (ver desvio `ambiente`).
10. Commits por pathspec; pre-commit `Passed`; push na sequência (ver "Commit e push").
11. Propagação abaixo.

## Provas (comando → saída)

- `node scripts/run-mcp-server.test.cjs` → `27/27 passed`; no `%TEMP%` real, `run-mcp-server-test-*` antes 0, depois 0.
- **Vermelho do teste** (commit `13b319f03`, contra o wrapper antigo): `11/26 passed`; falhas `wrapper.sweepSessionTemps is not a function`, `prepareSessionTemp is not a function`, `isPidAlive is not a function`, env (k) e o estrutural `scheduleSessionTempSweep comes after every runAndExit in main()`.
- **Vermelho do vazamento do runner** (teste antigo `61a824ee9` com `TEMP`/`TMP` apontando para `temp/wip/t`): deixou **9** `run-mcp-server-test-*`; o novo deixou **0**.
- **Mutantes do wrapper contra o teste unitário** (9 de 9 mortos): D3 servidor ignorado → FAIL sweep (c); D5 regex removida → FAIL (d); `ownDir` removido → FAIL (e); D6 idade removida → FAIL (f); `EPERM` = morto → FAIL liveness (m); `onExit` não roda no `error` → FAIL exit hook (n); `onExit` depois do `process.exit` → FAIL (n); varredura fora do `main` → FAIL estrutural; `TMP` não exportado → FAIL env (k). Mais um (rm do catch do `prepareSessionTemp` removido) → FAIL caso (o).
- **Mutantes do wrapper contra o smoke** (4 de 4 mortos): `SESSION_TEMP=0` → `FAIL 4`; env sem redirecionar → `FAIL 4`; varredura nunca agendada → `FAIL 8: the dead session folder survived the next launch`; sem `onExit` → `FAIL 8: the clean exit left … behind`.
- Smoke final (depois do `a77f49b45`, que exige também `playwright-artifacts-*` dentro da pasta da sessão): `smoke ok`; contraprova `smoke FAIL 4`. `%TEMP%\pw-ia` sem resto do smoke.
- Teste-de-fumaça em produção sem querer: um executor vizinho subiu o MCP depois da troca e criou `pw-ia\51216-…` com `owner.json {wrapper, server}` válidos (sem navegar, então sem perfil). O smoke e o revisor viram a varredura poupá-lo.

## aceite

- Sessão de IA que navega e morre dura não deixa perfil nem artefatos na raiz → smoke (4): `playwright_chromiumdev_profile-*` e `playwright-artifacts-*` dentro de `pw-ia\<wrapper>-*`; (6): a pasta morta existe; (8): some na largada seguinte. Aviso de perfil novo na raiz não disparou.
- Término normal não deixa nada → smoke (8): `sessionDirs(second.pid)` vazio depois do `stdin.end()`; caso n (`onExit` nos dois ramos).
- Sessão humana e disco cheio continuam subindo → passo 8 `intacta`; casos h/o (falha ao criar → `null`, log, sem pasta); contraprova `SESSION_TEMP=0`: o servidor respondeu `initialize` e `navigate` com o TEMP padrão antes do `FAIL 4`.
- Rodar o teste não deixa pasta → 9 → 0 (vermelho do vazamento acima) e `antes=0 depois=0` no `%TEMP%` real.

## completei

- `+` caso m (liveness `EPERM`/`ESRCH` com `process.kill` trocado): sem ele o mutante "EPERM = morto" sobrevivia, pois todos os outros casos injetam `isAlive`.
- `+` caso n (`onExit` nos ramos `exit` e `error`, hook que lança): a limpeza na saída não tinha prova fora do smoke.
- `+` caso o e o `rm` no `catch` de `prepareSessionTemp` (achado do revisor: ENOSPC no `owner.json` deixava pasta órfã).
- `+` `owner.json` por `rename` (leitura da varredura vizinha nunca vê JSON pela metade); comparação de `ownDir` por nome minúsculo; `isPidAlive` trata qualquer erro que não seja `ESRCH` como vivo.
- `+` smoke com `try/finally` (`cleanUp`: fecha o stdin, espera 20 s, só então `kill`), poll até o `lockfile` do Chromium sumir em vez de "espera 3 s", checagem de `isForkStale()` (`smoke FAIL 0`), aviso de perfil **ou** artefatos novos na raiz, `RUN_MCP_SERVER_PATH` para rodar mutantes.
- `+` `isForkStale` e `runAndExit` exportadas.

## Decisões técnicas — Fase 1

- **Dois commits e o teste vermelho primeiro** (regra de 10/10, card `tipo: "bug"`), em vez do commit único do passo 10. Motivo: a regra da casa vence o texto do md; o conserto não toca o arquivo de teste (o caso o foi em commit próprio depois). Confiança alta. Reverteria: nada, é só ordem de commits.
- **O wrapper vivo foi trocado por cópia inteira** (`cp` de `temp/wip/` depois de testar a cópia com `RUN_MCP_SERVER_PATH`, `node --check` e 9 mutantes): é config viva de três executores vizinhos. Confiança alta.
- **D2/D12 corrigidas por medição (16/10):** no Windows o libuv põe cada filho num job object `KILL_ON_JOB_CLOSE`; matar o wrapper (`TerminateProcess`) mata o servidor e o Chromium junto. Experimento mínimo (`temp/wip/exp.cjs`: pai → filho → neto, `kill` no filho): neto morre em <1,5 s mesmo com o pipe do avô aberto. Consequências: (a) o roteiro (5) do smoke não separa as duas mortes, ele mata o wrapper e confere que servidor e Chromium sumiram (mata o servidor só se ainda vivo); (b) o `owner.json.server` é redundante no Windows, mas a regra "pasta morta = todos os pids mortos" continua certa em outro SO e custa nada; (c) a pasta da sessão morta fica completa e destravada, que é o que a varredura remove. Confiança alta (medido duas vezes). Reverteria: nada no código.
- **`isPidAlive`: qualquer erro ≠ `ESRCH` = vivo** (o md só nomeava `EPERM`): errar para "vivo" só atrasa a limpeza. Confiança alta.
- **Smoke não mata servidor por pid na limpeza** (achado do revisor: pid reciclado). O job object já o derruba. Confiança alta.
- **Cérebro fora da jaula:** não usei `CEREBRO_ROTAS_OFF`. Duas linhas viram o card lateral `c4eb82180433f` (sem urgência) com o texto exato e os pontos de ancoragem; também no fragmento do diário. Confiança alta.

## Revisão adversarial e advisor

- Revisor de contexto zero (`revisor-diff`) leu o diff staged, rodou teste (26/26) e smoke (`smoke ok`): sem defeito que derrube o MCP, apague pasta viva ou alheia. 6 achados de baixa gravidade: corrigidos o 1 (kill por pid reciclado no smoke), o 2 (pasta meio-feita) e o 4 (comentário contradizia a medição). Registrados e aceitos: 3 (pid reciclado vira vazamento, nunca apagamento: direção segura; a Fase 2 mede), 5 (`onExit` pode segurar a saída ~3 s só se o Chromium ainda tiver arquivo preso: o resto vai para a varredura), 6 (pasta do primeiro lançamento fora de `created` se o `initialize` estourar 30 s: o `onExit` e a varredura recolhem).
- advisor: consultado duas vezes (fable): antes de editar (teste vermelho primeiro; wrapper montado em cópia; `isPidAlive` testado direto; smoke com `finally`; não contornar o `guarda-comando` no passo 6; sem `pull --rebase`) e no fim (smoke exigir `playwright-artifacts-*`: aplicado, passou; vermelho do vazamento do runner: aplicado; passo 9 sem `CEREBRO_ROTAS_OFF` e sem `[[PARCIAL]]`: aplicado; nota no card da Fase 2: feita). Nada recusado.

## propagou: 4 cards, 0 mds

- Anotados: `cc44810c2c259` (faxina, origem blindada), `cbf3ffaf58ead` (faxina enxerga `pw-ia`: estrutura e liveness), `cffad2d29c092` (Fase 2: `<T>` = `931b6e03a`, janela até 18/10 ou depois, 27 casos, fato do job object), `ce76ded67afbc` (faxina Fase 3: `pw-ia` com pid vivo é sessão em curso).
- Roadmaps que citam `chromiumdev_profile`: `central/roadmap/2026-10-11-melhoria-faxina-do-temp.md` (cards já anotados acima), `central/roadmap/2026-09-30-melhoria-temp-dos-testes.md` (só exemplo de nome de pasta; não afetado), este md.
- Card novo lateral, sem urgência: `c4eb82180433f` (hub e tema do cérebro).

## Desvios

- `ambiente`: o `guarda-escrita` da sessão headless só libera escrita fora do cwd do card para o próprio fragmento; o passo 9 ficou pela metade (FORK.md feito; `cerebro/projetos/playwright.md` e `cerebro/temas/playwright-mcp.md` no card `c4eb82180433f`). O `[x]` do passo 9 **não** foi marcado.
- `terreno`: premissa do job object (D2/D12) e acervo do passo 6 já zerado.

## Arquivos tocados

`scripts/run-mcp-server.cjs`, `scripts/run-mcp-server.test.cjs`, `scripts/run-mcp-server.smoke.cjs` (novo), `FORK.md`, este md (`[x]` e prova 24→27) e este relatório. Fora do repo: fragmentos de placar e de diário no cérebro. `temp/wip/` (gitignorado) apagado ao fim.

## Pendências e decisões pendentes

- `c4eb82180433f` (cerebro, sem urgência): aplicar as duas linhas do passo 9 no hub e no tema. Dono: fable.
- Fase 2 (`cffad2d29c092`, agendada para 14/10): reagendar para depois de 18/10; as provas e o `<T>` estão na nota do card. Dono: fable.
- Nenhuma decisão de Gabriel ou Andressa.
