# Farnsworth Command Palette — Reference

The Farnsworth command palette (`⌘K` from anywhere, or "Command Palette" in the View menu) is a VS Code-style fuzzy launcher for everything in the IDE. This is the canonical reference for what's wired today and what each entry does.

**Source of truth:** the `cmds` array in `src/app.js` (`openCommandPalette()`). When you add or change a command, update this doc in the same commit.

## Keybindings

The palette lists every command with its shortcut for discoverability. Some shortcuts are wired at two layers:

- **Monaco-layer bindings** (`monacoEditor.addCommand(...)`): fire only when the Monaco editor has focus. Monaco captures the keydown before it bubbles.
- **Document-layer bindings** (`document.addEventListener('keydown', ...)`): fire when Monaco does NOT have focus. Used for file-management commands (new file, close file, etc.) so they work from the canvas tab strip, terminal panel, chat input, etc.

When the same shortcut is wired at both layers, Monaco takes precedence because it captures the keydown first. The document-layer binding only runs if Monaco didn't already consume the key.

## File commands

| Command | Shortcut | Layer | What it does |
| --- | --- | --- | --- |
| Open Folder… | `⇧⌘O` | Document | Folder picker |
| Open File… | `⌘O` | Document | File picker |
| New File | `⌘N` | Both | Creates an empty file in the workspace via prompt + `fs:writeFile`. If no workspace is open, opens the folder picker first. |
| Close File | `⌘W` | Both | Closes the active tab. Pushes to the closed-files history so `Reopen Closed Editor` can bring it back. |
| Reopen Closed Editor | `⇧⌘T` | Both | Pops the most recent entry from `closedFiles[]` (max 20) and re-mounts the buffer + cursor. The cursor restoration is best-effort: if the saved line is still in bounds, the editor jumps back to it. |
| Close Folder | `⌥⌘W` | Document | Closes the workspace. Resets `state.folder`, `state.appType`, `state.openFiles`, `state.liveGameId`. |
| Reveal Active File in Finder | `⌘R` | Both | Calls `fs:showInFinder` IPC → `/usr/bin/open -R <path>` (TCC-safe; goes through LaunchServices directly). If no file is open, reveals the workspace folder instead. |

## Editor commands (Monaco-native)

| Command | Shortcut | Layer | What it does |
| --- | --- | --- | --- |
| Find in File… | `⌘F` | Both | Opens the find bar in the code editor. Seeks the input with the current selection if any. |
| Find File by Name… | `⇧⌘P` | Document | Opens the file finder overlay (fuzzy match across the workspace tree). |
| Search in Files… | `⇧⌘F` | Document | Opens the Search in Files overlay (`fs:grepWorkspace` under the hood). |
| Go to Line… | `⌃G` | Both | Prompts for a 1-based line number and jumps to it. Reuses Monaco's `revealLineInCenter` + `setPosition`. |
| Format Document | `⇧⌥F` | Both | Triggers Monaco's `editor.action.formatDocument`. No-op with no active file. |
| Toggle Word Wrap | `⌥Z` | Both | Flips Monaco's `wordWrap` option between `'off'` and `'on'`. Persists in-memory only — resets on reload, matching VS Code's default behavior. |
| Fold All | `⌘K ⌘0` | Monaco | Triggers `editor.foldAll`. KeyChord: ⌘K then ⌘0. |
| Unfold All | `⌘K ⌘J` | Monaco | Triggers `editor.unfoldAll`. |
| Save (built-in) | `⌘S` | Monaco | Saves the active file via `fs:writeFile`. Sets the dirty flag back to clean. |

## Workspace + panel commands

| Command | Shortcut | Layer | What it does |
| --- | --- | --- | --- |
| Show Files Tab | `⌘1` | Document | Switches right panel to Files |
| Show Tasks Tab | `⌘2` | Document | Switches right panel to Tasks |
| Show Live Tab | `⌘3` | Document | Switches right panel to Live |
| Toggle Left Panel | `⌥⌘B` | Document | Collapses / expands left panel (icon strip vs full width) |
| Toggle Right Panel | `⌥⌘R` | Document | Collapses / expands right panel |
| Focus Terminal | `⌘`` | Document | Switches left panel to Terminal tab |
| Focus Claude Code | `⇧⌘`` | Document | Switches left panel to Claude Code tab |
| Settings | `⌘,` | Document | Opens the settings modal (defaults to AI page) |
| Canvas: Open Preview DevTools | — | Palette | Opens detached Chromium devtools for the current canvas preview view (`canvas:openDevTools` IPC). Gated on Settings → Canvas → Browser engine → Devtools access — when the toggle is OFF, posts a notice in chat instead (and views created while OFF have `webPreferences.devTools=false`, so devtools are hard-disabled on them). Added Jul 13 with the settings honest-wiring pass. |

## AI commands (per-call-site routing, Jul 13)

Palette-only (no keybinding yet). Both run in the chat panel and use the routed model from Settings → AI → per-call-site routing. git plumbing is main-process (`git:diff` / `git:commit` IPCs, execFile arg arrays — model output can't shell-inject).

| Command | Shortcut | Layer | What it does |
| --- | --- | --- | --- |
| AI: Commit Changes | — | Palette | `git diff` (staged preferred, else working tree + untracked names) → routed model (`commit` row, default Haiku 4.5) writes the message → if the row's confirm toggle is ON, shows the message with Commit/Cancel chips in chat; else commits immediately. Working-tree mode stages all (`git add -A`) at commit time. |
| AI: Review Changes | — | Palette | Same diff → routed model (`review` row, default Sonnet 5) → concise markdown review (verdict / Issues / Suggestions) posted in chat. Read-only. |

A third routed call site, `titles` (conversation auto-naming after the first exchange, default Haiku 4.5), has no palette entry — it fires automatically from `sendChatMessage`'s finally block (`maybeGenerateConvTitle`).

## Recent folders

The palette also surfaces recently-opened folders via the `fs:getRecent` IPC. They appear at the bottom of the list, with the folder path as the sublabel. Selecting one calls `handleFolderPicked()`.

## Adding a new command

1. Add the entry to the `cmds` array in `openCommandPalette()` (around line 4782).
2. If it needs a Monaco keybinding, add a `monacoEditor.addCommand(...)` call inside `initMonacoEditor()` (around line 6904).
3. If it needs a global keybinding (works when Monaco doesn't have focus), add a branch to the document keydown listener in `wire()` (around line 5796).
4. Update this doc.

## Architecture notes

- The `cmds` array is re-built on every palette open. Recent items are fetched async via `window.farnsworth.getRecent()`. The palette is fuzzy-filtered by label + sublabel (case-insensitive `includes`, not fuzzy rank — VS Code's true fuzzy match is on the backlog).
- `closedFiles[]` is module-scoped (not on `state`) because it doesn't need to be serialized or persisted. It resets on app restart, which matches VS Code's behavior.
- The `fs:showInFinder` IPC wraps `/usr/bin/open -R <path>` instead of `shell.showItemInFolder` to avoid macOS AppleEvents TCC prompts (see [[essentials]] § toolchain on the Mac mini).
- Monaco's `KeyChord(...)` is the only way to bind multi-key sequences like ⌘K ⌘0 — there's no equivalent at the document layer. Document-layer chords would require manual state tracking on the first half-key.