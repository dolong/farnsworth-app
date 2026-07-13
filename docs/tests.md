# How Tests Work in Farnsworth

Farnsworth has a built-in UI automation test system for Devvit games. Tests are plain JSON files that live inside each project, and they drive the real game running in the canvas preview: clicking buttons, typing into inputs, waiting for screens, taking screenshots, and even asking an LLM to judge what is on screen. You can watch a test run live inside the IDE.

This page is the full reference: architecture, file format, every action, all three ways to create and run tests, best practices, troubleshooting, and internals.

**Quick links:** [Big picture](#1-the-big-picture) · [Where tests live](#2-where-tests-live) · [Test View](#3-the-test-view) · [Creating tests](#4-creating-tests) · [File format](#5-test-file-format) · [Actions](#6-actions-reference) · [Selectors](#7-selectors) · [Variables & control flow](#8-variables-and-control-flow) · [LLM steps](#9-llm-in-the-loop-llm-step) · [Running](#10-running-tests) · [Best practices](#11-writing-good-tests) · [Troubleshooting](#13-troubleshooting) · [Internals](#14-architecture-internals)

---

## 1. The big picture

```
   Test View UI            Chat agent                 Terminal
   (Run button)      ("run the play test")     python3 farnsworth-test.py ...
        |                     |                          |
        | test:run IPC        | test_run tool            |
        +---------------------+--------------------------+
                              |
                              v
            python3 farnsworth-test.py <path-to-test.json>
                              |
                              |  Chrome DevTools Protocol
                              |  (WebSocket, port 9222)
                              v
            WebContentsView target (url contains localhost:5174)
                              |
                              v
            The actual game, rendered in the canvas preview
```

Key ideas:

- **Tests are JSON files**, one file per test, stored inside the project they test. No code, no build step, no test framework dependency.
- **The runner is a single Python script** (`farnsworth-test.py`, in the Farnsworth app root). It connects to Electron's debugging port (CDP on 9222), finds the canvas preview's WebContentsView, and executes each step in order using real browser inputs (actual mouse events, actual key events).
- **Tests drive the real game**, not a mock. Whatever the canvas preview is showing (the dev server on `localhost:5174`) is what the test drives. If the Devvit emulator is active, the test exercises the emulated Redis/Reddit stack too.
- **Tests run visibly.** Because the runner drives the same WebContentsView you see in the canvas, you can watch every click and transition happen live in the IDE.
- **Tests are idempotent by convention.** Every test should start with a `reload` step so it can be re-run any number of times without state pollution.

### Why the WebContentsView?

The canvas preview renders the game in an Electron `WebContentsView`. A WebContentsView is an **independent CDP target**: it shows up as its own `type=page` entry on port 9222, separate from Farnsworth's main renderer. The runner attaches to it directly, which completely sidesteps the cross-origin iframe problem (no `webSecurity` hacks, no shim opt-in from game templates, no proxying). The game page is just a normal page as far as the runner is concerned.

---

## 2. Where tests live

```
<project>/.farnsworth/devvit-tests/*.json
```

Each Devvit project carries its own tests. They travel with the repo, sit next to the project's other Farnsworth config (`.farnsworth/config.json`), and never collide between projects. The directory is created automatically the first time Test View opens or a test is saved.

Example, from the-last-draft:

```
/Users/long/Documents/lastdraft/the-last-draft/.farnsworth/devvit-tests/
├── draft-5-picks-rarest.json
├── play-and-dismiss.json
├── play-and-screenshot-lobby.json
└── play-tab.json
```

Two naming layers:

- **The filename is the test's identity.** Test View and the chat agent list tests by filename (without `.json`). Names are normalized on save: anything that is not a letter or digit becomes a dash, lowercased, trimmed. `"My Cool Test"` saves as `my-cool-test.json`.
- **The JSON `name` field is a free-form description.** It can be as long as you like (e.g. `"FTUE (lobby coach + intro video) → team setup → 5 picks picking rarest → auto-assign → start"`). The runner prints it at the start of a run.

---

## 3. The Test View

Test View is the fifth canvas preview mode (the flask icon in the canvas size toggles, next to Post / App Mobile / App Desktop / App Fullscreen). It is the home for everything test-related:

- **Test list.** All tests in the active project's `.farnsworth/devvit-tests/`, sorted by name, with per-row **Run**, **Edit**, and **×** (delete, with confirm) buttons.
- **+ New.** Opens the inline editor in create mode.
- **Inline JSON editor.** Name field + JSON textarea + **Save** / **Save & Run** / **Cancel**. Save validates the JSON before writing (malformed JSON is rejected with the parse error, nothing is written to disk).
- **Generate from description.** A collapsible NLP helper inside the editor: describe the test in plain English and an LLM drafts the JSON for you. The result lands in the editor as editable text, it is not saved until you hit Save.
- **Run output.** Runner output streams into an output pane so you can follow step-by-step progress (`[3] click .bnav-play... OK`), plus a Reset to clear it.
- **Live game preview.** Test View creates its own WebContentsView of the running game, so the test is watchable while it executes. This was the entire point of the architecture: tests you can see.

Switching into Test View (or any preview change) tears down all existing WebContentsViews first and rebuilds the right one, which prevents orphaned views from stacking on top of each other.

---

## 4. Creating tests

Three paths, all producing the same JSON files.

### 4.1 The Test View editor

Canvas → Test View → **+ New**. Write or paste JSON, Save. Use **Generate from description** if you want an LLM first draft. This is the best path when you want full control over every step.

### 4.2 The chat agent (natural language)

Ask the chat panel directly:

> "Create a test called play-and-screenshot-lobby that loads the game, clicks PLAY, and screenshots the lobby."

The agent has five test tools:

| Tool | What it does |
|---|---|
| `open_testview` | Switches the canvas to Test View so you can watch |
| `test_list` | Lists the active project's tests |
| `test_read` | Loads a test's JSON |
| `test_save` | Validates + writes a test (name is normalized) |
| `test_run` | Executes a test by absolute path, returns pass/fail + output |

The agent reads `DEVVIT-TESTS.md` (app root) for the format before authoring, then saves into the active project. It can also edit existing tests ("make the lobby test wait 2 seconds after PLAY") and run them, reporting results back in chat.

### 4.3 The runner's scaffold command (terminal)

```bash
cd ~/Documents/Farnsworth/app
python3 farnsworth-test.py new my-test-name
python3 farnsworth-test.py new my-test-name --steps "reload, wait for .bnav-play, click .bnav-play, screenshot"
```

`new` writes a starter template; `--steps` parses simple plain-English fragments (reload / wait for X / click X / dismiss / screenshot / eval X) into steps. **Caveat:** the scaffolder writes to `./tests/` relative to the current directory (it predates the per-project convention). Move the file into `<project>/.farnsworth/devvit-tests/` afterwards, or just use the Test View editor or chat agent instead, which write to the right place.

---

## 5. Test file format

A test is a single JSON object. The runner reads exactly two top-level keys:

```json
{
  "name": "Human-readable description of the test",
  "steps": [ ... ]
}
```

Any other top-level keys (`description`, etc.) are ignored by the runner and safe to keep as metadata.

### Step anatomy

Each step is an object with an `action` plus action-specific fields:

```json
{
  "action": "click",
  "selector": ".bnav-play",
  "_comment": "Click the PLAY tab in the bottom nav"
}
```

- `action` (required): one of the actions in section 6.
- `_comment` / `name` (optional, any step): pure annotation. The runner ignores both; use `_comment` generously, it is the difference between a maintainable test and a mystery.
- `timeout` (wait actions): milliseconds before the step fails. **Default 5000.**
- Steps run strictly in order. A failed step is recorded and **the run continues** to the next top-level step (so one broken selector does not hide every result after it). Inside `if`/`while` blocks, a failed nested step aborts that block.

### A complete small test

```json
{
  "name": "reload, dismiss welcome, open PLAY tab, screenshot",
  "steps": [
    { "action": "reload", "waitMs": 2000, "_comment": "Reset state so the test is idempotent" },
    { "action": "waitFor", "selector": ".fw-stage--desktop", "timeout": 8000, "_comment": "Canvas rendered" },
    { "action": "clickIfPresent", "selector": ".lobby2-ftue svg", "_comment": "Dismiss welcome modal if present" },
    { "action": "click", "selector": ".bnav-play", "_comment": "PLAY tab" },
    { "action": "sleep", "ms": 1500, "_comment": "Let the lobby settle" },
    { "action": "screenshot", "path": "/tmp/play-tab.png", "_comment": "Visual snapshot" }
  ]
}
```

---

## 6. Actions reference

Fifteen actions, verified against the runner source.

| Action | Required fields | Optional fields | What it does |
|---|---|---|---|
| `reload` | | `waitMs` (default 1500) | `Page.reload` with cache ignored, then waits `waitMs`. Resets state for idempotent runs |
| `waitFor` | `selector` | `timeout` (default 5000) | Polls every 100ms until the selector matches (or `text=` fragment appears) |
| `waitForNotVisible` | `selector` | `timeout` (default 5000) | Polls until the selector no longer matches. For "wait for animation/overlay to finish" |
| `click` | `selector` | | Finds the element, dispatches real CDP mouse events (move, press, release) at its center. Fails if not found |
| `clickIfPresent` | `selector` | | Clicks only if present within 300ms; otherwise skips without failing. For optional overlays |
| `type` | `selector`, `text` | | Focuses the element, then `Input.insertText`. Fires proper `beforeinput`/`input` events, so React/Vue controlled inputs update correctly |
| `screenshot` | `path` | | Saves a PNG of the game page to `path`. Use absolute paths (`/tmp/...` recommended) |
| `eval` | `expression` | | Runs JS in the page, prints the return value (first 80 chars) |
| `sleep` | | `ms` (default 1000) | Fixed wait |
| `extract` | `expression`, `into` | | Runs JS, stores the return value in a variable for `${var}` interpolation |
| `setVar` | `name`, `value` | | Sets a variable to a literal |
| `increment` | `var` | | Adds 1 to a variable (starts at 0 if unset) |
| `if` | `condition`, `steps` | | Evaluates `condition` as JS; runs nested steps only if truthy. Falsy is not a failure |
| `while` | `steps` | `max` (default 100), `until` | Repeats nested steps up to `max` times; checks `until` (JS) before each iteration and stops when truthy. Hitting `max` is not a failure |
| `llm-step` | `prompt` | `into`, `screenshot`, `model`, `max_tokens` | Asks an LLM, optionally with a screenshot — direct API fast path (~2-3s), `claude` CLI fallback. See section 9 |

Notes:

- There is no `scroll`, `wait`, `hover`, or `frame` anything. An unknown action prints `UNKNOWN ACTION` and fails that step.
- `eval` exceptions (JS errors in your expression) fail the step with the exception text, which makes `eval` double as a cheap assertion: `{"action": "eval", "expression": "if (!document.querySelector('.lobby-stage')) throw new Error('no lobby')"}`.

---

## 7. Selectors

Two selector syntaxes:

### CSS (preferred)

Anything `document.querySelector` accepts:

```json
{ "action": "click", "selector": ".draft-card-slot:nth-child(2) .draft-card-anim" }
```

Comma-separated alternatives work and match whichever appears first: `".dh-btn.primary, .tsetup, .draft-start-btn"`.

### `text=` prefix

```json
{ "action": "click", "selector": "text=CONFIRM" }
```

Matches any **visible** element whose text content contains the fragment. For clicks, the runner searches buttons, role=button, common game UI classes, SVG nodes (`g`, `text`, `rect`), and elements inside `foreignObject`, prefers the most specific match, then walks up to the nearest clickable ancestor and clicks its center. For waits, it simply checks `document.body.innerText`.

Use `text=` for SVG-based buttons that CSS cannot address well (the TeamSelect START GAME button is the canonical example: `text=CONFIRM`, `text=CONTINUE TO DRAFT`, `text=AUTO ASSIGN`).

**Not supported:** XPath, and there is no `frame` field. The runner attaches directly to the game's own page (the WebContentsView), so the game's DOM is the top-level document. Selectors just work; no iframe hopping needed.

---

## 8. Variables and control flow

Any string field (selector, path, expression, prompt) supports `${varName}` interpolation from variables set by `extract`, `setVar`, `increment`, or `llm-step`'s `into`.

The signature pattern, from `draft-5-picks-rarest.json` (pick the rarest of 3 draft cards, 5 rounds):

```json
{ "action": "while", "max": 10, "until": "window.__pickCount >= 5 || !!document.querySelector('.da-btn.primary.big')", "steps": [
  { "action": "extract",
    "expression": "(() => { const slots = document.querySelectorAll('.draft-card-slot'); const m = {'COMMON':0,'UNCOMMON':0,'RARE':1,'ULTRA RARE':2}; let best = 0, br = -1; slots.forEach((s, i) => { const l = s.querySelector('.dc-tier-label'); const r = l ? (m[l.textContent.trim()] ?? 0) : 0; if (r > br) { br = r; best = i + 1; } }); window.__pickCount = (window.__pickCount ?? 0) + 1; return best; })()",
    "into": "bestN",
    "_comment": "Find the rarest card, remember its slot index" },
  { "action": "click", "selector": ".draft-card-slot:nth-child(${bestN}) .draft-card-anim" },
  { "action": "waitFor", "selector": ".draft-card-anim.picked", "timeout": 8000 },
  { "action": "waitForNotVisible", "selector": ".draft-card-anim.picked", "timeout": 30000, "_comment": "Next round" }
]}
```

How the pieces fit:

- **`extract` computes in the page, stores in the runner.** The JS runs in the game; the returned value lives in the runner's variable table across steps.
- **Page-side counters** (like `window.__pickCount`) survive between steps because the page is not reloaded mid-test; they reset on the next `reload`.
- **`if` guards optional flows.** FTUE coaches, intro videos, and first-run wizards only appear for fresh users; wrap them in `if` blocks (`"condition": "!!document.querySelector('.lb2-coach')"`) so the same test passes for both fresh and returning state.
- **`while` + `until` handles variable-length loops** like draft rounds or turn-based play. `until` is checked before each iteration; `max` is the safety valve.
- Failure semantics inside blocks: the first failed nested step aborts the block, and the block counts as one failed step; the run then continues with the next top-level step.

---

## 9. LLM in the loop (`llm-step`)

For assertions that are easier to judge visually than with selectors:

```json
{ "action": "llm-step",
  "prompt": "Look at the screenshot. Is the lobby visible with a PLAY button and no error dialogs? Answer YES or NO with one sentence.",
  "screenshot": true,
  "into": "lobbyCheck" }
```

- `screenshot: true` captures the current game page and sends it to the model **inline** (base64) with the prompt.
- **Fast path (default):** one direct POST to the Anthropic API. ~2-3s per step, measured Jul 11. Auth is injected automatically by Farnsworth's `test:run` spawn (the same sign-in the chat uses); terminal runs can set `ANTHROPIC_API_KEY`. Optional `max_tokens` (default 512) caps the answer.
- **Model precedence:** a step's `model` field (accepts `haiku` / `sonnet` / `opus` aliases or a full API id) > the `FARNSWORTH_TEST_MODEL` env var (set automatically from **Settings → AI → Testing model**, default Sonnet 5) > `claude-sonnet-5`. The runner prints the model it used in the step output, e.g. `[claude-sonnet-5]`. Aliases track the latest models: `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5`, `opus` → `claude-opus-4-8`.
- **Fallback:** with no auth available, the runner shells to `claude -p` (the original path). Slow — Node CLI boot plus an agentic Read-tool round trip, ~30s+ measured — and the model sometimes fails to read the screenshot file at all. Treat it as an emergency fallback, not a peer.
- The response text is printed and, with `into`, stored as a variable, so a later `if` can branch on it: `"condition": "${lobbyCheck}".includes("YES")` interpolates the answer into the JS before evaluation.

Keep prompts constrained ("Answer YES or NO plus one sentence") — generation length is the main remaining latency lever. llm-steps stay non-deterministic; they shine as the final "does this look right?" gate after a deterministic setup, not as a replacement for selector waits.

---

## 10. Running tests

### Prerequisites (all three run paths)

1. **Farnsworth is running.** Its launcher opens CDP on port 9222 automatically.
2. **The dev server is up** at `localhost:5174` (the Go Live button, or `npm run farnsworth:<type>` in the project).
3. **A game WebContentsView exists**: canvas is on Test View, App Mobile, App Desktop, or App Fullscreen. If only the main Farnsworth renderer exists, the runner exits with a clear error telling you to switch the canvas.
4. `python3` with the `websocket-client` package (`pip3 install websocket-client`).
5. For `llm-step`: nothing extra when launched from Farnsworth (auth is injected automatically). Terminal runs: set `ANTHROPIC_API_KEY`, or have the `claude` CLI on PATH as the slow fallback.

### From Test View

Click **Run** on a test row (or **Save & Run** in the editor). Output streams into the pane; the game view shows the test happening live.

### From the chat agent

> "Run the draft-5-picks-rarest test and tell me if it passes."

The agent calls `test_run` and reports the result, including output on failure.

### From the terminal

```bash
cd ~/Documents/Farnsworth/app
python3 farnsworth-test.py /path/to/project/.farnsworth/devvit-tests/play-tab.json
```

### Reading the output

```
Test: UI-only smoke test — dismiss welcome, click PLAY tab (idempotent)
Target: http://localhost:5174/
  [1] reload             ... OK (waited 2000ms)
  [2] waitFor            .fw-stage--desktop... OK
  [3] clickIfPresent     .fw-stage--desktop .lobby2-ftue svg... SKIPPED (not present)
  [4] click              .bnav-play... OK (312,780)
  [5] screenshot         /tmp/farnsworth-test-3-after-play.png... saved

5 passed, 0 failed (of 5)
```

- Exit code 0 = every step passed; 1 = at least one failed (or no target found).
- Farnsworth's `test:run` treats a run as OK only if the exit code is 0 **and** the summary line reports 0 failed. It returns the last 4000 chars of stdout and 2000 of stderr, so long runs stay reportable.
- Failed steps say why inline: `TIMEOUT`, `STILL VISIBLE (timeout)`, `EXCEPTION: Selector not found: ...`, `UNKNOWN ACTION`.

---

## 11. Writing good tests

1. **Start with `reload`.** Every test, no exceptions. It is what makes re-runs safe. Give it enough `waitMs` for the app to boot (2000-3000ms for the-last-draft).
2. **`waitFor` before you act.** The runner is faster than the UI. Never click a selector you have not waited for (or that a previous wait guarantees).
3. **`clickIfPresent` for anything conditional.** Welcome modals, FTUE coaches, sound prompts. `click` fails when the element is missing; `clickIfPresent` skips.
4. **Wrap first-run flows in `if` blocks.** A good test passes for both a fresh user and a returning one. See `draft-5-picks-rarest.json` for the pattern.
5. **Generous timeouts around animations.** Card flips, scene transitions, and staggered reveals in the-last-draft need 7-30s waits in places. `waitForNotVisible` is the right tool for "wait until the animation/overlay finishes".
6. **Screenshot at key moments, to `/tmp`, with absolute paths.** Relative paths resolve against the runner's working directory (the Farnsworth app dir when run from the IDE), which is rarely what you want.
7. **`_comment` every non-obvious step.** Future-you reads the JSON cold.
8. **`text=` for SVG buttons.** CSS cannot reach text inside composed SVG buttons reliably; `text=CONFIRM` can.
9. **Prefer selector waits over text waits** when a stable class exists; they are faster and less brittle to copy changes.
10. **One scenario per test.** Tests do not share state or chain; each one reloads and drives to its own end state.

---

## 12. Common selectors (the-last-draft)

Building blocks used by the existing tests. Check the game source when these drift.

| Selector | What it is |
|---|---|
| `.fw-stage--desktop` / `.fw-stage--mobile` | Frame wrapper once the canvas has rendered |
| `.bnav-play` | PLAY tab in the bottom nav |
| `.lobby2-ftue svg` | Welcome modal dismiss target in the lobby |
| `.lb2-coach` | Lobby FTUE coach overlay (click to advance pages) |
| `[data-testid='ftue-intro-video']` | FTUE intro video (3 taps: start, ask-skip, confirm-skip) |
| `.dh-btn.primary` | Draft hub "USE A PICK · START DRAFT" |
| `.tsetup`, `.ts-name-input` | Team setup wizard + team name input |
| `text=CONFIRM`, `text=CONTINUE TO DRAFT` | Team setup wizard SVG buttons |
| `.draft-start-btn` | "INITIATE DRAFT SEQUENCE" |
| `.draft-coach` | Draft FTUE coach overlay |
| `.draft-card-slot`, `.draft-card-anim` | Draft card slots + clickable card |
| `.dc-tier-label` | Card rarity label (COMMON / UNCOMMON / RARE / ULTRA RARE) |
| `.draft-card-anim.picked` | Pick confirmation state |
| `text=AUTO ASSIGN`, `.da-btn.primary.big` | Assign phase auto-fill + START GAME |
| `.lb2-qbtn` | Ranked queue button in the lobby |

---

## 13. Troubleshooting

**"No WebContentsView target found at port 9222"** with a hint about the main renderer: the canvas is not showing the game. Switch to Test View / App Mobile / App Desktop / App Fullscreen so a WebContentsView exists, then re-run.

**Connection refused on 9222**: Farnsworth is not running (or was launched without its normal launcher). Start it with `open /Applications/Farnsworth.app`.

**`ModuleNotFoundError: websocket`**: `pip3 install websocket-client`.

**A click lands but nothing happens**: the element was found but the game was mid-transition. Add a `waitFor` on something that signals readiness, or a short `sleep` after the previous step.

**`Selector not found` on something you can see**: check whether it is inside SVG or appears only after an animation. Try `text=` matching, or a longer `timeout` on a preceding `waitFor`.

**Typing does not stick in an input**: use the `type` action (it goes through `Input.insertText`, which React controlled inputs respect). Setting `.value` via `eval` will be reverted by React.

**Screenshot went missing**: relative `path` resolves against the runner's cwd (the Farnsworth app dir when run from the IDE). Use absolute paths.

**The test passes alone but fails after another test**: one of them is not idempotent. Make sure both start with `reload` and do not depend on leftover page-side state.

**Screenshots from the runner are correct even though CDP screenshots of Farnsworth itself are not**: the known "CDP does not capture composited views" gotcha applies to Farnsworth's *main renderer* target. The runner attaches to the WebContentsView's *own* target, where `Page.captureScreenshot` sees the game directly. Runner screenshots are trustworthy.

---

## 14. Architecture internals

For working on the test system itself.

### Components

| Piece | Location | Role |
|---|---|---|
| Runner | `~/Documents/Farnsworth/app/farnsworth-test.py` | Executes tests over CDP. Single file, ~500 lines, stdlib + `websocket-client` |
| Test storage | `<project>/.farnsworth/devvit-tests/*.json` | Per-project tests |
| Test View UI | `src/app.js` (`renderTestView` + editor helpers) | List / run / edit / delete / NLP generate |
| IPC handlers | `main.js` (search `test:list`) | Filesystem + spawn bridge for the renderer |
| Chat agent tools | `main.js` (`AGENT_TOOLS` + `executeAgentTool`) | Natural-language authoring path |
| Agent format spec | `~/Documents/Farnsworth/app/DEVVIT-TESTS.md` | What the chat agent reads before writing tests |

### IPC surface

| IPC | Args | Returns |
|---|---|---|
| `test:list` | `{ folder }` | `{ ok, tests: [{ name, path, size, modified }], dir }`; auto-creates the dir; `ok:false, error:'no_folder'` if folder invalid |
| `test:read` | `{ folder, name }` | `{ ok, path, name, json }` (raw string, preserves formatting) |
| `test:save` | `{ folder, name, json }` | Validates JSON, normalizes name, writes; `{ ok, path, name }` |
| `test:delete` | `{ folder, name }` | `rm -f` semantics (ok even if missing) |
| `test:run` | `{ path }` (absolute) | Spawns `python3 farnsworth-test.py <path>` with cwd = app dir; `{ ok, code, failed, stdout, stderr }`; `failed` parsed from the "N failed" summary |
| `canvas:setPreview` | `{ preview }` | Validates against `[post, mobile, desktop, fullscreen, testview]`, forwards to the renderer, which tears down all WebContentsViews and re-renders |

The chat agent's `test_*` tools replicate the same logic main-side (the agent runs in the main process, so it calls the shared helpers directly rather than going through `ipcMain`). `open_testview` sends the same `canvas:setPreview` message to the focused window.

### Runner internals

- **Target discovery**: GET `http://localhost:9222/json`, pick the `type=page` target whose URL contains `localhost:5174`. Clear error if only the main renderer is present.
- **CDP methods used**: `Runtime.evaluate` (all queries, waits at 100ms poll, evals), `Input.dispatchMouseEvent` (clicks at element center), `Input.insertText` (typing), `Page.reload` (reset), `Page.captureScreenshot` (screenshots).
- **Variable table** lives on the Tester instance for the duration of a run; `${var}` interpolation happens just before each string field is used.
- **Failure model**: top-level steps continue past failures (full-run visibility); nested steps abort their block. Exit 1 if anything failed.

---

## 15. History

| Date | Milestone |
|---|---|
| Jul 9, 2026 | Seed shipped: Python CDP runner + first idempotent sample test, in `~/Documents/farnsworth-tests/` on the Desktop. WebContentsView canvas swap landed the same day, driven by this suite's needs |
| Jul 11, 2026 (day) | Test View preview mode; inline editor replaced the standalone NLP creator modal; `test:read`/`test:delete` IPCs |
| Jul 11, 2026 (evening) | Tests moved per-project to `<project>/.farnsworth/devvit-tests/`; runner moved into the app root; chat agent gained the five test tools + `canvas:setPreview`; control flow (`if`/`while`/`extract`/vars) + `llm-step` in the runner |
| Jul 11, 2026 (night) | `llm-step` direct-API fast path: screenshot inline, one POST, ~3s per step (was ~34s via the `claude` CLI's agentic Read-tool round trip). Auth injected by `test:run` from the chat's sign-in; CLI kept as fallback |
