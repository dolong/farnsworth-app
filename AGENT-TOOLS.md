# AGENT-TOOLS.md

Living spec for the Farnsworth chat agent tool design space.  
**Source of truth for what exists**: `AGENT_TOOLS` array in `main.js` + `executeAgentTool` handler.  
**Source of truth for what the model knows**: system prompt `app.js` § "Chat agent tools".

---

## Current tools (14)

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
| `set_canvas_view(view)` | Switch top-level view: `"live"` / `"storybook"` / `"code"`. |
| `set_preview(preview)` | Within Live, switch surface: `"post"` / `"mobile"` / `"desktop"` / `"fullscreen"` / `"testview"`. Auto-switches to live. |
| `switch_devvit_user(username)` | Switch active emulator user (restarts dev server). Returns available list on miss. |

### Testing

| Tool | Description |
|---|---|
| `test_list` | List JSON tests in `<project>/.farnsworth/devvit-tests/`. |
| `test_read(name)` | Read a test file. Returns raw JSON string. |
| `test_save(name, json)` | Write + validate a test file. Name normalized to lowercase-dashes. |
| `test_run(path)` | Run a test via `farnsworth-test.py` (CDP). Returns stdout/stderr/exitCode/failed count. |

### Memory

| Tool | Description |
|---|---|
| `memory_recall(query)` | Search Farnsworth's long-term memory (concept articles, past conversations, code index, essentials, buffer). No workspace required. |

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
- `take_canvas_screenshot(filename?)` — capture the live preview → file
- `reload_canvas` — force WCV reload (equivalent to Page.reload on canvas CDP target)
- `get_canvas_url` — return the URL the canvas is currently showing
- `zoom_canvas(factor)` — set zoom (0.05–5.0)
- `set_devvit_subreddit(name)` — switch active subreddit (parallel to switch_devvit_user)

### Testing (gaps)
- `run_all_tests` — run every test in the project; return pass/fail counts
- `get_last_test_results` — return cached stdout from the last test_run

### Memory (gaps)
- `memory_save(key, value)` — agent writes a fact back to the memory store
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
