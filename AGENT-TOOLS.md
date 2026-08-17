# AGENT-TOOLS.md

Living spec for the Farnsworth chat agent tool design space.  
**Source of truth for what exists**: `AGENT_TOOLS` array in `main.js` + `executeAgentTool` handler.  
**Source of truth for what the model knows**: system prompt `app.js` § "Chat agent tools".

---

## Current tools (27)

### File system

| Tool | Description |
|---|---|
| `read_file(path)` | Read a workspace-relative file. Sandboxed: `..` blocked. |
| `write_file(path, content)` | Overwrite or create a workspace-relative file. Creates parent dirs. |
| `list_files(pattern?)` | List workspace files, optional glob filter (`*.js`, `src/**`). |

### Execution

| Tool | Description |
|---|---|
| `run_command(command)` | Shell command in the workspace dir. 30s timeout. Returns stdout/stderr/exitCode. |

### Canvas + emulator control

| Tool | Description |
|---|---|
| `open_testview` | Switch canvas to Test View. Legacy entry point — prefer `set_preview("testview")`. |
| `take_canvas_screenshot(filename?)` | Capture the active canvas preview and return the PNG to the agent for visual verification. |
| `set_canvas_view(view)` | Switch top-level view: `"live"` / `"storybook"` / `"code"` / `"prod"` (real headed Reddit Chrome). |
| `set_preview(preview)` | Within Live, switch surface: `"post"` / `"mobile"` / `"desktop"` / `"fullscreen"` / `"testview"`. Auto-switches to live. |
| `switch_devvit_user(username)` | Switch active emulator user (restarts dev server). Returns available list on miss. |

### Prod (real Reddit)

Drives a headed Chrome signed in as a **real Reddit account**, not the Devvit emulator.
Actions are visible to Reddit, affect that account, and are not undoable. All six sit
**above** the workspace-folder gate in `executeAgentTool` — Prod needs no open project
(only `prod_run_script` touches the folder, and only to resolve a bare script name).

| Tool | Description |
|---|---|
| `prod_status()` | Session state, URL, title, viewport, identity profiles, whether an app view is attached. |
| `prod_open_url(url, profileId?)` | Open a real Reddit URL. Starts the session if needed; reuses a live one by navigating. Switches the canvas to Prod. |
| `prod_open_app_view(url?)` | Click a custom post's splash into its interactive Devvit app view and attach to that OOPIF. |
| `prod_input({kind, nx, ny, text, key, deltaY})` | `click` / `type` / `key` / `wheel` into the live browser. Coordinates **normalized 0..1**. |
| `prod_run_script(name, timeout?)` | Run a `.farnsworth/devvit-tests/*.json` script against the real app view. Bare name or absolute path. |
| `prod_stop()` | Stop the session and close the Chrome window. |

**Working order:** `prod_open_url` -> `prod_open_app_view` (interactive posts only) -> `prod_run_script` or `prod_input`.

**No DOM access.** Prod is a frame mirror, not a queryable document: there is no
`document.querySelector` for the agent. Interaction is screenshot-aim-verify —
`take_canvas_screenshot`, then `prod_input` with normalized coordinates, then
screenshot again to confirm. `prod_run_script` is the deterministic alternative and
should be preferred whenever a script already covers the flow.

**Shared implementation.** `prod_input`, `prod_open_app_view`, and `prod_run_script`
call the same `prodInput` / `prodAppOpen` / `prodRunScript` functions the Scripts
panel buttons use through `prod:session:input` / `prod:app:open` / `prod:test:run`,
so the agent path and the UI path cannot drift.

### Testing

| Tool | Description |
|---|---|
| `test_list` | List JSON tests in `<project>/.farnsworth/devvit-tests/`. |
| `test_read(name)` | Read a test file. Returns raw JSON string. |
| `test_save(name, json)` | Write + validate a test file. Name normalized to lowercase-dashes. |
| `test_run(path, record?)` | Run a test. Shares `runTestByPath` with the `test:run` IPC: Node-native runner first (recordable), Python `farnsworth-test.py` fallback for `switchUser` / `llm-step`. Returns stdout/stderr/exitCode/failed count plus a `video` object when the run was recorded. `record` overrides the Test View toggle for this run only. |
| `test_recordings_list(limit?)` | List recorded run videos in `<project>/.farnsworth/recordings/`, newest first: path, source test, size, mtime. |
| `open_recordings_folder(path?)` | Reveal the recordings folder in Finder, or one specific `.webm`. Uses `/usr/bin/open -R` to avoid the AppleEvents TCC prompt. |
| `set_test_recording(enabled)` | Flip the persisted default-recording toggle (`test.record`). Same state as the Record button in Test View; broadcasts `test:record:changed` so the button repaints. |

**Recording (Aug 17).** Runs record to `<project>/.farnsworth/recordings/<test>_<stamp>.webm`
with a burned-in overlay (step index/total, action, selector, elapsed clock, pass/fail).
Precedence is per-run `record` -> `FARNSWORTH_TEST_RECORD` env -> `test.record` setting
-> on. Boundaries: WCV previews only (a game preview must be live), Node runner path
only, and a capture failure never fails the test. The agent tool and the Test View
button share one implementation so they cannot drift.


### Memory

| Tool | Description |
|---|---|
| `memory_recall(query)` | Search Farnsworth's long-term memory (concept articles, past conversations, code index, essentials, buffer). No workspace required. |
| `memory_upsert(slug, title, content, section?, scope)` | Create a concept or replace one named section. Explicit writes are buffered + archived first, then applied immediately through `db.js` so section FTS stays current. Scope is required: `global` or `project`. |
| `memory_append(slug, content, section?, scope)` | Add durable content under a section without replacing existing content. Exact duplicates are suppressed. |
| `memory_forget(slug, match, replacement?, reason?, scope)` | Correct or remove an exact obsolete claim. Archive remains immutable; the active concept is revised and reindexed. |

### UI output

| Tool | Description |
|---|---|
| `ui_show(surfaceType, data, surfaceId?)` | Render an inline UI surface in the chat stream. Renderer-side — never hits `executeAgentTool`. Supports streaming updates for `task_progress` + `work_result` via stable `surfaceId`. |

---

## Missing — design space

### File system (gaps)
- `delete_file(path)` — workspace-sandboxed rm
- `rename_file(from, to)` — workspace-sandboxed mv
- `search_in_files(query, pattern?)` — FTS5 / grep across project files
- `read_file_range(path, start, end)` — partial read for large files
- `get_diff(path)` — unstaged diff for a file

### Execution (gaps)
- `run_in_tab(tabId, command)` — target a named PTY tab
- `get_process_status` — check if dev server is running
- `kill_process(tabId)` — stop a specific PTY

### Canvas + emulator (gaps)
- `reload_canvas` — force WCV reload (equivalent to Page.reload on canvas CDP target)
- `get_canvas_url` — return the URL the canvas is currently showing
- `zoom_canvas(factor)` — set zoom (0.05–5.0)
- `set_devvit_subreddit(name)` — switch active subreddit (parallel to switch_devvit_user)

### Testing (gaps)
- `run_all_tests` — run every test in the project; return pass/fail counts
- `get_last_test_results` — return cached stdout from the last test_run
- `delete_recording(path)` / recordings retention — nothing prunes `.farnsworth/recordings/` today
- Prod-mode recording — Prod is a DOM mirror of an external Chrome screencast, so it needs a separate CDP `Page.startScreencast` + ffmpeg path

### Memory (gaps)
- `search_pkb` — full-text search the project knowledge base (FTS5 codebase index)

### Project / tasks (nothing yet)
- `list_tasks` — read the Tasks panel DB
- `create_task(title, description?)` — add a task
- `update_task(id, status)` — mark done/in-progress/etc.

### Code intelligence (nothing yet)
- `get_diagnostics` — Monaco error/warning list for the open file
- `open_file_at_line(path, line)` — open + jump to a line in Monaco
- `get_cursor_position` — current file + line the editor is at

### Git (ad-hoc via `run_command` today)
- `git_status` — short status of workspace
- `git_diff(path?)` — diff (file or full)
- `git_log(n?)` — last N commits
- `git_commit(message)` — stage all + commit with message

### Settings / config (nothing yet)
- `get_project_config` — read `.farnsworth/config.json`
- `update_project_config(key, value)` — write a setting
- `get_settings(key?)` — read Farnsworth app settings

### External (nothing yet)
- `web_search(query)` — search the web
- `fetch_url(url)` — fetch a URL and return text/JSON
- `reddit_fetch(path)` — fetch a Reddit API path with emulator credentials

---

## Priority gaps

Three tools unlock the biggest jump in "agent as a real IDE assistant":

1. **`take_canvas_screenshot`** — agent can see what it built. Unblocks visual feedback loop.
2. **`search_in_files`** — agent can find things without knowing paths. Unblocks refactoring tasks.
3. **`get_diagnostics`** — agent sees Monaco errors without being told. Unblocks self-correcting edits.

---

## IPC architecture

All canvas/emulator tools follow the same pattern:

```
executeAgentTool(name)
  → mainWindow.webContents.send('channel:name', payload)   // main → renderer
  → preload onChannelName bridge (contextBridge.exposeInMainWorld)
  → app.js renderer listener → state mutation + re-render
```

`run_command` uses `child_process.spawn` in the main process directly (no renderer needed).  
`memory_recall` calls `db.memoryRecall()` directly in main (no IPC).  
`ui_show` is intercepted renderer-side in `sendChatMessage()` before the tool loop (no `executeAgentTool` call).

---

## Related docs

- `DEVVIT-TESTS.md` — test JSON format spec (the agent reads this before authoring a test)
- `app/docs/tests.md` — full test system wiki (published at https://farnsworth-docs.vercel.app)
- `app/docs/enabling-live-preview.md` — **how to wire a Devvit project for Live Preview.** Read this whenever "Go Live" fails with "no farnsworth:devvit script in package.json" (or the project has no `dev-tools/` / `vite.devtools.config.ts` / `.farnsworth/config.json`). Self-contained: full file contents to add to any Devvit app.
- `UI-SURFACES.md` — `ui_show` surface type schemas (TBD — lives in system prompt for now)
