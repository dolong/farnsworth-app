# Farnsworth

AI-driven design canvas for game development. Discord-inspired, chat-first, Electron.

## Run

```bash
cd ~/Documents/Farnsworth/app
npm install
npm start
```

`npm install` pulls Electron (~150 MB first time). `npm start` launches the desktop window.

## Architecture

```
main.js              Electron main process — window, IPC, file I/O
preload.js           contextBridge exposing window.farnsworth
index.html           Single-window layout with 4 panes + settings overlay
src/styles.css       Discord-inspired design tokens + all component CSS
src/app.js           State management, rendering, mock data
```

Three regions in the main window:

- **Chat panel** (left, 384px) — agent conversation thread, status indicators, input
- **Canvas** (center, flex) — Live / Storybook / Code view modes, mobile/desktop preview, zoom
- **Right panel** (right, 352px) — Files / Bookmarks / Tasks / Live tabs
- **Settings overlay** — modal with 6 pages (AI, Memory, Canvas, Workspace, Appearance, Account)

## What's wired

- All 4 panes render with full Discord-styled visuals
- All right-panel tabs switch
- All canvas view modes + preview sizes switch
- All settings pages switch
- Settings persist to `~/Library/Application Support/Farnsworth/farnsworth/settings.json`
- Project file listing via IPC (mock data, real fs when project files exist)
- Status bar reflects state

## What's stubbed

- AI agent calls — chat input is wired, but no LLM backend yet
- Memory pipeline stages — UI shows all 6 stages, no real extraction/consolidation/retrieval
- Live instance metrics — mock data, no real health checks
- Task persistence — in-memory only, no DB

## Extending

To wire a real AI backend: replace the `sendChatMessage` stub in `src/app.js` with a real model call. The IPC channel `farnsworth.sendMessage` is already exposed via preload (add as needed).

To add a real memory pipeline: extend the `state.memory` object in `src/app.js` and add IPC handlers in `main.js`.
