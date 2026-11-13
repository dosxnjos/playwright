# Fase 3: ensaio ao vivo sem tocar no Chrome do Gabriel (13/11/2026)

Branch `sync-2026-11` no worktree `C:\Dev\pw-sync-1112`, build em dia (`scripts/.build-stamp` tocado depois do build).
Nada rodou no checkout `C:\Dev\playwright`, no Chrome do Gabriel nem pelos MCP do Claude Code.

## Como foi rodado

Script: [`ensaio.cjs`](ensaio.cjs) (nesta pasta). Ele:

- abre um **Chromium de teste** (canal `chromium`, revisão 1254 = 158.0.8127.18, headless, perfil temporário na pasta
  de rascunho da sessão) com a extensão do `packages/extension/dist` (`0.5.0.3`);
- lê o token da extensão na página "Manage clients" desse perfil (token de teste, não o do Gabriel);
- sobe **dois servidores MCP pelo wrapper** (`node scripts/run-mcp-server.cjs --extension --browser chromium`), dois
  processos com o **mesmo clientName** (`claude-code`), como duas abas do Claude Code, falando stdio com um cliente MCP
  do próprio script; o `tests/extension/chrome-stub.js` faz o papel do `chrome.exe`;
- com `PWTEST_CHROME_STUB_FOREGROUND=1` o stub ignora `--open-in-background`, como o **Chrome 157 do Gabriel** faz: a
  primeira página de conexão de cada processo abre **na frente**;
- tira do ambiente toda `PLAYWRIGHT_MCP_*`, `CENTRAL_ORIGEM` e `DEBUG` herdadas (o token real nunca chega ao teste);
- fecha só o que abriu (os dois clientes e o contexto do Chromium de teste pela API; nenhum `taskkill`).

Comando:

```bash
cd C:\Dev\pw-sync-1112
touch scripts/.build-stamp
env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION -u PLAYWRIGHT_MCP_PROFILE_DIR_NAME \
  node roadmap/2026-11-12-sync-upstream-pos-44047.d/ensaio.cjs <pasta de rascunho>
```

## Resultado (saída real, 13/11)

| item do roteiro | resultado | evidência |
| --- | --- | --- |
| extensão carregada | VERDE | `{"versao":"0.5.0.3","chromium":"158.0.8127.18"}` |
| 1. 2 conexões com o mesmo `clientName`, cada uma rotula o grupo | VERDE | grupos `Playwright · ensaio-A` (green, `A-main`) e `Playwright · ensaio-B` (blue, `B-main`) |
| 1b. as duas primeiras páginas de conexão abriram na frente (Chrome 157 simulado) e a aba do usuário voltou | VERDE | aba ativa `["Front"]` |
| 2. subagente abre aba em segundo plano, sem roubar foco, pelo portador | VERDE | grupo `Playwright · ensaio-A · gp-abcd` (purple, `A-sub`); aba ativa `["Front"]`; lançamentos do "chrome.exe" 2 → 2 (o subagente não abriu o navegador); log `Connect page opened via portador` presente |
| 3a. print de aba escondida < 60 s, janela sem foco (revela e devolve) | VERDE | 140 ms, `revealed=true`, aba ativa depois `["Front"]` |
| 3b. print de aba escondida < 60 s, janela com foco (não revela) | VERDE | 87 ms; `pw:mcp:shot screenshot viewport background=true timeout=60000 took 77ms ok` |
| 4. desconectar fecha as abas do agente e solta as do usuário | VERDE | `A-main` e `A-sub` fechadas; `User-in-A` (arrastada pelo usuário para o grupo de A) ficou no grupo `Playwright · ensaio-A` cinza; `B-main` intacta |
| 5. `browser_cookie_delete` por nome e por domínio funciona; `browser_cookie_clear` sem filtro é recusado | VERDE | `clearCookies({ name: 'drop' })` e `clearCookies({ name: 'other', domain: '127.0.0.1' })` sem erro, os dois somem da lista, `keep` fica; limpar: `Storage.clearCookies is not allowed: it changes the state of the browser, not of the tab`. Depois da revisão: apagar só vale para cookie de um site onde o agente tem aba (apagar por nome um cookie que também existe em outro site é recusado com o nome do site; passar `domain` resolve) |
| 6. smoke do wrapper (`scripts/run-mcp-server.smoke.cjs`) | VERDE | `smoke ok`; contraprova com `PLAYWRIGHT_MCP_SESSION_TEMP=0` → `smoke FAIL 4` (esperado) |

Vermelho: nenhum. Rodado de novo depois das correções da revisão adversarial do diff (commits `46012581b` e
`4a58ac010`): os 8 itens verdes outra vez (3a: 151 ms com `revealed=true`; 3b: 87 ms), `smoke ok`, `27/27 passed`.

## O que o ensaio não prova (levar para a Fase 4)

- **Headless não é o Chrome 157 de verdade.** O "abre na frente" foi simulado pelo stub; o foco de janela do sistema
  (`windows.update({focused:false})` devolvendo o foco ao terminal) e o print lento de aba escondida (12–31 s medidos em
  03/10 no Chrome real; no headless sai em ~100 ms) só aparecem no Chrome dele. Na Fase 4, conferir `pw:mcp:relay`
  (`Relay created, background=true`, `Connect page opened via portador`, `Capture of tab N: revealed=…`) e
  `pw:mcp:shot … took Nms` no primeiro dia.
- **Permissão nova `webNavigation`**: no Reload o Chrome pode pedir para aceitar "ler seu histórico de navegação".
  Sem aceitar, a extensão fica desativada naquele perfil.
- **Aba fantasma/queda de 09/11**: a hipótese 1 (chamada > 120 s derruba o servidor) não muda com este sync.

## Fase 4: liberada, com estes passos e esta reversão

Estado na hora deste relatório: `main` do fork = `d8a1a567e` (a tag `fork-pre-sync-2026-11` = `78989ed37` é anterior a
um commit só de `roadmap/`). Nenhum arquivo sem rastreio do checkout é rastreado pela branch (conferido: o
`reset --keep` não vai recusar por isso; `packages/playwright-ct-core/` não existe na branch).

Antes (janela 22h–7h, **zero servidores MCP rodando do checkout**, regra do commit `d8a1a567e`):

```bash
cd C:\Dev\playwright
git fetch origin
# 1) se a main andou depois de d8a1a567e (só roadmap/), trazer roadmap/ dela para a branch no worktree e commitar lá
git -C C:\Dev\pw-sync-1112 checkout main -- roadmap/ && git -C C:\Dev\pw-sync-1112 commit -m "docs(roadmap): ..." -- roadmap/
# 2) tag D-0 no SHA da main do momento (a fork-pre-sync-2026-11 é mais velha)
git tag fork-pre-virada-2026-11 main && git push origin fork-pre-virada-2026-11
# 3) virada
git reset --keep sync-2026-11
npm ci && npm run build && touch scripts/.build-stamp
# 4) só com o OK do Gabriel
git push --force-with-lease origin main
```

Reversão (pronta):

```bash
cd C:\Dev\playwright
git reset --keep fork-pre-virada-2026-11
npm ci && npm run build && touch scripts/.build-stamp
git push --force-with-lease origin main   # só se a virada já tiver ido para o origin; OK do Gabriel
```

e **Reload** da extensão (`chrome://extensions`) em cada perfil que usa a cópia unpacked, sem agente conectado (o
Reload apaga o `chrome.storage.session`). Se a tag D-0 não tiver sido criada: `git reset --keep d8a1a567e` (ou o SHA
anotado no passo 2).

**Depende do Gabriel:** o OK do `git push --force-with-lease origin main` (regra do `FORK.md` § Syncing) e o Reload
da extensão nos perfis `Profile 13`, `Profile 7`, `Default` e `Profile 6` (pode pedir clique para aceitar a permissão
`webNavigation`).
