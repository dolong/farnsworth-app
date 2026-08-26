# Devvit Tests - JSON test format reference

**You (the Farnsworth chat agent) are reading this because the user asked you to build, edit, or run a test.** Tests live at `<project>/.farnsworth/devvit-tests/*.json` and are executed by `farnsworth-test.py` over CDP against the game running in the canvas preview (the WebContentsView at localhost:5174).

This is the quick reference. The full human-facing wiki is at `docs/tests.md`.

## When to use the test tools

When the user asks any of:
- "create a test that..." / "make a test for X"
- "run the test that..." / "show me the tests" / "what tests exist?"
- "edit the test X to..."

→ Call `open_testview` FIRST (so the user can watch), then `test_list`, then `test_read` / `test_save` / `test_run` as needed.

## The test format

A test is one JSON file. The runner reads exactly two top-level keys; anything else is ignored metadata.

```json
{
  "name": "Human-readable description (can be long)",
  "steps": [
    { "action": "reload", "waitMs": 2000, "_comment": "Reset state - every test starts with this" },
    { "action": "waitFor", "selector": ".fw-stage--desktop", "timeout": 8000 },
    { "action": "clickIfPresent", "selector": ".lobby2-ftue svg", "_comment": "Dismiss welcome if present" },
    { "action": "click", "selector": ".bnav-play" },
    { "action": "sleep", "ms": 1500 },
    { "action": "screenshot", "path": "/tmp/my-test.png" }
  ]
}
```

The filename (normalized to lowercase-dashes by `test_save`) is the test's identity; the JSON `name` is a free-form description.

Step fields: `action` (required) + action-specific fields. `_comment` and `name` on a step are annotation only (use `_comment` generously). `timeout` defaults to **5000ms**. There is NO `label`, `frame`, or `waitAfter` field; for a pause after an action, add a `sleep` step.

## The canvas frame - mobile vs desktop (read this before authoring)

**A test cannot declare its own frame.** The runner reads only `name` and `steps`, so
the viewport a test executes against is ambient UI state: whatever the **resolution
dropdown** in the canvas header is set to while Test View is the active preview.

**The default is Mobile, 390 x 844.** If nobody has picked a preset, that is the frame
you get - so a test authored for a desktop layout will silently run in a phone and fail
in confusing ways. Desktop is fully supported; it just has to be selected.

| Group | Presets |
|---|---|
| Mobile | **390 x 844 (default)**, 375 x 667, 412 x 915, 428 x 926 |
| Desktop | 724 x 596 (App Desktop default), 1280 x 800, 1512 x 1320, 1920 x 1080, 2560 x 1440, 3440 x 1440 |
| Fullscreen | 1120 x 630 |
| Post | 700 x 512 |
| Custom | any W x H typed into the two boxes |

Picking a preset is a **real viewport change**: the game re-lays-out and its responsive
breakpoints fire. Display zoom (the +/- controls) is not - it never changes the logical
viewport, so selectors, clicks and screenshots behave identically at any zoom level.

Rules for authoring:

1. **Do not default to mobile silently.** If the layout differs between phone and
   desktop, ask which frame the test is for, or state which one you assumed.
2. **Make the assumption self-checking.** Right after `reload`, `waitFor` on
   `.fw-stage--desktop` or `.fw-stage--mobile`. If the operator has the wrong preset
   selected, the test then fails on step 2 with an obvious message instead of dying on
   a selector that only exists in the other layout.
3. **Device classification** follows the picked preset while its dimensions still match
   the on-screen frame. After a corner-drag resize or a restart it falls back to
   orientation: width >= height means desktop.
4. **Switching the frame is the operator's job, not yours.** There is no test action and
   no tool parameter that sets it. Say which preset the user needs to pick.

## Available actions (complete list - do not invent others)

| Action | Required | Optional | Description |
|---|---|---|---|
| `reload` | | `waitMs` (default 1500) | Reload the page, wait. Start every test with this |
| `waitFor` | `selector` | `timeout` | Poll (100ms) until selector or `text=` fragment appears |
| `waitForNotVisible` | `selector` | `timeout` | Poll until selector is gone (animations, overlays) |
| `click` | `selector` | | Real mouse events at element center. Fails if missing |
| `clickIfPresent` | `selector` | | Click if present within 300ms, else skip (no fail) |
| `type` | `selector`, `text` | | Focus + CDP insertText (React-safe) |
| `screenshot` | `path` | | Save PNG. Use ABSOLUTE paths, `/tmp/<test-name>-<moment>.png` |
| `eval` | `expression` | | Run JS, print result. Throwing = step fails (use as assertion) |
| `sleep` | | `ms` (default 1000) | Fixed wait |
| `extract` | `expression`, `into` | | Run JS, store result in a variable |
| `setVar` | `name`, `value` | | Set a variable to a literal |
| `increment` | `var` | | var += 1 |
| `if` | `condition`, `steps` | | Run nested steps only if JS `condition` is truthy |
| `while` | `steps` | `max` (default 100), `until` | Repeat nested steps until JS `until` truthy or `max` reached |
| `switchUser` | `username` | `timeout` (default 60000) | Switch the active Devvit emulator user. Restarts the dev server and re-attaches. See below |
| `llm-step` | `prompt` | `into`, `screenshot`, `model`, `max_tokens` | Visual judgment via direct Anthropic API (~2-3s; screenshot sent inline; auth auto-injected by Farnsworth). Falls back to `claude` CLI only if no auth (slow, ~30s+). `model` accepts `haiku`/`sonnet`/`opus` or a full API id; default = Settings → AI → Testing model (Sonnet 5 unless changed) |

There is NO `scroll`, `wait`, or `hover` action.

## Selectors

- **CSS** (preferred): anything `document.querySelector` takes. Comma alternatives OK: `".dh-btn.primary, .draft-start-btn"`.
- **`text=` prefix**: `"text=CONFIRM"` matches visible elements whose text contains the fragment, walks up to the clickable ancestor. Use for SVG-based buttons that CSS cannot reach.
- **NO XPath.** `xpath:` is not supported and will fail.
- **NO `frame` field.** The runner attaches directly to the game page; the game DOM is the top-level document.

## Variables and control flow

Any string field supports `${var}` interpolation from `extract`/`setVar`/`increment`/`llm-step into`. Pattern for "pick the rarest card each round":

```json
{ "action": "while", "max": 10, "until": "window.__picks >= 5", "steps": [
  { "action": "extract", "expression": "(() => { window.__picks = (window.__picks ?? 0) + 1; return 2; })()", "into": "bestN" },
  { "action": "click", "selector": ".draft-card-slot:nth-child(${bestN}) .draft-card-anim" },
  { "action": "waitForNotVisible", "selector": ".draft-card-anim.picked", "timeout": 30000 }
]}
```

Wrap first-run-only flows (FTUE coaches, intro videos) in `if` blocks testing `!!document.querySelector(...)` so the test passes for fresh AND returning users.

## Switching Devvit users mid-test

```json
{ "action": "switchUser", "username": "carol" }
```

`username` takes `"carol"` or `"u/carol"` — the `u/` prefix is normalized on both sides, so either works.

**This is an expensive step, by necessity.** The emulator's server-runner seeds the current user from its config at BOOT, so switching requires a full dev-server restart (typically 3-10s). The runner handles the fallout for you: it drives the switch through Farnsworth's renderer, waits for the server to come back, then re-attaches to the rebuilt game page. Variables set via `extract`/`setVar` survive the switch; page state does not.

Practical consequences:

- **The page is freshly loaded after a switch.** You do NOT need a `reload` right after — but you DO need to re-navigate (click through the lobby, etc.), because you're back at the app's entry point.
- **If the user is already active, the step is a no-op** and skips the restart. Safe to put at the top of every test to pin identity without paying for a restart on every run.
- **The user must already exist** in Farnsworth's emulator settings (cogwheel → users). The step fails with the list of available users if not; it will not create one.
- Raise `timeout` above the 60s default only if the project's dev server is unusually slow to boot.

Multi-user flows (one user posts, another sees it) are the main use:

```json
{ "action": "switchUser", "username": "bob" },
{ "action": "click", "selector": ".bnav-play" },
{ "action": "switchUser", "username": "carol" },
{ "action": "waitFor", "selector": ".lb2-mission-tab", "timeout": 15000 }
```

## Common selectors (the-last-draft)

| Selector | What |
|---|---|
| `.fw-stage--desktop` / `.fw-stage--mobile` | Canvas rendered |
| `.bnav-play` | PLAY tab (bottom nav) |
| `.lobby2-ftue svg` | Welcome modal dismiss |
| `.lb2-coach` / `.draft-coach` | FTUE coach overlays (click to advance) |
| `[data-testid='ftue-intro-video']` | FTUE intro video (3 taps: start, ask-skip, confirm) |
| `.dh-btn.primary` | Draft hub USE A PICK |
| `.ts-name-input`, `text=CONFIRM`, `text=CONTINUE TO DRAFT` | Team setup wizard |
| `.draft-start-btn` | INITIATE DRAFT SEQUENCE |
| `.draft-card-slot`, `.draft-card-anim`, `.dc-tier-label` | Draft cards + rarity label |
| `text=AUTO ASSIGN`, `.da-btn.primary.big` | Assign phase + START GAME |

Read the project source for anything not listed - do not guess selectors.

## Common pitfalls

1. **Start every test with `reload`** (idempotency: tests must be safe to re-run).
2. **`waitFor` before you act.** The runner is faster than the UI.
3. **`clickIfPresent` for optional overlays**; `if` blocks for FTUE flows.
4. **Generous timeouts around animations** (7-30s in the-last-draft draft sequence); `waitForNotVisible` to wait out transitions.
5. **`screenshot` needs an absolute `path`** (`/tmp/...`). There is no auto screenshots dir.
6. **Failed steps do not stop the run** at the top level (you get full output); nested steps abort their `if`/`while` block.
7. **The frame is not part of the test.** Mobile 390 x 844 is the default, so a desktop
   test needs a Desktop preset picked in the resolution dropdown first. Guard the
   assumption with a `waitFor` on `.fw-stage--desktop` / `.fw-stage--mobile`.

## The tools you'll call

| Tool | Args | Returns |
|---|---|---|
| `open_testview` | (none) | `{ ok, preview: 'testview' }` after canvas switch |
| `test_list` | (uses active workspace folder) | `{ ok, tests: [{name, path, size, modified}], dir }` |
| `test_read` | `name` | `{ ok, name, path, json }` (raw JSON string) |
| `test_save` | `name`, `json` | `{ ok, path, name }` after JSON validation |
| `test_run` | `path` (ABSOLUTE, from test_list/test_save) | `{ ok, code, failed, stdout, stderr }` |

## Example agent flows

User: "create a test that loads the game, clicks PLAY, and screenshots the lobby"

```
1. open_testview
2. test_list (see what exists)
3. Build JSON per this spec (reload → waitFor → clickIfPresent FTUE → click → sleep → screenshot /tmp/...)
4. test_save({ name: "play-and-screenshot-lobby", json: <the JSON> })
5. test_run({ path: <result.path from test_save> })
6. Report result; include stdout/stderr if it failed
```

User: "make the lobby screenshot test wait 2 seconds after PLAY"

```
1. test_read({ name: "play-and-screenshot-lobby" })
2. Change the sleep step's ms from 1500 → 2000
3. test_save with the edited JSON
4. Report the change
```
