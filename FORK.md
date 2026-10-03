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
| 4 | dark theme + redesigned connect/status UI, manifest `0.4.0.x` (`0.4.0.3` since patch 7's popup source) | `extension/src/ui/`, `extension/manifest.json` | declined (#41841) |
| 6 | agent routing: one browser backend per calling agent (`_meta.agente`); `browser_close` text says what it closes; AI sessions start with routing off; an ended agent's backend is released by a SubagentStop marker file | `mcp/agentRouter.ts`, `mcp/program.ts:189`, `backend/common.ts` (`browser_close` text), `tools/index.ts` (exports `withAgentRouting` for the spec), `tests/mcp/agent-routing.spec.ts`, `scripts/run-mcp-server.cjs` (`envForAiSession`) | ours; upstream declined a similar path (#39703, #42961) |
| 7 | silent connect: a relay already connected opens the next connect page from inside Chrome; a sub-agent connects, opens tabs and `select`s in the background; the connect page drops the token from its own URL | `mcp/cdpRelay.ts`, `mcp/extensionContextFactory.ts:38`, `backend/extensionSession.ts` (`relayScope`), `mcp/agentRouter.ts` (`_entryFor`), `tools/index.ts` (exports for the spec), `extension/src/background.ts` (`silent`), `extension/src/ui/connect.tsx` (token), `extension/manifest.json` (`0.4.0.3`, `webNavigation`), `tests/mcp/agent-silent.spec.ts`; since the 03/10 live test also `mcp/browserModel.ts` (`onTabCreated` guard), `mcp/cdpRelayV2.ts` (`ownTabsOnly`, `onInitialized`), `backend/screenshot.ts` (`screenshotTimeout`, `screenshotTimeoutFor`, `pw:mcp:shot`), `extension/src/connectedTabGroup.ts` (agent tabs closed one by one; owner by an attached opener), `extension/src/relayConnection.ts` (popup source), `tests/extension/popup-source.spec.ts`. Live check 03/10: isolation, release and no stolen focus ok; a sub-agent's screenshot timed out 3/3 (30 s timeout since, re-check pending) | ours |

Tab ownership: a tab is **agent-owned** (closed on disconnect) if the agent created it: the token-bypass seed, a
popup, `browser_tabs new`, `Target.createTarget`. It is **user-owned** (only ungrouped) if the user picked it in the
connect page or dragged it into the group (only the main agent's group: a tab dragged into a sub-agent's group is
not attached, see § Silent connect, "Own tabs only"). Decided once, when the tab enters the group (both in the group-entry event
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
Since patch 7's popup source, "a tab opened from a tab in the group" means opened from a tab this connection has
attached (`connectedTabGroup.ts` `_onTabGroupChanged`): a tab opened from a group tab the relay ignored, and later
dragged in, is the user's (covered by `tests/extension/popup-source.spec.ts`).

## Agent routing (patch 6)

One Claude Code session runs one server process, and its sub-agents (Agent tool, Workflow agents) call the browser
through that same process. Without routing they share one current tab, `browser_close` closes everyone's tabs and
`browser_set_group_label` renames the main agent's group. `mcp/agentRouter.ts` wraps the backend factory
(`program.ts:189`) and keeps one backend per caller, created on the caller's first tool call by the same factory the
HTTP mode uses per client. Plan and measurements: `roadmap/2026-10-03-melhoria-abas-por-agente.md`.

- **Contract.** The caller comes in `arguments._meta`, stamped outside the model by a PreToolUse hook
  (`~/.claude/hooks/playwright-agente.cjs carimbo`, matcher `mcp__playwright__.*`, installed 03/10/2026; without
  it every call is `main`):
  - `agente`: the routing key (`agent_id`, or `main`). Missing or not matching `^[\w-]{1,64}$` -> `main`, which is
    today's behavior, so without the hook the router is inert.
  - `agenteTipo`: only names the group: `gp` (general-purpose), `wf` (workflow-subagent), else the type itself.
    Group title of an agent: `<main's label, or the client name> · <type>-<last 4 chars of the key>`.
  - `sessao`: the session id; names the release-marker folder (below). Missing or not matching the same regex ->
    no folder, no markers read.
  - The zod schemas drop `_meta`, so tools never see it; page WebMCP tools get it stripped too (`browserBackend.ts`).
- **When it is on:** `--extension` (each agent gets its own relay, connection and tab group) and `--isolated` (each
  agent gets its own context on the shared browser). **Off** in the persistent mode (a second backend fails with
  "use --isolated"), with `--cdp-endpoint`, a remote endpoint or `--shared-browser-context`, and with
  `PLAYWRIGHT_MCP_AGENT_ROUTING=off`. AI-opened sessions (`ia:*`) get that `off` from the wrapper (`envForAiSession`)
  until a maestro round with browsing sub-agents is measured.
- **Per agent:** current tab, `eN` refs, snapshot, `browser_close` (drops only the caller's backend) and
  `browser_set_group_label` (only the caller's group; the registry is a `WeakMap` per `Browser`).
- **Lifecycle:** a non-`main` agent's backend is disposed after `PLAYWRIGHT_MCP_AGENT_IDLE_MS` (default 30 min)
  without calls, never with a call in flight; `main` never expires. A backend's `disconnected` only drops that key:
  the router never re-emits it (the server would dispose every agent, main included). Everything goes on session end.
- **Release marker (agent ended).** On the first call carrying a valid `sessao`, the router creates
  `<PLAYWRIGHT_MCP_AGENT_RELEASE_DIR or ~/.playwright-mcp/agentes-fim>/<sessao>/`; the folder means "this session
  uses the browser". A SubagentStop hook (`playwright-agente.cjs fim`, roadmap 3.3; until that entry is in
  `~/.claude/settings.json` only the idle timeout releases) writes an empty file named after the ended `agent_id`
  there, only if the folder exists, so a server without the router (npx fallback) never reacts.
  The router sweeps every 5 s and at the start of every call (before picking the caller's backend): it deletes each
  marker and disposes that agent's backend (in extension mode its tab group closes). A marker of an unknown key is
  only deleted (no browser is ever created for it), `main`'s is ignored, and an agent with a call in flight keeps its
  marker until the next sweep. The caller's own marker is only deleted: an agent that calls is alive (resumed with
  SendMessage after its SubagentStop, or kept going by another SubagentStop hook), so it keeps its browser; resumed
  after a periodic sweep already ran, it starts on a fresh one. Session end clears the timer and removes the session folder; a folder that vanished
  while the server lives (an older server of the same session disposed) is recreated on the next sweep.
- **Log:** `DEBUG=pw:mcp:router` prints `create key=… clientName=…`, `release key=… known=…`, `stale marker key=… (caller)` and `drop key=…`;
  past 8 live agents one stderr warning (tab group colors repeat from the 9th), no cap.
- **Limitations:**
  - an unhandled rejection in one agent's page shows up in the next response of every agent (each Context hooks
    `process.on`; same as the HTTP mode);
  - `--isolated`: agents share no cookies or storage (one context each);
  - `tools/list` only lists the main agent's page WebMCP tools (a sub-agent can still call its own page's tool);
  - in extension mode, closing an agent's last tab closes its connection: the next call reconnects (navigate in the
    last tab instead of closing it); with patch 7 a sub-agent reconnects in the background, the main agent with focus;
  - a server process killed without dispose leaves its empty session folder behind (harmless, nothing reads it);
  - release markers only cover agents whose SubagentStop fires (normal end of an Agent tool or Workflow agent,
    measured; Esc or crash not measured): the idle timeout stays the safety net.
- **`browser_close` text** promises that other agents keep their tabs. That is only true with the hook installed;
  with routing off (`ia:*`, persistent) the backend is shared and the close takes everyone's tabs. The old patch 5
  (tool texts warning that the current tab is shared) was dropped after the live gate (roadmap 2.3, 03/10/2026):
  `backend/{tabs,navigate}.ts` are upstream's again.
- **Tests:** `tests/mcp/agent-routing.spec.ts` covers `--isolated` (including idle dispose measured by context count
  and no idle with a call in flight) plus a fake-backend case for the drop-by-name on `browser_close` (the path
  extension mode needs when `disconnected` does not follow; in `--isolated` `disconnected` always comes first), and
  the release markers (periodic sweep disposes the agent, unknown/`main` markers only deleted, the caller's own marker
  consumed by its call without losing its state, no folder without a valid `sessao`, folder removed on session end),
  with `PLAYWRIGHT_MCP_AGENT_RELEASE_DIR` under the test output.
  Extension mode was checked by hand on 03/10/2026 (roadmap 1.7 and 2.3: one group per agent, scoped close and label).
- **Another machine:** copy the hook from `C:\Dev\cerebro\harness-espelho\` to `~/.claude/hooks/` and add the
  PreToolUse entry of roadmap 2.2 to `~/.claude/settings.json`; without it the agents of a session share one tab again.

## Silent connect (patch 7)

Without it every agent's first browser call launches `chrome.exe` with a connect page, and the extension focuses the
page and its window: one stolen window per sub-agent.

- **Carrier.** `mcp/cdpRelay.ts` keeps a process-wide set of relays whose extension is connected. A relay that needs
  its connect page asks one of them to `chrome.tabs.create` it (already allow-listed in the extension, no new
  command); the `pw:mcp:relay` log says `Connect page opened via portador`. A relay counts as a carrier only after its
  extension handshake (`extension.initialized`). A closed carrier or an error: the next carrier. With a token, one
  deadline (10 s, `PWTEST_EXTENSION_CARRIER_TIMEOUT` in tests) runs from the carrier's `chrome.tabs.create` to the
  connect page's WebSocket; past it the page is closed (`chrome.tabs.remove` through the same carrier, also when the
  create answers late) and the old `chrome.exe` launch takes over, so a background page that never connects, or an
  "Invalid token" error page, ends up as a foreground page instead of a hidden leftover. The carrier's own profile is
  used, so `--profile-dir-name` does not matter on that path.
- **First connections at the same time.** With a token and no carrier yet, a relay waits (up to the 30 s connect
  timeout) for a relay that started connecting before it, then uses it as carrier: only the oldest launches
  `chrome.exe`. Never on younger ones (no deadlock), never without a token (that relay waits for a click).
- **Background relay.** The router creates every agent but `main` inside `relayScope.run({ background: true })`
  (`backend/extensionSession.ts`, an `AsyncLocalStorage`); `extensionContextFactory.ts` hands it to the relay
  (`Relay created, background=…` in the log). A background relay opens its connect page with `active:false` (only with
  a token: without one the page stays in front, the user has to click Allow), opens its tabs (`browser_tabs new`) with
  `active:false`, and answers `Page.bringToFront` itself, so `browser_tabs select` of a sub-agent never changes the
  tab you are looking at. The main agent keeps today's behavior.
- **Focus emulation (background relay).** A background tab gets no `requestAnimationFrame`, and the `stable` check of
  click, hover and check polls on it; `--extension` connects with `noDefaults`, which skips focus emulation
  (`server/chromium/crPage.ts`). So right after each `chrome.debugger.attach` (seed, `browser_tabs new`, popups) a
  background relay sends `Emulation.setFocusEmulationEnabled {enabled:true}` to that tab, before Playwright sees it.
  The patch 7 review measured it outside the extension (plain CDP to real Chrome, background tab): with it the page is
  `visible` and `page.click` works; with `noDefaults`, `Timeout 5000ms exceeded`. Through the extension: unmeasured
  until roadmap 4.5 (a sub-agent's `browser_click` in a background tab).
- **Own tabs only (background relay).** Defect 1 of the 03/10 live test: a leftover tab of an earlier run showed up in a
  fresh sub-agent's group and got attached, so the sub-agent could read, drive or close it. The extension forwards any
  tab that enters a connection's group as `chrome.tabs.onCreated`; who put it there was never found (no extension call
  groups a tab that already exists). So `BrowserModel.onTabCreated` (`mcp/browserModel.ts`), in a background relay and
  after the handshake (`extension.initialized`, which `cdpRelayV2.ts` passes on as `onInitialized`), only takes a tab
  it already knows (re-attach after a detach) or one whose `openerTabId` is one of its tabs (popup; the extension
  passes the real opener there since `0.4.0.3`, see "Popups" below); anything else is
  never recorded or attached (`pw:mcp:relay` log: `Ignoring tab N: entered a background relay's group …`). The seed
  arrives before the handshake, and `browser_tabs new` is attached by `createTarget` itself. Cost: **dragging a tab
  into a sub-agent's group no longer hands it to that sub-agent** (it stays in the group, unattached, and is only
  ungrouped when the sub-agent ends). The main agent's group keeps upstream's behavior. Hardening that does not fix
  the entry: on disconnect the extension closes agent tabs one by one (`Promise.allSettled`), so one tab already gone
  no longer aborts the batch and leaves the others open (`connectedTabGroup.ts` `_onConnectionClose`).
- **Popups and `openerTabId` (extension `0.4.0.3`).** ⚠️ `openerTabId` does **not** say who opened a tab: for a popup
  (`window.open`, `target=_blank`, ctrl+click, `noopener`) Chrome sets it to the tab that was **active**, and a
  sub-agent's tab never is. Measured in bundled Chromium 1247 (headless, 03/10/2026): popup of background tab B with A
  active -> `openerTabId: A`, `groupId`: B's group, and **no** `tabs.onUpdated` with `groupId` (a tab created inside a
  group never goes through `_onTabGroupChanged`); `webNavigation.onCreatedNavigationTarget` comes right after
  `tabs.onCreated` with `sourceTabId: B`. Before the fix a sub-agent's popup reached the connection of the active tab
  (the main agent attached it; if no connection owned the active tab, nobody did), and the guard above could not help.
  So `relayConnection.ts` forwards popups from `onCreatedNavigationTarget` (only when `sourceTabId` is attached to that
  connection, with `openerTabId` replaced by it) and drops the raw `tabs.onCreated` forwarding; the relay guard then
  admits the popup, and `_onTabAttached` makes it agent-owned (closed when the sub-agent ends). `chrome.tabs.create`
  is not affected: with or without `index` it appends at the end of the strip, no group, no opener (same measurement).
  Needs the `webNavigation` permission (Reload the unpacked extension; Chrome may ask to accept "read your browsing
  history"); an extension without it keeps upstream's `openerTabId` path. Also seen there and **not fixed**: such a
  popup is created `active:true`, so a sub-agent's `window.open`/`target=_blank` brings its popup to the front. And a
  tab created inside a group from a group tab no connection attached (ctrl+click in a user tab the guard ignored) is
  tracked by nobody: neither attached, closed nor ungrouped, it stays in a `Playwright · …` group until the service
  worker restarts. Hypothesis, not checked: a plausible origin of the 03/10 leftover.
- **Screenshot timeout (background relay).** Defect 2 of the 03/10 live test: `browser_take_screenshot` of a
  sub-agent's tab (created with `active:false`, never shown, focus emulated) failed 3/3 with `Timeout 5000ms exceeded`
  after `fonts loaded`, i.e. in `Page.getLayoutMetrics`/`Page.captureScreenshot`, not in the font wait; the same capture
  of a background tab passed before patch 7. `backend/screenshot.ts` gives it `max(action timeout, 30 s)`
  (`screenshotTimeoutFor(tab)`: the relay registered for `tab.page.context().browser()`, its `background` getter,
  then `screenshotTimeout`); the main agent keeps the action timeout. `DEBUG=pw:mcp:shot` logs every capture: `screenshot <target> background=… timeout=… took Nms ok|failed`.
  Unknown yet: whether 30 s is enough or the capture of a never-shown tab hangs; that is what the next live test measures.
- **Extension.** `background.ts`: a token connection (no picked tab) whose connect page is not the active tab skips
  the `tabs.update(active)` + `windows.update(focused)`. An older extension still connects, only with focus.
  `ui/connect.tsx` removes `token` from its own URL (`history.replaceState`) before anything connects: with the
  token the connect page becomes the agent's first tab, and its URL used to come back in tool responses (`Page URL`).
- **Not covered:** a popup a sub-agent's page opens (`window.open`, `target=_blank`) is created by Chrome, not by the
  relay, so it comes to the front (seen in Chromium, see "Popups" above). With `--extension --isolated` all agents share one relay, and the agent
  that created it decides `background` for everyone (read from the code, untested; not a configuration used here).
  A sub-agent has no way to bring its tab to the front (`browser_tabs select` and `page.bringToFront()` are answered
  locally): focus emulation is what keeps its background tab usable; if a click still times out there, the way out is
  `PLAYWRIGHT_MCP_AGENT_SILENT=off` and a server restart.
- **Kill switch:** `PLAYWRIGHT_MCP_AGENT_SILENT=off` (server env) turns off the carrier and the background relay (with
  it the own-tabs-only guard and the longer screenshot timeout); the extension side then never sees a background
  connect page, so it focuses as before.
- **Tests:** `tests/mcp/agent-silent.spec.ts` drives `CDPRelayServer` with a fake extension and a fake CDP client
  (carrier, `active` with and without token, dead carrier skipped, kill switch, background tabs and `bringToFront`,
  focus emulation, carrier page that never connects / answers late / fails, simultaneous first connections, router
  scope, own tabs only: seed attached, intruder ignored after the handshake and before auto-attach, popup attached,
  re-attach, main relay and kill switch attach as upstream; `background` getter, `screenshotTimeout`,
  `screenshotTimeoutFor` and the timeout `browser_take_screenshot`'s handler passes on (fake tab, relay registered by
  hand), and the `pw:mcp:shot` line through a real server; the `chrome.exe` launch is stubbed through
  `child_process.spawn`). `tests/extension/popup-source.spec.ts` runs the **real extension** in headless Chromium with
  two real relays (main + background sub-agent, no MCP server, no window, so it runs on Windows:
  `npm run test-extension -- popup-source`): a sub-agent popup goes to the sub-agent and not to the main agent whose tab
  is active, the main agent's popup still goes to it, a sub-agent popup is closed when it ends, and a user tab opened
  from an ignored tab and dragged in is only ungrouped. Not covered by a test: a real screenshot with `background=true`
  (headless shows no slow capture) and the extension's one-by-one close. Real Chrome: roadmap 4.0/4.5, by hand after
  the extension "Reload".

## Known limitations

- `browser_set_group_label` errors with `--extension --shared-browser-context`: that mode reconnects through another
  `Browser` object, so the registry lookup misses.
- A tab dragged by hand into a sub-agent's tab group is not attached (patch 7, own tabs only): give the main agent the
  tab instead, or set `PLAYWRIGHT_MCP_AGENT_SILENT=off` and restart the server.
- A sub-agent's screenshot may take up to 30 s before failing (patch 7, screenshot timeout), instead of 5 s.
- A sub-agent's popup comes to the front (Chrome creates it `active:true`), and with an extension older than `0.4.0.3`
  (no `webNavigation`) it is never attached to the sub-agent (patch 7, "Popups"): Reload the unpacked extension.
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

⚠️ The checkout usually has someone's uncommitted `roadmap/*.md` edits, so `git rebase` refuses and `--autostash` is
off-limits (the stash is shared between sessions). Rehearse instead: `git worktree add -b ensaio-sync <dir> main`, rebase
and test there, then move the real checkout with `git reset --keep ensaio-sync` (keeps those edits when `roadmap/` is
the same on both sides). Rebuilding with `npm run build` is enough when `package-lock.json` barely moved; `npm ci`
wipes `node_modules` under MCP servers that other sessions are running from this checkout.

Likely conflicts: `backend/tools.ts` (keep both tool lists), `tests/mcp/capabilities.spec.ts` (keep
`browser_set_group_label` in the list), `.github/workflows/*` (modify/delete: `git rm` again; also drop any new
workflow with an automatic trigger, e.g. `check_copilot_models.yml` on 01/10/2026), `ui/connect.css`,
`mcp/program.ts:189` (keep `withAgentRouting(factory, config)` around whatever upstream passes to `start`),
`backend/common.ts:27` (keep the fork's `browser_close` text), `tools/index.ts` (keep the fork's exports),
`mcp/cdpRelay.ts` (patch 7: carrier set, `background` constructor option, the early return in
`_openConnectPageInBrowser`, `active:false` in `sendCommand`, the `Page.bringToFront` case),
`mcp/extensionContextFactory.ts:38` (pass `relayScope`'s `background`), `extension/src/background.ts` (`silent`
around the focus calls in `_connectTab`), `extension/src/ui/connect.tsx` (token stripped right after `params`),
`mcp/browserModel.ts` (`ownTabsOnly` option, `onInitialized`, the guard at the top of `onTabCreated`),
`mcp/cdpRelayV2.ts` (constructor `options`, `onInitialized()` in the `extension.initialized` case),
`backend/screenshot.ts` (`screenshotTimeoutFor(tab)` instead of the `actionTimeoutOptions` spread, the `try/finally`
with `pw:mcp:shot` around the capture), `backend/extensionSession.ts` (`background` in `ExtensionSessionRelay`),
`extension/src/connectedTabGroup.ts` (`Promise.allSettled` in `_onConnectionClose`, `attachedTabs` in
`_onTabGroupChanged`'s `fromGroupTab`), `extension/src/relayConnection.ts` (`popupSourceEvents`, `_onPopupCreated`,
the early return in the `chrome.tabs.onCreated` case), `extension/manifest.json` (`webNavigation`).
Then check: `npm run ctest-mcp -- group-label capabilities tabs core agent-routing agent-silent screenshot`,
`npm run test-extension -- popup-source` (headless, runs on Windows), plus from `packages/extension/`
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
⚠️ If "Reload" brings back an old version (startup shows the `dist` one), the profile's entry is also an account
(Web Store-synced) extension with a stale record (`account_extension_type: 2` in `Secure Preferences`). Cure: remove
the extension and "Load unpacked" again. That wipes its `localStorage`, so the token changes: rotate it everywhere the
vault note lists. Hit Profile 13 on 01/10/2026 (stale 0.2.1 from 17/07), cured that way.
The manifest `key` pins the same extension ID as the Chrome Web Store version: disable the store copy in that profile
first. `--load-extension` is ignored on branded Chrome 137+; scripted runs need the `chromium` channel.

## Testing gotchas

- **`tests/extension/` needs a human on Windows.** The connect flow relies on Chrome's OS-level singleton (relaunching
  the same `chrome.exe`/`--user-data-dir` opens a tab in the existing window); on Windows the tests hang at 30 s and
  ask you to click "Allow & select" by hand. Validation is the macOS `tests_extension.yml` (**disabled manually in the repo's Actions tab as of 29/09/2026**:
  enable it there to use it; push to `main`
  with paths under `packages/extension/`, `tests/extension/` or `tools/`; free on a public repo) and a live check. `tests/mcp/` runs fine locally (`npm run ctest-mcp`).
  Exception: `tests/extension/popup-source.spec.ts` connects real relays in-process to the extension in headless
  Chromium (no singleton, no click), so it runs locally; it stubs `child_process.spawn` only for the relay's launch
  (its `executablePath` is node), since the same process launches Chromium.
- ⚠️ **Unset `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (and `PLAYWRIGHT_MCP_EXTENSION`) before running extension tests.** If the
  shell has the real token exported, the test server sends it to the test browser's extension and the connect page shows
  "Invalid token provided.": `env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN npm run test-extension -- <filter>`.
- Don't point `--output` at a Windows 8.3 short path (e.g. `C:/Users/GABRIE~1/...`, the session scratchpad):
  `core.spec.ts` "can navigate to file:// URLs" then fails with `Connection closed`, on upstream too. Default output is fine.
  Seen again on 03/10/2026 with a long path (`<worktree>/temp/fase4-results`): same failure, passes with the default.
- Never `taskkill /F /IM chrome.exe`: dozens of PIDs belong to one real window. Kill specific PIDs found by matching the
  command line against the test's `userDataDir`.
- Server death is clean on Windows without a browser: `watchdog.ts` closes on `process.stdin` `close`.

## Chrome's "started debugging this browser" infobar

Global to the browser window, driven by `chrome.debugger`; there is no per-connection API. It goes away when the last
attachment detaches. Only `--silent-debugger-extension-api` hides it entirely: not recommended, it silences a real
security signal for the whole browser.
