### Monorepo Packages

| Package | npm name | Purpose |
|---------|----------|---------|
| `playwright-core` | `playwright-core` | Browser automation engine: client, server, dispatchers, protocol |
| `playwright` | `playwright` | Test runner + browser automation (public package) |
| `playwright-test` | `@playwright/test` | Test runner entry point |
| `playwright-client` | `@playwright/client` | Standalone client package |
| `protocol` | *(internal)* | RPC protocol definitions (`protocol.yml` → generated `channels.d.ts`) |

### Browser Packages

`playwright-chromium`, `playwright-firefox`, `playwright-webkit` — per-browser distributions.
`playwright-browser-chromium`, `playwright-browser-firefox`, `playwright-browser-webkit` — binary packages.

### Tooling Packages

| Package | Purpose |
|---------|---------|
| `html-reporter` | HTML test report viewer |
| `trace-viewer` | Trace viewer UI |
| `recorder` | Test recorder |
| `web` | Shared web UI components |
| `injected` | Scripts injected into browser pages |

### Component Testing

`playwright-ct-core`, `playwright-ct-react`, `playwright-ct-vue`

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `tests/` | All test suites (page, library, playwright-test, mcp, components, etc.) |
| `docs/src/` | API documentation — **source of truth** for public TypeScript types |
| `docs/src/api/` | Per-class API reference (`class-page.md`, `class-locator.md`, etc.) |
| `utils/` | Build scripts, code generation, linting, doc tools |
| `browser_patches/` | Browser engine patches |

## Build

```bash
npm run build       # Full build
npm run watch       # Watch mode (recommended during development)
```

Assume watch is running and code is up to date. Generated files (types, channels, validators) are produced by watch automatically.

## Lint and type check

```bash
npm run flint
```

Runs all lint checks in parallel: eslint, tsc, doclint, check-deps, generate_channels, generate_types, lint-tests, test-types, lint-packages, code-snippet linting.

**Always run `flint` before committing.** Do not use `tsc --noEmit` or individual lint commands separately.

## Test Commands

| Command | Scope |
|---------|-------|
| `npm run ctest <filter>` | Chromium only library tests — **use during development** |
| `npm run test <filter> -- --project=<chromium,firefix,webkit>` | All library / per project |
| `npm run ttest <filter>` | Test runner (`tests/playwright-test/`) |
| `npm run ctest-mcp <filter>` | Chromium only MCP tools (`tests/mcp/`) |
| `npm run test-mcp <filter> -- --project=<chromium,firefox,webkit>` | MCP tools (`tests/mcp/`) |


### Filtering

```bash
npm run ctest tests/page/locator-click.spec.ts         # Specific file
npm run ctest tests/page/locator-click.spec.ts:12      # Specific location
npm run ctest -- --grep "should click"                 # By test name
npm run ctest-mcp snapshot                             # By file name part
```

### Test Directories and Fixtures

| Directory | Import | Key Fixtures | What to Test |
|-----------|--------|--------------|--------------|
| `tests/page/` | `import { test, expect } from './pageTest'` | `page`, `server`, `browserName` | User interactions: click, fill, navigate, locators, assertions |
| `tests/library/` | `import { browserTest, expect } from '../config/browserTest'` | `browser`, `context`, `browserType` | Browser/context lifecycle, cookies, permissions, browser-specific features |
| `tests/playwright-test/` | `import { test, expect } from './playwright-test-fixtures'` | test runner fixtures | Test runner: reporters, config, annotations, retries |
| `tests/mcp/` | `import { test, expect } from './fixtures'` | `client`, `server` | MCP tools via `client.callTool()` |

**Decision rule**: Does the test need `browser`/`browserType`/`context` → `tests/library/`. Just needs `page` + `server` → `tests/page/`.

## DEPS System

Import boundaries are enforced via `DEPS.list` files (52+ across the repo), checked by `npm run flint`.

**Key rule**: Client code NEVER imports server code. Server code NEVER imports client code. Communication is only through the protocol.
When creating or moving files, update the relevant `DEPS.list` to declare allowed imports. Files marked `"strict"` can only import what is explicitly listed.

## Coding Convention

For exported classes:
- `private _method()` — only used within the class itself
- `_method()` (no `private`) — used by other code in the same file, but not outside the file
- `method()` (public) — used in other files

Non-exported classes have no naming convention; they are internal implementation details.

## Commit Convention

Before committing, run `npm run flint` and fix errors.

Semantic commit messages: `label(scope): description`

Labels: `fix`, `feat`, `chore`, `docs`, `test`, `devops`

```bash
git checkout -b fix-39562
# ... make changes ...
git add <changed-files>
git commit -m "$(cat <<'EOF'
fix(proxy): handle SOCKS proxy authentication

Fixes: https://github.com/microsoft/playwright/issues/39562
EOF
)"
# **Never `git push` without an explicit instruction to push.**
git push origin fix-39562
gh pr create --repo microsoft/playwright --head username:fix-39562 \
  --title "fix(proxy): handle SOCKS proxy authentication" \
  --body "$(cat <<'EOF'
## Summary
- <describe the change very! briefly>

Fixes https://github.com/microsoft/playwright/issues/39562
EOF
)"
```

Never add Co-Authored-By agents in commit message.
Never add "Generated with" in commit message.
Never add test plan to PR description. Keep PR description short — a few bullet points at most.
Branch naming for issue fixes: `fix-<issue-number>`

**Never amend commits.** Always create a new commit for follow-up changes, even when iterating on an open PR. Amending rewrites history and forces a force-push, losing the incremental review trail. Only amend if the user explicitly says so.

**Never `git push` without an explicit instruction to push.** Applies even when a PR is already open for the branch — additional commits are immediately visible to reviewers. Commit locally, report what was committed, and wait. Only push when the user's message contains "push", "upload", "create PR", "ship it", or equivalent.

## Development Guides

Detailed guides for common development tasks:

- **[Architecture: Client, Server, and Dispatchers](.claude/skills/playwright-dev/library.md)** — package layout, protocol layer, ChannelOwner/SdkObject/Dispatcher base classes, DEPS rules, end-to-end RPC flow, object lifecycle
- **[Adding and Modifying APIs](.claude/skills/playwright-dev/api.md)** — 6-step process: define docs → implement client → define protocol → implement dispatcher → implement server → write tests
- **[MCP Tools and CLI Commands](.claude/skills/playwright-dev/tools.md)** — `defineTool()`/`defineTabTool()`, tool capabilities, CLI `declareCommand()`, config options, testing with MCP fixtures
- **[Vendoring Dependencies](.claude/skills/playwright-dev/vendor.md)** — bundle architecture, esbuild setup, typed wrappers, adding deps to existing bundles

---

## This fork (dosxnjos/playwright, branch `extension-multi-connection`)

**Not part of upstream — strip this section before the PR.** Fork of `microsoft/playwright`
to fix [playwright-mcp#893](https://github.com/microsoft/playwright-mcp/issues/893): the
Playwright Extension only sustains one connection at a time, so running several Claude Code
instances in parallel (each its own `npx @playwright/mcp --extension` process) makes every new
connection steal the browser from the previous one. Full plan, decisions and phase-by-phase
progress: `C:\Dev\roadmap\2026-07-16-playwright-extension-multiconexao.md` (not versioned here,
lives in the Nomura dev-diretrizes repo).

### What changed (packages/extension/)

- `background.ts`: `_activeGroup`/`_activeClientName` (singular) → `_connections: Map<selectorTabId,
  {group, clientName, title}>`. Removed the `_disconnect('Another connection is requested')` that
  used to kill the previous connection on every new one. `disconnect` message gained an optional
  `connectionId` (absent = disconnect all, keeps 1-connection behavior identical to upstream).
  `getConnectionStatus` now returns `connections: [{id, clientName, tabIds}]` instead of a single
  `{connectedTabIds, clientName}`.
- `connectedTabGroup.ts`: group title is now `Playwright · <clientName>` (deduped with a `(2)`,
  `(3)`... suffix), computed by `background.ts` and passed into the constructor — was a hardcoded
  `'Playwright'`. `cleanupStalePlaywrightGroups` matches by title **prefix** now, since
  `chrome.tabGroups.query({title})` doesn't support patterns and titles vary per connection.
  Also added tab-ownership tracking (`_agentOwnedTabs` / `_pendingOwner`) — see below.
- `status.tsx`: renders one block per active connection instead of a single one; each has its own
  Disconnect button (`connectionId`-scoped). Closes the window only when zero connections remain,
  matching the old single-connection behavior exactly in that case.

### Tab ownership (why some tabs close on disconnect and others don't)

A tab is **agent-owned** (closed when its connection closes) if the agent created it: the seed tab
via the token/`newTab` bypass path, or any tab the relay attaches on its own (popup, `browser_tabs
new`, `Target.createTarget`). A tab is **user-owned** (only ungrouped, never closed) if the user
picked it from the connect page's tab list, or dragged it into the group themselves. The decision
is made **once**, at the moment a tab enters the group (`ConnectedTabGroup._onTabGroupChanged`) —
never re-decided on a later re-attach (e.g. after the tab navigates), so a user's tab can't get
silently promoted to agent-owned just because it happened to reload.

### The "started debugging this browser" infobar (R3, no code — verdict only)

Chrome's debugger infobar is global to the browser window, driven by `chrome.debugger` at the
Chrome-UI level — it is **not scoped per tab or per extension connection**, so there is no API to
show/hide it per connection. It disappears on its own once the *last* `chrome.debugger` attachment
in the window detaches, which is a natural consequence of this fork's cleanup (closing/detaching a
connection's tabs). The only way to suppress it entirely is the browser flag
`--silent-debugger-extension-api` — **not recommended as a default**: it silences a real Chrome
security signal for the whole browser, not just Playwright's own connections.

### Build / reload workflow

```bash
npm ci && npm run build        # generates packages/extension/dist/
```
Then `chrome://extensions` → Developer mode → "Load unpacked" → `packages/extension/dist/`.
The manifest's `key` field pins the unpacked build to the **same extension ID** as the Chrome Web
Store version (`mmlmfjhmonkocbjadbfplnigmagldckm`) — disable the store extension in that profile
first, two extensions can't share an ID. **`--load-extension` is silently ignored on branded Chrome
137+** (Chromium source confirms this is intentional, official-build-only restriction) — load
unpacked manually via the UI, or use the `chromium` channel (not `chrome`) for anything scripted.

**Server version must stay pinned.** The extension and the `@playwright/mcp` server speak a
versioned protocol (`SUPPORTED_PROTOCOL_VERSION = 2` in `connect.tsx`); `~/.claude.json` should
pin `@playwright/mcp@<version>` instead of `@latest` once this extension is adopted, so the server
and this forked extension never drift apart silently.

### Testing gotchas found in this fork (16/07/2026)

- **`npm run test-extension` is not reliable on Windows.** `.github/workflows/tests_extension.yml`
  (upstream) only runs the suite on `macos-latest` — it has never been validated on Windows. The
  suite's connect flow relies on Chrome's OS-level singleton behavior (relaunching the same
  `chrome.exe` with the same `--user-data-dir` to open a tab in the *existing* window, rather than
  a new one — see `ignoreDefaultArgs: ['--enable-automation']` in `tests/extension/
  extension-fixtures.ts`), and that mechanism doesn't behave the same way on Windows: tests hang at
  30–60s waiting for the connect page that never opens, with an empty server stderr even under
  `PWDEBUGIMPL=1` (the server itself never errors — it's just never told a tab opened). Real
  validation for this fork happens via GitHub Actions on `dosxnjos/playwright` (same macOS-only
  workflow), not on a local Windows machine.
- **Never `taskkill /F /IM chrome.exe /T`** to clean up orphaned test browsers on this machine.
  Chrome's multi-process architecture means dozens of `chrome.exe` PIDs can all belong to a single
  *real* browser window (GPU, renderer, extension processes) — there's no way to distinguish a
  test's leftover process from the real one by image name alone. Kill specific PIDs only, found by
  matching the process's command line against the test's `userDataDir` path (`wmic process where
  "name='chrome.exe'" get ProcessId,CommandLine`), never a blanket image-name kill.
- **Server death is confirmed clean on Windows without needing a browser at all.** `watchdog.ts`
  closes the server via `process.stdin.on('close', ...)` — plain Node child-process semantics, not
  platform-specific. Verified by spawning `packages/playwright-core/lib/entry/mcp.js --extension`
  directly and closing its stdin: the process exits within ~1.5s, no orphan.
