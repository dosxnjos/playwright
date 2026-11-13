@AGENTS.md

---

## This fork (dosxnjos/playwright, single branch `main`)

Not part of upstream: delete this file before any PR (upstream renamed its `CLAUDE.md` to `AGENTS.md` in #43167;
this file only loads it and adds the fork section). `main` is upstream `main` plus a small patch set
(`browser_set_group_label`, agent tabs closed on disconnect, agent routing, focus zero, run-from-source wrapper).
What it carries, how to sync with upstream, how the wrapper and extension work, and the testing gotchas (unset
`PLAYWRIGHT_MCP_EXTENSION_TOKEN` first): **[FORK.md](FORK.md)**.
Plans and history: `roadmap/`. Project memory (local to this machine): `C:\Dev\cerebro\projetos\playwright.md`.
`npm run flint` covers `packages/extension/` since upstream #43072 (`npm run tsc` runs its two tsconfigs).
