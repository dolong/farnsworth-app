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
