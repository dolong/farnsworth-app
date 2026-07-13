# Farnsworth — Native macOS Menu Bar (Jul 2, 2026)

Added a proper VS Code-style menu bar to Farnsworth. Long reported the
app had no file/folder/window controls; the only way to open a folder
was via the welcome overlay. Now the macOS menu bar drives everything.

## What's wired

### Native menu bar (`Menu.setApplicationMenu` in main.js)
- **Farnsworth** (app menu): About, Settings… (⌘,), Hide, Quit
- **File**: New Window (⌘N), New File (⌥⌘N), Open File… (⌘O),
  Open Folder… (⇧⌘O), Open Recent (last 10 folders), Close Folder (⌥⌘W)
- **Edit**: Standard cut/copy/paste + Find (⌘F → command palette)
- **View**: Show Files/Tasks/Live Tabs (⌘1/⌘2/⌘3), Toggle Left/Right
  Panels (⌥⌘B / ⌥⌘R), Focus Terminal (⌘`), Focus Claude Code
  (⇧⌘`), Command Palette (⌘K), Reload, Toggle Developer Tools
- **Window**: New Window (⇧⌘N), live list of open Farnsworth windows,
  Minimize, Zoom
- **Help**: Farnsworth on GitHub

### Multi-window support (`openWindows[]` in main.js)
- New Window / ⌘N spawns a sibling instead of replacing the focused one
- Window menu lists every open Farnsworth window by index + title
- `closed` event removes the window and rebuilds the menu so the list
  stays accurate

### Renderer-side handler (`handleMenuAction` in src/app.js)
- Listens for `menu:action` IPC from the native menu
- Dispatches to the right renderer flow (openFolder, openFile,
  newFile, closeFolder, showTab, toggleLeftPanel, toggleRightPanel,
  focusTerminal, focusClaudeCode, focusCommandPalette, openSettings)

### Dynamic title bar
- Title bar (`titlebar__project`) and chat panel header
  (`chat__project-name`) now show the actual folder name instead of
  hardcoded "UX Screens MBA". When no folder is open, show
  "No folder open" and "Open a folder to start designing" in the sub
  count.

### Command palette (⌘K)
- Modal overlay with backdrop blur, dim background
- Fuzzy-search across commands + recent folders
- Keyboard navigation: ↑/↓ to move, Enter to select, Esc to close
- 12 commands wired + recent folders auto-listed (e.g. "the-last-draft")

### Files tab default
- Right panel already defaults to `files` (state.rightTab: 'files')
- When no folder is open, the empty state shows an "Open Folder…"
  button; clicking it calls `openFolderPicker()` (same path the menu
  uses)

## Files touched
- `main.js` — Menu import, buildMenu(), openWindows[], sendMenuAction,
  Menu.setApplicationMenu on app ready, menu rebuild on recent:add,
  openFolderDialog focused-window fix
- `preload.js` — exposed `onMenuAction(callback)` via contextBridge
- `src/app.js` — handleMenuAction(), openFileFromPath(),
  openNewFileDialog(), closeFolder(), openCommandPalette(),
  toggleLeftPanel/toggleRightPanel/switchLeftTab(), dynamic
  updateWindowTitle()
- `index.html` — replaced hardcoded "UX Screens MBA" with "No folder open"
- `src/styles.css` — command palette CSS (overlay, panel, items)

## Verified end-to-end
- Menu bar items: Apple, Farnsworth, File, Edit, View, Window, Help
  (via `osascript` querying `System Events`)
- File menu items: New Window, New File, Open File…, Open Folder…,
  Open Recent, Close Folder, Close Window
- Open Recent submenu: contains the actual recent folder
  (`the-last-draft`) + Clear Recent
- Command palette opens via View → Command Palette (⌘K), shows 13
  items, input auto-focused, ↑/↓/Enter/Esc all work
- Title bar shows "Farnsworth / the-last-draft" (dynamic, not
  hardcoded)
- Files tab is the active right-panel tab

## Future work (not in this batch)
- Tab persistence across menu-driven window opens (each window shares
  global tab list today — acceptable for v1)
- File → Open File… currently falls through to Open Folder if no
  folder is set; a dedicated file-open IPC handler would be cleaner
- Settings menu items (View → Memory Settings, etc.) would land
  alongside the existing Cmd+, app-level Settings