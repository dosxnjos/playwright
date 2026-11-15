# Relatório: revisão adversarial, correções e docs do `browser_use_profile` (15/11/2026)

Contrato: [`../2026-11-15-perfil-por-conversa.md`](../2026-11-15-perfil-por-conversa.md). Branch `feat-use-profile`
(worktree `C:\Dev\pw-use-profile`), sobre `4e5fb37c2`. Fases 1 a 3 feitas; **a virada (Fase 4) não foi feita**: os
passos estão no fim deste arquivo. Nada foi feito no checkout `C:\Dev\playwright`.

## Achados da revisão (Fase 2) e o que virou

Cada correção tem um commit e um teste que falhou antes e passou depois (rodado nos dois estados).

| # | gravidade | achado | veredito | commit | teste (`tests/mcp/use-profile.spec.ts`) |
| --- | --- | --- | --- | --- | --- |
| 1 | média | chamada que já esperava o backend roda no perfil antigo depois da troca | confirmado: `isError` vazio e a chamada servida pelo backend `env` | `6f1e7a519` | "a switch while main is still connecting…": a chamada responde "Not run: … Call it again" e nenhum backend `env` serve nada |
| 2 | média | de duas trocas simultâneas, a resposta tardia cita o perfil errado; "Closed" mesmo sem fechar | confirmado: respondeu "Now using profile jacira" com andressa em uso | `a00286176` | "two switches at the same time…": erro que nomeia o perfil em uso, e "still closing" quando a espera vence (espera curta por `PWTEST_USE_PROFILE_SWITCH_WAIT_MS`) |
| 3 | média | o rótulo do grupo some na troca e nada avisa | confirmado | `c552dd3ac` | "a switch closes the backends…": a resposta e o aviso de quem tinha rótulo pedem `browser_set_group_label` de novo |
| 4 | média | subagente no meio da troca segue no perfil novo sem aviso | confirmado: `browser_type` respondeu só "browser_type" | `a109cb156` | "an agent whose browser another agent's switch closed is told so…": aviso único no próximo resultado, a chamada em voo diz que talvez não tenha valido, o main é avisado quando um subagente troca |
| 5 | leve | pedir a variante inicial fecha tudo quando a pasta vem de `--profile-dir-name` | confirmado: "Now using profile padrao" | `2de531295` | servidor real com `--profile-dir-name` e sem a variável: "Already using" |
| 6 | leve | `browser_set_group_label` em voo grava o rótulo velho depois da troca | confirmado no roteador: `velho · agente-s1` | `bdfe33924` | mesmo teste do item 3: o grupo do subagente novo sai `test · agente-s1` |
| 7 | média | Chrome que não sobe despeja no stderr a URL com o token e derruba o servidor | confirmado: servidor morreu ("Connection closed") | `f69b053c3` | "a browser that cannot start…": erro `Could not start the browser at <caminho>: ENOENT`, servidor vivo na segunda chamada, nenhum `dummy-*` no stderr. O script de sondagem do revisor também deixou de vazar |
| 8 | média | qualquer agente troca para qualquer conta do cofre (alcance de injeção) | confirmado por leitura (é o D2) | `36b8569cc` | "PLAYWRIGHT_MCP_USE_PROFILE_ALLOW limits…": lista de permissão opcional; sem ela, comportamento de antes |
| 9 | leve | a descrição expõe o nome do Chrome, que pode ser e-mail | confirmado | `4e6c784ee` | teste da descrição: nome do Chrome só sem apelido e nunca com `@` |
| 10 | leve | o token vai na linha de comando do Chrome | confirmado, **sem mudança** (já era assim com o token ativo; mudar exige mexer na extensão) | — | registrado no `FORK.md` |

Nenhum achado foi refutado.

Um achado a mais, visto pelo advisor durante as correções: um agente avisado de uma troca guardava o aviso velho se
uma segunda troca viesse antes da próxima chamada dele. O aviso citava um perfil que já não estava em uso.
Confirmado e corrigido em `df2929565`: o último aviso substitui os anteriores e mantém o pedido de rótulo. O teste é
o mesmo "told so", estendido.

Decisões técnicas tomadas aqui (as mais reversíveis):
- **Item 1:** devolver erro, sem repetir a chamada no perfil novo. A repetição agiria numa conta que quem chamou não
  escolheu.
- **Item 3:** pedir o rótulo de novo, sem reaplicar sozinho. O Profile 6 roda a extensão da loja (`0.5.0`), que não
  tem o comando de rótulo, e a reaplicação ia falhar calada.
- **Item 8:** a lista de permissão é opcional e o perfil de partida fica sempre. **Ligar ou não é decisão do Gabriel**
  (pendência abaixo).

## Testes finais

Rodados no worktree, com o build refeito depois do último commit de código (`df2929565`). Todos com
`env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION`.

- **Arquivos MCP do fork** (`npx playwright test --config=tests/mcp/playwright.config.ts --project=chrome`, os 9
  arquivos de group-label, capabilities, tabs, core, agent-routing, agent-silent, screenshot, cookies e use-profile):
  88 passed, 1 failed.
  - A falha é `agent-routing.spec.ts:214`, a da espera de 10 s pela pasta de marcadores, que o `FORK.md` já dá como
    instável com a máquina carregada. Sozinha, com `--repeat-each=3`, passou 3/3.
  - Nota: o `ctest-mcp -- <filtro>` passado pelo `pesado` roda a suíte inteira. Por isso os filtros foram por arquivo.
- **`tests/mcp/use-profile.spec.ts`**: 12 testes, todos passando. 5 são novos ou foram estendidos por esta revisão.
- **Suíte MCP inteira** (869 testes, numa rodada intermediária, antes do conserto do aviso velho `df2929565`): 843
  passed, 22 skipped, 4 failed.
  - `agent-routing:214` e os dois de `http.spec.ts` (`:578`, `:650`) passaram sozinhos.
  - `storage.spec.ts:172` ("--storage-state com remoteEndpoint") falha 3/3 também sozinho. **Causa não explicada.**
    O servidor para logo depois de `create browser (remote)`, enquanto um `chromium.connect` direto ao mesmo tipo de
    servidor conecta em 73 ms. Nenhum arquivo do diff da branch está nesse caminho (`createRemoteBrowser`, com o
    roteador desligado por `remoteEndpoint`). Fica fora da lista de filtros do fork, então não bloqueia. Hipótese
    não provada: o `serverRegistry.find` lê o registro de navegadores da máquina, onde há os de outras sessões.
- **Suíte de extensão inteira** (`--config=tests/extension/playwright.config.ts --workers=3`): 95 passed, 6 failed.
  As seis falhas são as de ambiente do `FORK.md` § Testing gotchas: `extension.spec.ts` `:324`, `:336`, `:356` e
  `:368`, `tab-dragging.spec.ts:35` e `tab-management.spec.ts:123`.
  - Duas rodadas anteriores com 7 workers deram 10 e 21 falhas. A primeira rodou ao mesmo tempo que o flint e um
    build do worktree. A segunda deu `ERR_FILE_NOT_FOUND` em `manage.html` e "Timeout setting up user", com outras
    sessões rodando testes na máquina.
  - As quatro a mais da primeira rodada passaram sozinhas: `extension.spec.ts` `:101`, `:116`, `:125` e `:172`, que
    passam pelo spawn que o `f69b053c3` mudou. A rodada limpa com 3 workers fecha a questão.
- **`tests/extension/use-profile.spec.ts`** (com a verificação nova do aviso ao subagente, `7a0f50840`):
  `--repeat-each=3`, 3 passed.
- **`node scripts/run-mcp-server.test.cjs`**: 30/30.
- **`pesado npm run flint`**: exit 0.
  - A primeira rodada pegou 3 erros de estilo em `useProfile.ts`, corrigidos em `b9046ba1e`.
  - Desta vez o `doc` passou no Windows.
- **Script de sondagem do revisor** (`spawnprobe.cjs`, executável inexistente): o servidor não sai mais, e não há
  `dummy-*` no stderr nem no stdout.

## Docs (Fase 3)

- `FORK.md` (commit `384fb8555`):
  - patch 9 na tabela;
  - seção "Profile per conversation (patch 9)", com as regras de concorrência, a lista de permissão como limitação
    de segurança, o token na linha de comando e o modo sem roteador;
  - o filtro `use-profile` na conferência do sync;
  - os pontos novos de conflito em `cdpRelay.ts`.
- `C:\Dev\cerebro\temas\playwright-mcp.md` § Cofre de tokens: um parágrafo sobre como a conversa escolhe o perfil
  (commit `79808ea3` no repo `C:\Dev`, enviado).

## Pendências e decisões

- **Gabriel decide:** ligar `PLAYWRIGHT_MCP_USE_PROFILE_ALLOW` no `env` do `~/.claude.json`, por exemplo
  `padrao,jacira`. Sem a variável, qualquer agente pode pôr a conversa logada em qualquer conta do cofre (Default,
  Profile 7…). Recomendação: ligar com `padrao,jacira`, que é o que se usa hoje, e acrescentar perfis quando
  precisar.
- **A `main` andou:** `20cce6e22` só mexe no roadmap, e acrescenta a seção "Junto na mesma virada". A branch não foi
  rebaseada, porque push com force é proibido aqui. Na integração, trazer a `main` (merge). Conflito esperado: a
  linha D1 do roadmap; vale a versão da branch, mais a seção nova da `main`.
- **O arquivo de apelidos ainda não existe** (`~/.claude/playwright-apelidos.json`). Sem ele, "perfil da minha mãe"
  depende de o modelo já saber quem é a jacira. Ele é criado no passo 6 da virada.
- **`storage.spec.ts:172` falha neste worktree** com causa não explicada (detalhe em "Testes finais"). Vale
  conferir na integração se ele também falha na `main`.
- **Ainda não verificado:**
  - a troca no Chrome de verdade;
  - o Profile 6 com a extensão da loja: rótulo e fechamento das abas do agente faltam lá, segundo o `FORK.md`;
  - o modo HTTP com vários clientes.

## Fase 4: a virada (não feita)

Pré-condições:
- uma janela **sem agentes usando o navegador**, coordenada com a dev-9c;
- **zero servidores MCP rodando do checkout** durante o build (regra do `FORK.md` § Syncing): os ~11 servidores
  rodam do `lib/` dele.

1. **Integrar num worktree, nunca no checkout.** Se a virada leva junto os consertos da dev-bb (seção "Junto na
   mesma virada" do contrato), a branch de integração nasce de `feat-use-profile` e recebe `fix-beforeunload` e
   `fix-popup-page-closed`, com as ressalvas listadas lá. Só com o `browser_use_profile`, use a própria
   `feat-use-profile`. Nos dois casos, traga a `main`:
   ```bash
   cd C:\Dev\pw-use-profile            # ou o worktree de integração
   git fetch origin
   git merge origin/main               # conflito na linha D1 do roadmap: fica a da branch + a seção nova da main
   pesado npm ci && pesado npm run build
   env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION npx playwright test --config=tests/mcp/playwright.config.ts --project=chrome group-label capabilities tabs core agent-routing agent-silent screenshot cookies use-profile
   env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION npx playwright test --config=tests/extension/playwright.config.ts
   node scripts/run-mcp-server.test.cjs
   git push origin <branch>
   ```
2. **Marcar o ponto de volta** (no checkout, depois de conferir que a `main` local = `origin/main`):
   ```bash
   cd C:\Dev\playwright
   git fetch origin && git status -sb          # main sem commits locais
   git tag fork-pre-perfil-2026-11 main && git push origin fork-pre-perfil-2026-11
   ```
3. **Virar** (fast-forward, sem force: a branch contém a `main` depois do merge do passo 1):
   ```bash
   git merge --ff-only origin/<branch>
   pesado npm ci && pesado npm run build && touch scripts/.build-stamp   # sem o stamp, o wrapper cai no npx
   git push origin main
   ```
   Os arquivos sem rastreio do checkout (`roadmap/*-draft.md`, `packages/playwright-ct-core/`) não colidem com a
   branch.
   ⚠️ Entre o fast-forward e o `touch scripts/.build-stamp`, nenhuma conversa nova e nenhum Reconnect. Um servidor
   que suba nessa janela vê o build vencido, roda o npx e dispara um build destacado (`scripts/.build-lock`), que
   disputa com o manual.
4. **Extensão:** só a `feat-use-profile` não muda a extensão, então não há Reload. Se entrarem os consertos da
   dev-bb, haverá extensão `0.5.0.4`: fazer o Reload em `chrome://extensions` no Profile 13, sem agente conectado.
5. **Em cada conversa aberta:** `/mcp` → playwright → Reconnect. Só depois disso a conversa ganha a ferramenta.
6. **Apelidos:** criar `~/.claude/playwright-apelidos.json` (local, nunca versionado), por exemplo
   `{ "jacira": ["minha mãe", "mãe"], "padrao": ["Nomura", "trabalho"], "gabriel_pessoal": ["meu perfil pessoal"] }`.
   Se o Gabriel decidir, acrescentar também `PLAYWRIGHT_MCP_USE_PROFILE_ALLOW` no `env` do `~/.claude.json`.
   Os dois só valem numa conexão nova.
7. **Prova:**
   - numa conversa em `C:\Dev`, `browser_use_profile({profile:"jacira"})` e depois `browser_navigate` abrem no
     Profile 6;
   - outra conversa continua no Profile 13;
   - conferir `browser_set_group_label` depois da troca, porque a extensão da loja no Profile 6 não tem o comando;
   - depois, o caso real da dev-bb (passo 0 de `C:\Dev\univali-docs\docs\estado-2027-1.md`), ou a conferência só de
     leitura com a dev-c8, conforme o hub.

### Reversão

- **Sem rebuild:** pôr `PLAYWRIGHT_MCP_USE_PROFILE_ALLOW` com um nome que não existe (por exemplo `nenhum`). A
  ferramenta passa a listar e aceitar só o perfil de partida, então trocar fica impossível. Vale depois do Reconnect.
- **Código:**
  ```bash
  cd C:\Dev\playwright                 # zero servidores rodando do checkout
  git reset --keep fork-pre-perfil-2026-11
  pesado npm ci && pesado npm run build && touch scripts/.build-stamp
  git push --force-with-lease origin main    # só se a virada já foi para o origin; precisa do OK do Gabriel
  ```
  Depois, `/mcp` Reconnect em cada conversa. Se a virada trocou a extensão, Reload no Profile 13.
