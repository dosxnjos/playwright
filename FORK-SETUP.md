# Using this fork (dosxnjos/playwright)

This is a fork of [`microsoft/playwright`](https://github.com/microsoft/playwright), branch
`extension-multi-connection`. It exists to fix one thing the official Playwright Chrome
Extension can't do: **run more than one MCP client against the same browser at the same time**.

If you point an AI coding agent (Claude Code, or any other MCP client) at the official
`@playwright/mcp` package with `--extension`, opening a *second* agent instance disconnects and
steals the browser from the first one. This fork changes the extension so each connecting client
gets its own Chrome tab group, and adds a couple of small conveniences on top. Nothing else about
Playwright changes — this is not a different tool, just this one fix plus a couple of additions
layered on top of the real Playwright.

This document is standalone: it assumes no prior context beyond "I want an AI agent to control my
browser through Playwright, and I might be running more than one agent at once."

## What you get

- **Multiple simultaneous MCP connections** to the same Chrome browser, each in its own labeled
  tab group (`Playwright · <client name>`, deduplicated as `(2)`, `(3)`... if two connections
  share a name), instead of the second connection kicking out the first.
- **`browser_set_group_label`**, a new MCP tool an agent can call to give its own tab group a
  short custom label (e.g. the task it's working on), so a human glancing at their browser can
  tell which group of tabs belongs to which agent/session.
- A **local wrapper script** (`scripts/run-mcp-server.cjs`) that runs the MCP server from this
  fork's own build instead of always downloading Microsoft's published `@playwright/mcp` package
  — needed because the fix above lives in code this fork changed, not in the published package.

Everything else (navigating, clicking, snapshots, all the other MCP tools) is unmodified
Playwright — see the [upstream docs](https://github.com/microsoft/playwright) for those.

## Prerequisites

- Node.js 20 or newer (`node --version`).
- Git.
- Google Chrome (or Chromium/Edge — the extension targets Chromium-family browsers).
- An MCP-capable client (Claude Code, or anything else that speaks MCP over stdio).

## 1. Clone and build

```bash
git clone https://github.com/dosxnjos/playwright.git
cd playwright
npm ci
npm run build
```

The build takes on the order of 20-30 seconds on a typical machine (measured 17/07/2026: ~28s
cold, ~18s for a change touching a single file — the build isn't meaningfully incremental, so
don't expect it to get much faster on a second run). This produces:

- `packages/playwright-core/lib/` — the MCP server.
- `packages/extension/dist/` — the Chrome extension, ready to load unpacked.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. If the official "Playwright Extension" from the Chrome Web Store is already installed in this
   Chrome profile, **disable it first** — this fork's manifest pins the same extension ID
   (`mmlmfjhmonkocbjadbfplnigmagldckm`) so the two can't coexist in one profile.
4. Click **Load unpacked** and select `packages/extension/dist/`.

**If you're on branded Chrome 137 or newer**: `--load-extension` (the flag some tools use to load
extensions automatically) is silently ignored by Google's official Chrome build — this is an
intentional, official-builds-only restriction (confirmed against the Chromium source). Load the
extension manually via the UI as above, or use the `chromium` channel (not `chrome`) if you need
to load it from a script.

## 3. Point your MCP client at the fork

You have two options here, in increasing order of how much you benefit from this fork:

### Option A — quick check, official package + your local extension

Point your MCP config at the *official* `@playwright/mcp` package, same as any normal Playwright
MCP setup:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--extension", "--browser", "chrome"]
    }
  }
}
```

This lets you use the *extension* you just loaded (multi-connection support included, since
that's extension-side code), but the *server* is still the unmodified official package — so
`browser_set_group_label` (a server-side tool) won't be available. Useful for a fast sanity check
that the extension itself works, not for the full feature set.

### Option B — full fork, server included (recommended)

Use the wrapper script so the MCP server itself also comes from this fork's build:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/absolute/path/to/playwright/scripts/run-mcp-server.cjs", "--extension", "--browser", "chrome"]
    }
  }
}
```

(On Windows, use a double-backslashed absolute path, e.g.
`"C:\\path\\to\\playwright\\scripts\\run-mcp-server.cjs"`.)

The wrapper exists because a naive "always run the local build" setup has a real failure mode: if
the local build is ever broken (mid-edit, bad rebase, whatever), *every* MCP client using this
config breaks at once, with no fallback — worse than the official package, which always fetches a
known-good published version. The wrapper avoids that:

- If the local build is fresh, it runs the local server directly.
- If the local build is stale or missing, it falls back to `npx @playwright/mcp@0.0.78` for that
  launch (so you're never blocked), and rebuilds in the background for next time.
- If the background build fails, it keeps falling back automatically and logs the failure to
  `scripts/.build-log.txt` — nothing breaks, you just don't get this fork's extra tools until the
  build is fixed.

Restart your MCP client(s) after changing this config.

## 4. Using `browser_set_group_label`

Once connected via the fork server (Option B above), an agent can call:

```
browser_set_group_label({ label: "some short task name" })
```

This renames its own connection's tab group to `Playwright · some short task name` in the browser
UI (with a `(2)`, `(3)`... suffix if another active connection already used that exact label).
It's most useful when you're running more than one agent at once and want to glance at your
browser and tell them apart. Calling it again on the same connection renames that connection's own
group; it can't affect any other connection's group.

## Known limitations

- **This fix is extension + server code, not a config change.** It only takes effect once you've
  loaded the unpacked extension (step 2) *and* are running the server from this fork (step 3,
  Option B) — pointing only the extension or only the server at the fork gets you a partial
  effect at best.
- **Automated extension tests (`npm run test-extension`) are unreliable on Windows.** The
  upstream test suite for this area only runs on macOS in CI and has never been validated on
  Windows — its connect flow depends on Chrome's OS-level singleton relaunch behavior, which
  doesn't behave the same way there. If you're on Windows and see this suite hang or fail, that's
  this known gap, not necessarily a sign your setup is broken — try the actual extension in a real
  browser instead of trusting the automated suite's result on Windows.
- **One known open bug**: in the token-bypass connection path (bypassing the browser confirmation
  dialog via a saved token), the seed tab's ownership can resolve incorrectly on disconnect,
  leaving a tab behind that should have closed. Doesn't affect the tab-picker connection flow.
- This fork intentionally does **not** try to give tab groups per-sub-agent identity within a
  single MCP connection — Chrome doesn't support nested/hierarchical tab groups, and there's no
  protocol-level way to tell which sub-agent of a shared connection made a given call. Each
  *connection* gets its own group; sub-agents sharing one connection share its group.

## Updating

```bash
git pull
npm ci
npm run build
```

Then reload the unpacked extension in `chrome://extensions` (the reload icon on the extension's
card) and restart any MCP clients using it, so both sides pick up the change.

## Getting help / reporting issues

This is a personal fork, not an officially supported project — open an issue against
[`dosxnjos/playwright`](https://github.com/dosxnjos/playwright) if something's broken. For
anything unrelated to the multi-connection fix (a Playwright bug unrelated to this fork's
changes), check whether it reproduces against the official
[`microsoft/playwright`](https://github.com/microsoft/playwright) first — this fork only diverges
in the areas described above, everything else is unmodified upstream Playwright.
