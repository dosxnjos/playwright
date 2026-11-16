# dosxnjos/playwright: what this fork carries over upstream

Not part of upstream. `main` is `microsoft/playwright` `main` plus the small patch set below; it is the only branch.
The rule of the fork: carry only what upstream does not do. History of how it got here:

- 28/09/2026: rebuilt on top of upstream instead of merged (`roadmap/2026-09-28-refazer-fork-sobre-upstream.md`);
  old branch in tag `fork-pre-refazer-2026-09-28`, the unmerged ghost-tab commit in tag `fork-multi-connection-6f0b4cfdc`.
- 12-15/11/2026: upstream's #44047 rewrote the extension (`connectedTabGroup.ts`, `relayConnection.ts`,
  `pendingConnection.ts`, `ui/connect.css`, `ui/status.tsx` gone; `tabGroupManager.ts`, `tabRegistry.ts`,
  `connectionBroker.ts`, `clientSession.ts`, `ownedTab.ts`, `cdpPolicy.ts`, `ui/manage.tsx` new) and #43893 folded
  `mcp/cdpRelayV2.ts` into `mcp/cdpRelay.ts` + `mcp/browserModel.ts`. So the patches were **redone one by one** on the
  new upstream, not rebased. Plan, map, reports and rehearsal: `roadmap/2026-11-12-sync-upstream-pos-44047.md` and its
  folder `roadmap/2026-11-12-sync-upstream-pos-44047.d/` (`mapa.md`, `relatorio-fase2.md`, `ensaio.md`).
  Tags: `fork-pre-sync-2026-11` (`78989ed37`, the old fork) and `fork-pre-virada-2026-11` (`d8a1a567e`, `main` right
  before the switch); the work branch `sync-2026-11` stays on `origin`.

**Last sync:** 15/11/2026, `main` = `908d32b77` on top of upstream `8534271f0` (upstream `main` of 12/11, after
#44047). Extension `0.5.0.3`. Checked in real Chrome (Profile 13) on 15/11: label, navigate, snapshot, screenshot of a
hidden tab (178 ms and 2.4 s), no stolen focus; the close left only the agent tab the user was looking at, in the
gray group (§ Tab ownership, "Tab in front of the user"). One client, no sub-agent. Not measured there: a tab never
shown (`revealed=true`) and the window focus coming from another app.

## The patches (one commit each on the 15/11 base)

| # | what | where | state after the 15/11 sync | upstream status |
| --- | --- | --- | --- | --- |
| 1 | `scripts/run-mcp-server.cjs` wrapper (+ `background-build.cjs`, `prune-mcp-output.cjs`, `run-mcp-server.smoke.cjs`, `run-mcp-server.test.cjs`), `.pre-commit-config.yaml` (the central's gate), CI trimmed to manual + `upstream-drift.yml` | `scripts/`, `.pre-commit-config.yaml`, `.gitignore`, `.github/workflows/` | redone as it was; npx fallback pin `0.0.83` -> `0.0.85` | ours |
| 6 | agent routing: one browser backend per calling agent (`_meta.agente`); `browser_close` text says what it closes; AI sessions start with routing off; an ended agent's backend is released by a SubagentStop marker file | `mcp/agentRouter.ts`, `mcp/program.ts` (`withAgentRouting` around the factory passed to `mcpServer.start`), `backend/common.ts` (`browser_close` text), `tools/index.ts` (exports for the specs), `tests/mcp/agent-routing.spec.ts`, `scripts/run-mcp-server.cjs` (`envForAiSession`) | redone as it was; plus: the session folder goes on process `exit` (upstream's stdio server stopped calling `dispose` at stdin end, #43174), one `exit` listener per process | ours; upstream declined a similar path (#39703, #42961) |
| 2 | `browser_set_group_label` tool | server: `backend/groupLabel.ts`, `backend/extensionSession.ts` (`Browser -> relay` registry), `backend/tools.ts`, `mcp/{cdpRelay,browserModel,protocol,extensionContextFactory}.ts` (`extension.setGroupLabel`); extension: `clientSession.ts` (the command) -> `connectionBroker.ts` (`onSetGroupLabel`) -> `tabGroupManager.ts` (`setLabel`, `ClientTabGroup.setTitle`); `tests/mcp/{group-label,capabilities}.spec.ts`, `tests/extension/group-label.spec.ts` | **redesigned** on `TabGroupManager`; dedup " (2)", " (3)" there; with `--no-tab-group` it answers a text, not an error | upstream only has a **fixed name per server** (`--session-name`/`--session-color`, #44047); #41840 closed "not planned" in the 31/10 sweep |
| 7 | focus zero: who is in the background, carrier, put the user's tab back, focus emulation, popup source, silent popups, reveal for capture, 60 s screenshot ceiling | see § Focus zero | **shrunk**: what upstream now does left the patch (below) | ours; upstream covers part (#43864 `--background`, #43258, #44047) |
| 3 | agent-created tabs are **closed** when the client leaves (a dead worker's too); user tabs only go free | extension: `agentTabs.ts` (new), `ownedTab.ts` (`agent`), `tabRegistry.ts` (`claim(…, {agent})`, `closeAgentTabs`, `onDetach` demotion, popup origin), `tabPicker.ts` (blank tab = agent's), `clientSession.ts` (`chrome.tabs.create` claims with `agent: true`), `connectionBroker.ts` (`_closeSession`), `background.ts` (dead-worker cleanup, 3 s cap), `types.ts` + `ui/connect.tsx` (`closeAgentTabs`, `agentTabs=keep`); server: `mcp/cdpRelay.ts` (`agentTabs=keep` in the connect URL); `tests/extension/tab-ownership.spec.ts`, `tests/extension/harness.ts` | **redesigned** on the ownership model of #44047; switch `PLAYWRIGHT_MCP_AGENT_TABS=keep` gives upstream's behavior back; plus (15/11, `0.5.0.4`): an agent tab closes past a "Leave site?" dialog (§ Tab ownership) | upstream keeps every tab in a resumable gray group, by design (#41864, #44047) |
| 8 | a client can delete **some** cookies (by name or domain), not plant one or clear them all | extension: `cdpPolicy.ts` (`onlyExpiredCookies`, `cookieSitesOutside`, `Network.setCookie(s)`/`deleteCookies` refused), `clientSession.ts` (`_checkCookieSites`); `tests/extension/cookies.spec.ts` | **new** (15/11) | upstream refuses `Storage.setCookies` entirely (#44047), which also blocks `browser_cookie_delete` |
| 4 | the fork's own visual for the extension UI | (was `extension/src/ui/connect.css` & co.) | **postponed** (decision D6 of the sync roadmap): upstream's new UI already follows the system dark theme (`ui/colors.css`, `ui/common.css`); only the fork's own look is missing, a CSS-only patch if ever wanted | declined (#41841) |
| 9 | `browser_use_profile({ profile })`: the conversation picks a vault variant (token + Chrome profile folder) at run time; every agent's backend closes and reopens in it | `backend/useProfile.ts` (schema, vault reading, description), `mcp/agentRouter.ts` (the switch itself), `backend/extensionSession.ts` (`relayScope.profile`), `mcp/extensionContextFactory.ts` + `mcp/cdpRelay.ts` (token and folder of the chosen variant, carrier only of the same profile, spawn `error` handled), `mcp/program.ts` (start folder to the router), `tests/mcp/use-profile.spec.ts`, `tests/extension/use-profile.spec.ts` | **new** (15/11, branch `feat-use-profile`) | ours |
| — | a current tab that Chrome detached from the debugger (a PDF in an iframe) comes back current, at its place, unless the agent selected or opened a tab meanwhile; the "Target page … has been closed" error of the call stays | `backend/context.ts` (`_lostCurrentTab`), `tests/extension/scheme-detach.spec.ts` | new (15/11, branch `fix-popup-page-closed`) | not sent upstream |
| — | extension tests run on Windows: the relay starts a `.js` browser executable with `node`; `PWTEST_CHROME_STUB_FOREGROUND` plays Chrome < 158 | `mcp/cdpRelay.ts` (2 lines at the `spawn`), `tests/extension/chrome-stub.js` | new (12/11) | not sent upstream |

Manifest `0.5.0.4` (`0.5.0.3` until the 15/11 integration added the "Leave site?" close of patch 3) = upstream's
`0.5.0` + the three extension patches (7, 3, 8); extra permission `webNavigation`
(popup source). The fork's commands `extension.setGroupLabel`, `extension.revealForCapture` and
`extension.restoreAfterCapture` are documented here, not in upstream's `packages/extension/design.md`.

### Tab ownership (patch 3, on top of #44047)

Upstream (#44047) decides which **client** owns a tab (`TabRegistry`, `OwnedTab`). The fork adds which **origin** it
has: `OwnedTab.agent` is true when the client created the tab, false when the user gave it.

- **Agent's** (closed when the client leaves): the blank tab of a client that connected with nothing selected (the
  token path, `tabPicker.ts`), a `chrome.tabs.create` of the client (`browser_tabs new`, `Target.createTarget`), and
  a popup of an agent tab (the popup inherits the origin of its **source** tab).
- **User's** (only go free, i.e. stay in the gray group upstream leaves behind): picked on the connect page, a group
  taken over, a tab dragged into the group, a tab moved from another client, a popup of a user tab.
- **Demoted to the user's:** a tab detached for any reason other than `target_closed` (Cancel on the debugger bar,
  DevTools opened): the user took it over. A Cancel detaches **every** tab of the client, so all its agent tabs become
  the user's and stay open (accepted in the 13/11 review: the safe side).
- **Created after the client left:** a `chrome.tabs.create` that answers after the channel closed is closed at once.
- **Tab in front of the user is never closed** (rule since commit `46012581b`, 13/11): an agent tab that is the
  active tab of a focused window becomes the user's and goes free (gray group), instead of closing. The user may be
  typing in it (a 2FA code the agent asked for). A failed window query counts as focused. It applies on **both**
  paths: the normal close (`TabRegistry.closeAgentTabs`, run by `ConnectionBroker._closeSession`) and the dead-worker
  cleanup (`closeAgentTabsOfPreviousServiceWorker`, `agentTabs.ts`). Seen live on 15/11: the agent's tab the user was
  looking at stayed in the gray group when the test client left.
  ⚠️ **One exception, on the normal close only** (since `0.5.0.4`): an agent tab with a "Leave site?" dialog open (a
  navigation of the agent waiting on it) closes even in front, because Chrome brings a tab with a dialog to the front
  and nobody types into a page behind one. The dead-worker cleanup has no debugger, so there the rule has no exception.
- **"Leave site?" on close** (since `0.5.0.4`, branch `fix-beforeunload` plus the 15/11 review): `chrome.tabs.remove`
  runs the page's `beforeunload`, and a page that saw a click and has a handler kept its tab open with the dialog up,
  hanging `browser_tabs close`, `browser_close` and the close on leave (so the user's tabs never went to the gray
  group). An agent tab now closes like `page.close()` without the extension (`agentTabs.ts` `closeTabs`, also used by
  `clientSession.ts` for `chrome.tabs.remove` of agent tabs): an open "Leave site?" dialog is dismissed, then the
  dialog of the close is accepted, through the still attached debugger. The type of the open dialog is read from the
  debugger events (`noteDebuggerEvent`, fed by `TabRegistry`), so an **alert, confirm or prompt is never answered**: an
  agent tab behind closes past it (Chrome drops the dialog with the tab), one in front of the user goes free with it.
  Each tab's close, the dismiss included, is capped at 5 s (`AGENT_TAB_CLOSE_CAP_MS`); the tabs close side by side, so a
  leave waits 5 s at most for them. User tabs and navigations are unchanged: the user or `browser_handle_dialog`
  answers those. A tab without the debugger (a dead worker's) gets the plain remove, and its dialog stays for the user.
  Tests: `tests/extension/tab-ownership.spec.ts` ("Leave site?", "never dismissed", "5 s at most").
- Each agent tab is closed on its own (`Promise.allSettled`, with a retry while the user drags a tab), so one tab
  already gone does not keep the others open.
- `PLAYWRIGHT_MCP_AGENT_TABS=keep` (server env): the connect URL carries `agentTabs=keep` and nothing is closed, as
  upstream. `tests/extension/harness.ts` turns `keep` on by default, so upstream's specs (which expect the token's
  blank tab to survive) run unchanged; the fork's specs ask for `close`.

`browser_set_group_label` reaches the relay through a `Browser -> relay` registry (`backend/extensionSession.ts`),
not through `browserFactory`/`program`/`BrowserBackend`, which upstream keeps rewriting. No-op without `--extension`;
an error if `--extension` was requested but no relay is connected; a text answer with `--no-tab-group`.

⚠️ `--session-name`/`PLAYWRIGHT_MCP_SESSION_NAME` and `--session-color` (upstream, #44047) are **per server**: with
them every backend of the agent router gets the same title and color (`browserFactory.ts` uses `config.sessionName`
and ignores the `clientName` the router sets per agent), so sub-agents' groups look alike. The wrapper passes neither;
`browser_set_group_label` stays the way to name a group.

Pinning the profile at start is upstream's `--profile-dir-name` / `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` (takes the profile
**folder**, e.g. `Profile 13`); switching it during a conversation is the fork's patch 9 (§ Profile per conversation).

## Profile per conversation (patch 9, `browser_use_profile`)

Every conversation starts in `C:\Dev`, so the folder table (§ Running the server) cannot pick the profile. The
conversation calls `browser_use_profile({ profile: "jacira" })` instead; contract and decisions:
`roadmap/2026-11-15-perfil-por-conversa.md`, review report in its `.d/relatorio.md`.

- **Scope: the server, i.e. one conversation** (D2). The agent router handles the tool itself, before any backend
  exists, so a switch before the first browser call never opens the old profile. The chosen variant reaches every
  agent's relay through `relayScope.profile` and wins over `PLAYWRIGHT_MCP_EXTENSION_TOKEN`,
  `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` and `--profile-dir-name`. A carrier only serves relays of the same folder and token.
- **The switch** drops every agent's backend in the same tick (their agent tabs close, patch 3) and waits up to 10 s for
  them to close; the answer says "closed" or "still closing". Asking for the variant already in use (the start one:
  its token is the active token and its folder the one the relay starts with) changes nothing.
- **Concurrency rules** (from the 15/11 review): a call that was waiting for a backend the switch dropped is **not
  run** (error: call again); a call that ran while the switch closed its browser gets a note that it may not have taken
  effect; every other agent the switch dropped (and main, when a sub-agent switched) gets a one-time `### Note` in its
  next result; of two switches at once the earlier answers an error naming the profile in use; an agent that had
  labeled its group is asked to call `browser_set_group_label` again (the label lives in the old relay).
- **Description** (what the model reads in `tools/list`, read once at start): the pickable variants with the user's
  aliases (`~/.claude/playwright-apelidos.json`, e.g. `{ "jacira": ["minha mãe"] }`, path `PLAYWRIGHT_MCP_PROFILE_ALIASES`;
  local, never versioned) and the folder; Chrome's profile name only for a variant without an alias and never when it
  contains `@` (Chrome names a profile after its e-mail).
- **Errors, no change** (D4): unknown variant, variant without token or folder, variant left out of the allow list.
  Without `--extension` (D5) the tool answers that it does not apply.
- **Token** (D6): never in a response, the description or a `pw:mcp:*` log line; the router logs
  `use profile variant=X profileDir=Y closing=N`. A browser executable that cannot start fails the call with its error
  code and path (unhandled, Node used to print the connect URL with the token and kill the server).
- ⚠️ **Security limitation: any agent of the conversation can switch to any vault account**, so an instruction
  injected in a page can ask for one. `PLAYWRIGHT_MCP_USE_PROFILE_ALLOW=padrao,jacira` (server env, comma-separated)
  limits the variants the tool lists and accepts; the start variant always stays. Unset = every usable variant.
- **Limitations:** with `--extension` and the router off (`PLAYWRIGHT_MCP_AGENT_ROUTING=off`, `--shared-browser-context`)
  the tool answers an error instead of switching. Profile 6 and Default run the Web Store extension (`0.5.0`, § The
  extension), without the label command nor the agent-tab close. The HTTP mode has one router per client, so a switch
  does not leak between clients (read from the code, untested). The token of any vault variant goes on the Chrome
  command line when the relay has to start the browser (same as the active token upstream).
- **Tests:** `tests/mcp/use-profile.spec.ts` (fake backends for the router rules; a real server against a stub
  browser for the token and folder on the connect page, `--profile-dir-name`, the missing executable and the logs) and
  `tests/extension/use-profile.spec.ts` (real extension, headless: both agents' tabs close and the next call reconnects
  with the other folder). Separation of real profiles is only provable in the Gabriel's Chrome.

## Agent routing (patch 6)

One Claude Code session runs one server process, and its sub-agents (Agent tool, Workflow agents) call the browser
through that same process. Without routing they share one current tab, `browser_close` closes everyone's tabs and
`browser_set_group_label` renames the main agent's group. `mcp/agentRouter.ts` wraps the backend factory
(`program.ts`, the `mcpServer.start(withAgentRouting(factory, config), …)` call) and keeps one backend per caller,
created on the caller's first tool call by the same factory the HTTP mode uses per client. Plan and measurements:
`roadmap/2026-10-03-melhoria-abas-por-agente.md`.

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
  marker and disposes that agent's backend (in extension mode its client leaves: patch 3 closes its agent tabs). A
  marker of an unknown key is only deleted (no browser is ever created for it), `main`'s is ignored, and an agent with
  a call in flight keeps its marker until the next sweep. The caller's own marker is only deleted: an agent that calls
  is alive (resumed with SendMessage after its SubagentStop, or kept going by another SubagentStop hook), so it keeps
  its browser; resumed after a periodic sweep already ran, it starts on a fresh one. Session end clears the timer and
  removes the session folder; since the 15/11 sync that happens on process `exit` too, because upstream's stdio server
  no longer disposes the backend at stdin end (#43174). A folder that vanished while the server lives (an older server
  of the same session disposed) is recreated on the next sweep.
- **Log:** `DEBUG=pw:mcp:router` prints `create key=… clientName=…`, `release key=… known=…`, `stale marker key=… (caller)` and `drop key=…`;
  past 8 live agents one stderr warning (tab group colors repeat from the 9th), no cap.
- **Limitations:**
  - an unhandled rejection in one agent's page shows up in the next response of every agent (each Context hooks
    `process.on`; same as the HTTP mode);
  - `--isolated`: agents share no cookies or storage (one context each);
  - `tools/list` only lists the main agent's page WebMCP tools (a sub-agent can still call its own page's tool);
  - a server process killed without dispose or `exit` leaves its empty session folder behind (harmless, nothing reads it);
  - release markers only cover agents whose SubagentStop fires (normal end of an Agent tool or Workflow agent,
    measured; Esc or crash not measured): the idle timeout stays the safety net;
  - a marker can only release a connection that is still alive. When the extension's service worker dies mid-way, the
    agent's backend is already gone (`disconnected`): the next worker start closes its agent tabs (§ The extension,
    "Service worker death"), never the router.
  - Since #44047 a client that closes its last tab stays connected (the old "closing the last tab closes the
    connection" limitation is gone).
- **`browser_close` text** promises that other agents keep their tabs. That is only true with the hook installed;
  with routing off (`ia:*`, persistent) the backend is shared and the close takes everyone's tabs.
- **Tests:** `tests/mcp/agent-routing.spec.ts` covers `--isolated` (including idle dispose measured by context count
  and no idle with a call in flight) plus a fake-backend case for the drop-by-name on `browser_close`, and the release
  markers (periodic sweep disposes the agent, unknown/`main` markers only deleted, the caller's own marker consumed by
  its call without losing its state, no folder without a valid `sessao`, folder removed on session end), with
  `PLAYWRIGHT_MCP_AGENT_RELEASE_DIR` under the test output. The folder test (`:214`) can fail under load (10 s poll of
  the marker folder): it passed 4/4 alone on 13/11. Extension mode was checked by hand on 03/10/2026 (several agents)
and in the 13/11 rehearsal (headless Chromium, a sub-agent through the carrier); the 15/11 real-Chrome check had one
client only.
- **Another machine:** copy the hook from `C:\Dev\cerebro\harness-espelho\` to `~/.claude/hooks/` and add the
  PreToolUse entry of roadmap 2.2 to `~/.claude/settings.json`; without it the agents of a session share one tab again.

## Focus zero: silent connect (patch 7)

Decided by the Gabriel on 03/10/2026 ("pages and tab groups must not take the focus by default"); roadmap
`2026-10-03-melhoria-foco-zero-e-limpeza.md`. With a token, nothing the agents do takes the user's tab or window, the
main agent included. Since the 15/11 sync, upstream's `background` mode (#43864) does most of the work; the fork only
decides **who** is in the background and fills what Chrome 157 (the Gabriel's, on 12/11) and upstream do not.

**What upstream now does (left the patch on 15/11):** a background client's tabs open with `active:false`,
`Page.bringToFront`/`Target.activateTarget` are answered locally (`BrowserModel`), connecting does not activate the
tab nor focus the window (`connectionBroker.ts` `_show`), the token leaves the connect page's URL (#43258), and a tab
only joins a client by an explicit path (so the old "own tabs only" guard is gone; cost: dragging a tab into a
sub-agent's group hands it to that sub-agent again, upstream's behavior). `--open-in-background` opens the first
connect page behind, **only on Chrome >= 158**.

What the fork keeps:

- **Who is in the background** (`mcp/cdpRelay.ts` constructor; `pw:mcp:relay` log `Relay created, background=…
  subAgent=…`): a sub-agent always (the router creates it inside `relayScope.run({ background: true })`,
  `backend/extensionSession.ts`); the main agent when there is a token (`PLAYWRIGHT_MCP_EXTENSION_TOKEN`) and
  `PLAYWRIGHT_MCP_FOCUS` is not `on`; anyone started with upstream's `--background`. Without a token the main agent
  stays in front: the connect page needs a click on Allow. This feeds the same `background` flag upstream passes to
  the connect URL (`background=true`) and to `BrowserModel`.
- **Carrier** (`mcp/cdpRelay.ts` `connectedRelays`, `_openConnectPageViaCarrier`; `clientSession.ts`
  `_carriedConnectPages`): a relay that needs its connect page asks a relay of the same process that is already
  connected (after its handshake) to `chrome.tabs.create` it, with `active:false` when it is a background relay with a
  token. Log: `Connect page opened via portador`. The carrier does not claim a `connect.html` tab it opens; it may close
  it only while no client owns it (a page that did not connect within 10 s, `PWTEST_EXTENSION_CARRIER_TIMEOUT`; with
  the token the page becomes the blank tab of the client it connected, and then it is that client's). Past the
  deadline, or with a dead or failing carrier, the next carrier, then the old `chrome.exe` launch. The carrier's own
  profile is used, so `--profile-dir-name` does not matter on that path.
- **First connections at the same time** (`connectingRelays`, `_waitForEarlierRelay`): with a token and no carrier
  yet, a relay waits (up to the 30 s connect timeout) for a relay that started connecting before it and uses it as
  carrier, so only the oldest launches `chrome.exe`. Never on younger ones (no deadlock), never without a token.
- **Put the user's tab back** (`focusMemory.ts`, `connectionBroker.ts` `connect`, `ui/connect.tsx` sends `token: true`):
  Chrome 157 ignores `--open-in-background`, so each session's first connect page opens in front. For a background
  client that connected with the token, `FocusMemory.putBack` puts back the tab that was active in that window before
  the connect page and, if no Chrome window had the focus then, calls `chrome.windows.update(id, {focused:false})`.
  Only while the connect page is still the active tab. `FocusMemory` tracks `tabs.onActivated` and
  `windows.onFocusChanged` itself (always on, state in `chrome.storage.session`) and snapshots both at each
  `tabs.onCreated`: asking Chrome at connect time returns the connect page (measured 03/10). ⚠️ Cost: the service
  worker wakes up on every tab switch of the user (upstream avoids that). It can go when Chrome reaches 158 and
  `--open-in-background` works. ⚠️ Unmeasured on Windows: whether `focused:false` hands the focus back to the terminal.
- **Focus emulation** (`mcp/browserModel.ts` `_attachTab`): a background tab gets no `requestAnimationFrame`, and the
  `stable` check of click, hover and check polls on it; `--extension` connects with `noDefaults`, which skips focus
  emulation. So right after each `chrome.debugger.attach` a background relay sends
  `Emulation.setFocusEmulationEnabled {enabled:true}` (best effort).
- **Popup source** (`tabRegistry.ts` `popupSourceEvents`, `_onPopupCreated`; manifest `webNavigation`): ⚠️ Chrome's
  `openerTabId` names the tab that was **active** when the popup opened, not the one that opened it, and a background
  client's tab never is (measured in Chromium 1247 on 03/10 and on upstream's extension 0.5.0 with Chromium 158 on
  12/11: the popup never reached the client). So popups are claimed from `webNavigation.onCreatedNavigationTarget`,
  whose `sourceTabId` is the real opener, and upstream's `tabs.onCreated` opener path is skipped when that event
  exists. Without the permission, upstream's path.
- **Silent popups** (same function): Chrome creates the popup active; for a background client the fork puts back the
  tab Chrome names as `openerTabId`, unless that is the popup's source (the user was looking at the agent's tab, to
  follow it or log in: the popup stays in front). A put-back popup may flash; one in a window of its own stays in front.
- **Screenshot ceiling** (`backend/screenshot.ts` `screenshotTimeout`, `screenshotTimeoutFor`): a background relay's
  capture gets `max(action timeout, 60 s)`; `DEBUG=pw:mcp:shot` logs `screenshot <target> background=… timeout=… took
  Nms ok|failed`. Chrome draws no frame for a hidden tab and `Page.captureScreenshot` waits for one: ~12-31 s measured
  on 03/10 with the old extension; 178 ms and 2.4 s on 15/11 with `0.5.0.3`.
- **Reveal for capture** (decided by the Gabriel on 03/10: "mostrar só sem plateia"). Server: `mcp/browserModel.ts`
  `_captureRevealed` wraps each `Page.captureScreenshot` of a background relay with `extension.revealForCapture`,
  then the capture, then `extension.restoreAfterCapture` in a `finally`; both answer within 5 s or the capture goes on
  without them (`withDeadline`); one revealed capture at a time per process, held at most 15 s
  (`PWTEST_EXTENSION_REVEAL_HOLD_MS`), after which the tab is put back first. Extension: `captureReveal.ts` (one state
  for the whole extension, by window) through `clientSession.ts`: only a tab the client owns, not already active, in
  a window that is **not** the focused one (nobody looks); `chrome.tabs.update(active)` inside its window, never a
  window focus. The restore puts the user's tab back only while a revealed tab is in front. A client that leaves with
  a pending reveal gets the user's tab back before its agent tabs close (`connectionBroker.ts` `_closeSession`).
  Window focused -> nothing is revealed, the capture goes on slowly (hence the 60 s). Logs: `Capture of tab N:
  revealed=…`, `Capture without reveal: …`.
- **Kill switches:** `PLAYWRIGHT_MCP_AGENT_SILENT=off` (server env) turns off the carrier and the fork's background
  choice for every agent (upstream's `--background` still applies). `PLAYWRIGHT_MCP_FOCUS=on` only gives the main
  agent the front back (connect page and first connection in front, `browser_tabs new` active, `select` brings the
  tab up); sub-agents stay in the background. Both need a restart of Claude Code.
- **Tests:** `tests/extension/focus-zero.spec.ts` (token client in the background without `--background`;
  `PLAYWRIGHT_MCP_FOCUS=on`; the connect page of a browser < 158 gives the user's tab back; a sub-agent connects through
  the main agent in its own group; the carrier cannot close a page a client owns; `PLAYWRIGHT_MCP_AGENT_SILENT=off`),
  `popup-source.spec.ts` (popup of a background tab goes to its client; popup of the tab the user looks at stays in
  front), `capture-reveal.spec.ts` (window without focus reveals and restores; window with focus does not; not-owned
  tab refused; client leaving mid-capture), `tests/mcp/agent-silent.spec.ts` (only the screenshot ceiling and the
  `pw:mcp:shot` line). **Without a test since 15/11** (same code as the old fork, which had them with a fake
  extension): a carrier that does not answer, answers late or fails (the three fallbacks to `chrome.exe`), first
  connections at the same time, the 15 s reveal hold and two reveals crossing in one window. Not reproducible headless:
  the OS window focus and the slow capture.

## Cookies in extension mode (patch 8)

Upstream (#44047, `cdpPolicy.ts`) refuses CDP methods that change the browser, not the tab: `Storage.setCookies`,
`Storage.clearCookies`, permissions, cache. That also blocks `browser_cookie_delete`: Playwright's
`clearCookies(filter)` reads the cookies and sets the matching ones again with `expires: 0` through
`Storage.setCookies` (`server/browserContext.ts`). The fork lets `Storage.setCookies` through **only** when every cookie
of the call is already expired (a missing `expires` or `-1` is a session cookie: not expired) **and** each cookie is of
a site where the client has a tab (`cookieSitesOutside`, checked in `clientSession.ts`): deleting by name alone would
otherwise log the user out of every site with a cookie of that name; pass the `domain`. `Network.setCookie`,
`Network.setCookies` and `Network.deleteCookies` (the same store, unused by Playwright) are refused too. Planting a
cookie, `browser_cookie_clear` without a filter, permissions and cache stay refused. Test:
`tests/extension/cookies.spec.ts`. Use measured on 12/11: 0 calls of `browser_cookie_*` in the local transcripts.

## Known limitations

- `browser_set_group_label` errors with `--extension --shared-browser-context`: that mode reconnects through another
  `Browser` object, so the registry lookup misses.
- `browser_use_profile` answers an error instead of switching with `--extension` and the router off
  (`PLAYWRIGHT_MCP_AGENT_ROUTING=off`, `--shared-browser-context`): § Profile per conversation.
- Downloads in extension mode: `page.waitForEvent('download')` never fires (reported on 15/11). Upstream's
  design, not a fork bug: the extension connects with `noDefaults`, so the download behavior of the browser is left to
  Chrome (the file still lands in the user's Downloads folder). Workaround for agents: watch the Downloads folder for
  the new file instead of waiting for the event.
- A tab dragged by hand into a sub-agent's group **is** handed to that sub-agent (upstream's model since #44047; the
  old fork ignored it).
- A sub-agent's screenshot, and the main agent's with a token, can be slow while you look at the Chrome window (no
  reveal) and fails only after 60 s instead of 5 s. While you are in another app, the agent's tab shows in its window
  for the capture (about a second) and your tab comes back. ⚠️ Unmeasured in real Chrome: whether a revealed tab paints
  when its window is fully covered by another app (Windows occlusion tracking may still skip the frame); check
  `pw:mcp:shot ... took Nms` next to `Capture of tab N: revealed=true`. Two side effects of a reveal, read from the code
  and untested: `focusMemory.ts` records it as two tab switches, and a popup the agent's page opens during it has the
  agent tab as both source and active tab, so it is not put back.
- Focus zero: the main agent with a token can no longer show you a tab (`browser_tabs select` does not bring it up,
  new tabs open behind): `PLAYWRIGHT_MCP_FOCUS=on` and restart Claude Code. The tab the user was on is put back only if
  the extension saw it become active (state in `chrome.storage.session`).
- With `--extension --isolated` all agents share one relay, and the agent that created it decides `background` for
  everyone (read from the code, untested; not a configuration used here).
- npx fallback pin `0.0.85` (`NPX_FALLBACK_ARGS`): ⚠️ **inferred**, not run against extension `0.5.0.3`. It speaks the
  extension's protocol 2 and translates `Target.createTarget`, but predates #44047 (it does not forget a tab on
  `onDetach`). It only runs while the local build is stale; if it fails, the connection fails until the build ends.
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
   Store copy is installed in that profile, disable it first (same extension ID). Chrome may ask to accept "read your
   browsing history" (`webNavigation`). Open the extension's page ("Manage clients") in that profile and copy its token.
2. Claude Code MCP config (`~/.claude.json` -> `mcpServers.playwright`, or `claude mcp add`): `command` `node`, `args`
   `["<clone>/scripts/run-mcp-server.cjs", "--extension", "--browser", "chrome"]`, `env`
   `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<that token>`. With several Chrome profiles also set
   `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` to the profile folder that holds the extension (`Default`, `Profile 1`...), or the
   connect page may open in the wrong profile. Restart Claude Code.
3. The first launch after a `git pull` uses the official npx server while the wrapper rebuilds in the background; run
   `npm run build && touch scripts/.build-stamp` yourself to skip that.

On macOS `--load-extension` is ignored by branded Chrome 137+ like on Windows, so use the manual "Load unpacked".

Without any of the fork's features (no runtime label, agent tabs kept in a gray group, no focus zero on Chrome < 158)
the official route is enough: install the Chrome Web Store extension and run `npx @playwright/mcp@latest --extension`.

## Syncing with upstream

`origin` = `dosxnjos/playwright`, `upstream` = `microsoft/playwright`. Never a cron rebase (patches can conflict).

```bash
git fetch upstream
git rebase upstream/main          # on main, in a rehearsal worktree (below)
npm ci && npm run build && touch scripts/.build-stamp
git push --force-with-lease origin main   # the rebase rewrites main; needs the owner's OK each time
```

`.github/workflows/upstream-drift.yml` runs weekly (Mon 12:00 UTC) and only opens/updates one issue when `main` is
25+ commits behind or a rebase would conflict; it never syncs. Schedules run from the default branch (`main`), and GitHub
disables them after 60 days without repo activity (re-enable in the Actions tab).

⚠️ The checkout usually has someone's uncommitted `roadmap/*.md` files, so `git rebase` refuses and `--autostash` is
off-limits (the stash is shared between sessions). And the checkout serves the open Claude Code sessions (the wrapper
runs its build): never build, `npm ci` or switch branches there while a server runs from it. Rehearse instead:
`git worktree add -b ensaio-sync <dir> main`, rebase and test there, then, with **zero MCP servers running from the
checkout**, move it with `git reset --keep ensaio-sync` (keeps those files when `roadmap/` is the same on both sides),
`npm ci && npm run build && touch scripts/.build-stamp`, and Reload the extension (§ The extension). Tag the old `main`
first (`fork-pre-<name>`, pushed) so the way back is `git reset --keep <tag>`. The 15/11 sync is the worked example:
`roadmap/2026-11-12-sync-upstream-pos-44047.d/ensaio.md`.

Likely conflicts (the files upstream keeps rewriting, where the fork's lines live):

- `packages/extension/src/tabRegistry.ts` (patch 3 and popup source: `claim`'s `agent` option and the same-owner
  branch, `closeAgentTabs`, the `onDetach` demotion, `forgetAgentTabs` in `release` and `_onTabRemoved`,
  `noteDebuggerEvent`/`forgetOpenDialog` in the `onEvent`/`onDetach` listeners and `_onTabRemoved`,
  `popupSourceEvents`, the early return in `_onTabCreated`, `_onPopupCreated`);
- `packages/extension/src/clientSession.ts` (`checkCdpMethod(…, params)` and `_checkCookieSites`, the
  `connect.html` carrier branch and `agent: true` in `chrome.tabs.create`, the carried-page exception and the agent
  tabs sent to `closeTabs` in `chrome.tabs.remove`, the `extension.revealForCapture`/`restoreAfterCapture`/`setGroupLabel` cases);
- `packages/extension/src/connectionBroker.ts` (`FocusMemory` in the constructor, `token` and `putBack` in
  `connect`, `onSetGroupLabel`, `_closeSession` instead of `releaseAll` + `orphan` in `onClose`);
- `packages/extension/src/tabGroupManager.ts` (`ClientTabGroup.title`/`setTitle`, `setLabel`);
- `packages/extension/src/cdpPolicy.ts` (the three `Network.*` cookie methods, the expired-cookie exception);
- `packages/extension/src/background.ts` (dead-worker cleanup in `_ready` with the 3 s cap, `FocusMemory`, `token`
  in the `connect` message); `ownedTab.ts` (`agent`); `tabPicker.ts` (`agent` in `apply`); `types.ts`
  (`closeAgentTabs`, `token`); `ui/connect.tsx` (`closeAgentTabs`, `token` to `connect`); `manifest.json` (version
  `0.5.0.x`, `webNavigation`);
- `packages/playwright-core/src/tools/mcp/cdpRelay.ts` (who is background in the constructor, carrier sets and
  functions and their same-profile filter, `agentTabs=keep`, the `.js`-with-`node` spawn and its `error` wait, the
  `token` constructor argument, `setGroupLabel`, `sendToExtension`, `connectedRelays` in
  `onInitialized`/`onClose`/`stop`);
- `packages/playwright-core/src/tools/mcp/browserModel.ts` (`revealQueue`, `withDeadline`, `sendToExtension`,
  `_captureRevealed` in `handleCDPCommand`, focus emulation in `_attachTab`);
- `mcp/protocol.ts` (the three `extension.*` commands in `ExtensionCommands`), `mcp/extensionContextFactory.ts`
  (`registerExtensionRelay`), `mcp/program.ts` (keep `withAgentRouting(factory, config)` around whatever upstream
  passes to `start`), `backend/context.ts` (the detached current tab coming back: `kLostTabReturnMs`,
  `_lostCurrentTab` and its uses in `closeTab`, `newTab`, `selectTab`, `_onPageCreated`, `_onPageClosed`),
  `backend/screenshot.ts` (`screenshotTimeoutFor(tab)` instead of `actionTimeoutOptions`, the
  `pw:mcp:shot` `try/finally`), `backend/common.ts` (the `browser_close` text), `backend/tools.ts` (keep
  `groupLabel` in the list), `tools/index.ts` (the fork's exports), `tests/mcp/capabilities.spec.ts` (keep
  `browser_set_group_label`), `tests/extension/harness.ts` (`agentTabs=keep` default), `tests/extension/chrome-stub.js`;
- `.github/workflows/*`: modify/delete -> `git rm` again, and drop any new workflow with an automatic trigger. Upstream
  added two after the 15/11 base: `publish_manual.yml` and a daily dependency roll (#44077, #44111): check their
  triggers at the next sync.

Then check: `npm run build`; `npm run ctest-mcp -- group-label capabilities tabs core agent-routing agent-silent
screenshot cookies use-profile` (121 passed on 13/11, before `use-profile`); `env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION npm run
test-extension` (headless, runs on Windows since the 15/11 sync: 94 passed, 6 failed on 13/11, all six environment
failures listed in § Testing gotchas); `node scripts/run-mcp-server.test.cjs`; `node scripts/run-mcp-server.smoke.cjs`.
`npm run flint` covers `packages/extension/` since upstream #43072 (`npm run tsc` runs its two tsconfigs).
⚠️ On Windows `npm run flint` fails in `doc` (`getBrowserVersions` launches firefox and webkit, not installed here):
environment failure, not a regression.

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
The npx fallback has no fork-only server feature (`browser_set_group_label`, agent routing, carrier, reveal); the
extension-side patches come from the unpacked extension, whatever server runs.
Keep the fallback pin (`NPX_FALLBACK_ARGS`, now `0.0.85`) on a version that speaks the same extension protocol as this
fork (see § Known limitations).

**The Chrome profile follows the active token.** Each vault token `PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variant>` in
`~/.claude.json` has its profile folder registered beside it, `PLAYWRIGHT_MCP_PROFILE_DIR_NAME__<variant>` (`padrao` =
`Profile 13`, `gabriel_pessoal` = `Default`, `jacira` = `Profile 6`, `andressa` = `Profile 7`, `dosxnjos` = `Profile 14`,
`sofia` = `Profile 3`). The wrapper
(`envForActiveProfile`) finds the variant whose token equals the active `PLAYWRIGHT_MCP_EXTENSION_TOKEN` and exports
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` for the server; an explicit value wins, the legacy `PLAYWRIGHT_MCP_PROFILE_DIRECTORY`
is a fallback, and no match logs a warning instead of guessing. Without a profile Chrome opens the connect page in the
last-focused profile and offers the token to the wrong one. New token = add its `__<variant>` profile line too.

**The folder can pick the variant.** Before that, `envForFolder` reads `~/.claude/playwright-perfis.json` (local, never
versioned; `PLAYWRIGHT_MCP_PROFILE_TABLE` overrides the path), e.g. `{ "C:/Dev/univali-docs": "jacira" }`: when the server's
cwd (Claude Code starts it in the conversation's folder) is that folder or below it (case and `\`/`/` ignored, the longest key
wins), the active token becomes `__<variant>` and the profile follows. No table or no match = nothing changes; a variant with
no token logs a warning and keeps the default. Not `-s local` servers: the desktop app looks them up with backslashes and never
loads them. To save a new or rotated extension token, run `scripts/gravar-token-perfil.ps1 -Variante <name> [-Perfil "Profile N"]`
(`powershell -ExecutionPolicy Bypass -File ...`): it writes Doppler (`harness/prd`) and `~/.claude.json` and never prints it.

**AI-opened sessions never use the extension.** Sessions with `CENTRAL_ORIGEM="ia:<route>"` get
`--browser chromium --isolated --headless` (`argvForAiSession`), and `PLAYWRIGHT_MCP_EXTENSION` is dropped from their
env (`envForAiSession`): overnight there is no human to accept the connection and the first tool call used to hang for
1800 s. Human sessions (`humano:*` or no marker) keep the argv unchanged.

**Each launch prunes the output folder.** Every tool call leaves a `page-<timestamp>.yml` or `console-<timestamp>.log`
in `<cwd>/.playwright-mcp` and the server never removes them (110 MB in `C:\Dev\unclick` on 03/10/2026). After
spawning the server, the wrapper (`schedulePrune` / `pruneOutputDir`) deletes from `<cwd>/.playwright-mcp`,
`PLAYWRIGHT_MCP_OUTPUT_DIR` and `--output-dir` the **first-level files** whose name matches
`^(page|console|network|trace|video)-\d{4}-\d{2}-\d{2}T[\d-]+Z?(\.\w+)+$` and whose mtime is older than
`PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS` (default 7; `0` turns it off). Never a subfolder (`~/.playwright-mcp/agentes-fim`
survives), never a chosen name (`meu-print.png`). It is all async after the spawn and a failure only goes to stderr: it
neither delays the ~30 s startup nor kills the server. One-off run with the same rule:
`node scripts/prune-mcp-output.cjs [--dry-run] [--days N] <output folder>...`. Test (plain node, exit 0/1):
`node scripts/run-mcp-server.test.cjs`.

**AI-opened sessions get their own TEMP.** An isolated chromium killed hard (`TerminateProcess` runs no handler, no
cleanup inside the dying process can help) leaves `playwright_chromiumdev_profile-*` (~11 MB) and `playwright-artifacts-*`
in `%TEMP%`: 7 of them in two days on 10-11/10/2026, while the central's disk neared its floor. So an `ia:*` launch
(`prepareSessionTemp`) creates `%TEMP%\pw-ia\<wrapper pid>-<base36 time>` with an `owner.json`
(`{wrapper, server, createdAt}`; the server pid is added right after the spawn) and hands that folder to the server as
`TEMP`/`TMP`/`TMPDIR` (`envForAiSession`). The folder is never reused. Two ways it goes away: a normal end removes it
in the wrapper's exit hook (`runAndExit`'s `onExit`), and every later `ia:*` launch sweeps (`sweepSessionTemps`, async
after the spawn) the folders whose pids are **all** dead (`EPERM` counts as alive; no `owner.json` = judged by the pid in
the name and only at 10+ min of age; a name outside `^\d+-[0-9a-z]+$` or a busy file is skipped, `EBUSY` retried next
launch). Any failure creating the folder (disk full is the motivating case) falls back to the default TEMP with a line on
stderr; human sessions never touch it. `PLAYWRIGHT_MCP_SESSION_TEMP=0` turns it all off. Proof with a real chromium:
`node scripts/run-mcp-server.smoke.cjs` → `smoke ok` (run it after touching this; it needs the build and the stamp up to
date, and with `PLAYWRIGHT_MCP_SESSION_TEMP=0` it must say `smoke FAIL 4`). ⚠️ On Windows a hard kill of the wrapper
takes the server and the chromium with it (libuv puts every child in a kill-on-close job object; measured 16/10/2026),
so the folder of a dead session is complete and unlocked: that is exactly what the sweep removes.

**The central's gate runs the wrapper test.** The central's maestro closes every `[[FEITO]]` in this repo with
`pre-commit run --files <files committed by the round>`; without a `.pre-commit-config.yaml` the framework exits 1
(`.pre-commit-config.yaml is not a file`) and the round is read as rejected (measured 12/10/2026: one opus round lost
on a roadmap-only commit). The fork's `.pre-commit-config.yaml` has one `local` hook, `node scripts/run-mcp-server.test.cjs`,
that runs only when a `scripts/run-mcp-server*.cjs` file is in the commit; anything else is skipped. It is never
installed as a git hook (`pre-commit install` would stash the shared tree on human commits); `npm run flint` stays the lint.

To force pure npx again: put `"command": "npx", "args": ["-y", "@playwright/mcp@<pin>", "--extension", "--browser", "chrome"]`
back in `~/.claude.json`. Restart Claude Code instances after changing it; it is live config shared by all of them.

## The extension (`packages/extension/`)

Build: `npm ci && npm run build`, then `chrome://extensions` -> Developer mode -> "Load unpacked" ->
`packages/extension/dist/`. Reload it there after every build, **in each profile that uses the unpacked copy**, with
no agent connected (a Reload wipes `chrome.storage.session`, see below). A new permission (`webNavigation` in `0.5.0.3`)
may ask for a click; until it is accepted the extension stays disabled in that profile.

**Profiles (15/11/2026).** Only **Profile 13** matters (the Gabriel, 15/11) and only it runs the fork's copy
(`0.5.0.3`; `0.5.0.4` after the Reload of the cut-over that carries it). Profile 7 still has an old fork copy (`0.4.0.5`); Profile 6 and Default use the Chrome Web Store copy
(`0.5.0`). A server whose token points to one of those talks to a different extension: the extension-side patches
(3, 7, 8 and the label command) are missing there.

⚠️ If "Reload" brings back an old version (startup shows the `dist` one), the profile's entry is also an account
(Web Store-synced) extension with a stale record (`account_extension_type: 2` in `Secure Preferences`). Cure: remove
the extension and "Load unpacked" again. That wipes its `localStorage`, so the token changes: rotate it everywhere the
vault note lists. Hit Profile 13 on 01/10/2026 (stale 0.2.1 from 17/07), cured that way.
The manifest `key` pins the same extension ID as the Chrome Web Store version: disable the store copy in that profile
first. `--load-extension` is ignored on branded Chrome 137+; scripted runs need the `chromium` channel.

**Service worker death (11/11/2026, redone on 15/11).** An MV3 worker that dies (idle, crash) loses every session and
no close runs. Upstream (#44047) now marks the previous worker's client groups gray (resumable) and detaches its
debuggers at start-up, and keeps the worker alive while a client is connected (a 20 s keepalive), so the death is
rarer. The fork adds patch 3 on top: agent tabs are recorded in `chrome.storage.session` (`playwrightAgentTabs`,
`agentTabs.ts`; it dies with the browser session, so a tab id reused after a restart is never mistaken for an
agent's), and the next worker closes them (`closeAgentTabsOfPreviousServiceWorker`, run beside upstream's start-up in
`background.ts`, capped at 3 s so it never holds a new connection for long), except the tab in front of the user
(§ Tab ownership; ⚠️ here without the "Leave site?" exception of the normal close, since this worker has no debugger on
those tabs: an agent tab in front with that dialog stays, and so does the dialog). With no record (a worker of an older
version) nothing is closed, as upstream.
⚠️ `chrome.storage.session` is also wiped when the extension is **reloaded, updated or disabled**: the next worker
finds no record, so agent tabs of a connection alive at that moment stay open in a gray group (close them by hand).
Test: `tests/extension/tab-ownership.spec.ts` "agent tabs of a dead service worker close, unless the user looks at
it" (a mutant without the guard turned it red 3/3, 13/11). **Without a test since 15/11:** the 3 s cap, "no record ->
nothing closed", and the old seed-on-`connect.html` case (in the new model the seed is the client's blank tab, recorded
as the agent's).

## Testing gotchas

- **Extension tests run on Windows since the 15/11 sync** (`npm run test-extension`, headless, upstream's harness
  `tests/extension/harness.ts` with `chrome-stub.js` as the browser). Upstream's own run did not work on Windows (69 of
  75 failed: the relay `spawn`ed `chrome-stub.js` and Windows does not run a `.js`); the fork starts it with `node`.
  Six failures are the environment and also fail on upstream with that fix: `extension.spec.ts` `:324`, `:336`,
  `:356`, `:368` (a fake executable that does not run on Windows) and `tab-dragging.spec.ts:35`,
  `tab-management.spec.ts:123` (the title of `chrome://version` is localized: "Sobre a versão", not "About Version").
  The macOS `tests_extension.yml` workflow is **disabled manually in the repo's Actions tab** (since 29/09/2026).
- **`scripts/run-mcp-server.smoke.cjs` launches a real chromium** and needs the fork built with the stamp up to date
  (`isForkStale()` false, else `smoke FAIL 0`); it is the executor's proof, never a gate hook.
- ⚠️ **Unset `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (and `PLAYWRIGHT_MCP_EXTENSION`) before running extension tests.** If the
  shell has the real token exported, the test server sends it to the test browser's extension and the connect page shows
  "Invalid token provided.": `env -u PLAYWRIGHT_MCP_EXTENSION_TOKEN -u PLAYWRIGHT_MCP_EXTENSION npm run test-extension -- <filter>`.
- The test Chromium (revision 1254 = 158 on 12/11) already has `--open-in-background`; the Gabriel's Chrome 157 does
  not. `PWTEST_CHROME_STUB_FOREGROUND=1` makes the stub open the connect page in front, like Chrome 157
  (`focus-zero.spec.ts` and the 13/11 rehearsal use it).
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
