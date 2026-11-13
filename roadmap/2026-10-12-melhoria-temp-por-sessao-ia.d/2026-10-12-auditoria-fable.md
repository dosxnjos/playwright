## Auditoria do md — 2026-10-12 03:35 (sessão fable `a9c748ef`, retomada do card `c40ff28b01d02`)

**Por que esta rodada existiu:** a rodada opus de 02:56 fechou o desenho (commit `5e1cdbd46`) e o maestro
leu `[[FALHOU]] gate (pre-commit) reprovado`. Causa: **ambiente**, não raciocínio: o repo não tinha
`.pre-commit-config.yaml`, o pre-commit 4.6.0 sai rc 1 com `is not a file` e o classificador da central
(`tools/backup_e_auditoria.py:1430`) só reconhece a mensagem antiga `No .pre-commit-config.yaml`. A escalada
ficou registrada como classe `raciocinio`; o card `c40ff28b01d02` recebeu a correção em nota.

**O que esta rodada fez:**

- md auditado e reescrito no lugar (29 edições cirúrgicas; o resumo está no rodapé `> Auditado em 2026-10-12`).
  Mudanças de desenho: D10 (yaml do fork), D11 (executor no checkout principal), D12 (ordem de kill no smoke:
  wrapper primeiro); passos renumerados 1–11; passo 6 novo (acervo de `run-mcp-server-test-*`); JSON-RPC literal;
  `FAIL 3`/`FAIL 6` novos; commit + push no passo 10 (push é do executor: o hook `guarda-comando` barra o
  arquiteto, medido nesta rodada); Fase 2 com o passo 3.
- `.pre-commit-config.yaml` do fork + parágrafo e linha da tabela no `FORK.md`: commit `b01a9610e`.
- Provas rodadas: `pre-commit run --files roadmap/<este md> .pre-commit-config.yaml FORK.md` → `Skipped`, rc 0;
  `pre-commit run --files scripts/run-mcp-server.cjs` → `Passed`, rc 0 (`12/12 passed`).
- Medições: `run-mcp-server-test-*` no `%TEMP%`: 584 antes, 593 depois de o gate rodar o teste uma vez (o
  vazamento do próprio teste; Fase 1 passos 5–6). Build do fork em dia (`isForkStale()` falso).
- Card lateral `c1fde31065875` (central, `correcao`): classificador do gate; rotas A/B e recomendação no card.
- Nota no card da Fase 1 `cde7c5dc61118` (cwd, gate, renumeração).
- Sem push: a `main` local fica 4 commits à frente do `origin` até o executor da Fase 1 (passo 10).

**Cards:** Fase 1 `cde7c5dc61118` (pronta para execução, roda no principal) · Fase 2 `cffad2d29c092` (14/10,
depende da Fase 1) · laterais `cbf3ffaf58ead` (central, faxina `pw-ia`), `c7e20c66d6f0b` (unclick),
`c1fde31065875` (central, gate).
