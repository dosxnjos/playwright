# Perfil do Chrome escolhido pela conversa, em tempo de execução (15/11/2026)

> Contrato para um executor que nunca viu a conversa de origem (sessão `2a309762`, 15/11/2026).
> Pedido do Gabriel, pela dev-bb: "eu sempre inicio todas as minhas conversas na pasta Dev". Ele quer dizer
> "usa o perfil da minha mãe" numa conversa aberta em `C:\Dev` e isso funcionar, sem as outras conversas mudarem.
> A tabela pasta → variante (`~/.claude/playwright-perfis.json`, commit `eb179e14c`) não cobre esse caso, porque
> todas as conversas começam em `C:\Dev`.

## Estado de partida

- Fork `dosxnjos/playwright`, `main` em `cc3c4071b`. Leia `FORK.md` inteiro, em especial § Agent routing (patch 6),
  § Running the server (tabela por pasta, script de token) e § Focus zero.
- O cofre de tokens já está completo no `env` do servidor (`~/.claude.json` → `mcpServers.playwright.env`), e
  cada servidor recebe o cofre inteiro:
  - variantes `PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variante>` e `PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variante>`;
  - variantes de hoje: padrao = Profile 13, gabriel_pessoal = Default, jacira = Profile 6, andressa = Profile 7,
    dosxnjos = Profile 14, sofia = Profile 3.
- Um servidor por conversa (stdio). Dentro dele, o `AgentRouter` (`mcp/agentRouter.ts`) cria um backend por agente
  chamador (`_meta.agente`).

## Decisão (técnica, desta sessão)

Opção escolhida: **uma ferramenta no fork, `browser_use_profile`**, que a conversa chama quando o assunto é de
outro perfil. Descartadas:
- **marcador por sessão + `/mcp` Reconnect:** dois passos, exige o humano e é frágil;
- **escolha pelo rótulo do grupo:** é mágica e erra calado.

| # | decisão | confiança | reverte se |
| --- | --- | --- | --- |
| D1 | `browser_use_profile({ profile })`, `profile` = nome de variante do cofre. A descrição da ferramenta lista as variantes disponíveis, lidas do env na partida, com a pasta do perfil e o nome que o Chrome dá ao perfil (`Local State` → `profile.info_cache[dir].name`). Assim o modelo mapeia "perfil da minha mãe" → `jacira` sem tabela de apelidos. | média | o nome do perfil no Chrome não ajudar o modelo; aí entra uma tabela local de apelidos |
| D2 | Escopo: **a conversa (o servidor)**. Vale para o agente principal e para os subagentes criados depois. Trocar com backends abertos fecha esses backends (as abas dos agentes fecham, como no desconectar); a próxima chamada reabre no perfil novo. | média | precisar de perfis diferentes para agentes da mesma conversa |
| D3 | A tabela por pasta continua sendo o padrão na partida; a ferramenta passa por cima dela. Sem ferramenta e sem tabela: `padrao`. | alta | — |
| D4 | Variante sem token ou sem perfil registrado: erro claro, listando as variantes válidas, sem trocar nada. | alta | — |
| D5 | Fora do modo extensão (sessão `ia:*`, Chromium isolado): a ferramenta não faz nada e responde que não se aplica, como o `browser_set_group_label` faz. | alta | — |
| D6 | Nenhum token aparece em resposta, log ou erro; só o nome da variante e a pasta do perfil. | alta | — |

## Fases

1. **Implementar** num worktree próprio
   (`git -C C:\Dev\playwright worktree add -b feat-use-profile C:\Dev\pw-use-profile origin/main`):
   - a ferramenta e a troca de token e perfil por servidor no ponto em que o relay da extensão é criado
     (`extensionContextFactory.ts`, `cdpRelay.ts` e `browserFactory.ts`, ou o caminho do `AgentRouter`);
   - o roteamento do patch 6 respeita a variante;
   - testes MCP para: troca antes da primeira navegação; troca depois (os backends fecham); variante inválida;
     modo não extensão;
   - o build da extensão não muda (o token vai no `connect.html`).
2. **Revisão adversarial** sem contexto, por duas lentes:
   - correção e concorrência: duas chamadas ao mesmo tempo, subagente no meio da troca;
   - vazamento de token, pelos logs `pw:mcp:*`.
3. **Docs:**
   - `FORK.md`: um patch novo na tabela e uma seção curta;
   - `C:\Dev\cerebro\temas\playwright-mcp.md` § Cofre de tokens: como a conversa escolhe o perfil.
4. **Virada:** só com o build pronto e revisado, no checkout `C:\Dev\playwright` (`npm run build`, pela fila `pesado`
   se o guarda pedir), numa janela sem agentes usando o navegador, coordenada com a dev-9c. As conversas passam a
   ter a ferramenta depois de `/mcp` → playwright → Reconnect. Caso de teste: a dev-bb (sessão `2b628993`) faz o
   passo 0 de `C:\Dev\univali-docs\docs\estado-2027-1.md` (repostar um PDF na intranet da Univali pelo Profile 6).

## Junto na mesma virada: consertos dos relatos da dev-bb (15/11)

Uma virada só, com um Recarregar só (extensão `0.5.0.4`). Antes do build, juntar numa branch de integração a partir
de `feat-use-profile`. Resultado completo do workflow `wf_410bb6f7-b28` no journal da sessão `2a309762`.
- `fix-beforeunload` (`e55ece846`): uma aba do agente com "Sair do site?" deixava o `browser_tabs close` pendurado,
  e no desconectar a aba não fechava. A revisão aprovou com ressalvas, e duas entram na integração:
  - o `dismissOpenDialog` só dispensa diálogo do tipo `beforeunload`, porque hoje ele fecha também
    alert/confirm/prompt numa aba que o usuário está olhando;
  - o teto de 5 s cobre o `dismissOpenDialog` também.
  A metade "handle_dialog devolve o modal velho" não se reproduziu.
- `fix-popup-page-closed` (`3ebb593c6`): a causa é um PDF num iframe; o Chrome desanexa a aba, e o conserto devolve a
  aba ao lugar dela e como aba atual. O erro "page closed" continua. Contorno para os agentes: interceptar com
  `page.route` o documento do subframe antes do clique. Ressalva: limpar o registro também no `selectTab`/`newTab`.
- download (sem código): é limitação de desenho do upstream (`noDefaults`). Entra uma linha no `FORK.md` § Known
  limitations, com o contorno de vigiar a pasta Downloads.
- `FORK.md`: patch 3 (diálogo), o ponto novo de conflito em `backend/context.ts`, e a divergência sobre "aba na
  frente" (linha ~498).

## Pronto quando

- Numa conversa aberta em `C:\Dev`, `browser_use_profile({profile:"jacira"})` seguido de `browser_navigate` abre no
  Profile 6, e as outras conversas continuam no Profile 13.
- Testes e revisão verdes; docs atualizados; a dev-bb confirmou o caso real.
