# dosxnjos/playwright: what this fork carries over upstream

Not part of upstream. `main` is `microsoft/playwright` `main` plus the small patch set below; it is the only branch
(rebuilt as `fork-v2` on 28/09/2026, folded back into `main` on 01/10/2026).
The fork was rebuilt on top of upstream instead of merged: the old multi-connection code was replaced by
upstream's own (PR #42259), so what is left is only what upstream does not do. Plan and decisions:
`roadmap/2026-09-28-refazer-fork-sobre-upstream.md`. Old branch: tag `fork-pre-refazer-2026-09-28`;
the unmerged ghost-tab commit: tag `fork-multi-connection-6f0b4cfdc`.

## The patches (one commit each; reapply in this order after a sync)

| # | what | where | upstream status |
| --- | --- | --- | --- |
| 1 | `scripts/run-mcp-server.cjs` wrapper, CI workflows trimmed to manual + `tests_extension.yml` | `scripts/`, `.gitignore`, `.github/workflows/` | ours |
| 2 | `browser_set_group_label` tool | `backend/groupLabel.ts`, `backend/extensionSession.ts`, `mcp/{cdpRelay,protocol,extensionContextFactory}.ts`, `extension/src/{background,connectedTabGroup,relayConnection}.ts` | not upstream (#41840 open) |
| 3 | agent-owned tabs are **closed** on disconnect | `extension/src/{connectedTabGroup,background}.ts` | upstream only ungroups, by design (#41864) |
| 4 | dark theme + redesigned connect/status UI, manifest `0.4.0.1` | `extension/src/ui/`, `extension/manifest.json` | declined (#41841) |
| 5 | tool descriptions warn that the current tab is shared per connection | `backend/{tabs,navigate}.ts`, `tests/mcp/capabilities.spec.ts` | not upstream |

Tab ownership: a tab is **agent-owned** (closed on disconnect) if the agent created it: the token-bypass seed, a
popup, `browser_tabs new`, `Target.createTarget`. It is **user-owned** (only ungrouped) if the user picked it in the
connect page or dragged it into the group. Decided once, when the tab enters the group (both in the group-entry event
and in `_addTabToGroup`, because the event can land before the add resolves); never re-decided on re-attach.

`browser_set_group_label` reaches the relay through a `Browser -> relay` registry (`backend/extensionSession.ts`),
not through `browserFactory`/`program`/`BrowserBackend`, which upstream keeps rewriting. No-op without `--extension`;
an error if `--extension` was requested but no relay is connected.

Profile pinning is **not** a fork feature any more: use upstream's `--profile-dir-name` /
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` (takes the profile **folder**, e.g. `Profile 13`).

Ownership edge cases (found by the adversarial review, 28/09/2026): a tab the user takes over (Cancel on the debugger
bar, DevTools opened) is demoted to user-owned and never closed; a tab opened from a tab already in the group is
agent-owned whichever event lands first; a tab whose group call finishes after the connection closed is closed or
ungrouped by its owner. Not covered by any test (extension tests do not run on Windows): check by hand.

## Known limitations

- `browser_set_group_label` errors with `--extension --shared-browser-context`: that mode reconnects through another
  `Browser` object, so the registry lookup misses.
- Wrapper (`scripts/run-mcp-server.cjs`), inherited from the old fork: a `.build-lock` left by a killed background build
  is never expired (delete it by hand); `.build-stamp` gets the mtime of the build's end, so an edit made during the
  ~25 s build counts as built; the npx fallback runs with `shell: true` and unquoted args, so an arg containing a space
  splits in two there.

## Setting this up on another machine (macOS or Windows)

Everything is in this public repo; nothing secret is. Each machine has **its own** extension token (it lives in the
Chrome profile's extension storage): never copy someone else's.

```bash
git clone https://github.com/dosxnjos/playwright.git && cd playwright
npm ci && npm run build && touch scripts/.build-stamp     # ~25 s; Node 20+
```

1. Chrome -> `chrome://extensions` -> Developer mode -> "Load unpacked" -> `packages/extension/dist`. If the Chrome Web
   Store copy is installed in that profile, disable it first (same extension ID). Open the extension's page in that
   profile and copy its token.
2. Claude Code MCP config (`~/.claude.json` -> `mcpServers.playwright`, or `claude mcp add`): `command` `node`, `args`
   `["<clone>/scripts/run-mcp-server.cjs", "--extension", "--browser", "chrome"]`, `env`
   `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<that token>`. With several Chrome profiles also set
   `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` to the profile folder that holds the extension (`Default`, `Profile 1`...), or the
   connect page may open in the wrong profile. Restart Claude Code.
3. The first launch after a `git pull` uses the official npx server while the wrapper rebuilds in the background; run
   `npm run build && touch scripts/.build-stamp` yourself to skip that.

On macOS `--load-extension` is ignored by branded Chrome 137+ like on Windows, so use the manual "Load unpacked".
The `tests/extension/` suite is the one that runs on macOS (it is what upstream's CI uses).

Without any of the fork's features (no tab-group label, agent tabs only ungrouped, no dark UI) the official route is
enough: install the Chrome Web Store extension and run `npx @playwright/mcp@latest --extension`.

## Syncing with upstream

`origin` = `dosxnjos/playwright`, `upstream` = `microsoft/playwright`. Never a cron rebase (patches can conflict).

```bash
git fetch upstream
git rebase upstream/main          # on main
npm ci && npm run build && touch scripts/.build-stamp
git push --force-with-lease origin main   # the rebase rewrites main; needs the owner's OK each time
```

`.github/workflows/upstream-drift.yml` runs weekly (Mon 12:00 UTC) and only opens/updates one issue when `main` is
25+ commits behind or a rebase would conflict; it never syncs. Schedules run from the default branch (`main`), and GitHub
disables them after 60 days without repo activity (re-enable in the Actions tab).

Likely conflicts: `backend/tools.ts` (keep both tool lists), `tests/mcp/capabilities.spec.ts` (keep
`browser_set_group_label` in the list), `.github/workflows/*` (modify/delete: `git rm` again), `ui/connect.css`.
Then check: `npm run ctest-mcp -- group-label capabilities tabs core`, plus from `packages/extension/`
`npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.ui.json --noEmit`.

⚠️ `npm run flint` does **not** cover `packages/extension/` (its two tsconfigs are not in the root project): a real
`ReferenceError` in `connect.tsx` once shipped with a clean flint. Baseline on upstream: 3 `@types/chrome` errors in
`connectedTabGroup.ts` (`TabChangeInfo`, `ungroup` tuple); more than 3 is a regression.
⚠️ On Windows `npm run flint` also fails in `doc` (`getBrowserVersions` launches firefox and webkit, not installed
here); environment failure, not a regression.

## Running the server from this fork (`scripts/run-mcp-server.cjs`)

`~/.claude.json` runs `node <repo>/scripts/run-mcp-server.cjs --extension --browser chrome` instead of
`npx @playwright/mcp`, so local changes are live. A cold `npm run build` takes ~25 s, too slow for the MCP startup
timeout (~30 s), so the wrapper never builds inline:

- build up to date (`scripts/.build-stamp` newer than `packages/playwright-core/src/`) -> spawns
  `packages/playwright-core/lib/entry/mcp.js`;
- stale or missing -> spawns the official `npx @playwright/mcp@<pin>` **for this launch** and starts a detached
  `npm run build` (`scripts/background-build.cjs`, lock `scripts/.build-lock`, log `scripts/.build-log.txt`);
  a failed build leaves the stamp stale, so every launch retries while using the npx fallback (degraded, not broken).

⚠️ A manual `npm run build` does **not** refresh the stamp: `touch scripts/.build-stamp` or the next launch runs npx.
The npx fallback has no fork-only server feature (`browser_set_group_label`); the extension-side patches come from the unpacked extension, whatever server runs.
Keep the fallback pin (`NPX_FALLBACK_ARGS`) on a version that speaks the same extension protocol as this fork.

**The Chrome profile follows the active token.** Each vault token `PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variant>` in
`~/.claude.json` has its profile folder registered beside it, `PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variant>` (`padrao` =
`Profile 13`, `andressa` = `Profile 7`, `gabriel_pessoal` = `Default`, `jacira` = `Profile 6`). The wrapper
(`envForActiveProfile`) finds the variant whose token equals the active `PLAYWRIGHT_MCP_EXTENSION_TOKEN` and exports
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` for the server; an explicit value wins, the legacy `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`
is a fallback, and no match logs a warning instead of guessing. Without a profile Chrome opens the connect page in the
last-focused profile and offers the token to the wrong one. New token = add its `__<variant>` profile line too.

**AI-opened sessions never use the extension.** Sessions with `CENTRAL_ORIGEM="ia:<route>"` get
`--browser chromium --isolated --headless` (`argvForAiSession`), and `PLAYWRIGHT_MCP_EXTENSION` is dropped from their
env (`envForAiSession`): overnight there is no human to accept the connection and the first tool call used to hang for
1800 s. Human sessions (`humano:*` or no marker) keep the argv unchanged.

To force pure npx again: put `"command": "npx", "args": ["-y", "@playwright/mcp@<pin>", "--extension", "--browser", "chrome"]`
back in `~/.claude.json`. Restart Claude Code instances after changing it; it is live config shared by all of them.

## The extension (`packages/extension/`)

Build: `npm ci && npm run build`, then `chrome://extensions` -> Developer mode -> "Load unpacked" ->
`packages/extension/dist/`. Reload it there after every build, **in each profile that uses the unpacked copy**.
The manifest `key` pins the same extension ID as the Chrome Web Store version: disable the store copy in that profile
first. `--load-extension` is ignored on branded Chrome 137+; scripted runs need the `chromium` channel.

## Testing gotchas

- **`tests/extension/` needs a human on Windows.** The connect flow relies on Chrome's OS-level singleton (relaunching
  the same `chrome.exe`/`--user-data-dir` opens a tab in the existing window); on Windows the tests hang at 30 s and
  ask you to click "Allow & select" by hand. Validation is the macOS `tests_extension.yml` (**disabled manually in the repo's Actions tab as of 29/09/2026**:
  enable it there to use it; push to `main`
  with paths under `packages/extension/`, `tests/extension/` or `tools/`; free on a public repo) and a live check. `tests/mcp/` runs fine locally (`npm run ctest-mcp`).
- ⚠️ **Unset `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (and `PLAYWRIGHT_MCP_EXTENSION`) before running extension tests.** If the
  shell has the real token exported, the test server sends it to the test browser's extension and the connect page shows
  "Invalid token provided.": `env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN npm run test-extension -- <filter>`.
- Never `taskkill /F /IM chrome.exe`: dozens of PIDs belong to one real window. Kill specific PIDs found by matching the
  command line against the test's `userDataDir`.
- Server death is clean on Windows without a browser: `watchdog.ts` closes on `process.stdin` `close`.

## Chrome's "started debugging this browser" infobar

Global to the browser window, driven by `chrome.debugger`; there is no per-connection API. It goes away when the last
attachment detaches. Only `--silent-debugger-extension-api` hides it entirely: not recommended, it silences a real
security signal for the whole browser.
