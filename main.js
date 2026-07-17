// Farnsworth — main process
// Electron desktop shell. SQLite-backed persistence (db.js), folder-based workspace,
// Claude auth (manual API key + OAuth PKCE via claude.ai), real file operations.

const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, shell, dialog, safeStorage, Menu, session } = require('electron');
const path = require('path');
const os = require('os');
// `fs` is fs/promises — used by 13 `await fs.xxx(...)` call sites in
// this file (ensureDirs + config reads/writes + filesystem IPCs).
// `fsSync` is the sync fs — used by markWorkspaceTrusted + spawnFor
// (existsSync / readFileSync / writeFileSync / renameSync). Earlier
// I swapped `fs = require('fs')` to get sync methods, which broke the
// 13 await sites ("fs.mkdir is not a function" hidden behind a
// Uncaught Exception dialog Jun 28 ~16:59 ET). Both modules now kept.
const fs = require('fs/promises');
const fsSync = require('fs');
const child_process = require('child_process');
const crypto = require('crypto');
const db = require('./db');

// =============================================================================
// Auto-updater (electron-updater, reads app-update.yml bundled in app.asar).
// GitHub Releases channel: dolong/farnsworth-app. `checkForUpdatesAndNotify()`
// is fire-and-forget — checks GitHub for a newer version, downloads in the
// background, shows a native notification when ready (with a "Restart" button
// that quits + relaunches into the installed update).
//
// Disabled in dev (npm start / electron .) — only runs in packaged builds,
// via the ELECTRON_IS_PACKAGED === true guard below. That avoids accidentally
// showing a "newer version available" toast when you're working on the source.
// =============================================================================
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = true;        // download in the background
autoUpdater.autoInstallOnAppQuit = true; // install when the user quits
// Surface update events to the renderer so we can show an in-app banner later.
// Right now we just log them — the native notification from
// checkForUpdatesAndNotify() is the primary UX.
autoUpdater.on('update-available',  (info) => console.log('[autoUpdater] update available:', info?.version));
autoUpdater.on('update-downloaded', (info) => console.log('[autoUpdater] update downloaded:', info?.version, '— restart to apply'));
autoUpdater.on('error',             (err)  => console.warn('[autoUpdater] error:', err?.message || err));

// keytar (native) — try to load at startup so credential IPCs can reference
// it directly. If the native binary is missing/broken (Linux without libsecret,
// etc.), the require throws and we fall back to per-handler lazy requires with
// Mac `security` CLI fallback (existing pattern at lines ~1527, ~1682, ~1767).
let keytar;
try {
  keytar = require('keytar');
} catch (e) {
  console.warn('[keytar] load failed at startup:', e?.message || e);
}

// Open external URLs via `/usr/bin open` instead of Electron's
// `shell.openExternal`. The latter routes through NSWorkspace, which
// trips macOS AppleEvents TCC and shows "Farnsworth would like to access
// data from other apps" on every launch when Long is away. `/usr/bin/open`
// goes through LaunchServices directly and stays silent.
function openExternalSafe(url) {
  return new Promise((resolve) => {
    child_process.execFile('open', [url], (err) => {
      if (err) console.error('[openExternal] failed for', url, '-', err.message);
      resolve();
    });
  });
}

// Locate the `claude` binary. Bundled Resources/bin/claude is checked
// first so Farnsworth.app is self-contained on machines that don't have
// Claude Code CLI installed via npm. Falls back to PATH (`which`) then to
// common install locations (Jul 7 ~21:02 ET).
function findClaudePath() {
  const fs = require('fs');
  const path = require('path');
  // 1) Bundled binary (Contents/Resources/bin/claude)
  const bundled = path.join(process.resourcesPath || '', 'bin', 'claude');
  try { if (fs.existsSync(bundled)) return bundled; } catch {}
  // 2) PATH lookup via `which`
  try {
    const cmd = process.platform === 'win32' ? 'where claude.cmd' : 'which claude';
    const out = require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    const found = out.split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {}
  // 3) Common install locations
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'claude'),
    path.join(process.env.HOME || '', '.claude', 'bin', 'claude'),
    process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'claude.cmd') : null,
    process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'claude') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Same as findClaudePath() but for OpenAI's `codex` CLI (the Codex panel,
// Jul 14). Bundled Resources/bin/codex first, then PATH, then common
// install locations. brew installs to /opt/homebrew/bin/codex on this Mac.
function findCodexPath() {
  const fs = require('fs');
  const path = require('path');
  const bundled = path.join(process.resourcesPath || '', 'bin', 'codex');
  try { if (fs.existsSync(bundled)) return bundled; } catch {}
  try {
    const cmd = process.platform === 'win32' ? 'where codex.cmd' : 'which codex';
    const out = require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    const found = out.split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {}
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'codex'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Same as findClaudePath() but for nono. Bundled Resources/bin/nono first.
function findNonoPath() {
  const fs = require('fs');
  const path = require('path');
  const bundled = path.join(process.resourcesPath || '', 'bin', 'nono');
  try { if (fs.existsSync(bundled)) return bundled; } catch {}
  try {
    const cmd = process.platform === 'win32' ? 'where nono.cmd' : 'which nono';
    const out = require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    const found = out.split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {}
  const candidates = [
    '/opt/homebrew/bin/nono',
    '/usr/local/bin/nono',
    path.join(process.env.HOME || '', '.local', 'bin', 'nono'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Phase 2: terminal panel. node-pty for real PTYs, ws for renderer↔main bridge.
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('[terminal] node-pty not loaded:', e.message);
}
const WebSocket = require('ws');
const { getRelayClient } = require('./src/relay-client');

let mainWindow;
// Track all open Farnsworth windows so the Window menu can list them and
// "New Window" can spawn a sibling instead of stealing focus from the
// focused one. mainWindow stays as a reference for single-window flows.
const openWindows = [];
const userDataPath = () => path.join(app.getPath('userData'), 'farnsworth');

// Helper: send a menu action to the focused window (or the most recent
// one if nothing is focused). Lets the native menu drive renderer state
// without each menu item needing a renderer-side handler.
function sendMenuAction(type, payload) {
  const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
  if (!target || target.isDestroyed()) return;
  target.webContents.send('menu:action', { type, payload });
}

// ---- OAuth config (Claude Code SDK OAuth — production flow) ----
// Source: production OAuth CLIENT_ID extracted from the installed claude binary
// at /opt/homebrew/bin/claude, cross-checked against the decompiled bundle.
// The `https://claude.ai/oauth/claude-code-client-metadata` URL is the OAuth
// client-metadata *endpoint* (RFC 7591), NOT the client_id — the server's
// UUID validator rejects it. Production client_id is the UUID below.
//
// Endpoints verified from github.com/ben-vargas/claude-code-sdk_oauth gist
// (170 lines of production OAuth code that writes ~/.claude/.credentials.json
// in the shape Claude Code SDK reads):
//   - Auth URL:        https://claude.ai/oauth/authorize
//   - Redirect URI:    https://console.anthropic.com/oauth/code/callback
//   - Token URL:       https://console.anthropic.com/v1/oauth/token
//   - Token Content-Type: application/json (NOT form-urlencoded)
//   - After authorize: console.anthropic.com/oauth/code/callback page shows
//     code as `CODE#STATE` — user copies the full string and we split on '#'
//
// This flow does NOT go through the broken mutationFn at /v1/oauth/{org}/authorize.
// That endpoint is only required for the localhost loopback flow, where the page
// auto-POSTs the user's consent. With a console.anthropic.com redirect, the page
// just renders the auth code on the console page and the user copies it.
const OAUTH_AUTH_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Scope set from the gist (org:create_api_key gives a real API key from the
// access_token, plus the basic Claude Code scopes for inference + sessions).
// Anthropic console OAuth's known working set — same as Claude Code CLI's.
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

async function ensureDirs() {
  await fs.mkdir(userDataPath(), { recursive: true });
}

// ============================================================
// Native macOS menu bar — File / Edit / View / Window / Help
// ============================================================
// Built on app ready and rebuilt whenever the recent-folders list
// changes (Open Recent submenu needs to refresh). Each menu item's
// click sends a 'menu:action' IPC to the focused window so the
// renderer can react (open folder, switch tabs, etc.) without each
// item needing its own dedicated IPC handler.
// Resolution-preset helpers for the View → Resolution submenu.
// resizeWindowTo(w, h) resizes the focused window (or mainWindow) to
// w×h, clamped to the primary display's work area, and re-centers it.
// resizeWindowToFullScreen() sizes to the actual screen dimensions.
// Both bail out if no window exists.
function resizeWindowTo(w, h) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return;
  const display = require('electron').screen.getPrimaryDisplay();
  const wa = display.workAreaSize; // { width, height }
  const safeW = Math.min(w, wa.width);
  const safeH = Math.min(h, wa.height);
  // Compute the new position so the window stays centered on the display.
  const x = Math.round(display.workArea.x + (wa.width - safeW) / 2);
  const y = Math.round(display.workArea.y + (wa.height - safeH) / 2);
  win.unmaximize(); // make sure the actual size takes effect
  win.setBounds({ x, y, width: safeW, height: safeH });
}

function resizeWindowToFullScreen() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return;
  const display = require('electron').screen.getPrimaryDisplay();
  const wa = display.workArea;
  win.unmaximize();
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  let recents = [];
  try { recents = db.getRecentFolders(10) || []; } catch {}

  const recentItems = recents.length
    ? recents.map((r) => ({
        label: r.label || path.basename(r.path),
        sublabel: r.path,
        click: () => sendMenuAction('openFolder', { path: r.path }),
      }))
    : [{ label: 'No recent folders', enabled: false }];

  const windowItems = openWindows.length
    ? openWindows.map((w, i) => ({
        label: `Window ${i + 1}${w.getTitle() ? ' — ' + w.getTitle() : ''}`,
        click: () => { if (!w.isDestroyed()) w.focus(); },
      }))
    : [];

  const template = [
    // ---- App menu (macOS only) ----
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings...', accelerator: 'Cmd+,', click: () => sendMenuAction('openSettings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhideAll' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),

    // ---- File ----
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Cmd+N', click: () => createWindow() },
        { label: 'New File', accelerator: 'Cmd+Alt+N', click: () => sendMenuAction('newFile') },
        { type: 'separator' },
        {
          label: 'Open File...',
          accelerator: 'Cmd+O',
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow() || mainWindow;
            if (!focused) return;
            const r = await dialog.showOpenDialog(focused, {
              properties: ['openFile'],
              title: 'Open File',
            });
            if (!r.canceled && r.filePaths[0]) sendMenuAction('openFile', { path: r.filePaths[0] });
          },
        },
        {
          label: 'Open Folder...',
          accelerator: 'Cmd+Shift+O',
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow() || mainWindow;
            if (!focused) return;
            const r = await dialog.showOpenDialog(focused, {
              properties: ['openDirectory', 'createDirectory'],
              title: 'Open Folder',
            });
            if (!r.canceled && r.filePaths[0]) sendMenuAction('openFolder', { path: r.filePaths[0] });
          },
        },
        {
          label: 'Open Recent',
          submenu: [
            ...recentItems,
            { type: 'separator' },
            {
              label: 'Clear Recent',
              click: async () => {
                db.clearRecentFolders();
                Menu.setApplicationMenu(buildMenu());
              },
            },
          ],
        },
        { type: 'separator' },
        { label: 'Close Folder', accelerator: 'Cmd+Alt+W', click: () => sendMenuAction('closeFolder') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },

    // ---- Edit ----
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Find',
                accelerator: 'Cmd+F',
                click: () => sendMenuAction('focusCommandPalette'),
              },
            ]
          : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' },
            ]),
      ],
    },

    // ---- View ----
    {
      label: 'View',
      submenu: [
        { label: 'Show Files Tab', accelerator: 'Cmd+1', click: () => sendMenuAction('showTab', { tab: 'files' }) },
        { label: 'Show Tasks Tab', accelerator: 'Cmd+2', click: () => sendMenuAction('showTab', { tab: 'tasks' }) },
        { label: 'Show Live Tab',  accelerator: 'Cmd+3', click: () => sendMenuAction('showTab', { tab: 'live' }) },
        { type: 'separator' },
        { label: 'Toggle Left Panel',  accelerator: 'Cmd+Alt+B', click: () => sendMenuAction('toggleLeftPanel') },
        { label: 'Toggle Right Panel', accelerator: 'Cmd+Alt+R', click: () => sendMenuAction('toggleRightPanel') },
        { type: 'separator' },
        { label: 'Focus Terminal', accelerator: 'Cmd+`', click: () => sendMenuAction('focusTerminal') },
        { label: 'Focus Claude Code', accelerator: 'Cmd+Shift+`', click: () => sendMenuAction('focusClaudeCode') },
        { type: 'separator' },
        { label: 'Command Palette', accelerator: 'Cmd+K', click: () => sendMenuAction('focusCommandPalette') },
        { label: 'Search in Files…', accelerator: 'Cmd+Shift+F', click: () => sendMenuAction('focusSearchOverlay') },
        { label: 'Find File by Name…', accelerator: 'Cmd+Shift+P', click: () => sendMenuAction('focusFileFinder') },
        { type: 'separator' },
        // Resolution presets — three buckets (mobile, desktop, fullscreen)
        // matching the pattern from the-last-draft's StoryFrame.jsx (Zoom
        // select) and PhoneFrame.jsx (device presets). Lets Long resize
        // the IDE window to common canvas sizes for previewing how game
        // UIs will look at each breakpoint. Each preset recenters the
        // window on the primary display so the change is predictable.
        {
          label: 'Resolution',
          submenu: [
            {
              label: 'Mobile',
              submenu: [
                { label: 'iPhone SE 3   (375 × 667)',  click: () => resizeWindowTo(375, 667) },
                { label: 'iPhone 14    (390 × 844)',  click: () => resizeWindowTo(390, 844) },
                { label: 'Pixel 7      (412 × 915)',  click: () => resizeWindowTo(412, 915) },
                { label: 'iPhone 14 +  (428 × 926)',  click: () => resizeWindowTo(428, 926) },
              ],
            },
            {
              label: 'Desktop',
              submenu: [
                { label: 'Compact     (1280 × 800)',  click: () => resizeWindowTo(1280, 800) },
                { label: 'Default     (1512 × 1320)', click: () => resizeWindowTo(1512, 1320) },
                { label: 'HD          (1920 × 1080)', click: () => resizeWindowTo(1920, 1080) },
                { label: 'QHD         (2560 × 1440)', click: () => resizeWindowTo(2560, 1440) },
                { label: 'Ultrawide   (3440 × 1440)', click: () => resizeWindowTo(3440, 1440) },
              ],
            },
            {
              label: 'Full Screen',
              submenu: [
                { label: 'Match Display', click: () => resizeWindowToFullScreen() },
                { label: 'Toggle Maximize/Restore', click: () => {
                  const w = BrowserWindow.getFocusedWindow() || mainWindow;
                  if (w) {
                    if (w.isMaximized()) w.unmaximize(); else w.maximize();
                  }
                }},
              ],
            },
          ],
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // ---- Window ----
    {
      label: 'Window',
      submenu: [
        { label: 'New Window', accelerator: 'Cmd+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        ...windowItems,
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ]
          : [{ role: 'close' }]),
      ],
    },

    // ---- Help ----
    {
      role: 'help',
      submenu: [
        {
          label: 'Farnsworth on GitHub',
          click: () => openExternalSafe('https://github.com/TheAnomalyXYZ/farnsworth'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1512,
    height: 1320,
    minWidth: 1100,
    minHeight: 800,
    title: 'Farnsworth',
    backgroundColor: '#1e1f22',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable <webview> tag — used by the canvas live preview to load the
      // dev server in a separate, CDP-targetable renderer process. Lets us
      // attach automation (agent-browser) directly to the preview frame
      // instead of fighting cross-origin barriers from the parent renderer.
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Force focus on macOS so the menu bar reflects Farnsworth's menus
    // immediately on launch. Without this, the window appears but stays
    // behind whatever was last focused (Vellum, Slack, etc.), and the
    // menu bar at the top shows the wrong app's menus. Long hit this on
    // Jul 2 — clicking the Farnsworth window didn't bring it to focus.
    mainWindow.focus();
    if (process.platform === 'darwin' && app.focus) {
      app.focus({ steal: true });
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // ------------------------------------------------------------
  // Close handler (Jun 28 ~16:12 ET)
  // ------------------------------------------------------------
  // Long hit the X (top-right traffic-light close button), the window
  // closed, but the main process stayed alive on darwin (default
  // Electron behaviour: app keeps running so user can reopen from Dock).
  // The wrapper script hides the Electron dock icon, so reopening was
  // impossible — the user saw a "stuck" state where the app was alive
  // but no window showed. He force-quit + relaunched and the active
  // conversation was gone because state.chatActiveId only lived in
  // renderer memory.
  //
  // Two fixes:
  //   (1) intercept close to force the renderer to flush its pending
  //       conversation save (the 500ms debounce in saveActiveConversation
  //       would otherwise lose data on a quick close);
  //   (2) make window-all-closed call app.quit() unconditionally so
  //       darwin also exits, so the next `open` launches cleanly.
  // ------------------------------------------------------------
  mainWindow.on('close', async (event) => {
    if (mainWindow._closeInProgress) return;
    event.preventDefault();
    mainWindow._closeInProgress = true;
    try {
      // Ask the renderer to flush any pending save synchronously. The
      // 500ms debounce in saveActiveConversation would otherwise lose
      // data on a quick X-click. executeJavaScript awaits the promise,
      // so we know the DB write has flushed before we close.
      await mainWindow.webContents.executeJavaScript(
        '(async () => { try { if (typeof saveActiveConversation === "function") await saveActiveConversation(); ' +
        'if (typeof persistClaudeCodeTabs === "function") persistClaudeCodeTabs(); ' +
        'if (typeof persistCodexTabs === "function") persistCodexTabs(); ' +
        'return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } })()',
        true,
      ).catch(() => {});
      // 1.5s ceiling so a hung renderer can't keep the app alive
      // indefinitely. Long had to force-quit last time; don't repeat.
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      app.quit();
    }
  });

  // Track this window in openWindows so the Window menu can list it.
  // When a window closes, remove it and rebuild the menu so the list
  // stays accurate.
  openWindows.push(mainWindow);
  mainWindow.on('closed', () => {
    const idx = openWindows.indexOf(mainWindow);
    if (idx >= 0) openWindows.splice(idx, 1);
    if (mainWindow && mainWindow === openWindows[0]) mainWindow = openWindows[0] || null;
    try { Menu.setApplicationMenu(buildMenu()); } catch {}
  });
  // Rebuild the menu whenever a new window opens so the Window list
  // shows the latest count and titles.
  try { Menu.setApplicationMenu(buildMenu()); } catch {}
}

// ============================================================
// IPC: Settings (SQLite-backed)
// ============================================================
ipcMain.handle('settings:get', async () => db.getAllSettings());

ipcMain.handle('settings:set', async (_event, settings) => {
  // Pass the OBJECT — setAllSettings runs Object.entries itself. Passing
  // entries here double-converted and wrote numeric keys ('0','1',...) with
  // ["key",value] pair values, silently breaking bulk settings persistence
  // for every key (found Jul 12 while wiring testingModel).
  db.setAllSettings(settings || {});
  return true;
});
// Single-key getters/setters — preferred for new code. The bulk
// `settings:get`/`settings:set` round-trip serialises through
// JSON.parse which mangles scalar values when callers hand back
// unparseable shapes. Single-key reads return the raw stored string.
ipcMain.handle('setting:get', async (_event, key) => {
  if (!key || typeof key !== 'string') return null;
  return db.getSetting(key);
});
ipcMain.handle('setting:set', async (_event, key, value) => {
  if (!key || typeof key !== 'string') return { ok: false, error: 'bad_key' };
  db.setSetting(key, value);
  return { ok: true };
});

// ============================================================
// IPC: Dev tools (farnsworth backend, per app type)
// ============================================================
// Reads ~/.cache/farnsworth-<appType>.json (written by
// `npm run farnsworth:<appType>` in the app's template repo) and confirms
// the dev server PID is still alive. One handler serves every app type
// (devvit, threejs, blockchain, ...) — the renderer passes the open
// workspace's appType. Defaults to 'devvit'.
//
// Returns { available: true, type, url, pid, startedAt } when the dev
// server is up, or { available: false } (or { available: false, url, pid,
// dead: true }) when the meta file is missing or the process is dead.
ipcMain.handle('dev:farnsworth:get', async (_event, appType = 'devvit', repoRoot) => {
  const fs = require('fs');
  const path = require('path');
  const type = (typeof appType === 'string' && appType) ? appType : 'devvit';
  const metaPath = path.join(require('os').homedir(), '.cache', `farnsworth-${type}.json`);
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || !meta.pid || !meta.url) return { available: false, type };
    // Validate the cached dev server belongs to the current workspace.
    // Long Jul 9 ~15:05 ET — without this, opening a different workspace
    // (e.g. Farnsworth itself) would still load the iframe pointed at
    // lastdraft's last session's dev server, which auto-plays bgMusic and
    // wedges Cmd+Q. If the cache's repoRoot doesn't match the active
    // workspace, treat as not-available (the dev server belongs to a
    // different project — likely orphaned after a folder switch).
    if (repoRoot && typeof repoRoot === 'string' && meta.repoRoot && meta.repoRoot !== repoRoot) {
      return { available: false, type, reason: 'wrong_workspace', cachedRepoRoot: meta.repoRoot };
    }
    try { process.kill(meta.pid, 0); }
    catch { return { available: false, type, url: meta.url, pid: meta.pid, dead: true }; }
    // serverPid + serverUrl added Jul 10 when the Farnsworth-side
    // server-runner spawned alongside Vite (emulator-backed tRPC + Hono
    // on port 3000). Older meta files without these fields are valid —
    // renderer should treat undefined as "not available".
    return {
      available: true,
      type,
      url: meta.url,
      pid: meta.pid,
      startedAt: meta.startedAt,
      serverPid: meta.serverPid || null,
      serverUrl: meta.serverUrl || null,
    };
  } catch {
    return { available: false, type };
  }
});

// Boot the farnsworth dev server for a workspace by running its
// `npm run farnsworth:<appType>` script (which lives in the app's template
// repo). The script kills any stale instance, boots vite in the background,
// writes ~/.cache/farnsworth-<type>.json, and blocks until the server responds
// (or times out ~30s) then exits. We wait for that exit and return the meta so
// the renderer can immediately re-render the canvas with live iframes.
//
// repoRoot is the open workspace folder (state.folder). It must contain a
// package.json defining the `farnsworth:<type>` script.
ipcMain.handle('dev:farnsworth:boot', async (_event, appType = 'devvit', repoRoot) => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawn } = require('child_process');
  const type = (typeof appType === 'string' && appType) ? appType : 'devvit';

  if (!repoRoot || typeof repoRoot !== 'string') {
    return { ok: false, error: 'no_workspace', message: 'Open a workspace folder first.' };
  }
  const scriptName = `farnsworth:${type}`;
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    if (!pkg.scripts || !pkg.scripts[scriptName]) {
      return {
        ok: false,
        error: 'no_script',
        message: `This workspace has no "${scriptName}" script in package.json.`,
      };
    }
  } catch {
    return {
      ok: false,
      error: 'no_package_json',
      message: `No package.json found at ${repoRoot}.`,
    };
  }

  // Ensure node/npm are on PATH (Apple Silicon Homebrew isn't on the default
  // PATH inherited when the app is launched via LaunchServices/`open`).
  const env = { ...process.env };
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin'];
  env.PATH = [...extraPaths, env.PATH || ''].filter(Boolean).join(':');

  // Devvit emulator: write the per-project config (current user, current
  // subreddit, seeded users/subreddits) to a temp file and inject the
  // emulator loader via NODE_OPTIONS so the user's scripts.dev subprocess
  // intercepts @devvit/redis and @devvit/public-api imports automatically.
  // Farnsworth's own devvit-emulator package lives in this app's dir.
  if (type === 'devvit') {
    try {
      const fs2 = require('fs');
      const path2 = require('path');
      const os2 = require('os');
      const loaderPath = path2.join(__dirname, 'devvit-emulator', 'loader.mjs');
      if (fs2.existsSync(loaderPath)) {
        // Seed defaults for this workspace on first boot.
        db.devvitInitDefaultsForProject(repoRoot);
        // Snapshot the per-project config + user library + subreddit library
        // into a single JSON file the loader reads at boot.
        const settings = db.devvitGetProjectSettings(repoRoot) || {};
        const users = db.devvitListUsers();
        const subreddits = db.devvitListSubreddits();
        const cfg = {
          currentUsername: settings.current_username || null,
          currentSubredditName: settings.current_subreddit_name || null,
          users,
          subreddits,
        };
        const cacheDir = path2.join(os2.homedir(), '.cache');
        fs2.mkdirSync(cacheDir, { recursive: true });
        const repoHash = Buffer.from(repoRoot).toString('hex').slice(0, 16);
        const cfgPath = path2.join(cacheDir, `farnsworth-devvit-${repoHash}.json`);
        // Phase 1: separate state file for emulator-internal state (Redis
        // store + Reddit posts/comments/flairs). Hydrated on boot, written
        // back debounced on writes. Survives dev server restarts so the
        // game doesn't reset between code reloads.
        const statePath = path2.join(cacheDir, `farnsworth-devvit-${repoHash}-state.json`);
        fs2.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        env.DEVVIT_EMULATOR_CONFIG = cfgPath;
        env.DEVVIT_EMULATOR_STATE = statePath;
        // Also expose the config to the browser-side shim via Vite's
        // import.meta.env.VITE_* substitution. The dev-tools vite's
        // @devvit/web/client shim (the-last-draft/dev-tools/devvit-shim.ts)
        // reads this at module-load time to set context.username +
        // context.subredditName from the active emulator user. Without this
        // the iframe game would always show the shim's hardcoded 'dev-user'
        // regardless of the cogwheel selection.
        env.VITE_DEVVIT_EMULATOR_CONFIG_JSON = JSON.stringify(cfg);
        const existingNodeOpts = env.NODE_OPTIONS || '';
        env.NODE_OPTIONS = `--import "${loaderPath}"${existingNodeOpts ? ' ' + existingNodeOpts : ''}`;
      }
    } catch (e) {
      console.error('[devvit-emulator] failed to inject loader:', e);
    }
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn('npm', ['run', scriptName], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 4000); });

    // Safety timeout — the script itself polls up to ~30s, so give it 45s.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout', message: 'Dev server did not come up within 45s.' });
    }, 45000);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: 'spawn_failed', message: err.message });
    });

    child.on('exit', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: 'script_failed', code, message: stderr.trim() || `Script exited ${code}.` });
        return;
      }
      // Script exited 0 → server is up and meta written. Read it back.
      const metaPath = path.join(os.homedir(), '.cache', `farnsworth-${type}.json`);
      try {
        const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
        resolve({ ok: true, type, url: meta.url, pid: meta.pid, startedAt: meta.startedAt });
      } catch {
        resolve({ ok: true, type, url: `http://localhost:5174` });
      }
    });
  });
});

// Stop the farnsworth dev server (kills the vite process) and clears its meta
// so the canvas falls back to static images. Best-effort.
ipcMain.handle('dev:farnsworth:stop', async (_event, appType = 'devvit') => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFile } = require('child_process');
  const type = (typeof appType === 'string' && appType) ? appType : 'devvit';
  const metaPath = path.join(os.homedir(), '.cache', `farnsworth-${type}.json`);

  // Kill by pid from meta if present. serverPid was added Jul 10 when the
  // Farnsworth-side server-runner spawned alongside Vite (so the workspace's
  // src/server/ tRPC + Hono code runs against the emulator's persistent
  // redis). Older meta files without serverPid are handled gracefully.
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    if (meta && meta.pid) { try { process.kill(meta.pid, 'SIGKILL'); } catch {} }
    if (meta && meta.serverPid) { try { process.kill(meta.serverPid, 'SIGKILL'); } catch {} }
  } catch {}

  // Belt-and-suspenders: kill any lingering devtools vite process + the
  // server-runner (added Jul 10).
  await new Promise((resolve) => {
    execFile('pkill', ['-f', 'vite.devtools.config.ts'], () => resolve());
  });
  await new Promise((resolve) => {
    execFile('pkill', ['-f', 'server-runner.mjs'], () => resolve());
  });

  // Clear the meta so get/re-detect reports unavailable.
  try { await fs.promises.unlink(metaPath); } catch {}
  return { ok: true, type };
});

// ============================================================
// IPC: Recent folders
// ============================================================
ipcMain.handle('recent:get', async () => db.getRecentFolders(10));

// (recent:clear already exists further down — registering it twice crashes
// main with "Attempted to register a second handler". Learned Jul 14 ~00:08.)

// Real install facts for Settings -> About (Jul 13). The DB can live one
// level deeper than userData (CFBundleName nesting) -- probe both.
ipcMain.handle('app:info', async () => {
  const userData = app.getPath('userData');
  let dbPath = null, dbSize = 0;
  for (const cand of [path.join(userData, 'farnsworth', 'farnsworth.db'), path.join(userData, 'farnsworth.db')]) {
    try { const st = fsSync.statSync(cand); if (st.size > 0) { dbPath = cand; dbSize = st.size; break; } } catch {}
  }
  return {
    ok: true,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform + ' ' + process.arch,
    userData, dbPath, dbSize,
  };
});
ipcMain.handle('recent:add', async (_event, folderPath) => {
  db.addRecentFolder(folderPath, path.basename(folderPath));
  // Rebuild the menu so the Open Recent submenu picks up the new entry.
  try { Menu.setApplicationMenu(buildMenu()); } catch {}
  return db.getRecentFolders(10);
});
ipcMain.handle('recent:clear', async () => {
  db.clearRecentFolders();
  try { Menu.setApplicationMenu(buildMenu()); } catch {}
  return [];
});

// ============================================================
// IPC: Folder picker
// ============================================================
ipcMain.handle('dialog:openFolder', async () => {
  const focused = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(focused, {
    properties: ['openDirectory'],
    title: 'Open Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ============================================================
// IPC: Workspace config (per-folder .farnsworth/config.json)
// ============================================================
ipcMain.handle('workspace:loadConfig', async (_event, folderPath) => {
  try {
    const configPath = path.join(folderPath, '.farnsworth', 'config.json');
    const raw = await fs.readFile(configPath, 'utf8');
    return { ok: true, config: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('workspace:saveConfig', async (_event, folderPath, config) => {
  try {
    const configDir = path.join(folderPath, '.farnsworth');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ============================================================
// IPC: Devvit emulator — user library + per-project settings
// ============================================================
// The user/subreddit library is global (workspaces table-agnostic);
// per-project settings live in devvit_project_settings keyed by
// workspace_path. The renderer calls these from the cogwheel popover
// and from the canvas-overlay-bar user dropdown.
ipcMain.handle('devvit:list-users', async () => db.devvitListUsers());
ipcMain.handle('devvit:upsert-user', async (_event, user) => db.devvitUpsertUser(user));
ipcMain.handle('devvit:delete-user', async (_event, id) => db.devvitDeleteUser(id));
ipcMain.handle('devvit:list-subreddits', async () => db.devvitListSubreddits());
ipcMain.handle('devvit:upsert-subreddit', async (_event, sub) => db.devvitUpsertSubreddit(sub));
ipcMain.handle('devvit:delete-subreddit', async (_event, id) => db.devvitDeleteSubreddit(id));
ipcMain.handle('devvit:get-project-settings', async (_event, workspacePath) => {
  db.devvitInitDefaultsForProject(workspacePath);
  return db.devvitGetProjectSettings(workspacePath);
});
ipcMain.handle('devvit:set-project-settings', async (_event, workspacePath, currentUserId, currentSubredditId) => {
  const res = db.devvitSetProjectSettings(workspacePath, currentUserId, currentSubredditId);
  // Also rewrite the on-disk config the loader reads on next boot so the
  // next subprocess picks up the change. (For mid-session switching the
  // subprocess reloads via the watcher below — see devvit-emulator/loader.mjs.)
  try {
    const os2 = require('os');
    const fs2 = require('fs');
    const path2 = require('path');
    const settings = db.devvitGetProjectSettings(workspacePath) || {};
    const users = db.devvitListUsers();
    const subreddits = db.devvitListSubreddits();
    const cfg = {
      currentUsername: settings.current_username || null,
      currentSubredditName: settings.current_subreddit_name || null,
      users,
      subreddits,
    };
    const cacheDir = path2.join(os2.homedir(), '.cache');
    fs2.mkdirSync(cacheDir, { recursive: true });
    const cfgPath = path2.join(cacheDir, `farnsworth-devvit-${Buffer.from(workspacePath).toString('hex').slice(0, 16)}.json`);
    fs2.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[devvit-emulator] failed to rewrite config file:', e);
  }
  return res;
});

// ============================================================
// IPC: Canvas WebContentsView (Jul 9 ~18:55 ET)
// ============================================================
// The canvas live preview renders the dev server inside a
// WebContentsView (not a <webview>) so the inner viewport's dimensions
// match the container's pixel rect. Electron's <webview> tag locks the
// inner viewport at first-load size (~300x150 HTML default) and never
// propagates height changes from CSS — the game renders squished to a
// 150px strip.
//
// BrowserView (the legacy API) was tried first (Jul 9 ~18:20 ET) but
// failed to visually composite on top of the renderer in Electron 31
// despite the webContents loading correctly (verified via its own
// debugger target — game rendered at 390x844 inside, but the
// BrowserView's pixels never appeared on the Farnsworth window).
// WebContentsView is the modern replacement (Electron 28+); it uses
// the same View hierarchy as BrowserView but is wired via
// `mainWindow.contentView.addChildView()` and composes correctly.
//
// Trade-offs vs <webview>:
// - WebContentsView renders on top of the renderer (separate webContents)
// - z-order is determined by add order (most recent on top)
// - Click events inside the view are captured by it; outside clicks
//   pass through to the renderer
// - Doesn't share the renderer's CSS, session storage, or DevTools
//   target — its own debugger target is at port 9222 type=page

const canvasWebContentsViews = new Map();
// Desired content zoom factor per view (set via canvas:setZoomFactor).
// Electron persists per-origin zoom levels in the persist:farnsworth
// partition and RESTORES them when a navigation commits — silently
// overriding any factor set before the page loaded (bit us Jul 13: fresh
// views came up at yesterday's 0.99 instead of the current canvas zoom).
// We re-apply the desired factor on load-commit events instead.
const canvasViewZoomFactors = new Map();

// --- Canvas engine settings (Settings -> Canvas -> Browser engine, Jul 13) ---
// Network access: true = unrestricted (default). false = block outbound
// requests whose host isn't local, so the Live preview's dev servers keep
// working while external calls are denied. The filter is per-session
// (= per partition); we track every partition a canvas view has used and
// re-apply on live toggles via canvas:setNetworkAccess.
let canvasNetworkAllowed = true;
const canvasPartitions = new Set(['persist:farnsworth']);
const CANVAS_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
function applyCanvasNetworkFilter(ses) {
  try {
    if (canvasNetworkAllowed) { ses.webRequest.onBeforeRequest(null); return; }
    ses.webRequest.onBeforeRequest((details, callback) => {
      try {
        const u = new URL(details.url);
        // Only police network protocols; devtools:/data:/blob:/file: pass.
        if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return callback({});
        if (CANVAS_LOCAL_HOSTS.has(u.hostname)) return callback({});
      } catch {}
      callback({ cancel: true });
    });
  } catch (e) { console.error('[canvas:networkFilter]', e); }
}

ipcMain.handle('canvas:setNetworkAccess', (_event, { allowed }) => {
  canvasNetworkAllowed = allowed !== false;
  for (const part of canvasPartitions) {
    try { applyCanvasNetworkFilter(session.fromPartition(part)); } catch {}
  }
  return { ok: true, allowed: canvasNetworkAllowed };
});

// Open Chromium devtools for a preview view (palette: Canvas: Open Preview
// DevTools). Renderer gates on settings.canvas.engine.devtools; views
// created while the toggle was OFF also have webPreferences.devTools=false,
// so openDevTools is a no-op on them by construction.
ipcMain.handle('canvas:openDevTools', (_event, args) => {
  const wanted = args && args.viewId;
  const view = wanted ? canvasWebContentsViews.get(wanted) : canvasWebContentsViews.values().next().value;
  if (!view) return { ok: false, error: 'No preview open' };
  try { view.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});


ipcMain.handle('canvas:createView', async (_event, { viewId, url, bounds, opts }) => {
  try {
    // Re-create if a view with this ID already exists (defensive).
    if (canvasWebContentsViews.has(viewId)) {
      const existing = canvasWebContentsViews.get(viewId);
      existing.setBounds(bounds);
      try { existing.webContents.loadURL(url); } catch {}
      return { ok: true, updated: true };
    }
    // Engine settings (Settings -> Canvas, Jul 13): the renderer computes
    // opts from state.settings.canvas.engine at creation time. partitionKey
    // -> per-project cookie/localStorage isolation; devTools=false hard-
    // disables Chromium devtools for this view.
    const partition = (opts && opts.partitionKey)
      ? 'persist:fw-' + String(opts.partitionKey).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48)
      : 'persist:farnsworth';
    canvasPartitions.add(partition);
    applyCanvasNetworkFilter(session.fromPartition(partition));
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: !opts || opts.devTools !== false,
      }
    });
    mainWindow.contentView.addChildView(view);
    view.setBounds(bounds);
    // Pin the content zoom on every navigation commit — otherwise the
    // partition's persisted per-origin zoom wins over whatever the renderer
    // set while the page was still loading.
    const applyZoom = () => {
      const f = canvasViewZoomFactors.get(viewId);
      if (f) { try { view.webContents.setZoomFactor(f); } catch {} }
    };
    view.webContents.on('did-navigate', applyZoom);
    view.webContents.on('did-finish-load', applyZoom);
    view.webContents.loadURL(url);
    canvasWebContentsViews.set(viewId, view);
    return { ok: true };
  } catch (e) {
    console.error('[canvas:createView] error:', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('canvas:updateViewBounds', (_event, { viewId, bounds }) => {
  const view = canvasWebContentsViews.get(viewId);
  if (!view) return { ok: false, error: 'view_not_found' };
  try {
    view.setBounds(bounds);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('canvas:removeView', (_event, { viewId }) => {
  const view = canvasWebContentsViews.get(viewId);
  if (!view) return { ok: false, error: 'view_not_found' };
  try {
    mainWindow.contentView.removeChildView(view);
    view.webContents.destroy();
    canvasWebContentsViews.delete(viewId);
    canvasViewZoomFactors.delete(viewId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Nuke every canvas WebContentsView at once. Used by the renderer when the
// preview mode changes (testview -> Post View, mobile -> desktop, etc.) to
// catch the async setup race: if a view is created via canvasCreateView
// AFTER teardown has already run, it stays orphaned in the
// canvasWebContentsViews map with no DOM placeholder referencing it.
// Calling removeAllViews on every preview switch ensures no view survives
// across previews regardless of in-flight createView promises. Jul 11
// ~16:30 ET — testview orphan bug fix.
ipcMain.handle('canvas:removeAllViews', () => {
  try {
    for (const [viewId, view] of canvasWebContentsViews) {
      try {
        mainWindow.contentView.removeChildView(view);
        view.webContents.destroy();
      } catch {}
    }
    canvasWebContentsViews.clear();
    canvasViewZoomFactors.clear();
    return { ok: true, removed: canvasWebContentsViews.size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Switch the canvas preview mode (post | mobile | desktop | fullscreen | testview).
// Used by the chat agent's open_testview tool (Jul 11 ~18:50 ET) and any
// future programmatic preview switcher. Forwards to the renderer via
// 'canvas:setPreview' IPC; the renderer's handler nukes WebContentsViews,
// sets state.preview, syncs the resolution dropdown, and re-renders —
// exactly what the size-toggle click does.
ipcMain.handle('canvas:setPreview', (_event, { preview } = {}) => {
  try {
    const allowed = ['post', 'mobile', 'desktop', 'fullscreen', 'testview'];
    if (!preview || !allowed.includes(preview)) {
      return { ok: false, error: 'invalid_preview', allowed };
    }
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    target.webContents.send('canvas:setPreview', { preview });
    return { ok: true, preview };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Reload the active canvas WebContentsView. Called from the companion v0.4
// Preview sheet reload button. Jul 13 — same handler name as the companion
// command (companion sends {type:'command', name:'reloadPreview'}).
ipcMain.handle('canvas:reloadPreview', () => {
  try {
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    // Re-broadcast as a renderer-side event so the canvas manager reloads
    // the active view. The canvas manager listens for 'canvas:reloadPreview'.
    target.webContents.send('canvas:reloadPreview');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Set the active model alias for the chat composer. Called from the
// companion v0.4 Settings sheet. Jul 13 — accepts {alias:'opus'|'sonnet'|'haiku'}
// and persists via the settings:set IPC, then broadcasts model:changed.
ipcMain.handle('chat:setModel', (_event, { alias } = {}) => {
  try {
    const allowed = ['opus', 'sonnet', 'haiku'];
    if (!alias || !allowed.includes(alias)) {
      return { ok: false, error: 'invalid_alias', allowed };
    }
    db.setSetting('model', alias);
    // Broadcast to companions.
    try {
      const rc = getRelayClient();
      if (rc && rc.status === 'connected') {
        rc.send({ type: 'model:changed', alias, ts: Date.now() });
      }
    } catch {}
    return { ok: true, alias };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Signal the chat agent to stop the current inference run. Called from the
// companion v0.4 Stop button. Jul 13 — broadcasts as a renderer-side event
// that the chat panel listens for.
ipcMain.handle('chat:stopInference', () => {
  try {
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    target.webContents.send('chat:stopInference');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Set the active Devvit emulator user for the current project. Called from
// the companion v0.4 Preview sheet cogwheel. Jul 13 — persists to
// devvit_project_settings.current_user_id, broadcasts emulator:config.
ipcMain.handle('devvit:setProjectUser', async (_event, { folder, userId } = {}) => {
  try {
    if (!folder || typeof folder !== 'string') return { ok: false, error: 'missing_folder' };
    if (!userId || typeof userId !== 'number') return { ok: false, error: 'missing_user_id' };
    // Preserve the existing subreddit id when only updating the user.
    const existing = db.devvitGetProjectSettings(folder);
    db.devvitSetProjectSettings(folder, userId, existing?.current_subreddit_id || null);
    // Look up the username for the broadcast.
    const user = db.prepare('SELECT username, reddit_id FROM devvit_users WHERE id = ?').get(userId);
    try {
      const rc = getRelayClient();
      if (rc && rc.status === 'connected') {
        rc.send({
          type: 'emulator:config',
          user: user?.username || null,
          userId, folder, ts: Date.now(),
        });
      }
    } catch {}
    return { ok: true, user: user?.username || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Set the active Devvit emulator subreddit for the current project. Called
// from the companion v0.4 Preview sheet cogwheel. Jul 13 — persists to
// devvit_project_settings.current_subreddit_id, broadcasts emulator:config.
ipcMain.handle('devvit:setProjectSubreddit', async (_event, { folder, subredditId } = {}) => {
  try {
    if (!folder || typeof folder !== 'string') return { ok: false, error: 'missing_folder' };
    if (!subredditId || typeof subredditId !== 'number') return { ok: false, error: 'missing_subreddit_id' };
    const existing = db.devvitGetProjectSettings(folder);
    db.devvitSetProjectSettings(folder, existing?.current_user_id || null, subredditId);
    const sub = db.prepare('SELECT name, reddit_id FROM devvit_subreddits WHERE id = ?').get(subredditId);
    try {
      const rc = getRelayClient();
      if (rc && rc.status === 'connected') {
        rc.send({
          type: 'emulator:config',
          subreddit: sub?.name || null,
          subredditId, folder, ts: Date.now(),
        });
      }
    } catch {}
    return { ok: true, subreddit: sub?.name || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Toggle visibility of a canvas WebContentsView without destroying it.
// Used by modals/popovers that overlap the canvas region (e.g. the Devvit
// emulator cogwheel popover) — the WebContentsView is a separate composited
// layer that CSS z-index cannot affect, so hide it instead.
ipcMain.handle('canvas:setVisible', (_event, { viewId, visible }) => {
  const view = canvasWebContentsViews.get(viewId);
  if (!view) return { ok: false, error: 'view_not_found' };
  try {
    view.setVisible(visible !== false);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Scale a canvas view's CONTENT to match the renderer's zoom transform.
// WebContentsViews don't follow CSS transforms; when the artboard is scaled
// the renderer shrinks the view's bounds (transformed placeholder rect) and
// calls this so the page inside renders at the same scale. factor is the
// zoom scale (0.25-2.0); the page's logical CSS viewport stays constant
// (bounds/factor), so test-runner selectors + screenshots are unaffected.
ipcMain.handle('canvas:setZoomFactor', (_event, { viewId, factor }) => {
  const view = canvasWebContentsViews.get(viewId);
  if (!view) return { ok: false, error: 'view_not_found' };
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0.05 || f > 5) return { ok: false, error: 'bad_factor' };
  try {
    canvasViewZoomFactors.set(viewId, f);
    view.webContents.setZoomFactor(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Debug: inspect a canvas WebContentsView's state.
ipcMain.handle('canvas:debugView', (_event, { viewId }) => {
  const view = canvasWebContentsViews.get(viewId);
  if (!view) return { found: false, error: 'view_not_found' };
  const wc = view.webContents;
  try {
    return {
      found: true,
      url: wc.getURL(),
      title: wc.getTitle(),
      isLoading: wc.isLoading(),
      isCrashed: wc.isCrashed(),
      bounds: view.getBounds(),
    };
  } catch (e) {
    return { found: true, error: e.message };
  }
});

// ============================================================
// IPC: Test scripts (NLP test creator, Jul 10 ~23:50 ET)
//
// Per-project location (Jul 11 ~18:38 ET — was ~/Documents/farnsworth-tests/tests/
// globally). Tests now live at <project>/.farnsworth/devvit-tests/ matching the
// existing .farnsworth/config.json per-project pattern (Jul 2 ~15:08 ET). Each
// IPC handler takes a `folder` arg pointing at the active project root and
// computes the test dir from it. The Python runner moved to
// ~/Documents/Farnsworth/app/farnsworth-test.py — Farnsworth owns its own test
// infrastructure tool. Long's request: "shouldnt it make sense to make it in
// .farnsworth/devvit-tests/ maybe per project".
//
// Save: writes a JSON test script to <project>/.farnsworth/devvit-tests/
// Run:  spawns the Python CDP test runner against the saved file
//
// These back the in-canvas test editor in Test View (Jul 11 ~16:42 ET)
// plus the optional NLP "Generate from description" button.
// ============================================================
const TEST_RUNNER_PATH = path.join(app.getAppPath(), 'farnsworth-test.py');

// Settings → AI → Testing model: display name → API id for the runner env
// (FARNSWORTH_TEST_MODEL). Mirrors src/app.js modelToApiId — keep in sync.
// Unknown values pass through: the runner accepts haiku/sonnet/opus aliases
// and full API ids. Returns null when the setting is unset (runner default:
// claude-sonnet-4-5).
const MODEL_DISPLAY_TO_API = {
  'Opus 4.8': 'claude-opus-4-8',
  'Opus 4.8 High': 'claude-opus-4-8',
  'Opus 4.7': 'claude-opus-4-7',
  'Opus 4.6': 'claude-opus-4-6',
  'Opus 4.5': 'claude-opus-4-5-20251101',
  'Sonnet 5': 'claude-sonnet-5',
  'Sonnet 4.6': 'claude-sonnet-4-6',
  'Sonnet 4.5': 'claude-sonnet-4-5',
  'Haiku 4.5': 'claude-haiku-4-5',
  'Fable 5': 'claude-fable-5',
};

function testingModelApiId() {
  const display = db.getSetting('testingModel');
  if (!display || typeof display !== 'string') return null;
  return MODEL_DISPLAY_TO_API[display] || display;
}

// Resolve a per-project tests dir from a `folder` arg. The folder must
// be a valid project root; validate that it exists + is a directory before
// computing the .farnsworth/devvit-tests/ path. If `folder` is missing or
// invalid, return null so the IPC handlers can surface a "pick a folder
// first" hint in the renderer.
function resolveTestScriptsDir(folder) {
  if (!folder || typeof folder !== 'string') return null;
  const resolved = path.resolve(folder);
  let stat;
  try { stat = fsSync.statSync(resolved); } catch { return null; }
  if (!stat.isDirectory()) return null;
  return path.join(resolved, '.farnsworth', 'devvit-tests');
}

ipcMain.handle('test:list', async (_event, { folder } = {}) => {
  // List all JSON tests in <folder>/.farnsworth/devvit-tests/ for the
  // Test View canvas preview (Jul 11 14:50 ET). Per-project location
  // adopted Jul 11 ~18:38 ET — each Devvit app has its own tests folder
  // that travels with the project. Returns name/path/size/modified for
  // each file; the renderer uses this to populate the test runner panel.
  // If folder is missing/invalid, return ok:false so the renderer can
  // show "pick a folder first" instead of an empty list.
  const dir = resolveTestScriptsDir(folder);
  if (!dir) return { ok: false, error: 'no_folder', folder };
  try {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const tests = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      tests.push({
        name: entry.name.replace(/\.json$/i, ''),
        path: filePath,
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }
    // Sort by name (stable for users — same order every load).
    tests.sort((a, b) => a.name.localeCompare(b.name));
    // Broadcast to companions (Jul 13 — companion v0.4 Test sheet subscribes).
    try {
      const rc = getRelayClient();
      if (rc && rc.status === 'connected') {
        rc.send({ type: 'test:list', tests, dir, ts: Date.now() });
      }
    } catch {}
    return { ok: true, tests, dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('test:save', async (_event, { folder, name, json }) => {
  try {
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', folder };
    if (!name || typeof name !== 'string') return { ok: false, error: 'missing_name' };
    if (!json || typeof json !== 'string') return { ok: false, error: 'missing_json' };
    // Validate JSON before writing so we don't persist malformed scripts
    try { JSON.parse(json); } catch (e) {
      return { ok: false, error: 'invalid_json', message: e.message };
    }
    const safeName = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (!safeName) return { ok: false, error: 'invalid_name' };
    const filePath = path.join(dir, `${safeName}.json`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, json + '\n', 'utf8');
    return { ok: true, path: filePath, name: safeName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('test:run', async (_event, { path: testPath }) => {
  // test:run takes an absolute test path (not a folder) — the renderer
  // already knows the per-project dir from the test:list response, and
  // passes the full path through. This lets the IPC work for tests that
  // live anywhere, not just the active project's dir.
  try {
    if (!testPath || typeof testPath !== 'string') return { ok: false, error: 'missing_path' };
    // Spawn the Python test runner. Capture stdout+stderr, resolve with
    // the merged output. Exit code 0 = pass, non-zero = fail (but a test
    // can also exit 0 with "X failed" in stdout — treat that as partial).
    // cwd is the Farnsworth app dir so the runner's relative imports
    // (if any) resolve against its own location; the test path is
    // absolute so cwd doesn't affect what the runner targets.
    const { spawn } = require('child_process');
    // Inject the chat's auth into the runner env so llm-step can take the
    // direct-API fast path (one POST, screenshot inline) instead of shelling
    // to the claude CLI. Runner falls back to the CLI when absent. Jul 11.
    const llmAuth = await getValidAccessToken().catch(() => null);
    const runnerEnv = { ...process.env };
    if (llmAuth && llmAuth.token) {
      runnerEnv.FARNSWORTH_AUTH_TOKEN = llmAuth.token;
      runnerEnv.FARNSWORTH_AUTH_KIND = llmAuth.kind || 'api_key';
    }
    const testModel = testingModelApiId();
    if (testModel) runnerEnv.FARNSWORTH_TEST_MODEL = testModel;
    // Broadcast test:state(running) to companions (Jul 13 — companion v0.4
    // Test sheet subscribes and shows the running badge).
    try {
      const rc = getRelayClient();
      if (rc && rc.status === 'connected') {
        rc.send({ type: 'test:state', testId: testPath, status: 'running', ts: Date.now() });
      }
    } catch {}
    return await new Promise((resolve) => {
      const proc = spawn('python3', [TEST_RUNNER_PATH, testPath], {
        cwd: app.getAppPath(),
        env: runnerEnv,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        const failedMatch = stdout.match(/(\d+)\s+failed/);
        const failed = failedMatch ? Number(failedMatch[1]) : 0;
        const passed = code === 0 && failed === 0;
        // Broadcast test:state(passed/failed) to companions.
        try {
          const rc = getRelayClient();
          if (rc && rc.status === 'connected') {
            rc.send({
              type: 'test:state',
              testId: testPath,
              status: passed ? 'passed' : 'failed',
              code, failed, ts: Date.now(),
            });
          }
        } catch {}
        resolve({
          ok: passed,
          code,
          failed,
          stdout: stdout.slice(-4000),  // tail, in case of long output
          stderr: stderr.slice(-2000),
        });
      });
      proc.on('error', err => {
        try {
          const rc = getRelayClient();
          if (rc && rc.status === 'connected') {
            rc.send({ type: 'test:state', testId: testPath, status: 'failed', error: err.message, ts: Date.now() });
          }
        } catch {}
        resolve({ ok: false, error: err.message });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Read a test JSON's contents (used by the Test View editor when the user
// clicks Edit on a row — load the file's text into the editor textarea so
// they can modify it). Returns the raw JSON string (not parsed) so the
// editor can preserve formatting. Jul 11 ~16:42 ET — inline test editor
// feature in Test View (deprecates the standalone test creator modal).
// Per-project location: <folder>/.farnsworth/devvit-tests/<name>.json
// (Jul 11 ~18:38 ET — was the global ~/Documents/farnsworth-tests/tests/).
ipcMain.handle('test:read', async (_event, { folder, name }) => {
  try {
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', folder };
    if (!name || typeof name !== 'string') return { ok: false, error: 'missing_name' };
    const safeName = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (!safeName) return { ok: false, error: 'invalid_name' };
    const filePath = path.join(dir, `${safeName}.json`);
    const json = await fs.readFile(filePath, 'utf8');
    return { ok: true, path: filePath, name: safeName, json };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'not_found' };
    return { ok: false, error: e.message };
  }
});

// Delete a test JSON. Used by the Test View row's × button (with
// browser-confirm prompt in the renderer). Idempotent: returns ok:true
// even if the file didn't exist (matches `rm -f` semantics). Jul 11
// ~16:42 ET — see test:read for context. Per-project location:
// <folder>/.farnsworth/devvit-tests/<name>.json (Jul 11 ~18:38 ET).
ipcMain.handle('test:delete', async (_event, { folder, name }) => {
  try {
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', folder };
    if (!name || typeof name !== 'string') return { ok: false, error: 'missing_name' };
    const safeName = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (!safeName) return { ok: false, error: 'invalid_name' };
    const filePath = path.join(dir, `${safeName}.json`);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return { ok: true, path: filePath, name: safeName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================================
// IPC: Memory system (Tier 1, Jul 5 2026)
//
// Surface mirrors Vellum's 6-layer pipeline in compressed form:
// bootstrap = always-loaded essentials + recent concepts
// recall    = LIKE-based concept+essential+buffer search (Tier 2: vec)
// remember  = append raw fact to buffer + archive (immutable daily log)
// get/set   = CRUD on concepts + essentials
// consolidate = flip buffer rows to consolidated (Tier 2: merge into concept)
// archive   = read daily log (for debugging + future community-memory)
// ============================================================
// ============================================================
// Memory Tier 3 — per-stage model pipeline (Jul 12 2026)
//
// Five real stages, each with its own model + toggle read from the
// 'memory' settings row (written by Settings → Memory in the renderer):
//   1 extraction    — distills each turn into durable facts (Haiku 4.5)
//   2 consolidation — merges buffer → concept sections (Sonnet 5,
//                     scheduled + buffer-threshold + manual)
//   3 retrieval     — re-ranks recall results (Sonnet 5, on demand)
//   4 router        — picks concept articles pre-turn (Haiku 4.5)
//   5 l2selector    — picks sections within routed articles (Haiku 4.5)
// Every stage degrades gracefully: disabled / no auth / bad model output
// falls back to the pre-Tier-3 behavior. Stats per run land in the
// 'memoryStageStats' settings row for the Settings page.
// ============================================================

const MEMORY_STAGE_DEFAULTS = {
  extraction:    { enabled: true, model: 'Haiku 4.5', tier: 'speed',    extract: ['Corrections', 'Preferences', 'Decisions'], noiseFilter: true },
  consolidation: { enabled: true, model: 'Sonnet 5',  tier: 'balanced', schedule: 'Daily', autoOnBuffer: true, bufferThreshold: 50 },
  retrieval:     { enabled: true, model: 'Sonnet 5',  tier: 'balanced', depth: 'Standard', summariesFirst: true, graphSpread: true },
  router:        { enabled: true, model: 'Haiku 4.5', tier: 'speed',    bucketBudget: 3, gate: true },
  l2selector:    { enabled: true, model: 'Haiku 4.5', tier: 'speed' },
  retrospective: { enabled: true, model: 'Sonnet 5',  tier: 'balanced', quietMinutes: 30, maxPerTick: 2 },
};

// Bump a named counter inside a stage's stats blob (gate skips, noise skips).
function memoryStatCounter(stage, key) {
  try {
    const cur = db.memoryStageStatsGet();
    const val = (((cur || {})[stage] || {})[key] || 0) + 1;
    db.memoryStageStatsPatch(stage, { [key]: val });
  } catch {}
}

function memoryStageConf(stage) {
  let saved = null;
  try {
    const raw = db.getSetting('memory');
    saved = raw ? JSON.parse(raw) : null;
  } catch {}
  return { ...MEMORY_STAGE_DEFAULTS[stage], ...((saved || {})[stage] || {}) };
}

// Tolerant JSON extraction from model output (code fences, prose wrapping).
function memoryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// One inference call for a pipeline stage, on the stage's configured model.
// Returns the response text, or null (stage disabled / no auth / API error).
// Callers MUST degrade to their non-model behavior on null.
async function memoryStageInference(stage, system, user, maxTokens = 512) {
  const conf = memoryStageConf(stage);
  if (!conf.enabled) return null;
  const auth = await getValidAccessToken();
  if (!auth) { console.warn(`[memory tier3] ${stage}: no auth, skipping`); return null; }
  const model = MODEL_DISPLAY_TO_API[conf.model] || conf.model || 'claude-haiku-4-5';
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (auth.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14';
  } else {
    headers['x-api-key'] = auth.token;
  }
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      db.memoryStageStatsPatch(stage, { lastRun: new Date().toISOString(), ms, model, lastError: `${res.status}: ${errText}` }, true);
      console.warn(`[memory tier3] ${stage} API ${res.status}:`, errText);
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
    db.memoryStageStatsPatch(stage, { lastRun: new Date().toISOString(), ms, model, lastError: null }, true);
    return text;
  } catch (e) {
    db.memoryStageStatsPatch(stage, { lastRun: new Date().toISOString(), ms: Date.now() - t0, model, lastError: e.message }, true);
    console.warn(`[memory tier3] ${stage} failed:`, e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Stage 2: consolidation pass (model-driven merge of buffer → concepts) ----
let consolidationRunning = false;
async function runConsolidationPass(reason = 'manual') {
  if (consolidationRunning) return { ok: false, error: 'already_running' };
  consolidationRunning = true;
  try {
    const buffer = db.memoryBufferList(true, 50);
    if (!buffer.length) return { ok: true, processed: 0, reason };
    const conf = memoryStageConf('consolidation');
    if (!conf.enabled) return db.memoryConsolidate(null); // Tier-1 behavior: flip flags
    const concepts = db.memoryListConcepts(100);
    const articleIndex = concepts.map(c => `- ${c.slug} — ${c.title}${c.lead ? ': ' + String(c.lead).slice(0, 120) : ''}`).join('\n') || '(no articles yet)';
    const bufferLines = buffer.map(b => `[${b.id}] (${b.source || 'chat'}) ${String(b.content).slice(0, 400)}`).join('\n');
    const system = `You are the consolidation stage of an IDE assistant's memory system. Merge buffered facts into wiki-style concept articles. Prefer appending to existing articles; create an article only for a genuinely new durable topic. Use "essential" only for identity-level facts that must load every session. Use "drop" for noise, duplicates, and transient status.
Two special always-loaded articles exist: 'threads' (open loops — active commitments, follow-ups, waiting-on-someone) and 'recent' (rolling digest of notable events, newest first). Keep them current: file open-loop facts into 'threads' and notable events into 'recent' (append, or a "lane" op to REPLACE the whole body when entries resolved or went stale — keep each lane under ~20 lines). "lane" ops take ids:[] and don't consume buffer ids.
Every buffer id must appear in exactly one non-lane op. Return ONLY JSON:
{"ops":[
 {"op":"append","ids":[1],"slug":"existing-slug","section":"section heading","content":"markdown to append"},
 {"op":"create","ids":[2,3],"slug":"kebab-slug","title":"Title","lead":"1-2 sentence standalone summary","body":"markdown with ## section headings"},
 {"op":"essential","ids":[4],"key":"snake_case_key","value":"short value"},
 {"op":"lane","ids":[],"slug":"threads","body":"full replacement markdown"},
 {"op":"drop","ids":[5]}
]}`;
    const user = `EXISTING ARTICLES:\n${articleIndex}\n\nBUFFER (unconsolidated facts):\n${bufferLines}`;
    const text = await memoryStageInference('consolidation', system, user, 2048);
    if (!text) return { ok: false, error: 'inference_unavailable', reason };
    const parsed = memoryParseJson(text);
    if (!parsed || !Array.isArray(parsed.ops)) return { ok: false, error: 'bad_model_output', reason };
    const applied = { append: 0, create: 0, essential: 0, drop: 0, lane: 0 };
    const doneIds = new Set();
    for (const op of parsed.ops) {
      const ids = Array.isArray(op.ids) ? op.ids.filter(id => buffer.find(b => b.id === id)) : [];
      try {
        if (op.op === 'append' && op.slug && op.content) {
          const r = db.memoryAppendToSection(op.slug, op.section || 'notes', op.content);
          if (r.ok) applied.append++;
          else {
            // Model referenced an unknown slug — recover by creating a
            // minimal article rather than losing the fact.
            db.memoryUpsertConcept({ slug: op.slug, title: op.slug.replace(/-/g, ' '), lead: null, body: `## ${op.section || 'notes'}\n\n${op.content}\n`, source: 'consolidation' });
            applied.create++;
          }
        } else if (op.op === 'create' && op.slug && op.title) {
          db.memoryUpsertConcept({ slug: op.slug, title: op.title, lead: op.lead || null, body: op.body || null, source: 'consolidation' });
          applied.create++;
        } else if (op.op === 'essential' && op.key && op.value) {
          db.memorySetEssential(op.key, op.value, 'consolidation', 0.9);
          applied.essential++;
        } else if (op.op === 'lane' && db.MEMORY_LANE_SLUGS.includes(op.slug) && op.body) {
          // Full-body replacement of a pinned lane (threads / recent).
          const cur = db.memoryGetConcept(op.slug);
          db.memoryUpsertConcept({ slug: op.slug, title: cur?.title || op.slug, lead: cur?.lead || null, body: String(op.body), source: 'consolidation' });
          applied.lane++;
        } else if (op.op === 'drop') {
          applied.drop++;
        } else {
          continue; // malformed op — leave its ids unconsolidated for the next pass
        }
        ids.forEach(id => doneIds.add(id));
      } catch (e) {
        console.warn('[memory tier3] consolidation op failed:', e.message);
      }
    }
    if (doneIds.size) db.memoryConsolidate([...doneIds]);
    db.memoryStageStatsSetGlobal('lastConsolidationAt', new Date().toISOString());
    console.log(`[memory tier3] consolidation (${reason}): ${doneIds.size}/${buffer.length} buffer rows → ${JSON.stringify(applied)}`);
    return { ok: true, processed: doneIds.size, total: buffer.length, applied, reason };
  } finally {
    consolidationRunning = false;
  }
}

// Auto-consolidation when the buffer crosses the configured threshold.
function maybeAutoConsolidate() {
  try {
    const conf = memoryStageConf('consolidation');
    if (!conf.enabled || !conf.autoOnBuffer) return;
    const threshold = Number(conf.bufferThreshold) || 50;
    if (db.memoryUnconsolidatedCount() >= threshold && !consolidationRunning) {
      runConsolidationPass('buffer-threshold').catch(e => console.warn('[memory tier3] auto-consolidation failed:', e.message));
    }
  } catch {}
}

// Scheduled consolidation — Hourly / Daily / Weekly, checked every 30 min
// (and once shortly after boot).
const MEMORY_SCHEDULE_MS = { Hourly: 3600e3, Daily: 86400e3, Weekly: 604800e3 };
function maybeScheduledConsolidation() {
  try {
    const conf = memoryStageConf('consolidation');
    if (!conf.enabled) return;
    const interval = MEMORY_SCHEDULE_MS[conf.schedule] || MEMORY_SCHEDULE_MS.Daily;
    const stats = db.memoryStageStatsGet();
    const last = stats.lastConsolidationAt ? Date.parse(stats.lastConsolidationAt) : 0;
    if (Date.now() - last >= interval && db.memoryUnconsolidatedCount() > 0 && !consolidationRunning) {
      runConsolidationPass('scheduled').catch(e => console.warn('[memory tier3] scheduled consolidation failed:', e.message));
    }
  } catch {}
}
setInterval(maybeScheduledConsolidation, 30 * 60 * 1000);
setTimeout(maybeScheduledConsolidation, 90 * 1000);

// ---- v3.1 Stage 6: retrospective (post-conversation sweep) ----
// Live extraction sees one turn at a time; the retrospective re-reads a
// whole conversation once it has gone quiet and captures what was missed
// (arcs, decisions, corrections). Output lands in the buffer like any other
// fact (source='retrospective'). State lives in the 'memoryRetroState'
// settings row: convId → the updated_at that was last swept.
let retrospectiveRunning = false;

function memoryRetroState() {
  try { return JSON.parse(db.getSetting('memoryRetroState') || '{}'); } catch { return {}; }
}
function memoryRetroMarkDone(convId, updatedAt) {
  try {
    const s = memoryRetroState();
    s[convId] = updatedAt || new Date().toISOString();
    db.setSetting('memoryRetroState', JSON.stringify(s));
  } catch {}
}
// SQLite CURRENT_TIMESTAMP strings are UTC without a zone marker — parse as UTC.
function sqliteUtcMs(ts) {
  if (!ts) return 0;
  const s = String(ts);
  return Date.parse(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z') || 0;
}

async function runRetrospective(convId) {
  const conv = db.getConversation(convId);
  if (!conv) return { ok: false, error: 'no_such_conversation' };
  let msgs = [];
  try { msgs = JSON.parse(conv.messages || '[]'); } catch {}
  const textOf = (m) => typeof m?.content === 'string' ? m.content
    : Array.isArray(m?.content) ? m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')
    : typeof m?.text === 'string' ? m.text : '';
  const lines = msgs.slice(-40)
    .map(m => `${(m.role === 'assistant' || m.role === 'agent') ? 'assistant' : 'user'}: ${textOf(m).slice(0, 500)}`)
    .filter(l => l.length > 12);
  if (lines.length < 4) {
    memoryRetroMarkDone(convId, conv.updated_at);
    return { ok: true, skipped: true, reason: 'too_short' };
  }
  const already = db.memoryBufferList(false, 30).map(b => `- ${String(b.content).slice(0, 120)}`).join('\n') || '(none)';
  const system = `You are the retrospective stage of an IDE assistant's memory. Review a finished conversation and capture durable facts that the live per-turn extraction MISSED — decisions, corrections, preferences, plans, project state. Skip code contents, transient status, and anything in ALREADY CAPTURED. Return ONLY JSON {"items":[{"kind":"correction|preference|decision|name|plan|fact","content":"one-line fact"}]} — items may be empty.`;
  const user = `CONVERSATION "${conv.title || 'Untitled'}":\n${lines.join('\n').slice(0, 12000)}\n\nALREADY CAPTURED (recent buffer):\n${already}`;
  const text = await memoryStageInference('retrospective', system, user, 700);
  if (text === null) return { ok: false, error: 'inference_unavailable' };
  const parsed = memoryParseJson(text);
  const items = Array.isArray(parsed?.items) ? parsed.items.slice(0, 8) : [];
  for (const item of items) {
    if (!item || !item.content) continue;
    db.memoryBufferAppend(`[${item.kind || 'fact'}] ${item.content}`, `retrospective: ${conv.title || convId}`, 'retrospective');
  }
  memoryRetroMarkDone(convId, conv.updated_at);
  if (items.length) maybeAutoConsolidate();
  console.log(`[memory tier3] retrospective "${conv.title || convId}": ${items.length} facts captured`);
  return { ok: true, items: items.length, title: conv.title };
}

async function maybeRetrospectives() {
  if (retrospectiveRunning) return;
  retrospectiveRunning = true;
  try {
    const conf = memoryStageConf('retrospective');
    if (!conf.enabled) return;
    const quietMs = Math.max(5, Number(conf.quietMinutes) || 30) * 60e3;
    // First run ever: don't storm through history — only the 3 most recent
    // conversations are eligible; everything older is marked as swept.
    if (!db.getSetting('memoryRetroState')) {
      const seed = {};
      db.listAllConversations(500).slice(3).forEach(c => { seed[c.id] = c.updated_at; });
      db.setSetting('memoryRetroState', JSON.stringify(seed));
    }
    const state = memoryRetroState();
    const convs = db.listAllConversations(60);
    let ran = 0;
    for (const c of convs) {
      if (ran >= (Number(conf.maxPerTick) || 2)) break;
      if (state[c.id] === c.updated_at) continue;                  // nothing new since last sweep
      if (Date.now() - sqliteUtcMs(c.updated_at) < quietMs) continue; // still active — wait for quiet
      try {
        const r = await runRetrospective(c.id);
        if (r.ok && !r.skipped) ran++;
      } catch (e) {
        console.warn('[memory tier3] retrospective failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('[memory tier3] retrospective sweep failed:', e.message);
  } finally {
    retrospectiveRunning = false;
  }
}
setInterval(maybeRetrospectives, 30 * 60 * 1000);
setTimeout(maybeRetrospectives, 150 * 1000);

ipcMain.handle('memory:bootstrap', async () => db.memoryBootstrap());
ipcMain.handle('memory:recall', async (_event, query, limit) => {
  const res = await db.memoryRecall(query, limit);
  // Stage 3: retrieval re-rank. A model orders (and prunes) the concept +
  // section candidates. Essentials / code / buffer keep their FTS order.
  // On any failure the raw FTS5-ordered result goes back unchanged.
  try {
    const conf = memoryStageConf('retrieval');
    const candidates = [
      ...(res.concepts || []).map(c => ({ type: 'concept', ref: c, label: `${c.slug} — ${c.title}: ${String(c.lead || '').slice(0, 120)}` })),
      ...(res.sections || []).map(s => ({ type: 'section', ref: s, label: `${s.slug} § ${s.heading}: ${String(s.content || '').slice(0, 120)}` })),
    ];
    if (conf.enabled && candidates.length > 1) {
      const list = candidates.map((c, i) => `[${i}] (${c.type}) ${c.label}`).join('\n');
      const system = 'You rank memory search results. Given a query and numbered candidates, return ONLY JSON {"keep":[indices]} — most relevant first, irrelevant candidates omitted.';
      const text = await memoryStageInference('retrieval', system, `QUERY: ${query}\n\nCANDIDATES:\n${list}`, 200);
      const parsed = memoryParseJson(text || '');
      if (parsed && Array.isArray(parsed.keep) && parsed.keep.length) {
        const seen = new Set();
        const keep = parsed.keep.filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i) && seen.add(i));
        res.concepts = keep.filter(i => candidates[i].type === 'concept').map(i => candidates[i].ref);
        res.sections = keep.filter(i => candidates[i].type === 'section').map(i => candidates[i].ref);
        res.reranked = true;
      }
    }
  } catch (e) {
    console.warn('[memory tier3] retrieval re-rank skipped:', e.message);
  }
  return res;
});
ipcMain.handle('memory:remember', async (_event, content, opts) => {
  const ctx = opts?.context || null;
  const src = opts?.source || 'chat';
  const kind = opts?.kind || 'fact';
  // The immutable daily log always gets the raw content, extraction or not.
  db.memoryArchiveAppend(kind, content, ctx ? { context: ctx, source: src } : { source: src });

  // Stage 1: extraction. A cheap model distills the raw turn into durable
  // facts before anything enters the buffer. Disabled / no auth / bad
  // output → raw buffering (pre-Tier-3 behavior).
  const conf = memoryStageConf('extraction');

  // v3.1 noise pre-filter (Vellum-style): low-value acks skip the extraction
  // model call entirely. The archive row above already holds the raw text,
  // so nothing is lost — this just saves a model call on "ok" / "thanks".
  if (conf.enabled && conf.noiseFilter !== false) {
    const t = String(content).trim();
    if (t.length < 10 || /^(ok(ay)?|k+|y(es|ep|eah)?|no(pe)?|thanks?(\s+you)?|ty|thx|cool|nice|got it|sounds good|sure(\s+thing)?|lol|ha(ha)+|great|perfect|done|nvm|hm+|huh|yo|hey|hi|hello)[.!?\s]*$/i.test(t)) {
      memoryStatCounter('extraction', 'noiseSkips');
      return { ok: true, extracted: 0, skipped: true, noise: true };
    }
  }

  if (conf.enabled) {
    try {
      const cats = (Array.isArray(conf.extract) && conf.extract.length ? conf.extract : ['Corrections', 'Preferences', 'Decisions']).join(', ');
      const system = `You are the memory-extraction stage of an IDE assistant. Decide whether this chat content contains durable facts worth remembering across sessions. Focus on: ${cats}. Distill each fact into one short line. Skip small talk, transient status, and code contents. Return ONLY JSON: {"keep":true|false,"items":[{"kind":"correction|preference|decision|name|plan|fact","content":"one-line fact"}]}`;
      const text = await memoryStageInference('extraction', system, `[source: ${src}] ${String(content).slice(0, 1500)}`, 400);
      if (text !== null) {
        const parsed = memoryParseJson(text);
        if (parsed && parsed.keep === false) return { ok: true, extracted: 0, skipped: true };
        if (parsed && Array.isArray(parsed.items) && parsed.items.length) {
          let last = null;
          for (const item of parsed.items.slice(0, 6)) {
            if (!item || !item.content) continue;
            last = db.memoryBufferAppend(`[${item.kind || 'fact'}] ${item.content}`, ctx, 'extraction');
          }
          maybeAutoConsolidate();
          return { ok: true, extracted: parsed.items.length, id: last?.id };
        }
      }
    } catch (e) {
      console.warn('[memory tier3] extraction failed, raw buffering:', e.message);
    }
  }
  const bufferRes = db.memoryBufferAppend(content, ctx, src);
  maybeAutoConsolidate();
  return bufferRes;
});
ipcMain.handle('memory:get', async (_event, slug) => db.memoryGetConcept(slug));
ipcMain.handle('memory:set', async (_event, concept) => {
  const res = db.memoryUpsertConcept(concept);
  // Tier 2: re-embed so memory_vec stays in sync. Fire-and-forget —
  // the sync upsert is the primary write; embedding catches up async.
  if (concept?.slug) db.memoryConceptEmbed(concept.slug).catch((e) => console.warn('[memory tier2] embed failed:', e.message));
  return res;
});
ipcMain.handle('memory:delete', async (_event, slug) => {
  const res = db.memoryDeleteConcept(slug);
  db.memoryConceptForget(slug);
  return res;
});
ipcMain.handle('memory:list', async (_event, limit) => db.memoryListConcepts(limit));
ipcMain.handle('memory:essential-get', async (_event, key) => db.memoryGetEssential(key));
ipcMain.handle('memory:essential-set', async (_event, key, value, source, confidence) => db.memorySetEssential(key, value, source, confidence));
ipcMain.handle('memory:essential-delete', async (_event, key) => db.memoryDeleteEssential(key));
ipcMain.handle('memory:essentials', async () => db.memoryListEssentials());
ipcMain.handle('memory:consolidate', async (_event, bufferIds) => {
  // Explicit ids (per-row buttons in Settings): plain flag flip. Null (the
  // "Consolidate all" path): run the real Stage-2 model pass.
  if (Array.isArray(bufferIds) && bufferIds.length) return db.memoryConsolidate(bufferIds);
  return await runConsolidationPass('manual');
});
ipcMain.handle('memory:archive', async (_event, opts) => db.memoryArchiveList(opts));
ipcMain.handle('memory:buffer', async (_event, onlyUnconsolidated, limit) => db.memoryBufferList(onlyUnconsolidated, limit));

// ---- Tier 3 IPCs (Jul 12 2026) ----

// Stages 4+5: pre-turn routing. Router picks up to bucketBudget concept
// articles for the user's new message; the L2 selector then picks sections
// within them (lead always included). Returns essentials + routed concepts
// ready for preamble assembly in the renderer.
ipcMain.handle('memory:route', async (_event, opts = {}) => {
  const context = String(opts?.context || '').slice(0, 800);
  const routerConf = memoryStageConf('router');
  const essentials = db.memoryListEssentials();
  // v3.1 pinned lanes (threads + recent): always returned; the renderer
  // injects them on the first message of a conversation like essentials.
  const lanes = db.memoryGetLanes();
  if (!routerConf.enabled) return { ok: false, disabled: true, essentials, lanes };

  // v3.1 injection gate: when the message shares zero keywords with the
  // memory corpus, skip the router model entirely — no model call, no
  // routed injection. Essentials + lanes still flow on the first message.
  if (routerConf.gate !== false && !db.memoryGateCheck(context)) {
    memoryStatCounter('router', 'gateSkips');
    return { ok: true, essentials, lanes, concepts: [], routed: [], gated: true };
  }

  // Lanes are always injected, so they never compete for router budget.
  const all = db.memoryListConcepts(150).filter(c => !db.MEMORY_LANE_SLUGS.includes(c.slug));
  if (!all.length) return { ok: true, essentials, lanes, concepts: [], routed: [] };
  const budget = Math.max(1, Math.min(Number(routerConf.bucketBudget) || 3, 6));
  const index = all.map(c => `- ${c.slug} — ${c.title}${c.lead ? ': ' + String(c.lead).slice(0, 140) : ''}`).join('\n');
  const routerSystem = `You are the memory router of an IDE assistant. Given the user's new message and the article index, pick up to ${budget} articles genuinely useful for answering. Return ONLY JSON {"slugs":["slug",...]}. Return {"slugs":[]} when none are relevant.`;
  const routerText = await memoryStageInference('router', routerSystem, `USER MESSAGE:\n${context}\n\nARTICLE INDEX:\n${index}`, 200);
  if (routerText === null) return { ok: false, error: 'router_unavailable', essentials, lanes };
  const routerParsed = memoryParseJson(routerText);
  const slugs = (Array.isArray(routerParsed?.slugs) ? routerParsed.slugs : [])
    .filter(s => all.find(c => c.slug === s)).slice(0, budget);
  if (!slugs.length) return { ok: true, essentials, lanes, concepts: [], routed: [] };

  // Stage 5: L2 section selector — only worth a model call when at least
  // one routed article actually has multiple sections.
  const l2Conf = memoryStageConf('l2selector');
  const sectionMap = {};
  for (const slug of slugs) sectionMap[slug] = db.memorySectionsForConcept(slug);
  let picks = null;
  if (l2Conf.enabled && slugs.some(s => (sectionMap[s] || []).length > 1)) {
    const headingsList = slugs.map(s => `${s}: ${(sectionMap[s] || []).map(x => x.heading).join(' | ') || '(no sections)'}`).join('\n');
    const l2System = 'You select sections within memory articles. Each article\'s lead paragraph is always included automatically. Given the user message and each article\'s section headings, return ONLY JSON {"picks":[{"slug":"...","sections":["heading",...]}]} — only the sections that matter.';
    const l2Text = await memoryStageInference('l2selector', l2System, `USER MESSAGE:\n${context}\n\nARTICLE SECTIONS:\n${headingsList}`, 300);
    const l2Parsed = memoryParseJson(l2Text || '');
    if (l2Parsed && Array.isArray(l2Parsed.picks)) picks = l2Parsed.picks;
  }

  const out = [];
  for (const slug of slugs) {
    const full = db.memoryGetConcept(slug);
    if (!full) continue;
    const secs = sectionMap[slug] || [];
    if (picks) {
      const p = picks.find(x => x && x.slug === slug);
      const wanted = new Set((p?.sections || []).map(h => String(h).toLowerCase()));
      const chosen = secs.filter(x => wanted.has(String(x.heading).toLowerCase()));
      out.push({ slug, title: full.title, lead: full.lead, sections: chosen.map(x => ({ heading: x.heading, content: x.content })) });
    } else if (!l2Conf.enabled) {
      // L2 disabled: whole article (v2-style injection).
      out.push({ slug, title: full.title, lead: full.lead, body: full.body });
    } else {
      // L2 enabled but didn't run / returned nothing: lead only.
      out.push({ slug, title: full.title, lead: full.lead, sections: [] });
    }
  }
  return { ok: true, essentials, lanes, concepts: out, routed: slugs };
});

// Manual "Run now" for the consolidation stage (Settings → Memory).
ipcMain.handle('memory:run-consolidation', async () => await runConsolidationPass('manual'));

// Manual retrospective (Settings → Memory "Run now", or with an explicit
// conversation id). Without an id, sweeps the most recent conversation
// regardless of quiet time.
ipcMain.handle('memory:run-retrospective', async (_event, convId) => {
  if (convId) return await runRetrospective(convId);
  const convs = db.listAllConversations(1);
  if (!convs.length) return { ok: false, error: 'no_conversations' };
  return await runRetrospective(convs[0].id);
});

// Per-stage run stats + corpus counters for the Settings page.
ipcMain.handle('memory:stage-stats', async () => ({
  ok: true,
  stats: db.memoryStageStatsGet(),
  bufferCount: db.memoryUnconsolidatedCount(),
  sectionsCount: db.memorySectionsCount(),
}));

// ============================================================
// IPC: Memory Tier 2 — codebase indexer (sqlite-vec)
// ============================================================

// Code index stats for the Settings panel.
ipcMain.handle('memory:code-stats', async (_event, workspacePath) => db.memoryCodeStats(workspacePath));

// Search the FTS5 keyword index for a workspace. Returns ranked chunks
// matching the query string. Tier 2 ships FTS5-only (sqlite-vec is loaded
// but embeddings stay disabled until onnxruntime BFCArena is fixed
// upstream). Positional args: workspacePath, query, k.
ipcMain.handle('memory:code-search', async (_event, workspacePath, query, k) => {
  if (!workspacePath || !query) return { ok: false, error: 'missing_args' };
  return db.memoryCodeFtsSearch(query, k || 12, workspacePath);
});

// Manually upsert a single file (used by the renderer when it wants to
// force-index a file without waiting for the watcher).
ipcMain.handle('memory:code-index-file', async (_event, workspacePath, filePath, content) => {
  return await db.memoryCodeUpsertFile(workspacePath, filePath, content);
});

// Manually remove a file from the index (called by the watcher on unlink).
ipcMain.handle('memory:code-remove-file', async (_event, workspacePath, filePath) => {
  return db.memoryCodeRemoveFile(workspacePath, filePath);
});

// Re-embed a concept after upsert (called after memory:set so the vec
// table stays in sync with memory_concepts).
ipcMain.handle('memory:concept-embed', async (_event, slug) => {
  return await db.memoryConceptEmbed(slug);
});

// Forget a concept's embedding (called after memory:delete).
ipcMain.handle('memory:concept-forget', async (_event, slug) => {
  return db.memoryConceptForget(slug);
});

// Code file watcher — singleton. Starts a chokidar watcher on the given
// folder; on add/change it calls memoryCodeUpsertFile, on unlink it
// calls memoryCodeRemoveFile. Filtering by extension + ignored dirs is
// done in the watcher setup.
let codeWatcher = null;
let watchedFolder = null;

const CODE_FILE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.html', '.css', '.scss', '.sass', '.vue', '.svelte',
  '.sql', '.sh', '.bash', '.zsh',
]);
const CODE_FILE_IGNORED = /(^|[\/\\])(\.git|node_modules|\.DS_Store|dist|build|out|\.next|\.cache|coverage|__snapshots__|target|vendor|\.venv|venv|\.env|\.turbo|\.parcel-cache|\.idea|\.vscode)([\/\\]|$)/;

function stopCodeWatcher() {
  if (codeWatcher) {
    try { codeWatcher.close(); } catch (_) {}
    codeWatcher = null;
    watchedFolder = null;
    console.log('[memory tier2] code watcher stopped');
  }
}

ipcMain.handle('memory:code-watch', async (_event, workspacePath) => {
  if (!workspacePath || typeof workspacePath !== 'string') {
    return { ok: false, error: 'missing_workspace_path' };
  }
  // Already watching this folder — no-op.
  if (watchedFolder === workspacePath && codeWatcher) {
    return { ok: true, already_watching: true };
  }
  stopCodeWatcher();
  const chokidar = await import('chokidar');
  console.log('[memory tier2] starting watcher on', workspacePath);
  codeWatcher = chokidar.watch(workspacePath, {
    ignored: (path, stats) => {
      // Always ignore known-bad dirs (any depth)
      if (CODE_FILE_IGNORED.test(path)) return true;
      // For files (stats available): require a known code extension
      if (stats && stats.isFile()) {
        const base = path.split('/').pop();
        const ext = '.' + (base.split('.').pop() || '').toLowerCase();
        return !CODE_FILE_EXTS.has(ext);
      }
      // For directories and unknown: don't ignore (let chokidar recurse)
      return false;
    },
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watchedFolder = workspacePath;

  codeWatcher.on('add', async (filePath) => {
    console.log('[memory tier2] add:', filePath);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const res = await db.memoryCodeUpsertFile(workspacePath, filePath, content);
      console.log('[memory tier2] indexed', filePath, '→', res?.chunk_count || 0, 'chunks');
    } catch (e) {
      console.warn('[memory tier2] add failed:', filePath, e.message);
    }
  });
  codeWatcher.on('change', async (filePath) => {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const res = await db.memoryCodeUpsertFile(workspacePath, filePath, content);
      if (res?.ok && !res.skipped) {
        console.log('[memory tier2] re-indexed', filePath, '→', res.chunk_count, 'chunks');
      }
    } catch (e) {
      console.warn('[memory tier2] change failed:', filePath, e.message);
    }
  });
  codeWatcher.on('unlink', (filePath) => {
    try {
      db.memoryCodeRemoveFile(workspacePath, filePath);
    } catch (e) {
      console.warn('[memory tier2] unlink failed:', filePath, e.message);
    }
  });
  codeWatcher.on('ready', () => {
    console.log('[memory tier2] code watcher ready on', workspacePath);
  });
  codeWatcher.on('error', (err) => {
    console.error('[memory tier2] watcher error:', err.message);
  });

  return { ok: true, watching: workspacePath };
});

ipcMain.handle('memory:code-unwatch', async () => {
  stopCodeWatcher();
  return { ok: true };
});

// ============================================================================
// UI folder watcher — pushes add/change/unlink events to the renderer so the
// Files panel can refresh automatically when the agent (or anything outside
// the editor) modifies a file. Separate from the memory code watcher (which
// only cares about code extensions + writes to memory_code_chunks). The UI
// watcher emits all file types and emits raw events to the renderer; debouncing
// + readFolder() happens renderer-side so we can also scroll/highlight.
// ============================================================================
let uiWatcher = null;
let uiWatchedFolder = null;

function stopUiWatcher() {
  if (uiWatcher) {
    try { uiWatcher.close(); } catch (_) {}
    uiWatcher = null;
    uiWatchedFolder = null;
    console.log('[fs watch] UI watcher stopped');
  }
}

ipcMain.handle('fs:watchFolder', async (event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') {
    return { ok: false, error: 'missing_folder_path' };
  }
  if (uiWatchedFolder === folderPath && uiWatcher) {
    return { ok: true, already_watching: true };
  }
  stopUiWatcher();
  const chokidar = await import('chokidar');
  console.log('[fs watch] starting UI watcher on', folderPath);
  // Same ignore set as the memory watcher minus the code-extension filter
  // (the Files panel shows everything, including images / configs).
  uiWatcher = chokidar.watch(folderPath, {
    ignored: (path) => CODE_FILE_IGNORED.test(path),
    persistent: true,
    ignoreInitial: true,  // don't emit add events for existing files
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    depth: 99,
  });
  uiWatchedFolder = folderPath;

  const send = (type, path) => {
    try {
      event.sender.send('fs:folderEvent', { type, path, folder: folderPath });
    } catch (e) {
      // Window may have closed mid-watch — silent.
    }
  };
  uiWatcher.on('add', (filePath) => send('add', filePath));
  uiWatcher.on('change', (filePath) => send('change', filePath));
  uiWatcher.on('unlink', (filePath) => send('unlink', filePath));
  uiWatcher.on('ready', () => console.log('[fs watch] UI watcher ready on', folderPath));
  uiWatcher.on('error', (err) => console.error('[fs watch] UI watcher error:', err.message));

  return { ok: true, watching: folderPath };
});

ipcMain.handle('fs:unwatchFolder', async () => {
  stopUiWatcher();
  return { ok: true };
});

// ============================================================================
// Unsaved-changes confirm dialog. Used by the renderer when closing a
// dirty tab or switching folders, and by main's before-quit handler when
// the user tries to quit with dirty buffers open. Three buttons: Save,
// Don't Save, Cancel.
// ============================================================================
ipcMain.handle('dialog:confirmDiscard', async (_event, opts) => {
  const { fileName, count } = opts || {};
  const buttons = ['Save', "Don't Save", 'Cancel'];
  const detail = count && count > 1
    ? `${count} files have unsaved changes. Save them before closing?`
    : `${fileName || 'This file'} has unsaved changes. Save before closing?`;
  try {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons,
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'Unsaved changes',
      detail,
    });
    return { choice: result.response };  // 0=Save, 1=Don't Save, 2=Cancel
  } catch (e) {
    return { choice: 2, error: e.message };  // default to Cancel on error
  }
});

// Cleanup on app quit
app.on('before-quit', () => {
  try { stopUiWatcher(); } catch (_) {}
});

// Memory worker cleanup on app quit
app.on('before-quit', () => {
  try { stopCodeWatcher(); } catch (_) {}
  try { db.closeEmbedWorker(); } catch (_) {}
});

// ============================================================
// IPC: File operations
// ============================================================
ipcMain.handle('fs:readDir', async (_event, folderPath, depth = 2) => {
  try {
    const entries = await readDirRecursive(folderPath, depth);
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function readDirRecursive(dir, depth, base = dir) {
  const out = [];
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const item of items) {
    if (['node_modules', '.git', 'dist', 'build', '.next', '.cache'].includes(item.name)) continue;
    if (item.name.startsWith('.') && item.name !== '.farnsworth') continue;
    const full = path.join(dir, item.name);
    const rel = path.relative(base, full);
    if (item.isDirectory()) {
      out.push({ path: rel, type: 'dir', name: item.name });
      if (depth > 1) {
        const children = await readDirRecursive(full, depth - 1, base);
        children.forEach(c => out.push(c));
      }
    } else {
      const ext = path.extname(item.name).slice(1);
      let size = 0;
      try { size = (await fs.stat(full)).size; } catch {}
      out.push({ path: rel, type: 'file', name: item.name, ext, size });
    }
  }
  return out;
}

ipcMain.handle('fs:readFile', async (_event, folderPath, filePath) => {
  try {
    const full = path.join(folderPath, filePath);
    const content = await fs.readFile(full, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:writeFile', async (_event, folderPath, filePath, content) => {
  try {
    const full = path.join(folderPath, filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Reveal a file (or folder) in Finder. Wraps `/usr/bin/open -R <path>`
// which goes through LaunchServices directly and does NOT trip the
// macOS AppleEvents TCC prompt that `shell.showItemInFolder()` does
// on first invocation. Returns {ok} on success, {ok: false, error} on
// failure (e.g. missing workspace, missing file, path doesn't exist).
//
// Args:
//   folderPath — workspace root (must be set; we resolve relative paths
//                against it for safety)
//   filePath   — file path relative to the workspace. Empty string
//                reveals the workspace folder itself.
ipcMain.handle('fs:showInFinder', async (_event, folderPath, filePath) => {
  if (!folderPath) return { ok: false, error: 'missing_folder' };
  const target = filePath ? path.join(folderPath, filePath) : folderPath;
  try {
    await fs.access(target);
  } catch (err) {
    return { ok: false, error: 'not_found' };
  }
  return new Promise((resolve) => {
    child_process.execFile('open', ['-R', target], (err) => {
      if (err) {
        console.error('[fs:showInFinder] open -R failed for', target, '-', err.message);
        return resolve({ ok: false, error: err.message });
      }
      resolve({ ok: true, target });
    });
  });
});

// Rename a file or folder within the workspace. The new path is also
// resolved against the workspace root so a user can't escape via "../".
ipcMain.handle('fs:rename', async (_event, folderPath, oldRelPath, newRelPath) => {
  if (!folderPath || !oldRelPath || !newRelPath) {
    return { ok: false, error: 'missing_args' };
  }
  const oldFull = path.resolve(folderPath, oldRelPath);
  const newFull = path.resolve(folderPath, newRelPath);
  const rootResolved = path.resolve(folderPath);
  if (!oldFull.startsWith(rootResolved + path.sep) && oldFull !== rootResolved) {
    return { ok: false, error: 'old_outside_workspace' };
  }
  if (!newFull.startsWith(rootResolved + path.sep) && newFull !== rootResolved) {
    return { ok: false, error: 'new_outside_workspace' };
  }
  try {
    await fs.access(oldFull);
  } catch {
    return { ok: false, error: 'source_not_found' };
  }
  try {
    await fs.access(newFull);
    return { ok: false, error: 'target_exists' };
  } catch {
    // good — target doesn't exist
  }
  try {
    await fs.mkdir(path.dirname(newFull), { recursive: true });
    await fs.rename(oldFull, newFull);
    return { ok: true, oldPath: oldRelPath, newPath: newRelPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Delete a file or folder (recursive for folders) within the workspace.
ipcMain.handle('fs:delete', async (_event, folderPath, relPath) => {
  if (!folderPath || !relPath) return { ok: false, error: 'missing_args' };
  const full = path.resolve(folderPath, relPath);
  const rootResolved = path.resolve(folderPath);
  if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) {
    return { ok: false, error: 'outside_workspace' };
  }
  try {
    await fs.access(full);
  } catch {
    return { ok: false, error: 'not_found' };
  }
  try {
    const stat = await fs.lstat(full);
    if (stat.isDirectory()) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await fs.unlink(full);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Search file CONTENTS across the workspace (Cmd+Shift+F / "Search in Files").
// Returns matches grouped by file. Uses ripgrep via /usr/bin/grep -rn as a
// fallback so we don't need a new dependency. Skips node_modules, .git,
// .farnsworth, dist, build, coverage by default. Caps results at 500 to
// keep the renderer's overlay responsive.
//
// Args:
//   folderPath — workspace root
//   query      — substring to search (regex if opts.regex)
//   opts       — { regex?: bool, caseSensitive?: bool, includeGlobs?: string[], maxResults?: number }
ipcMain.handle('fs:grepWorkspace', async (_event, folderPath, query, opts = {}) => {
  if (!folderPath || !query) return { ok: false, error: 'missing_args' };
  const maxResults = opts.maxResults || 500;
  const caseFlag = opts.caseSensitive ? '' : '-i';
  const excludeDirs = ['--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=.farnsworth', '--exclude-dir=dist', '--exclude-dir=build', '--exclude-dir=coverage'];
  const includeArgs = (opts.includeGlobs || []).flatMap(g => ['--include', g]);
  const useRegex = opts.regex ? '-E' : '-F';
  // -n line numbers, -H file paths, --null prints path\0line\0text for safe parsing of any content
  const args = ['-rnH', '--null', caseFlag, useRegex, ...excludeDirs, ...includeArgs, '-e', query, folderPath];
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      child_process.execFile('/usr/bin/grep', args, { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        // grep exit code 1 = no matches (not an error)
        if (err && err.code === 1) return resolve({ stdout: '' });
        if (err) return reject(err);
        resolve({ stdout, stderr });
      });
    });
    if (!stdout) return { ok: true, matches: [], files: 0 };
    // Parse records. GNU grep with --null produces: path\0line:content\n
    // (one NUL after the file name, then "line:content" up to the newline).
    // Split on newline first to get records, then split each on \0 to peel
    // the path off, then split the remainder on ":" once to get line + text.
    const records = stdout.split('\n').filter(Boolean);
    const matches = [];
    const files = new Set();
    for (const rec of records) {
      if (matches.length >= maxResults) break;
      const nullIdx = rec.indexOf('\0');
      if (nullIdx < 0) continue;
      const fullPath = rec.slice(0, nullIdx);
      const rest = rec.slice(nullIdx + 1);
      const colonIdx = rest.indexOf(':');
      const lineNum = colonIdx >= 0 ? rest.slice(0, colonIdx) : '0';
      const lineText = colonIdx >= 0 ? rest.slice(colonIdx + 1) : rest;
      const rel = fullPath.startsWith(folderPath) ? fullPath.slice(folderPath.length + 1) : fullPath;
      files.add(rel);
      matches.push({ file_path: rel, line_number: parseInt(lineNum, 10), line_text: lineText });
    }
    return { ok: true, matches, files: files.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Flat file list for the Quick Open overlay (Cmd+Shift+P). Returns every
// file path under the workspace, relative to folderPath. Skips the usual
// noise (node_modules, .git, dist, build, .farnsworth, coverage) and any
// hidden file/dir. Caps at 20k entries to keep the renderer responsive
// for huge repos.
//
// Args:
//   folderPath — workspace root
//   opts       — { maxDepth?: number, includeHidden?: bool, maxEntries?: number }
ipcMain.handle('fs:listFiles', async (_event, folderPath, opts = {}) => {
  if (!folderPath) return { ok: false, error: 'missing_args' };
  const maxDepth = opts.maxDepth || 8;
  const maxEntries = opts.maxEntries || 20000;
  const skipDirs = new Set(['node_modules', '.git', '.farnsworth', 'dist', 'build', 'coverage', '.next', '.cache', '.DS_Store']);
  const files = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxEntries) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (files.length >= maxEntries) { truncated = true; return; }
      if (ent.name.startsWith('.') && ent.name !== '.env' && !opts.includeHidden) continue;
      if (skipDirs.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = full.startsWith(folderPath) ? full.slice(folderPath.length + 1) : full;
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        files.push(rel);
      }
    }
  }
  try {
    await walk(folderPath, 0);
    return { ok: true, files, count: files.length, truncated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ============================================================
// IPC: Auth — manual API keys (anthropic-console + openai-api providers)
// Provider param added Jul 14 for the OpenAI section; omitted = anthropic
// so every pre-existing caller keeps working unchanged.
// ============================================================
const API_KEY_PROVIDERS = ['anthropic-console', 'openai-api'];
function apiKeyProvider(p) {
  return API_KEY_PROVIDERS.includes(p) ? p : 'anthropic-console';
}

ipcMain.handle('auth:setApiKey', async (_event, key, provider) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Encryption not available on this system' };
    }
    db.setAuthToken(apiKeyProvider(provider), key, null, null, { source: 'api_key' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:hasApiKey', async (_event, provider) => {
  const t = db.getAuthToken(apiKeyProvider(provider));
  return { ok: true, hasKey: !!(t && t.accessToken) };
});

ipcMain.handle('auth:clearApiKey', async (_event, provider) => {
  db.deleteAuthToken(apiKeyProvider(provider));
  return { ok: true };
});

// Codex CLI login detection (~/.codex/auth.json). Read-only, same idea as
// the Claude Code CLI Keychain detection: Farnsworth reports what the CLI
// already stored. auth.json shapes seen in the wild: { OPENAI_API_KEY }
// (API-key login) or { tokens: { id_token, access_token, account_id } }
// (ChatGPT-subscription login).
ipcMain.handle('auth:codexStatus', async () => {
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fsSync.existsSync(p)) return { ok: true, available: false };
    const raw = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    const method = raw?.tokens?.access_token ? 'chatgpt'
      : (raw?.OPENAI_API_KEY ? 'api_key' : null);
    return { ok: true, available: !!method, method };
  } catch (err) {
    return { ok: true, available: false, error: err.message };
  }
});

// ============================================================
// IPC: Auth — Claude.ai OAuth (PKCE)
// ============================================================
//
// Flow (Jun 25 ~17:35 ET rewrite to use loopback redirect):
//   1. User clicks "Sign in with Claude.ai" in Settings → AI
//   2. Renderer calls auth:oauthStart → main generates PKCE + spins up localhost HTTP server
//   3. Main opens browser to claude.com with redirect_uri=http://localhost:PORT/callback
//   4. User logs in and approves on claude.ai
//   5. Anthropic redirects browser to our localhost server with ?code=...&state=...
//   6. Our server captures the code, closes itself, auto-exchanges code for token
//   7. Token stored encrypted in SQLite, success page shown to user
//
// Why loopback: Claude Code CLI uses `http://localhost:PORT/callback` (confirmed via strings dump of
// `/opt/homebrew/bin/claude` Jun 25 ~17:35 ET). Anthropic's OAuth server validates the redirect_uri
// against what's registered for the client_id, and `https://platform.claude.com/oauth/code/callback`
// is NOT registered for `9d1c250a-e61b-44d9-88ed-5944d1962f5e` — server returns
// "Invalid request format" at authorization. The code-paste path (auth:oauthComplete) is kept as a
// fallback if loopback fails.
//
// Tokens are refreshed automatically via auth:oauthRefresh (called when access token nears expiry)

const OAUTH_LOOPBACK_PORTS = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];

async function pickFreePort() {
  const net = require('net');
  for (const port of OAUTH_LOOPBACK_PORTS) {
    const ok = await new Promise((resolve) => {
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => tester.close(() => resolve(true)))
        .listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error('No free loopback port in ' + OAUTH_LOOPBACK_PORTS.join(','));
}

function startOAuthCallbackServer(port, expectedState, onCode) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDesc = url.searchParams.get('error_description');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:-apple-system,sans-serif;padding:40px;background:#1e1f22;color:#fff;">
          <h2>Sign-in failed</h2>
          <p>${error}: ${errorDesc || 'unknown error'}</p>
          <p style="color:#888">You can close this window.</p>
        </body></html>`);
        server.close();
        reject(new Error(`${error}: ${errorDesc || ''}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>State mismatch</h2></body></html>`);
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      if (!code) {
        res.writeHead(400).end('Missing code');
        server.close();
        reject(new Error('Missing code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:-apple-system,sans-serif;padding:40px;background:#1e1f22;color:#fff;">
        <h2>Signed in to Farnsworth</h2>
        <p>You can close this window and return to Farnsworth.</p>
        <script>setTimeout(() => window.close(), 1500);</script>
      </body></html>`);
      server.close();
      onCode(code, state);
      resolve({ code, state });
    });

    server.listen(port, '127.0.0.1', () => {});
    server.on('error', reject);
  });
}

ipcMain.handle('auth:oauthStart', async () => {
  try {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    const redirectUri = OAUTH_REDIRECT_URI;

    db.putOAuthState(state, codeVerifier, redirectUri);

    const authUrl = new URL(OAUTH_AUTH_URL);
    authUrl.searchParams.set('code', 'true');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('scope', OAUTH_SCOPES);
    authUrl.searchParams.set('state', state);

    await openExternalSafe(authUrl.toString());

    return {
      ok: true,
      authUrl: authUrl.toString(),
      state,
      instructions: `Browser opened. After approving on claude.ai, the platform.claude.com/oauth/code/callback page will show a code in the format <48chars>#<fragment>. Copy just the 48 characters before the # and paste into Farnsworth to finish sign-in.`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:oauthWaitForCallback', async (_event, state) => {
  try {
    const oauthState = db.getOAuthState(state);
    if (!oauthState) {
      return { ok: false, error: 'OAuth session not found or expired.' };
    }
    const m = oauthState.redirect_uri.match(/localhost:(\d+)/);
    if (!m) {
      return { ok: false, error: 'OAuth state has no loopback port — must use auth:oauthComplete manually.' };
    }
    const port = parseInt(m[1], 10);

    const { code } = await startOAuthCallbackServer(port, state, () => {});

    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OAUTH_CLIENT_ID,
        code,
        state,
        code_verifier: oauthState.code_verifier,
        redirect_uri: oauthState.redirect_uri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      db.cleanupOAuthState();
      return { ok: false, error: `Token exchange failed (${tokenRes.status}): ${text}` };
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    if (!accessToken) {
      db.cleanupOAuthState();
      return { ok: false, error: 'No access_token in response: ' + JSON.stringify(tokenData) };
    }

    let accountInfo = null;
    try {
      const rolesRes = await fetch('https://api.anthropic.com/api/oauth/claude_cli/roles', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        },
      });
      if (rolesRes.ok) {
        const roles = await rolesRes.json();
        accountInfo = { source: 'oauth', scopes: tokenData.scope, roles };
      }
    } catch {}

    if (!accountInfo) accountInfo = { source: 'oauth', scopes: tokenData.scope };

    db.cleanupOAuthState();
    db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, accountInfo);

    return { ok: true, provider: 'anthropic-claudeai', expiresAt, accountInfo };
  } catch (err) {
    db.cleanupOAuthState();
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:oauthComplete', async (_event, codeWithState, state) => {
  try {
    db.cleanupOAuthState();
    const oauthState = db.consumeOAuthState(state);
    if (!oauthState) {
      return { ok: false, error: 'OAuth session expired or invalid state. Please start over.' };
    }

    // User pastes either just the code, or `CODE#STATE` (the format the
    // console.anthropic.com/oauth/code/callback page displays).
    // If state was provided in the paste, use it (it's the same value we sent
    // in the authorize URL -- the page echoes it back so the user can paste it).
    // Otherwise fall back to the state we generated server-side.
    const [code, pastedState] = String(codeWithState).split('#');
    const exchangeState = pastedState || state;

    // Exchange code for token. JSON body (per ben-vargas gist), not form-urlencoded.
    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: OAUTH_CLIENT_ID,
        code,
        state: exchangeState,
        code_verifier: oauthState.code_verifier,
        redirect_uri: oauthState.redirect_uri,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return { ok: false, error: `Token exchange failed (${tokenRes.status}): ${text}` };
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    if (!accessToken) {
      return { ok: false, error: 'No access_token in response: ' + JSON.stringify(tokenData) };
    }

    // Try to fetch account info (email + tier) by hitting /v1/oauth/claude_cli/roles or similar
    let accountInfo = null;
    try {
      const rolesRes = await fetch('https://api.anthropic.com/api/oauth/claude_cli/roles', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        },
      });
      if (rolesRes.ok) {
        const roles = await rolesRes.json();
        accountInfo = {
          source: 'oauth',
          scopes: tokenData.scope,
          roles: roles,
        };
      }
    } catch {}

    if (!accountInfo) {
      accountInfo = { source: 'oauth', scopes: tokenData.scope };
    }

    db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, accountInfo);

    return {
      ok: true,
      provider: 'anthropic-claudeai',
      expiresAt,
      accountInfo,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:oauthRefresh', async () => {
  try {
    const t = db.getAuthToken('anthropic-claudeai');
    if (!t || !t.refreshToken) {
      return { ok: false, error: 'No refresh token available' };
    }
    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: t.refreshToken,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return { ok: false, error: `Refresh failed (${tokenRes.status}): ${text}` };
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || t.refreshToken;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, t.accountInfo);
    return { ok: true, expiresAt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:oauthStatus', async () => {
  const t = db.getAuthToken('anthropic-claudeai');
  if (!t) return { ok: true, connected: false };
  const now = new Date();
  const expiresAt = t.expiresAt ? new Date(t.expiresAt) : null;
  const expiresInSec = expiresAt ? Math.floor((expiresAt - now) / 1000) : null;
  return {
    ok: true,
    connected: true,
    expiresAt: t.expiresAt,
    expiresInSec,
    accountInfo: t.accountInfo,
  };
});

ipcMain.handle('auth:oauthDisconnect', async () => {
  db.deleteAuthToken('anthropic-claudeai');
  return { ok: true };
});

// Import OAuth tokens from Claude Code CLI's macOS Keychain entry. This is a
// workaround for when claude.ai/v1/oauth/{org}/authorize mutationFn is broken
// (returns 400 "Invalid request format" for every body shape, including the
// exact body the page itself sends). The Keychain entry "Claude Code-credentials"
// contains a JSON blob with accessToken, refreshToken, expiresAt, scopes
// written by Claude Code CLI on successful login.
// Read Claude Code CLI's OAuth credentials from the OS credential store.
// Cross-platform via keytar — Mac Keychain / Windows Credential Manager /
// Linux libsecret. Falls back to shelling `security` on Mac if keytar's
// native binary isn't loaded (e.g. running outside an Electron-rebuilt env).
//
// The blob Claude Code CLI writes is the same on every platform:
//   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, scopes, ... } }
ipcMain.handle('auth:importFromKeychain', async () => {
  let blob = null;
  let source = 'keytar';

  // 1) Try keytar (cross-platform — preferred path)
  try {
    const keytar = require('keytar');
    const pw = await keytar.getPassword('Claude Code-credentials');
    if (pw) blob = pw;
  } catch (e) {
    // keytar native binary missing or load failed — fall through to Mac shell
    console.warn('[auth] keytar read failed: ' + (e?.message || e) + ' — trying Mac security CLI fallback');
  }

  // 2) Mac shell fallback — same entry the CLI writes to Keychain
  if (!blob && process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      blob = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      source = 'security-cli';
    } catch (e) {
      // ignore — fall through to "not found" error
    }
  }

  if (!blob) {
    return {
      ok: false,
      error: 'no_credentials',
      message: 'No Claude Code credentials found in the OS credential store. Sign in once via Claude Code CLI first (run `claude auth login` in Terminal), then click Import again.',
    };
  }

  let creds;
  try {
    creds = JSON.parse(blob);
  } catch (e) {
    return { ok: false, error: 'parse_failed', message: 'Credential store blob is not valid JSON: ' + e.message };
  }
  const oauth = creds.claudeAiOauth || creds;
  const accessToken = oauth.accessToken || oauth.access_token;
  const refreshToken = oauth.refreshToken || oauth.refresh_token;
  const expiresAt = oauth.expiresAt
    ? new Date(oauth.expiresAt).toISOString()
    : new Date(Date.now() + 3600 * 1000).toISOString();
  if (!accessToken) {
    return { ok: false, error: 'no_access_token', message: 'No accessToken in credential blob: ' + JSON.stringify(creds).slice(0, 200) };
  }
  const accountInfo = {
    source: 'oauth',
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    importedFrom: 'claude-code-cli-' + source,
  };
  db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, accountInfo);
  return {
    ok: true,
    expiresAt,
    accountInfo,
    scopes: oauth.scopes,
    expiresInSec: Math.floor((new Date(expiresAt) - new Date()) / 1000),
    source,
  };
});

// Spawn `claude login` as a child process. The CLI opens the browser to
// claude.ai/oauth/authorize, captures the local-loopback callback itself,
// exchanges the code for tokens, and writes them to the OS credential store.
// After the child exits (success or failure), we read the freshly-written
// credential store entry via the same keychain-import path as the manual
// Import button.
//
// Cross-platform: uses `which`/`where` first, then common install paths.
ipcMain.handle('auth:runClaudeLogin', async () => {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // 1) Find the `claude` binary (bundled Resources/bin/claude first, Jul 7 ~21:02 ET).
  const claudePath = findClaudePath();
  if (!claudePath) {
    return {
      ok: false,
      error: 'claude_not_found',
      message: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code — then click this button again.',
    };
  }

  // 2) Spawn `claude login`. stdio: 'ignore' keeps the main-process terminal
  // quiet; the user sees the browser open as the visible signal. The CLI
  // captures its own local-loopback callback, so we just wait for exit.
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudePath, ['login'], { stdio: 'ignore', detached: false });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed', message: 'Failed to spawn `claude login`: ' + e.message });
    }

    // 5-minute cap — covers the typical browser-authorize flow plus margin.
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: 'timeout', message: '`claude login` timed out after 5 minutes. Try again or run `claude login` in a terminal yourself.' });
    }, 5 * 60 * 1000);

    child.on('exit', async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return resolve({ ok: false, error: 'claude_login_failed', message: '`claude login` exited with code ' + code + '. Try again or run `claude login` in a terminal.' });
      }
      // claude login wrote a fresh entry to the OS credential store.
      // Re-read it via the same path as auth:importFromKeychain so the
      // renderer doesn't need to call two IPCs in sequence.
      const result = await importFromKeychainCore();
      if (result.ok) result.claudeLoginRan = true;
      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: 'spawn_failed', message: '`claude login` child error: ' + err.message });
    });
  });
});

// Reusable: read Claude Code CLI's OAuth blob from the OS credential store
// and write to auth_tokens. Called by both auth:importFromKeychain (manual
// button) AND auth:runClaudeLogin (after the child process exits) so the
// read/parse/persist logic lives in one place.
async function importFromKeychainCore() {
  let blob = null;
  let source = 'keytar';

  // 1) Try keytar (cross-platform — preferred path)
  try {
    const keytar = require('keytar');
    const pw = await keytar.getPassword('Claude Code-credentials');
    if (pw) blob = pw;
  } catch (e) {
    console.warn('[auth] keytar read failed: ' + (e?.message || e) + ' — trying Mac security CLI fallback');
  }

  // 2) Mac shell fallback — same entry the CLI writes to Keychain
  if (!blob && process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      blob = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      source = 'security-cli';
    } catch (e) {
      // ignore — fall through to "not found" error
    }
  }

  if (!blob) {
    return {
      ok: false,
      error: 'no_credentials',
      message: 'No Claude Code credentials found in the OS credential store. Sign in once via Claude Code CLI first (run `claude login` in Terminal), then click Import again.',
    };
  }

  let creds;
  try {
    creds = JSON.parse(blob);
  } catch (e) {
    return { ok: false, error: 'parse_failed', message: 'Credential store blob is not valid JSON: ' + e.message };
  }
  const oauth = creds.claudeAiOauth || creds;
  const accessToken = oauth.accessToken || oauth.access_token;
  const refreshToken = oauth.refreshToken || oauth.refresh_token;
  const expiresAt = oauth.expiresAt
    ? new Date(oauth.expiresAt).toISOString()
    : new Date(Date.now() + 3600 * 1000).toISOString();
  if (!accessToken) {
    return { ok: false, error: 'no_access_token', message: 'No accessToken in credential blob: ' + JSON.stringify(creds).slice(0, 200) };
  }
  const accountInfo = {
    source: 'oauth',
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    importedFrom: 'claude-code-cli-' + source,
  };
  db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, accountInfo);
  return {
    ok: true,
    expiresAt,
    accountInfo,
    scopes: oauth.scopes,
    expiresInSec: Math.floor((new Date(expiresAt) - new Date()) / 1000),
    source,
  };
}

// Re-store Farnsworth's current auth_tokens row back to the OS credential
// store so Claude Code CLI sees the same entry (and so a Farnsworth restart
// on Windows/Linux doesn't need a fresh `claude auth login`).
// Cross-platform via keytar. Mac fallback to `security` if keytar isn't loaded.
ipcMain.handle('auth:reStoreToKeychain', async () => {
  const t = db.getAuthToken('anthropic-claudeai');
  if (!t || !t.accessToken || !t.refreshToken) {
    return { ok: false, error: 'no_token', message: 'No Farnsworth auth_tokens row to re-store. Import from Claude Code CLI first.' };
  }
  const blob = {
    claudeAiOauth: {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt ? new Date(t.expiresAt).getTime() : Date.now() + 3600 * 1000,
      scopes: t.accountInfo?.scopes || ['user:file_upload', 'user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: t.accountInfo?.subscriptionType || 'unknown',
      rateLimitTier: t.accountInfo?.rateLimitTier || 'unknown',
    },
  };
  const payload = JSON.stringify(blob);

  // 1) keytar first (cross-platform)
  try {
    const keytar = require('keytar');
    await keytar.setPassword('Claude Code-credentials', 'Claude Code', payload);
    return { ok: true, source: 'keytar' };
  } catch (e) {
    console.warn('[auth] keytar write failed: ' + (e?.message || e) + ' — trying Mac security CLI fallback');
  }

  // 2) Mac shell fallback
  if (process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      // Delete-then-add avoids "already exists" failures when overwriting.
      try { execSync('security delete-generic-password -s "Claude Code-credentials"', { encoding: 'utf8', timeout: 5000 }); } catch {}
      execSync(
        'security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w ' +
          "'" + payload.replace(/'/g, "'\\''") + "'",
        { encoding: 'utf8', timeout: 5000, shell: true }
      );
      return { ok: true, source: 'security-cli' };
    } catch (e) {
      return { ok: false, error: 'write_failed', message: 'Mac security CLI re-store failed: ' + e.message };
    }
  }

  return { ok: false, error: 'write_failed', message: 'keytar write failed and no Mac fallback available' };
});

// ============================================================
// IPC: Claude Code detection (legacy)
// ============================================================

// ============================================================
// IPC: Claude Code detection
// ============================================================
// On macOS, the `claude` CLI stores its OAuth tokens in the Keychain
// (`Claude Code-credentials`), not in `~/.claude/.credentials.json` (which
// is the Linux/Windows path). Long hit this when the left Claude Code
// panel showed "signed in" but Settings → AI still prompted to sign in.
// Check Keychain first, fall back to the file path for non-mac platforms.
ipcMain.handle('auth:checkClaudeCode', async () => {
  const { execSync } = require('child_process');

  // macOS: read Keychain entry "Claude Code-credentials" (same as the
  // working claudeCode:checkAuth handler below).
  if (process.platform === 'darwin') {
    try {
      const out = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (out && out.startsWith('{')) {
        const blob = JSON.parse(out);
        const oauth = blob.claudeAiOauth || blob;
        if (oauth.accessToken) {
          return {
            ok: true,
            hasAuth: true,
            source: 'keychain',
            subscriptionType: oauth.subscriptionType || null,
            expiresAt: oauth.expiresAt || null,
          };
        }
      }
      return { ok: true, hasAuth: false, source: 'keychain_empty' };
    } catch {
      // Keychain lookup failed (no entry, denied, etc.) — fall through
      // to file-path check in case Long has both.
    }
  }

  // Linux / Windows: read ~/.claude/.credentials.json.
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(raw);
    return {
      ok: true,
      hasAuth: !!(creds.claudeAiOauth || creds.accessToken),
      source: 'file',
    };
  } catch {
    return { ok: true, hasAuth: false, source: 'none' };
  }
});

// ============================================================
// ============================================================
// Agent Tools (Phase 4)
// ============================================================
//
// Tools the renderer can pass to inference:send so Claude can read/write files,
// list the workspace, and run shell commands. Each tool delegates to the
// existing fs:* IPC handlers — same validation, same paths.

const AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Path is relative to the workspace folder.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path (e.g. "src/app.js" or "README.md")' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace (overwrites existing; creates parent dirs as needed). Path is relative to the workspace folder.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        content: { type: 'string', description: 'Full file contents to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories in the workspace. Optionally filter by glob pattern (e.g. "*.js", "src/**"). Returns paths relative to workspace folder.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional glob pattern to filter results' }
      }
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace directory. Returns stdout, stderr, and exit code. Timeout 30s.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g. "ls -la", "node -v")' }
      },
      required: ['command']
    }
  },
  {
    // Renderer-side tool — Claude emits this to render an inline UI surface
    // (step progress card, choice buttons, form, copy block, work-result
    // receipt, etc.) inside the chat stream. The renderer intercepts this
    // name in sendChatMessage() before the real tool loop runs, so it never
    // reaches executeAgentTool. We still include it in AGENT_TOOLS so the
    // model knows it exists and knows the input shapes.
    //
    // Surfaces are atomic when emitted except task_progress + work_result
    // which support streaming updates via surfaceId (re-emit with the same
    // surfaceId to flip step states or accumulate sections in place).
    name: 'ui_show',
    description: 'Render an inline UI surface in the chat stream. Use this to show step-by-step progress, ask the user for a choice, capture form input, show a copyable command, or emit a work-result receipt after completing work. The surface renders inline in the chat and remains until dismissed by the user or replaced by a new emit with the same surfaceId.',
    input_schema: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'Stable id for streaming updates. Required for task_progress + work_result. Other surfaces can omit.' },
        surfaceType: {
          type: 'string',
          enum: ['card', 'choice', 'confirmation', 'form', 'copy_block', 'work_result', 'credential', 'oauth_connect'],
          description: 'The surface shape to render.'
        },
        data: { type: 'object', description: 'Surface-specific payload. Shape depends on surfaceType — see UI-SURFACES.md.' }
      },
      required: ['surfaceType', 'data'],
      additionalProperties: false
    }
  },
  // -------------------------------------------------------------------
  // Test View tools — chat agent can navigate to Test View, list/read/save
  // tests, and run them. The chat agent's system prompt references
  // DEVVIT-TESTS.md which documents the test JSON format. All tools use the
  // active workspace folder (set via handleFolderPicked → state.folder);
  // open_testview switches the canvas to Test View so the user can see the
  // results. Added Jul 11 ~18:50 ET.
  // -------------------------------------------------------------------
  {
    name: 'test_list',
    description: 'List all JSON tests in the active workspace\'s .farnsworth/devvit-tests/ folder. Returns names, absolute paths, sizes, and modification times. Use this first to see what tests exist before creating, editing, or running one. Requires an open workspace folder.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'test_read',
    description: 'Read a test JSON file from the active workspace\'s .farnsworth/devvit-tests/ folder. Returns the raw JSON string (not parsed) so the editor can preserve formatting. Use this before editing a test to load its current contents.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Test name without .json extension (e.g. "play-tab"). Whitespace becomes dashes.' }
      },
      required: ['name']
    }
  },
  {
    name: 'test_save',
    description: 'Save a test JSON file to the active workspace\'s .farnsworth/devvit-tests/ folder. JSON is validated before writing. The name is normalized to lowercase-dashes (e.g. "My Test!" → "my-test"). See DEVVIT-TESTS.md for the test format.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Test name (will be normalized to lowercase-dashes)' },
        json: { type: 'string', description: 'Full test JSON as a string (will be validated)' }
      },
      required: ['name', 'json']
    }
  },
  {
    name: 'test_run',
    description: 'Run a test against the canvas WebContentsView. Takes the test\'s ABSOLUTE file path (not a name) — get it from test_list or test_save results. Returns stdout/stderr (last 4000/2000 chars), exit code, and a `failed` count parsed from the runner output.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the test JSON file (e.g. /Users/long/Documents/lastdraft/the-last-draft/.farnsworth/devvit-tests/play-tab.json)' }
      },
      required: ['path']
    }
  },
  {
    name: 'open_testview',
    description: 'Navigate the canvas preview to Test View so the user can see the test runner panel. Use this BEFORE test_list / test_save / test_run when the user asks anything about tests — they expect to see Test View, not the Post View. Auto-switches the canvas mode to live if needed. No-op if the canvas is already in Test View.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'memory_recall',
    description: 'Search Farnsworth\'s long-term memory: concept articles, article sections, essentials, unfiled buffer facts, past conversations, and the indexed codebase. Use when the user references something from a previous session that isn\'t in this conversation (a past decision, an earlier chat, project history).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for — topic, decision, name, or phrase' }
      },
      required: ['query']
    }
  }
];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

async function executeAgentTool(name, input) {
  // memory_recall works without a workspace folder — it searches the
  // assistant's own store, not the project.
  if (name === 'memory_recall') {
    const q = String(input?.query || '').trim();
    if (!q) return { ok: false, error: 'bad_input', message: 'query required' };
    const res = await db.memoryRecall(q, 8);
    const fmt = [];
    if (res.essentials?.length) fmt.push('essentials:\n' + res.essentials.map(e => `- ${e.key}: ${e.value}`).join('\n'));
    if (res.concepts?.length) fmt.push('concepts:\n' + res.concepts.map(c => `- ${c.slug}: ${String(c.lead || c.title || '').slice(0, 200)}`).join('\n'));
    if (res.sections?.length) fmt.push('sections:\n' + res.sections.map(s => `- ${s.slug} § ${s.heading}: ${String(s.content || '').slice(0, 300)}`).join('\n'));
    if (res.conversations?.length) fmt.push('past conversations:\n' + res.conversations.map(c => `- "${c.title}": ${c.snippet}`).join('\n'));
    if (res.buffer?.length) fmt.push('recent unfiled facts:\n' + res.buffer.map(b => `- ${String(b.content).slice(0, 160)}`).join('\n'));
    if (res.code?.length) fmt.push('code index:\n' + res.code.map(c => `- ${c.path || c.file || '?'}: ${String(c.content || '').slice(0, 120)}`).join('\n'));
    return { ok: true, result: fmt.join('\n\n') || 'No memory matches for that query.' };
  }

  const folder = db.getSetting('currentFolder');
  if (!folder) {
    return { ok: false, error: 'no_folder', message: 'No workspace folder open. Open a folder first.' };
  }
  if (name === 'read_file') {
    if (!input?.path || typeof input.path !== 'string') return { ok: false, error: 'bad_input', message: 'path required' };
    if (input.path.includes('..')) return { ok: false, error: 'bad_input', message: 'path cannot contain ..' };
    const res = await fs.readFile(path.join(folder, input.path), 'utf8');
    return { ok: true, content: res.toString(), path: input.path };
  }
  if (name === 'write_file') {
    if (!input?.path || typeof input.path !== 'string') return { ok: false, error: 'bad_input', message: 'path required' };
    if (input.path.includes('..')) return { ok: false, error: 'bad_input', message: 'path cannot contain ..' };
    if (typeof input.content !== 'string') return { ok: false, error: 'bad_input', message: 'content required' };
    const full = path.join(folder, input.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, input.content, 'utf8');
    return { ok: true, message: `Wrote ${input.path} (${input.content.length} chars)`, path: input.path };
  }
  if (name === 'list_files') {
    const entries = await readDirRecursive(folder, 4);
    let filtered = entries.filter(e => !e.path.startsWith('.') && !e.path.includes('node_modules'));
    if (input?.pattern) {
      const re = globToRegex(input.pattern);
      filtered = filtered.filter(e => re.test(e.path) || re.test(e.name));
    }
    return { ok: true, files: filtered.slice(0, 200).map(e => ({ path: e.path, type: e.type })) };
  }
  if (name === 'run_command') {
    // Chat-agent commands run silently in exec() — no PTY write, no panel
    // switch. The agent already has the captured output and the chat chip
    // renders it inline. Re-executing via the active PTY would be a side-
    // effect hazard for commands like `npm install`, `git commit`, etc.
    // Jul 13 ~17:35 ET: also wrap in nono Seatbelt via farnsworth-chat-run
    // profile so a prompt-injected agent can't read ~/.aws/credentials
    // or write outside the workspace folder. Falls back to plain exec
    // (with a console warning) if nono isn't installed.
    return await runShellCommand(input.command, {
      pipeToActiveTerminal: false,
      sandboxProfile: 'farnsworth-chat-run',
    });
  }
  // -------------------------------------------------------------------
  // Test View tools (Jul 11 ~18:50 ET) — wire the chat agent to the
  // existing test:* IPCs + canvas:setPreview. Each handler calls the
  // exact same logic as the IPC handler so behavior stays consistent.
  // -------------------------------------------------------------------
  if (name === 'test_list') {
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', message: 'No workspace folder open. Open a folder first.' };
    try {
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const tests = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        tests.push({
          name: entry.name.replace(/\.json$/i, ''),
          path: filePath,
          size: stat.size,
          modified: stat.mtimeMs,
        });
      }
      tests.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, tests, dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (name === 'test_read') {
    if (!input?.name || typeof input.name !== 'string') return { ok: false, error: 'missing_name' };
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', message: 'No workspace folder open. Open a folder first.' };
    const safeName = input.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (!safeName) return { ok: false, error: 'invalid_name' };
    const filePath = path.join(dir, `${safeName}.json`);
    try {
      const json = await fs.readFile(filePath, 'utf8');
      return { ok: true, name: safeName, path: filePath, json };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: false, error: 'not_found', name: safeName };
      return { ok: false, error: e.message };
    }
  }
  if (name === 'test_save') {
    if (!input?.name || typeof input.name !== 'string') return { ok: false, error: 'missing_name' };
    if (!input?.json || typeof input.json !== 'string') return { ok: false, error: 'missing_json' };
    const dir = resolveTestScriptsDir(folder);
    if (!dir) return { ok: false, error: 'no_folder', message: 'No workspace folder open. Open a folder first.' };
    try { JSON.parse(input.json); } catch (e) {
      return { ok: false, error: 'invalid_json', message: e.message };
    }
    const safeName = input.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    if (!safeName) return { ok: false, error: 'invalid_name' };
    const filePath = path.join(dir, `${safeName}.json`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, input.json + '\n', 'utf8');
    return { ok: true, name: safeName, path: filePath };
  }
  if (name === 'test_run') {
    if (!input?.path || typeof input.path !== 'string') return { ok: false, error: 'missing_path' };
    if (!fsSync.existsSync(input.path)) return { ok: false, error: 'not_found', path: input.path };
    const { spawn } = require('child_process');
    // Same auth injection as the test:run IPC — llm-step direct-API fast path.
    const llmAuth = await getValidAccessToken().catch(() => null);
    const runnerEnv = { ...process.env };
    if (llmAuth && llmAuth.token) {
      runnerEnv.FARNSWORTH_AUTH_TOKEN = llmAuth.token;
      runnerEnv.FARNSWORTH_AUTH_KIND = llmAuth.kind || 'api_key';
    }
    const testModel = testingModelApiId();
    if (testModel) runnerEnv.FARNSWORTH_TEST_MODEL = testModel;
    return await new Promise((resolve) => {
      const proc = spawn('python3', [TEST_RUNNER_PATH, input.path], {
        cwd: app.getAppPath(),
        env: runnerEnv,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        const failedMatch = stdout.match(/(\d+)\s+failed/);
        const failed = failedMatch ? Number(failedMatch[1]) : 0;
        resolve({
          ok: code === 0 && failed === 0,
          code,
          failed,
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-2000),
        });
      });
      proc.on('error', err => {
        resolve({ ok: false, error: err.message });
      });
    });
  }
  if (name === 'open_testview') {
    // Switch canvas to Test View. Auto-switches the canvas mode to live
    // if needed (so the preview actually renders). No-op if already on
    // testview but we still send the IPC so the renderer can refresh.
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    target.webContents.send('canvas:setPreview', { preview: 'testview' });
    return { ok: true, preview: 'testview' };
  }
  if (name === 'ui_show') {
    // Renderer-side tool. The renderer's sendChatMessage() stream handler
    // intercepts this BEFORE calling executeTool (see src/app.js), so this
    // branch is a safety net for the case where someone calls the IPC
    // directly. Returns ok + kind: 'surface' so callers can detect it.
    return { ok: true, kind: 'surface', surfaceType: input?.surfaceType, data: input?.data };
  }
  return { ok: false, error: 'unknown_tool', message: `Unknown tool: ${name}` };
}

// ============================================================
// IPC: Inference (call Claude API with saved OAuth token or manual API key)
// ============================================================
async function getValidAccessToken() {
  // Try OAuth first
  const oauth = db.getAuthToken('anthropic-claudeai');
  if (oauth && oauth.accessToken) {
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;
    const expired = expiresAt && expiresAt < Date.now() + 60_000;
    if (expired && oauth.refreshToken) {
      // Refresh via the same flow the oauthRefresh handler uses.
      // 15s AbortController timeout — if claude.ai's OAuth endpoint hangs
      // (rate limit, network, revoked refresh token), bail out so the
      // inference call can fall through to the API-key path instead of
      // leaving the renderer stuck on "Thinking...".
      const refreshController = new AbortController();
      const refreshTimeout = setTimeout(() => refreshController.abort(), 15_000);
      try {
        const tokenRes = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: OAUTH_CLIENT_ID,
            refresh_token: oauth.refreshToken,
          }).toString(),
          signal: refreshController.signal,
        });
        clearTimeout(refreshTimeout);
        if (tokenRes.ok) {
          const data = await tokenRes.json();
          const accessToken = data.access_token;
          const refreshToken = data.refresh_token || oauth.refreshToken;
          const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
          db.setAuthToken('anthropic-claudeai', accessToken, refreshToken, expiresAt, oauth.accountInfo);
          return { kind: 'oauth', token: accessToken, accountInfo: oauth.accountInfo };
        }
        // Log non-2xx so silent failures are visible. Falls through to API-key path.
        const errText = await tokenRes.text().catch(() => '');
        console.error('[auth] OAuth refresh returned ' + tokenRes.status + ': ' + errText.slice(0, 200));
      } catch (e) {
        clearTimeout(refreshTimeout);
        console.error('[auth] OAuth refresh threw: ' + (e?.name || '') + ' ' + (e?.message || ''));
      }
    }
    if (!expired) {
      return { kind: 'oauth', token: oauth.accessToken, accountInfo: oauth.accountInfo };
    }
  }
  // Fall back to manual API key
  const consoleKey = db.getAuthToken('anthropic-console');
  if (consoleKey && consoleKey.accessToken) {
    return { kind: 'api_key', token: consoleKey.accessToken };
  }
  return null;
}

ipcMain.handle('inference:send', async (_event, opts = {}) => {
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (messages.length === 0) {
    return { ok: false, error: 'No messages to send' };
  }
  const model = opts.model || 'claude-opus-4-8';
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 4096;
  const system = typeof opts.system === 'string' ? opts.system : null;

  const auth = await getValidAccessToken();
  if (!auth) {
    return {
      ok: false,
      error: 'no_auth',
      message: 'No auth — sign in to Claude.ai or paste an API key in Settings → AI.',
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (auth.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14';
  } else {
    headers['x-api-key'] = auth.token;
  }

  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (Array.isArray(opts.tools) && opts.tools.length) body.tools = opts.tools;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(errBody); } catch {}
      return {
        ok: false,
        status: res.status,
        error: parsed?.error?.type || 'api_error',
        message: parsed?.error?.message || errBody.slice(0, 500),
      };
    }

    const data = await res.json();
    const blocks = data.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
    const toolUses = blocks.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id,
      name: b.name,
      input: b.input || {},
    }));
    return {
      ok: true,
      text,
      content: blocks,
      toolUses,
      model: data.model,
      usage: data.usage,
      stopReason: data.stop_reason,
    };
  } catch (e) {
    return { ok: false, error: 'network', message: e.message };
  }
});

ipcMain.handle('inference:toolExecute', async (_event, name, input) => {
  try {
    return await executeAgentTool(name, input || {});
  } catch (err) {
    return { ok: false, error: err.message || 'tool_failed' };
  }
});

ipcMain.handle('inference:agentTools', async () => {
  return { ok: true, tools: AGENT_TOOLS };
});

// ------------------------------------------------------------
// Git IPCs for per-call-site AI commands (Jul 13 ~23:05 ET)
// ------------------------------------------------------------
// AI Commit / AI Review palette commands need a working-tree diff and a
// commit primitive. execFile with argument arrays (never a shell string)
// so model-generated commit messages can't inject. cwd resolves from the
// renderer-passed folder, falling back to the persisted currentFolder.
const GIT_DIFF_CHAR_LIMIT = 50000;

function resolveGitCwd(explicit) {
  const c = explicit || (db.getSetting && db.getSetting('currentFolder'));
  return (typeof c === 'string' && c) ? c : null;
}

function gitExec(cwd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        err: err ? String(err.message || err) : null,
      });
    });
  });
}

// Lightweight branch + dirty state for the status bar. Separate from
// git:diff so the 60s status-bar poll never pays for a full diff.
ipcMain.handle('git:branch', async (_e, opts = {}) => {
  const cwd = resolveGitCwd(opts.cwd);
  if (!cwd) return { ok: false, error: 'no_folder' };
  const inside = await gitExec(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || !/true/.test(inside.stdout)) {
    return { ok: false, error: 'not_a_repo' };
  }
  const branch = (await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || '(no branch)';
  const dirty = !!(await gitExec(cwd, ['status', '--porcelain'])).stdout.trim();
  return { ok: true, branch, dirty };
});

ipcMain.handle('git:diff', async (_e, opts = {}) => {
  const cwd = resolveGitCwd(opts.cwd);
  if (!cwd) return { ok: false, error: 'no_folder', message: 'No folder open' };
  const inside = await gitExec(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || !/true/.test(inside.stdout)) {
    return { ok: false, error: 'not_a_repo', message: 'Folder is not a git repository' };
  }
  const branch = (await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || '(no branch)';
  const status = (await gitExec(cwd, ['status', '--porcelain'])).stdout;
  // Prefer the staged diff when something is staged; otherwise diff the
  // working tree. Untracked files aren't in `git diff` — append their
  // names so the model knows they exist (content stays out to keep the
  // payload bounded).
  let source = 'staged';
  let diff = (await gitExec(cwd, ['diff', '--cached'])).stdout;
  if (!diff.trim()) {
    source = 'working';
    diff = (await gitExec(cwd, ['diff'])).stdout;
    const untracked = status.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3)).filter(Boolean);
    if (untracked.length) diff += '\n# Untracked files:\n' + untracked.map(f => '#   ' + f).join('\n') + '\n';
  }
  let truncated = false;
  if (diff.length > GIT_DIFF_CHAR_LIMIT) { diff = diff.slice(0, GIT_DIFF_CHAR_LIMIT); truncated = true; }
  return { ok: true, branch, source, diff, status, truncated, clean: !status.trim() };
});

ipcMain.handle('git:commit', async (_e, opts = {}) => {
  const cwd = resolveGitCwd(opts.cwd);
  const message = typeof opts.message === 'string' ? opts.message.trim() : '';
  if (!cwd) return { ok: false, error: 'no_folder', message: 'No folder open' };
  if (!message) return { ok: false, error: 'empty_message', message: 'Empty commit message' };
  if (opts.addAll) {
    const add = await gitExec(cwd, ['add', '-A']);
    if (add.code !== 0) return { ok: false, error: 'add_failed', message: (add.stderr || add.err || '').slice(0, 500) };
  }
  const commit = await gitExec(cwd, ['commit', '-m', message]);
  if (commit.code !== 0) return { ok: false, error: 'commit_failed', message: (commit.stderr || commit.stdout || commit.err || '').slice(0, 500) };
  const hash = (await gitExec(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const branch = (await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { ok: true, hash, branch, stdout: commit.stdout.slice(0, 500) };
});

// ------------------------------------------------------------
// Streaming inference — SSE from api.anthropic.com/v1/messages
// with stream: true. Forwards events to the renderer via
// webContents.send('inference:chunk', { requestId, type, ... }).
// Handles text_delta streaming AND tool_use streaming (accumulate
// partial_json per block index, JSON.parse on block_stop).
// ------------------------------------------------------------
ipcMain.on('inference:stream', async (event, opts = {}) => {
  const requestId = opts.requestId || ('stream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('inference:chunk', { requestId, ...payload });
  };

  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (messages.length === 0) {
    send({ type: 'error', error: 'No messages to send' });
    return { ok: false };
  }
  const model = opts.model || 'claude-opus-4-8';
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 4096;
  const system = typeof opts.system === 'string' ? opts.system : null;

  const auth = await getValidAccessToken();
  if (!auth) {
    send({ type: 'error', error: 'no_auth', message: 'No auth — sign in to Claude.ai or paste an API key in Settings → AI.' });
    return { ok: false };
  }

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Accept': 'text/event-stream',
  };
  if (auth.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14';
  } else {
    headers['x-api-key'] = auth.token;
  }

  const body = { model, max_tokens: maxTokens, messages, stream: true };
  if (system) body.system = system;
  if (Array.isArray(opts.tools) && opts.tools.length) body.tools = opts.tools;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(errBody); } catch {}
      send({
        type: 'error',
        error: parsed?.error?.type || 'api_error',
        message: parsed?.error?.message || errBody.slice(0, 500),
        status: res.status,
      });
      return { ok: false };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const blocks = {}; // index -> { type, text, id, name, inputJson, input }
    let stopReason = null;
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events separated by blank line
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop();

      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        let eventType = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        if (eventType === 'message_start') {
          send({ type: 'message_start', message: parsed.message });
        } else if (eventType === 'content_block_start') {
          const idx = parsed.index;
          blocks[idx] = parsed.content_block || { type: 'text', text: '' };
          if (blocks[idx].type === 'tool_use') blocks[idx].inputJson = '';
          send({ type: 'block_start', index: idx, block: blocks[idx] });
        } else if (eventType === 'content_block_delta') {
          const idx = parsed.index;
          const delta = parsed.delta || {};
          if (delta.type === 'text_delta') {
            if (!blocks[idx]) blocks[idx] = { type: 'text', text: '' };
            blocks[idx].text = (blocks[idx].text || '') + delta.text;
            send({ type: 'text_delta', index: idx, text: delta.text });
          } else if (delta.type === 'input_json_delta') {
            if (!blocks[idx]) blocks[idx] = { type: 'tool_use', inputJson: '' };
            blocks[idx].inputJson = (blocks[idx].inputJson || '') + (delta.partial_json || '');
            send({ type: 'tool_use_delta', index: idx, partialJson: delta.partial_json || '' });
          } else if (delta.type === 'thinking_delta') {
            // Jul 14 ~09:20 ET: accumulate thinking text. Without this,
            // blocks[idx] keeps the empty thinking field from
            // content_block_start, the assistant message gets pushed to
            // history with `thinking: ''`, and the next API call returns
            // HTTP 400 with "messages.N.content.M.thinking: each thinking
            // block must contain thinking". Triggered by switching the
            // chat's default model to one with adaptive thinking
            // enabled (Fable 5 / Opus 4.8 High).
            if (!blocks[idx]) blocks[idx] = { type: 'thinking', thinking: '' };
            blocks[idx].thinking = (blocks[idx].thinking || '') + (delta.thinking || '');
          } else if (delta.type === 'signature_delta') {
            // Jul 14 ~09:20 ET: capture the signature so the API can
            // verify the thinking block on subsequent turns. Required
            // (and unmodified) when a thinking block is echoed back.
            if (!blocks[idx]) blocks[idx] = { type: 'thinking', thinking: '', signature: '' };
            blocks[idx].signature = (blocks[idx].signature || '') + (delta.signature || '');
          }
        } else if (eventType === 'content_block_stop') {
          const idx = parsed.index;
          if (blocks[idx]?.type === 'tool_use' && blocks[idx].inputJson) {
            try { blocks[idx].input = JSON.parse(blocks[idx].inputJson); } catch { blocks[idx].input = {}; }
          }
          send({ type: 'block_stop', index: idx });
        } else if (eventType === 'message_delta') {
          stopReason = parsed.delta?.stop_reason || stopReason;
          if (parsed.usage) usage = { ...(usage || {}), ...parsed.usage };
          send({ type: 'message_delta', stopReason, usage });
        } else if (eventType === 'message_stop') {
          // end of message
        }
      }
    }

    const blockArr = Object.keys(blocks).sort((a, b) => +a - +b).map(k => blocks[k]);
    const text = blockArr.filter(b => b.type === 'text').map(b => b.text || '').join('');
    const toolUses = blockArr.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id, name: b.name, input: b.input || {},
    }));
    const result = { ok: true, text, content: blockArr, toolUses, stopReason, usage };
    send({ type: 'done', result });
    return { ok: true, requestId };
  } catch (e) {
    send({ type: 'error', error: 'network', message: e.message });
    return { ok: false };
  }
});

// ============================================================
// IPC: Live panel — Anomaly Intelligence Reddit Games API
//
// Two endpoints, both proxied through main so the renderer doesn't
// need a direct cross-origin fetch. Base URL is fixed; the game id
// is a swappable constant in src/app.js (LIVE_DEFAULT_GAME_ID).
// ============================================================
const ANOMALYINT_BASE = 'https://anomalyint.vercel.app';

ipcMain.handle('live:loadGame', async (_event, gameId) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(gameId) || gameId.length > 128) {
    return { ok: false, error: 'bad_input', message: 'Game id has invalid characters' };
  }
  // Read-through cache: if SQLite has a fresh row, return it instantly
  // (with cached: true so the renderer can show "Updated Xm ago" without
  // a fetch spinner). Otherwise fetch the API and persist.
  const cached = db.getLiveGameCache(gameId);
  if (cached) {
    return { ok: true, cached: true, data: cached.data, fetched_at: cached.fetched_at };
  }
  return await fetchAndCacheLiveGame(gameId);
});

// Force a fresh API fetch and persist the result. The refresh icon
// next to the "Updated" date in the Live header calls this. Bypasses the
// cache (always hits the network) and overwrites the stored row.
ipcMain.handle('live:refreshGame', async (_event, gameId) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(gameId) || gameId.length > 128) {
    return { ok: false, error: 'bad_input', message: 'Game id has invalid characters' };
  }
  return await fetchAndCacheLiveGame(gameId);
});

async function fetchAndCacheLiveGame(gameId) {
  // Timeout is configurable via the `live.timeout_seconds` settings key
  // (default 15s). AbortController fires when the timer elapses; the
  // fetch rejects with AbortError and we surface a clear timeout error
  // so the renderer's existing error UI can take over instead of
  // spinning forever.
  const timeoutSeconds = Number(db.getSetting('live.timeout_seconds')) || 15;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(`${ANOMALYINT_BASE}/api/reddit-games/${gameId}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Farnsworth/1.0' },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return { ok: false, status: 404, error: 'not_found', message: 'Game not found' };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: 'upstream', message: body.slice(0, 500) };
    }
    const data = await res.json();
    // Persist to SQLite so the next render is instant.
    const saved = db.saveLiveGameCache(gameId, data);
    return { ok: true, cached: false, data, saved: saved.ok === true };
  } catch (e) {
    if (e && (e.name === 'AbortError' || String(e).includes('aborted'))) {
      return { ok: false, error: 'timeout', message: `Request timed out after ${timeoutSeconds}s. Check the API URL or increase the timeout in Live settings.` };
    }
    return { ok: false, error: 'network', message: e.message };
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('live:chat', async (_event, gameId, payload) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(gameId) || gameId.length > 128) {
    return { ok: false, error: 'bad_input', message: 'Game id has invalid characters' };
  }
  if (!payload || (typeof payload.message !== 'string' && !Array.isArray(payload.messages))) {
    return { ok: false, error: 'bad_input', message: 'Provide a "message" string or a "messages" array' };
  }
  // Same configurable timeout as fetchAndCacheLiveGame — AbortController
  // fires when live.timeout_seconds elapses so the chat/tickets fetches
  // don't hang the Live panel forever.
  const timeoutSeconds = Number(db.getSetting('live.timeout_seconds')) || 15;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(`${ANOMALYINT_BASE}/api/reddit-games/${gameId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Farnsworth/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: 'upstream', message: body.slice(0, 500) };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    if (e && (e.name === 'AbortError' || String(e).includes('aborted'))) {
      return { ok: false, error: 'timeout', message: `Chat request timed out after ${timeoutSeconds}s. The API may be slow or unreachable.` };
    }
    return { ok: false, error: 'network', message: e.message };
  } finally {
    clearTimeout(timer);
  }
});

// ============================================================================
// IPC: Live panel — cached ticket suggestions (SQLite-backed)
//
// One row per game_id in live_tickets_cache. The renderer auto-fetches on
// Live tab mount; the "Refresh" button regenerates + overwrites.
// ============================================================================
ipcMain.handle('live:ticketsGet', async (_event, gameId) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  const cached = db.getLiveTickets(gameId);
  if (!cached) return { ok: true, cached: null };
  return { ok: true, cached };
});

ipcMain.handle('live:ticketsSave', async (_event, gameId, tickets, rawReply) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  if (!Array.isArray(tickets)) {
    return { ok: false, error: 'bad_input', message: 'tickets must be an array' };
  }
  return db.saveLiveTickets(gameId, tickets, rawReply);
});

ipcMain.handle('live:ticketsClear', async (_event, gameId) => {
  if (!gameId || typeof gameId !== 'string') {
    return { ok: false, error: 'bad_input', message: 'Missing game id' };
  }
  return db.clearLiveTickets(gameId);
});

// ============================================================
// IPC: Chat history (SQLite-backed)
// ============================================================
ipcMain.handle('chat:list', async (_event, workspacePath) => db.getChatHistory(workspacePath, 200));
ipcMain.handle('chat:add', async (_event, workspacePath, role, content, model, meta) => {
  db.addChatMessage(workspacePath, role, content, model, meta);
  return { ok: true };
});
ipcMain.handle('chat:clear', async (_event, workspacePath) => {
  db.clearChatHistory(workspacePath);
  return { ok: true };
});

// ============================================================
// IPC: Tasks (SQLite-backed)
// ============================================================
ipcMain.handle('tasks:list', async (_event, workspacePath) => db.getTasks(workspacePath));
ipcMain.handle('tasks:add', async (_event, workspacePath, status, title, detail, priority, source, assignee, fileLink) => {
  const id = db.addTask(workspacePath, status, title, detail, priority, source, assignee, fileLink);
  return { ok: true, id, task: db.getTasks(workspacePath).find(t => t.id === id) };
});
ipcMain.handle('tasks:update', async (_event, id, fields) => {
  db.updateTask(id, fields);
  return { ok: true };
});
ipcMain.handle('tasks:delete', async (_event, id) => {
  db.deleteTask(id);
  return { ok: true };
});

// ============================================================
// IPC: Platform
// ============================================================
ipcMain.handle('app:platform', () => process.platform);

// ============================================================
// Lifecycle
// ============================================================
app.whenReady().then(async () => {
  await ensureDirs();
  db.init(userDataPath(), safeStorage);
  await db.migrateLegacy(userDataPath());
  // Explicitly set the activation policy to `regular` — without this,
  // Electron can be treated as a UI element (no menu bar, no Dock
  // activation) when launched via a non-exec wrapper script, which
  // produces the "Farnsworth window is focused but the menu bar shows
  // whatever was last focused" symptom Long hit on Jul 2.
  // See [[farnsworth-app-bundle]] § wrapper script + activation policy.
  if (process.platform === 'darwin' && app.setActivationPolicy) {
    app.setActivationPolicy('regular');
  }
  // Install the native macOS menu bar before createWindow() so the
  // first paint already has File / Edit / View / Window / Help menus.
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  startTerminalServer();
  startClaudeCodeServer();
  startCodexServer();

  // ====================================================================
  // Auto-updater check (packaged builds only; dev mode skips it).
  // Runs after createWindow() so any in-app update banner has a renderer
  // to attach to later (not wired up yet — just logs for now + native
  // notification from checkForUpdatesAndNotify()).
  // ====================================================================
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[autoUpdater] check failed:', err?.message || err);
    });
  }

  // Start the relay client (outbound WS to farnsworth-relay). No-op if
  // RELAY_DISABLED=1 or the relay isn't reachable — Farnsworth keeps
  // working locally, the relay just won't be in the picture.
  try {
    const relayClient = getRelayClient();
    relayClient.start();
    // Forward ALL incoming relay messages to the renderer over IPC (wildcard).
    // Previously this registered four specific types (chat / command /
    // canvas:subscribe / canvas:state); the wildcard makes new protocol types
    // (chat:history:request, chat:conversation:select, ...) renderer-only
    // changes — no main.js edit or app restart needed per type. The renderer's
    // wireRelay() switch ignores types it doesn't handle, so relay acks and
    // hellos passing through are harmless. (Jul 15 2026, companion chat sync)
    relayClient.on('*', (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('relay:message', { type: msg.type, payload: msg });
      }
    });
    relayClient.onStatus((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('relay:status', { status });
      }
    });

    // ====================================================================
    // Companion Claude Code bridge (Jul 16 2026)
    // --------------------------------------------------------------------
    // Piggybacks the companion onto the desktop's ACTIVE Claude Code PTY
    // (same cwd + same session via the desktop's JSONL). One PTY, two
    // viewers -- the companion's input is written into the desktop's PTY
    // stdin and the desktop's PTY onData is forwarded back to the
    // companion via relayClient.send(). When the companion closes the
    // sheet it sends claudeCode:detach and we remove the onData listener.
    // ====================================================================
    const companionClaudeAttachments = new Map(); // companionId -> { term, onData, tabId }
    relayClient.on('claudeCode:subscribe', (msg) => {
      const companionId = msg?.companionId || msg?.from || 'companion';
      const targetTabId = msg?.tabId || null;
      // Pick the requested tabId, falling back to whichever Claude Code tab
      // is currently active on the desktop. claudeCodePtys is populated by
      // the startClaudeCodeServer() spawnFor() closure below. Map iteration
      // is insertion order so the LAST entry is the most-recently-spawned —
      // a reasonable proxy for "active" (Long typically opens one tab at
      // a time and works in it; opening a new tab moves the focus).
      const entry = (targetTabId && claudeCodePtys.get(targetTabId))
        || [...claudeCodePtys.values()].at(-1)
        || null;
      if (!entry) {
        relayClient.send({ type: 'claudeCode:attached', companionId, ok: false, reason: 'no-active-session' });
        return;
      }
      // Clean up any prior attachment from this companion (re-subscribe).
      const prior = companionClaudeAttachments.get(companionId);
      if (prior) { try { prior.term.removeListener('data', prior.onData); } catch {} }
      const onData = (data) => {
        try {
          relayClient.send({ type: 'claudeCode:output', companionId, tabId: entry.tabId, data });
        } catch (e) { /* connection might be down — safe to drop */ }
      };
      entry.term.on('data', onData);
      companionClaudeAttachments.set(companionId, { term: entry.term, onData, tabId: entry.tabId });
      // Send the desktop's CURRENT cols/rows so the companion adopts the
      // desktop's winsize (and scales its font to fit) instead of resizing
      // the shared PTY down. The desktop is the sole size owner.
      relayClient.send({ type: 'claudeCode:attached', companionId, tabId: entry.tabId, ok: true, sessionId: entry.sessionId, cwd: entry.cwd, cols: entry.cols || 80, rows: entry.rows || 24 });
    });
    relayClient.on('claudeCode:input', (msg) => {
      const companionId = msg?.companionId || msg?.from || 'companion';
      const att = companionClaudeAttachments.get(companionId);
      const data = typeof msg?.data === 'string' ? msg.data : '';
      if (att && data) { try { att.term.write(data); } catch (e) { /* PTY died -- safe to drop */ } }
    });
    relayClient.on('claudeCode:resize', (msg) => {
      // INTENTIONAL NO-OP (Jul 16 fix). One PTY, one winsize, two viewers
      // of different sizes. If we honored the companion's phone-narrow
      // cols/rows here we'd resize the SHARED PTY down and reflow the
      // desktop's own xterm into a ~1-char column (the garble Long saw
      // when the companion navigated to Claude Code). The desktop is the
      // sole size owner; the companion adopts the desktop's cols/rows
      // (sent in claudeCode:attached) and scales its font to fit instead
      // of driving the PTY. So we deliberately ignore companion resizes.
    });
    relayClient.on('claudeCode:interrupt', (msg) => {
      // Ctrl+C cancels the current claude turn without killing the PTY.
      const companionId = msg?.companionId || msg?.from || 'companion';
      const att = companionClaudeAttachments.get(companionId);
      if (att) { try { att.term.write('\x03'); } catch {} }
    });
    relayClient.on('claudeCode:detach', (msg) => {
      const companionId = msg?.companionId || msg?.from || 'companion';
      const att = companionClaudeAttachments.get(companionId);
      if (att) {
        try { att.term.removeListener('data', att.onData); } catch {}
        companionClaudeAttachments.delete(companionId);
      }
    });

    // ====================================================================
    // Canvas screencast bridge (Jul 16) — same "Piggyback" idea as the
    // Claude Code bridge, but for the visual canvas. The companion's
    // Preview tab used to iframe the desktop's LOCAL dev-server URL
    // (http://localhost:5174/?view=mobile). That's unreachable from a
    // phone (localhost = the phone) and triggers Chrome's Local Network
    // Access prompt on desktop (public origin reaching into localhost).
    //
    // Instead: the desktop screencasts the active WebContentsView by
    // polling webContents.capturePage(), JPEG-encoding each frame, and
    // pushing it over the relay as `canvas:frame`. Taps/scrolls flow back
    // as `canvas:input` and are replayed via webContents.sendInputEvent().
    // No localhost, no tunnel, no permission prompt — rides the relay the
    // companion is already connected to, so it works on any paired device.
    // ====================================================================
    const companionCanvasStreams = new Map(); // companionId -> { timer, inFlight }
    // The canvas preview has TWO render shapes (Jul 9 WebContentsView swap):
    //   - mobile/desktop/fullscreen previews are WebContentsViews (tracked in
    //     canvasWebContentsViews). They composite ABOVE the DOM, so they must
    //     be captured via their OWN webContents.capturePage().
    //   - post view is a plain DOM <iframe> in the renderer (localhost:517x
    //     OOPIF). It is NOT in canvasWebContentsViews, so we capture the main
    //     window cropped to the iframe rect (capturePage on the renderer DOES
    //     include composited OOPIFs, unlike WebContentsView layers).
    // Resolve the active capture target on every tick so switching preview
    // mode on the desktop re-targets automatically.
    const IFRAME_RECT_JS =
      "(function(){var f=document.querySelector('iframe[src*=\"localhost\"]')||document.querySelector('iframe');" +
      "if(!f)return null;var r=f.getBoundingClientRect();" +
      "return {x:Math.max(0,Math.round(r.left)),y:Math.max(0,Math.round(r.top))," +
      "width:Math.round(r.width),height:Math.round(r.height)};})()";
    const getIframeRect = async () => {
      try { const r = await mainWindow.webContents.executeJavaScript(IFRAME_RECT_JS, true); return (r && r.width > 0) ? r : null; }
      catch { return null; }
    };
    const stopCanvasStream = (companionId) => {
      const s = companionCanvasStreams.get(companionId);
      if (s) { try { clearInterval(s.timer); } catch {} companionCanvasStreams.delete(companionId); }
    };
    // Capture one JPEG frame from whatever the desktop is currently showing.
    const captureCanvasFrame = async (maxWidth, quality) => {
      const entries = [...canvasWebContentsViews.entries()];
      let img;
      if (entries.length) {
        img = await entries[entries.length - 1][1].webContents.capturePage();
      } else {
        const rect = await getIframeRect();
        if (!rect) return null;
        img = await mainWindow.webContents.capturePage(rect);
      }
      if (!img || img.isEmpty()) return null;
      const sz = img.getSize();
      if (sz.width > maxWidth) img = img.resize({ width: maxWidth });
      const out = img.getSize();
      return { data: img.toJPEG(quality).toString('base64'), w: out.width, h: out.height };
    };
    relayClient.on('canvas:screencast:start', async (msg) => {
      const companionId = msg?.companionId || msg?.from || 'companion';
      const fps = Math.min(Math.max(Number(msg?.fps) || 6, 1), 15);
      const quality = Math.min(Math.max(Number(msg?.quality) || 50, 20), 90);
      const maxWidth = Math.min(Math.max(Number(msg?.maxWidth) || 720, 240), 1280);
      stopCanvasStream(companionId); // clean re-subscribe
      const hasTarget = canvasWebContentsViews.size > 0 || !!(await getIframeRect());
      relayClient.send({
        type: 'canvas:screencast:started', companionId,
        ok: hasTarget, reason: hasTarget ? undefined : 'no-active-view', ts: Date.now(),
      });
      const stream = { timer: null, inFlight: false };
      stream.timer = setInterval(async () => {
        if (stream.inFlight) return; // don't stack captures
        stream.inFlight = true;
        try {
          const frame = await captureCanvasFrame(maxWidth, quality);
          if (frame) relayClient.send({ type: 'canvas:frame', companionId, ...frame, ts: Date.now() });
        } catch (e) { /* view reloading/destroyed — drop this frame */ }
        stream.inFlight = false;
      }, Math.round(1000 / fps));
      companionCanvasStreams.set(companionId, stream);
    });
    relayClient.on('canvas:screencast:stop', (msg) => {
      stopCanvasStream(msg?.companionId || msg?.from || 'companion');
    });
    relayClient.on('canvas:input', async (msg) => {
      const nx = Number(msg?.nx), ny = Number(msg?.ny);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      const cx = Math.min(Math.max(nx, 0), 1), cy = Math.min(Math.max(ny, 0), 1);
      const entries = [...canvasWebContentsViews.entries()];
      let wc, x, y;
      if (entries.length) {
        const view = entries[entries.length - 1][1];
        const b = view.getBounds();
        wc = view.webContents; x = Math.round(cx * b.width); y = Math.round(cy * b.height);
      } else {
        const rect = await getIframeRect();
        if (!rect) return;
        // sendInputEvent at window-absolute coords; Chromium routes to the OOPIF.
        wc = mainWindow.webContents; x = Math.round(rect.x + cx * rect.width); y = Math.round(rect.y + cy * rect.height);
      }
      try {
        if (msg.kind === 'scroll') {
          wc.sendInputEvent({ type: 'mouseWheel', x, y,
            deltaX: Math.round(Number(msg.dx) || 0), deltaY: Math.round(Number(msg.dy) || 0),
            canScroll: true });
        } else { // tap (default) — mouse down + up
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 });
        }
      } catch (e) { /* target gone — drop */ }
    });
  } catch (e) {
    console.warn('[main] relay-client init failed (non-fatal):', e.message);
  }
  // NOTE: app.dock.hide() was previously called here, but it makes the
  // app behave like a UI element (no menu bar, can't be activated) when
  // the wrapper bash script is the parent process — which is exactly
  // how Farnsworth.app launches (the bash launcher spawns Electron as
  // a child). The Farnsworth.app bundle's icon is already shown in the
  // Dock via LaunchServices, so hiding Electron's Dock icon doesn't
  // change the visual outcome but does break focus/activation. Keep
  // the Dock icon visible so Dock clicks can activate the window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  db.close();
  // Always quit on close. The default darwin behaviour (keep alive,
  // reopen from Dock) doesn't apply to Farnsworth because we hide the
  // Electron dock icon (the wrapper script owns it). Long hit this on
  // Jun 28 ~16:12 ET: closed the window, the process stayed alive,
  // `open /Applications/Farnsworth.app` did nothing (single-instance
  // lock + already-running process), so the app looked stuck. Quitting
  // unconditionally means the next `open` always launches fresh.
  app.quit();
});
// ============================================================
// IPC: Terminal panel (Phase 2)
// ============================================================
//
// Each WebSocket connection maps 1:1 to a node-pty process. The renderer
// (xterm.js + addon-fit) connects to ws://localhost:<TERMINAL_WS_PORT>, sends
// JSON messages of the form { type: 'data'|'resize'|'close', ... }, and
// receives the same shape back. PTY env inherits from the Electron process;
// TERM is forced to xterm-256color so apps render colors correctly.

const TERMINAL_WS_PORT = 9223;
let terminalWss = null;

function startTerminalServer() {
  if (!pty) {
    console.error('[terminal] node-pty unavailable; terminal panel disabled');
    return;
  }
  if (terminalWss) return;
  terminalWss = new WebSocket.Server({ port: TERMINAL_WS_PORT });
  terminalWss.on('connection', (ws) => {
    const shell = (process.env.SHELL) || '/bin/zsh';
    // The renderer sends the workspace cwd on the first WS message via
    // {type:'init', cwd}. Spawning is deferred until that arrives (with a
    // 2s fallback to the currentFolder setting / homedir) so the shell
    // starts in the project folder, not in ~ or /.
    const tabId = 'tty-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    let initialized = false;
    let term = null;
    const spawnPty = (initCwd) => {
      const cwd = initCwd
        || (db.getSetting && db.getSetting('currentFolder'))
        || os.homedir();
      // Prepend homebrew to PATH so `npm`, `node`, `claude`, etc. resolve.
      // Electron's process.env.PATH from a `open`-launched bundle does NOT
      // include /opt/homebrew/bin (LaunchServices doesn't load shell rc
      // files), which is why `npm run dev` was giving "command not found".
      const pathWithBrew = (process.env.PATH || '')
        + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
      try {
        term = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            PATH: pathWithBrew,
          },
        });
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'pty.spawn failed: ' + e.message }));
        ws.close();
        return;
      }
      const send = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      };
      const entry = { pty: term, lastActivity: Date.now(), tabId };
      terminalPtys.set(ws, entry);
      // Tell the renderer what its tabId is so the close handler can target it.
      send({ type: 'ready', tabId });
      term.onData((data) => {
        entry.lastActivity = Date.now();
        send({ type: 'data', data });
      });
      term.onExit(({ exitCode, signal }) => {
        send({ type: 'exit', exitCode, signal });
        ws.close();
      });
      // Permanent message handler — init messages are ignored after spawn.
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'data') term.write(msg.data);
        else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          try { term.resize(msg.cols, msg.rows); } catch {}
        } else if (msg.type === 'close') {
          try { term.kill(); } catch {}
        }
      });
      ws.on('close', () => {
        terminalPtys.delete(ws);
        try { term.kill(); } catch {}
      });
      ws.on('error', () => {
        terminalPtys.delete(ws);
        try { term.kill(); } catch {}
      });
    };
    // First-message init handler — fires once. Renderer sends {type:'init', cwd}
    // right after WS open. If it never arrives (or arrives malformed), the
    // 2s fallback spawns with currentFolder / homedir.
    ws.once('message', (raw) => {
      if (initialized) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'init') return;
      initialized = true;
      spawnPty(typeof msg.cwd === 'string' && msg.cwd.length > 0 ? msg.cwd : null);
    });
    setTimeout(() => {
      if (initialized) return;
      initialized = true;
      spawnPty(null); // falls back to currentFolder / homedir
    }, 2000);
  });
  console.log(`[terminal] WebSocket server listening on ws://localhost:${TERMINAL_WS_PORT}`);
}

// Claude Code panel — separate WebSocket server + PTY pool that spawns the
// `claude` binary instead of bash. Same protocol as the terminal panel
// ({type:'data'|'resize'|'close'} ⇄ {type:'data'|'exit'|'ready'}), separate
// port (9224) so the two panels can run independently side-by-side. The
// renderer keeps a parallel `claudeCodeSessions` map mirroring the existing
// `terminalSessions` structure.
//
// CWD = workspace folder, env inherits from Electron so Claude Code picks up
// the same OAUTH credentials it would if launched from Terminal.app.
const CLAUDE_CODE_WS_PORT = 9224;
let claudeCodeWss = null;
// Companion Claude Code bridge (Jul 16 2026) — tracks live Claude Code
// PTYs by tabId so the companion-side relay handler can piggyback onto
// the desktop's active session. Populated on successful pty.spawn inside
// spawnFor(); cleared on term.onExit and WS close.
const claudeCodePtys = new Map(); // tabId -> { term, send, sessionId, cwd }

function startClaudeCodeServer() {
  if (!pty) {
    console.error('[claude-code] node-pty unavailable; Claude Code panel disabled');
    return;
  }
  // Mark Farnsworth's working directory as trusted in Claude Code's
  // `~/.claude.json` `projects` map so the workspace trust dialog
  // (Long's "Accessing workspace: /Users/long" prompt from Jun 28 ~16:34 ET)
  // is skipped on every PTY spawn. Without this, every Farnsworth restart
  // shows the prompt even when `--resume <sessionId>` loads the right
  // JSONL — the trust decision lives separately from the session data.
  // Verified Jun 28 ~16:36 ET: existing projects like
  // `/Users/long/Documents/lastdraft/the-last-draft` already have
  // `hasTrustDialogAccepted: true` set; we mirror that for the cwd.
  const markWorkspaceTrusted = (cwd) => {
    if (!cwd) return;
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      let cfg = {};
      try { cfg = JSON.parse(fsSync.readFileSync(claudeJsonPath, 'utf8')); } catch {}
      cfg.projects = cfg.projects || {};
      const existing = cfg.projects[cwd] || {};
      cfg.projects[cwd] = {
        ...existing,
        hasTrustDialogAccepted: true,
      };
      // Atomic write: tmp + rename so a concurrent claude CLI read doesn't
      // see a partial file.
      const tmpPath = claudeJsonPath + '.tmp';
      fsSync.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
      fsSync.renameSync(tmpPath, claudeJsonPath);
    } catch (e) {
      console.warn('[claude-code] could not mark workspace trusted:', e.message);
    }
  };
  // Run once at server boot for the default cwd; also called per-spawn
  // when the cwd changes (rare — only if Long opens a folder elsewhere).
  markWorkspaceTrusted((db.getSetting && db.getSetting('currentFolder')) || os.homedir());
  if (claudeCodeWss) return;

  // Locate the `claude` binary. Electron's main process inherits a minimal
  // Locate the `claude` binary (bundled Resources/bin/claude first, Jul 7 ~21:02 ET).
  const claudePath = findClaudePath();
  if (!claudePath) {
    console.error('[claude-code] claude binary not found on PATH or candidate paths; Claude Code panel will fail to spawn');
  } else {
    console.log(`[claude-code] using claude at: ${claudePath}`);
  }

  claudeCodeWss = new WebSocket.Server({ port: CLAUDE_CODE_WS_PORT });
  claudeCodeWss.on('connection', (ws) => {
    // [DEBUG Jul 6 ~00:05 ET] trace cwd at connection
    const initialCwd = (db.getSetting && db.getSetting('currentFolder')) || os.homedir();
    console.log('[claude-code] WS connect: initial cwd =', JSON.stringify(initialCwd), 'from currentFolder =', JSON.stringify(db.getSetting?.('currentFolder')));
    // CWD priority: renderer's `state.folder` (via init message) > currentFolder setting > homedir.
    // `cwd` is `let` (not `const`) so the init handler can update it before spawnFor runs.
    // Long's Claude Code panel PTYs were spawning in `~` instead of the project folder
    // because we captured `cwd` at WS-connection time from `currentFolder`, which lags
    // behind the renderer's `state.folder` when the panel mounts before a folder is opened
    // (verified Jul 5 ~23:55 ET via CDP: `state.folder` was null at panel mount, currentFolder
    // later became `/Users/long/Documents/lastdraft/the-last-draft`, but the captured cwd
    // had been frozen as homedir → sessions landed in `~/.claude/projects/-Users-long/` not
    // `-Users-long-Documents-lastdraft-the-last-draft/`). Mirror the terminal panel's init
    // protocol (lines 2216-2320) so the renderer can correct the cwd before spawn.
    let cwd = (db.getSetting && db.getSetting('currentFolder')) || os.homedir();
    const tabId = 'cc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    let term = null;
    let spawned = false;
    let initialized = false;
    // Stashed at spawn-time so the rename handler can rebuild the args
    // (and append `--name <title>`) without re-running the JSONL exists
    // check. Cleared on respawn.
    const nonoBin = findNonoPath();
    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    // First-message init handler — fires once for the renderer's
    // `{ type: 'init', cwd }` message. Updates `cwd` so the eventual
    // `spawnFor` (triggered by the renderer's `spawn` message) reads the
    // renderer's actual state.folder rather than the captured-at-WS-open
    // value. If the init message never arrives, the 2s fallback below
    // spawns with whatever `cwd` already is (currentFolder or homedir).
    ws.once('message', (raw) => {
      if (initialized) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'init') return;
      initialized = true;
      if (typeof msg.cwd === 'string' && msg.cwd.length > 0) {
        cwd = msg.cwd;
      }
    });
    setTimeout(() => {
      // Mark initialized even if no init arrived — spawnFor must still
      // be able to run when the renderer's spawn message comes later.
      initialized = true;
    }, 2000);

    // Wait for the renderer to send `{ type: 'spawn', sessionId }` before
    // starting the PTY. The sessionId controls whether we resume an
    // existing Claude Code session (`claude --resume <id>`) or create a
    // new one with a deterministic UUID (`claude --session-id <uuid>`).
    // Long asked for this Jun 28 ~16:30 ET — without it, every restart
    // starts a fresh claude session and re-asks the workspace trust
    // prompt instead of continuing the prior conversation.
    const spawnFor = (sessionId) => {
      if (spawned) return;
      spawned = true;
      const claudeBin = claudePath || 'claude';
      const args = [];
      let useSessionId = null;
      // Stashed for the rename handler (Jul 14 ~10:58 ET) so we can
      // rebuild the spawn args with `--name <title>` appended without
      // re-running the JSONL exists check.
      // Strict UUID v4 format check (8-4-4-4-12). The `claude` CLI rejects
      // anything else with "Error: Invalid session ID. Must be a valid UUID"
      // (verified Jun 28 ~16:33 ET after my earlier ffffffff-prefix attempt).
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      // Project dir Claude Code uses for `cwd`: encodes path segments
      // (e.g. `/Users/long` → `-Users-long`). Long asked for session
      // resume Jun 28 ~16:30 ET — `--resume <uuid>` loads
      // `<projectsDir>/<uuid>.jsonl` if it exists; if not, claude exits
      // with "No conversation found with session ID: ..." (verified Jun
      // 28 ~16:42 ET for cc-3 which had never been used).
      const projectsDir = path.join(os.homedir(), '.claude', 'projects',
        '-' + cwd.split('/').filter(Boolean).join('-'));
      const sessionJsonlExists = sessionId && typeof sessionId === 'string' && uuidRe.test(sessionId)
        && fsSync.existsSync(path.join(projectsDir, sessionId + '.jsonl'));
      if (sessionJsonlExists) {
        // Resume an existing session whose JSONL we can find on disk.
        // The renderer captured this UUID from the prior PTY's `ready`
        // message and persisted it in the `claudeCode.tabs` settings.
        args.push('--resume', sessionId);
        useSessionId = sessionId;
      } else {
        // Either no sessionId was sent, the UUID is malformed, or the
        // persisted session's JSONL file is missing (never-used tab or
        // file was cleaned up). Spawn a fresh session with a known UUID
        // so we can persist + resume it on the next restart.
        // crypto.randomUUID() returns a v4 UUID like 03f3a2ed-d905-402f-a62f-7186bcc63fe8.
        useSessionId = crypto.randomUUID();
        args.push('--session-id', useSessionId);
      }
      // Ensure the cwd is marked as trusted in `~/.claude.json` before
      // we spawn the PTY, so the workspace trust dialog doesn't appear.
      markWorkspaceTrusted(cwd);
      // Wrap claude in nono.sh for kernel-level isolation (Tier 1, Jul 5).
      // farnsworth-claude profile extends `default` (which already blocks
      // credentials, keychains, browser data, dangerous commands) and adds
      // Tier 1 isolation via nono was rolled back Jul 6 ~08:15 ET because
      // the Seatbelt sandbox blocks ~/.claude.json + macOS Keychain reads,
      // which Claude Code requires for auth (Keychain) + workspace trust
      // (~/.claude.json `projects[cwd].hasTrustDialogAccepted`). Under the
      // sandbox, claude runs but reports "Not logged in · Please run /login"
      // and ignores its own settings. Without those reads, the panel
      // always asks for re-auth on restart. The farnsworth-claude profile
      // is kept at v0.6.0 on disk for reference / future work but no
      // longer wired into the spawn. See [[nono-farnsworth-claude]] §
      // rollback note + [[claude-code-panel]] § cwd bug.
      let spawnBin, spawnArgs;
      if (nonoBin) {
        // Wrap claude in nono.sh for kernel-level isolation (Tier 1, Jul 5).
        // farnsworth-claude v0.7.0 (Jul 7 ~22:58 ET) adds filesystem.allow
        // + allow_file + bypass_protection for ~/.claude.json + ~/.claude/
        // + ~/Library/Keychains so Seatbelt doesn't break Claude Code's
        // auth (Keychain reads) + workspace trust
        // (~/.claude.json `projects[cwd].hasTrustDialogAccepted`) reads.
        // Without these allows, claude under the wrap reports 'Not logged
        // in · Please run /login' and ignores its own settings. With them,
        // smoke test (Jul 7 ~23:01 ET) shows: claude --version works,
        // head ~/.claude.json reads, security find-generic-password
        // returns OAuth tokens, ~/.aws/.ssh/.gnupg/.config/gh still
        // blocked, bash -c escape still blocked at startup. See
        // [[nono-farnsworth-claude]] § v0.7.0 + [[claude-code-panel]] §
        // isolation via nono. markWorkspaceTrusted above handles the
        // trust map; nono profile handles credential/keychain isolation.
        // --allow-cwd is load-bearing: nono v0.66's wrap otherwise resets
        // the wrapped process's cwd to '/' AND prompts "Share <cwd> with
        // read+write access?" on every PTY spawn. The prompt blocks the
        // user every time they open the Claude Code panel. With --allow-cwd
        // (level set by profile workdir.access=readwrite), no prompt and
        // the cwd is honored. Same fix as the chat-agent runSandboxedCommand
        // cwd bug (Jul 14 ~21:50 ET, dab622a).
        spawnBin = nonoBin;
        spawnArgs = ['wrap', '--profile', 'farnsworth-claude', '--allow-cwd', '--', claudeBin, ...args];
      } else {
        // Direct spawn (no nono). Fallback if nono isn't installed.
        // Claude Code's own permission system (workspace trust,
        // settings.json permissions.allow, etc.) is the safety layer;
        // markWorkspaceTrusted above handles the trust map.
        spawnBin = claudeBin;
        spawnArgs = args;
      }
      try {
        // PATH-override rule (Jul 7 ~21:02 ET): bundled Resources/bin/
        // first, then homebrew, then /usr/local. This makes claude +
        // nono self-contained inside Farnsworth.app.
        const bundledBin = path.join(process.resourcesPath || '', 'bin');
        const newPath = [bundledBin, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
          .filter(Boolean)
          .join(':');
        term = pty.spawn(spawnBin, spawnArgs, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', PATH: newPath },
        });
      } catch (e) {
        send({ type: 'error', message: 'claude pty.spawn failed: ' + e.message + ' — is `claude` on PATH? Run `npm i -g @anthropic-ai/claude-code` if not.' });
        ws.close();
        return;
      }
      // Auto-accept Claude Code 2.1.204's "Share X to skip this prompt"
      // workspace dialog (Jul 7 ~23:33 ET). The prompt appears for every
      // interactive PTY spawn even when `~/.claude.json` has
      // `projects[cwd].hasTrustDialogAccepted=true` -- different field,
      // different UX flow. Accepting it ('y\r') persists per-cwd in
      // ~/.claude.json so subsequent PTY spawns in the same cwd skip it.
      // We only auto-accept ONCE per WS connection (track via promptSeen
      // flag) so we don't spam 'y' if the user opens a different prompt.
      let promptSeen = false;
      term.onData((data) => {
        send({ type: 'data', data });
        if (!promptSeen && /to skip this prompt/.test(data) && /\[y\/N\]/.test(data)) {
          promptSeen = true;
          setTimeout(() => {
            try { term.write('y\r'); } catch {}
          }, 150);
        }
      });
      term.onExit(({ exitCode, signal }) => {
        send({ type: 'exit', exitCode, signal });
        claudeCodePtys.delete(tabId); // companion bridge cleanup
        try {
          // Best-effort: tell any companion attached to this PTY that the
          // session died. The relayClient may not be ready yet; guard.
          const rc = (() => { try { return getRelayClient && getRelayClient(); } catch { return null; } })();
          rc && rc.send && rc.send({ type: 'claudeCode:exit', tabId, exitCode, signal });
        } catch {}
        ws.close();
      });
      // Register for the companion bridge. The desktop xterm still owns the
      // PTY -- this just exposes it for piggyback read/write. tabId is
      // duplicated into the value so the bridge can echo it back in
      // claudeCode:output / claudeCode:exit without needing the Map key.
      claudeCodePtys.set(tabId, { tabId, term, send, sessionId: useSessionId, cwd, cols: 80, rows: 24 });
      send({ type: 'ready', tabId, sessionId: useSessionId });
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'spawn') {
        spawnFor(msg.sessionId);
      } else if (term && msg.type === 'data') {
        term.write(msg.data);
      } else if (term && msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try { term.resize(msg.cols, msg.rows); } catch {}
        // Record the desktop's live winsize on the bridge entry so a
        // subscribing companion adopts the CURRENT desktop cols/rows in
        // its claudeCode:attached ack (the desktop is the size owner).
        const e = claudeCodePtys.get(tabId);
        if (e) { e.cols = msg.cols; e.rows = msg.rows; }
      } else if (term && msg.type === 'close') {
        try { term.kill(); } catch {}
      } else if (spawned && term && msg.type === 'rename' && typeof msg.name === 'string' && msg.name.trim()) {
        // First-message rename (Jul 14 ~13:00 ET, simplified ~14:55 ET):
        // send `/rename <title>` to the existing PTY instead of killing
        // and respawning. claude Code's slash command renames the session
        // in-place + writes custom-title to the JSONL, with no PTY churn.
        // The earlier kill+respawn approach had two bugs verified Jul 14
        // ~14:38 ET: (a) the new PTY spawned at hardcoded 80x24 didn't
        // match xterm's actual width, so content wrapped narrow until the
        // user resized the window; (b) the user's typed chars went to the
        // old PTY which was killed before claude could process them, so
        // the first message got lost (Enter on an empty new PTY = no-op).
        // The renderer-side keydown handler now sends data("\r") before
        // the rename so the typed text submits as a normal message first,
        // then /rename runs on the now-empty prompt.
        const newName = String(msg.name).slice(0, 80);
        try {
          term.write(`/rename ${newName}\r`);
        } catch (e) {
          send({ type: 'error', message: 'claude /rename failed: ' + e.message });
        }
        send({ type: 'renamed', tabId, name: newName });
      }
    });
    ws.on('close', () => {
      try { term && term.kill(); } catch {}
    });
    ws.on('error', () => {
      try { term && term.kill(); } catch {}
    });
  });
  console.log(`[claude-code] WebSocket server listening on ws://localhost:${CLAUDE_CODE_WS_PORT}`);
}

ipcMain.handle('claudeCode:getWsUrl', () => `ws://localhost:${CLAUDE_CODE_WS_PORT}`);
ipcMain.handle('claudeCode:close', async (_event, tabId) => {
  // The renderer tracks the WS per tab; this is a no-op marker for symmetry
  // with terminal:close — the WS close handler in main does the actual cleanup.
  return { ok: true, tabId };
});

// ============================================================
// Claude Code panel tab persistence
// ============================================================
// Long asked (Jun 28 ~15:51 ET) for the panel to remember its open
// tabs across restarts — when the IDE quits and relaunches, the same
// tabs should come back without the user having to recreate them.
// We store the tab list + active tab ID in the settings table as a
// single JSON blob (`claudeCode.tabs`). PTYs themselves are NOT
// persisted — on restore, each tab re-spawns a fresh `claude` child
// process when the user activates it (lazy init pattern, mirrors how
// terminal tabs already work).
//
// Shape stored at `claudeCode.tabs`:
//   { tabs: [{ id: 'cc-1', label: 'claude', createdAt: '...', sessionId: 'uuid' }],
//     activeId: 'cc-1' }
// `sessionId` (Jun 28 ~16:30 ET) is the Claude Code session UUID — when
// present, restore uses `claude --resume <sessionId>` so the prior
// conversation continues instead of starting fresh and re-asking the
// workspace trust prompt.
ipcMain.handle('claudeCode:listTabs', async () => {
  try {
    const raw = db.getSetting('claudeCode.tabs');
    if (!raw) return { ok: true, tabs: [], activeId: null };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      ok: true,
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      activeId: parsed.activeId || null,
    };
  } catch (e) {
    return { ok: false, error: e.message, tabs: [], activeId: null };
  }
});

ipcMain.handle('claudeCode:saveTabs', async (_event, state) => {
  try {
    if (!state || !Array.isArray(state.tabs)) {
      return { ok: false, error: 'tabs must be an array' };
    }
    db.setSetting('claudeCode.tabs', {
      tabs: state.tabs,
      activeId: state.activeId || null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Auth gate for the Claude Code panel — the renderer calls these before
// spawning the `claude` TUI so unauthenticated users see a clean sign-in
// card instead of a raw `claude login` prompt dumped into xterm.
//
// `claudeCode:checkAuth` wraps `auth:checkClaudeCode` (already exists) and
// returns the same shape — { ok, hasAuth, source, message }.
// `claudeCode:runLogin` wraps `auth:runClaudeLogin` which spawns `claude
// login` as a child process and waits for the Keychain to update, then
// auto-imports the token. Returns { ok, claudeLoginRan, ... }.
ipcMain.handle('claudeCode:checkAuth', async () => {
  // Lazy-require to avoid loading auth handlers at startup if unused.
  const { ipcMain: _ignored } = require('electron');
  // Just call the existing handler's implementation by re-invoking via the
  // registered name. Simpler: emit the same logic inline.
  const claudePath = findClaudePath();
  if (!claudePath) {
    return { ok: false, hasAuth: false, source: 'no_binary', message: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code' };
  }
  // Check Keychain directly — that's where Claude Code stores OAuth tokens.
  // `claude auth status` prints "Not logged in" if no Keychain entry, but
  // reading Keychain directly is faster and doesn't fork a process.
  const { execSync: exec } = require('child_process');
  try {
    const out = exec('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 }).trim();
    if (out && out.startsWith('{')) {
      const blob = JSON.parse(out);
      const oauth = blob.claudeAiOauth || blob;
      if (oauth.accessToken && oauth.refreshToken) {
        return {
          ok: true,
          hasAuth: true,
          source: 'keychain',
          subscriptionType: oauth.subscriptionType || null,
          expiresAt: oauth.expiresAt || null,
        };
      }
    }
    return { ok: true, hasAuth: false, source: 'keychain_empty', message: 'No OAuth token in Keychain' };
  } catch (e) {
    return { ok: false, hasAuth: false, source: 'keychain_error', message: 'Keychain lookup failed: ' + e.message };
  }
});

ipcMain.handle('claudeCode:runLogin', async () => {
  // Delegate to the existing auth:runClaudeLogin handler. It spawns
  // `claude login`, waits for the Keychain to update, and returns the
  // import result. We re-export it under the claudeCode: namespace so
  // the panel's own IPC surface is self-contained.
  const { ipcMain: ipc } = require('electron');
  // Re-run the same logic by calling the handler directly via a synthetic
  // event — simpler is to just inline-import the function. But the
  // existing handler is registered as an anonymous async arrow, so the
  // easiest path is to invoke the IPC by name through the handler map.
  // Electron doesn't expose handlers by name publicly, so we re-implement
  // the call by spawning `claude login` here and watching Keychain.
  const { execSync, spawn } = require('child_process');
  const claudePath = findClaudePath();
  if (!claudePath) {
    return { ok: false, error: 'claude_not_found', message: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code' };
  }

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudePath, ['login'], { stdio: 'ignore', detached: false });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed', message: 'Failed to spawn `claude login`: ' + e.message });
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: 'timeout', message: '`claude login` timed out after 5 minutes.' });
    }, 5 * 60 * 1000);
    child.on('exit', async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return resolve({ ok: false, error: 'claude_login_failed', message: '`claude login` exited with code ' + code });
      }
      // claude login wrote a fresh Keychain entry. Verify + return status.
      try {
        const out = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 }).trim();
        if (out && out.startsWith('{')) {
          const blob = JSON.parse(out);
          const oauth = blob.claudeAiOauth || blob;
          if (oauth.accessToken) {
            return resolve({ ok: true, hasAuth: true, claudeLoginRan: true });
          }
        }
      } catch {}
      resolve({ ok: false, error: 'no_keychain_after_login', message: '`claude login` exited but no Keychain entry was written.' });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: 'spawn_failed', message: '`claude login` child error: ' + err.message });
    });
  });
});

// ============================================================
// Codex panel — WebSocket PTY server (mirrors the Claude Code panel)
// ============================================================
// Same architecture as startClaudeCodeServer: one WS server, one PTY per
// connection, renderer drives spawn via the init/spawn protocol so the
// cwd is always the project folder (mirrors the Jul 5 cwd fix on the
// Claude Code panel from day one). Ports: terminal=9223, claude
// code=9224, codex=9225.
//
// Isolation note: no nono wrap here (no farnsworth-codex profile yet).
// codex ships its own macOS Seatbelt sandbox + approval modes — the TUI
// defaults to workspace-write with approval prompts, which is the same
// isolation class the nono wrap gives Claude Code. Revisit if we want a
// nono profile layered on top.
//
// Session resume note: unlike claude, codex has no `--session-id <uuid>`
// pre-assignment we can persist and `--resume` by. Tabs persist their
// labels across restarts but each PTY starts a fresh codex session.
// `codex resume` picker support is a v2 item.
const CODEX_WS_PORT = 9225;
let codexWss = null;

function startCodexServer() {
  if (!pty) {
    console.error('[codex] node-pty unavailable; Codex panel disabled');
    return;
  }
  // Mark the workspace trusted in ~/.codex/config.toml so codex's
  // first-run "Do you trust this folder?" prompt is skipped — mirrors
  // markWorkspaceTrusted on the Claude Code side (~/.claude.json).
  // config.toml projects-table shape:
  //   [projects."/Users/long/Documents/foo"]
  //   trust_level = "trusted"
  // String-level check + append (no TOML parser dep). Appending a
  // top-level [projects."..."] table header at EOF is always valid TOML
  // regardless of what table the file currently ends inside.
  const markCodexTrusted = (cwd) => {
    if (!cwd) return;
    try {
      const dir = path.join(os.homedir(), '.codex');
      const cfgPath = path.join(dir, 'config.toml');
      fsSync.mkdirSync(dir, { recursive: true });
      let raw = '';
      try { raw = fsSync.readFileSync(cfgPath, 'utf8'); } catch {}
      if (raw.includes(`[projects."${cwd}"]`)) return; // already present
      const block = `${raw && !raw.endsWith('\n') ? '\n' : ''}\n[projects."${cwd}"]\ntrust_level = "trusted"\n`;
      fsSync.writeFileSync(cfgPath, raw + block, 'utf8');
    } catch (e) {
      console.warn('[codex] could not mark workspace trusted:', e.message);
    }
  };
  markCodexTrusted((db.getSetting && db.getSetting('currentFolder')) || os.homedir());
  if (codexWss) return;

  const codexPathAtBoot = findCodexPath();
  if (!codexPathAtBoot) {
    console.error('[codex] codex binary not found on PATH or candidate paths; Codex panel will show the install/sign-in card');
  } else {
    console.log(`[codex] using codex at: ${codexPathAtBoot}`);
  }

  codexWss = new WebSocket.Server({ port: CODEX_WS_PORT });
  codexWss.on('connection', (ws) => {
    // cwd protocol mirrors the Claude Code panel: renderer sends `init`
    // with state.folder before `spawn`, so the PTY lands in the project
    // folder even when the panel mounts before a folder is opened.
    let cwd = (db.getSetting && db.getSetting('currentFolder')) || os.homedir();
    const tabId = 'cx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    let term = null;
    let spawned = false;
    let initialized = false;
    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.once('message', (raw) => {
      if (initialized) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'init') return;
      initialized = true;
      if (typeof msg.cwd === 'string' && msg.cwd.length > 0) {
        cwd = msg.cwd;
      }
    });
    setTimeout(() => { initialized = true; }, 2000);

    const spawnFor = () => {
      if (spawned) return;
      spawned = true;
      // Re-resolve at spawn time — the user may have installed codex
      // after Farnsworth booted (the sign-in card's Re-check path).
      const codexBin = findCodexPath() || 'codex';
      markCodexTrusted(cwd);
      try {
        const bundledBin = path.join(process.resourcesPath || '', 'bin');
        const newPath = [bundledBin, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
          .filter(Boolean)
          .join(':');
        term = pty.spawn(codexBin, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', PATH: newPath },
        });
      } catch (e) {
        send({ type: 'error', message: 'codex pty.spawn failed: ' + e.message + ' — is `codex` on PATH? Install with `brew install codex`.' });
        ws.close();
        return;
      }
      term.onData((data) => send({ type: 'data', data }));
      term.onExit(({ exitCode, signal }) => {
        send({ type: 'exit', exitCode, signal });
        ws.close();
      });
      send({ type: 'ready', tabId });
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'spawn') {
        spawnFor();
      } else if (term && msg.type === 'data') {
        term.write(msg.data);
      } else if (term && msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try { term.resize(msg.cols, msg.rows); } catch {}
      } else if (term && msg.type === 'close') {
        try { term.kill(); } catch {}
      }
    });
    ws.on('close', () => {
      try { term && term.kill(); } catch {}
    });
    ws.on('error', () => {
      try { term && term.kill(); } catch {}
    });
  });
  console.log(`[codex] WebSocket server listening on ws://localhost:${CODEX_WS_PORT}`);
}

ipcMain.handle('codex:getWsUrl', () => `ws://localhost:${CODEX_WS_PORT}`);
ipcMain.handle('codex:close', async (_event, tabId) => {
  // Symmetry with claudeCode:close — the WS close handler in main does
  // the actual PTY cleanup.
  return { ok: true, tabId };
});

// Codex panel tab persistence — same shape as `claudeCode.tabs` minus
// sessionId (no resume surface, see the note on startCodexServer).
// Shape stored at `codex.tabs`:
//   { tabs: [{ id: 'cx-1', label: 'codex', createdAt: '...' }], activeId: 'cx-1' }
ipcMain.handle('codex:listTabs', async () => {
  try {
    const raw = db.getSetting('codex.tabs');
    if (!raw) return { ok: true, tabs: [], activeId: null };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      ok: true,
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      activeId: parsed.activeId || null,
    };
  } catch (e) {
    return { ok: false, error: e.message, tabs: [], activeId: null };
  }
});

ipcMain.handle('codex:saveTabs', async (_event, state) => {
  try {
    if (!state || !Array.isArray(state.tabs)) {
      return { ok: false, error: 'tabs must be an array' };
    }
    db.setSetting('codex.tabs', {
      tabs: state.tabs,
      activeId: state.activeId || null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Auth gate for the Codex panel — reads ~/.codex/auth.json (the same
// source auth:codexStatus uses for the Settings → AI OpenAI section;
// this handler adds the binary check + the panel-shaped response).
// auth.json shapes seen in the wild: { OPENAI_API_KEY } (API-key login)
// or { tokens: { id_token, access_token, account_id } } (ChatGPT login).
ipcMain.handle('codex:checkAuth', async () => {
  const codexPath = findCodexPath();
  if (!codexPath) {
    return { ok: false, hasAuth: false, source: 'no_binary', message: 'Codex CLI not found. Install with: brew install codex (or npm i -g @openai/codex)' };
  }
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fsSync.existsSync(p)) {
      return { ok: true, hasAuth: false, source: 'no_auth_json', message: 'Codex CLI is not signed in.' };
    }
    const raw = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    const method = raw?.tokens?.access_token ? 'chatgpt'
      : (raw?.OPENAI_API_KEY ? 'api_key' : null);
    if (method) return { ok: true, hasAuth: true, source: 'auth_json', method };
    return { ok: true, hasAuth: false, source: 'auth_json_empty', message: 'auth.json exists but has no usable credentials.' };
  } catch (e) {
    return { ok: false, hasAuth: false, source: 'auth_json_error', message: 'auth.json read failed: ' + e.message };
  }
});

ipcMain.handle('codex:runLogin', async () => {
  // Spawns `codex login` (starts a localhost:1455 callback server + opens
  // the browser for ChatGPT sign-in), waits for exit, then verifies
  // ~/.codex/auth.json got written. Mirrors claudeCode:runLogin.
  const { spawn } = require('child_process');
  const codexPath = findCodexPath();
  if (!codexPath) {
    return { ok: false, error: 'codex_not_found', message: 'Codex CLI not found. Install with: brew install codex (or npm i -g @openai/codex)' };
  }
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexPath, ['login'], { stdio: 'ignore', detached: false });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed', message: 'Failed to spawn `codex login`: ' + e.message });
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: 'timeout', message: '`codex login` timed out after 5 minutes.' });
    }, 5 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return resolve({ ok: false, error: 'codex_login_failed', message: '`codex login` exited with code ' + code });
      }
      try {
        const p = path.join(os.homedir(), '.codex', 'auth.json');
        if (fsSync.existsSync(p)) {
          const raw = JSON.parse(fsSync.readFileSync(p, 'utf8'));
          if (raw?.tokens?.access_token || raw?.OPENAI_API_KEY) {
            return resolve({ ok: true, hasAuth: true, codexLoginRan: true });
          }
        }
      } catch {}
      resolve({ ok: false, error: 'no_auth_after_login', message: '`codex login` exited but ~/.codex/auth.json has no credentials.' });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: 'spawn_failed', message: '`codex login` child error: ' + err.message });
    });
  });
});

ipcMain.handle('terminal:getWsUrl', () => `ws://localhost:${TERMINAL_WS_PORT}`);

// Relay IPC: renderer → main → relay
ipcMain.handle('relay:send', async (_event, msg) => {
  const rc = getRelayClient();
  return rc.send(msg);
});
ipcMain.handle('relay:status', async () => {
  const rc = getRelayClient();
  return rc.status;
});

// ------------------------------------------------------------
// Terminal PTY registry — tracks active PTYs so the agent's
// run_command can pipe its command into the most-recently-active
// terminal tab for visual feedback. The actual command execution
// runs via child_process.exec so the output is captured reliably.
// ------------------------------------------------------------
const terminalPtys = new Map(); // ws -> { pty, lastActivity }

function getActiveTerminalPty() {
  let best = null;
  let latest = 0;
  for (const [ws, entry] of terminalPtys.entries()) {
    if (ws.readyState === 1 /* OPEN */ && entry.lastActivity > latest) {
      latest = entry.lastActivity;
      best = entry.pty;
    }
  }
  return best;
}

async function runShellCommand(command, opts = {}) {
  const folder = db.getSetting('currentFolder');
  if (!folder) return { ok: false, error: 'no_folder', message: 'No workspace folder open' };
  if (!command || typeof command !== 'string') return { ok: false, error: 'bad_input', message: 'command required' };
  const pipeToActiveTerminal = opts.pipeToActiveTerminal !== false;
  const sandboxProfile = opts.sandboxProfile || null;
  // If a sandbox profile is requested, spawn through nono wrap so the
  // command runs under Seatbelt. This is the chat-agent run_command
  // path -- without it, an LLM could prompt-inject into reading
  // ~/.aws/credentials or exfiltrating via curl. Profile selection
  // decides what's allowed (see ~/.config/nono/profiles/).
  // Verified Jul 13 ~17:35 ET: farnsworth-chat-run profile blocks reads
  // on ~/.aws/.ssh/.gnupg/.config/gh + outside-cwd writes; cwd is rw;
  // shells run. Network allowlist is best-effort in nono v0.66 profile
  // field (CLI flag enforces strictly, profile field doesn't).
  if (sandboxProfile) {
    const nonoBin = findNonoPath();
    if (nonoBin) {
      return await runSandboxedCommand(nonoBin, sandboxProfile, command, folder);
    }
    console.warn('[runShellCommand] sandbox profile requested but nono not found, running unsandboxed');
  }
  const { exec } = require('child_process');
  // pipeToActiveTerminal defaults true to preserve the prior
  // terminal:runCommand IPC behavior. The chat agent's executeTool path
  // passes { pipeToActiveTerminal: false } because the agent already has
  // the captured stdout/stderr and re-typing the command into the PTY would
  // (a) be visually noisy (it switches the user to the terminal panel) and
  // (b) re-execute side-effecting commands a second time. The terminal chip
  // in the chat message renders the captured output inline.
  return await new Promise((resolve) => {
    exec(command, { cwd: folder, maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (pipeToActiveTerminal) {
        const activePty = getActiveTerminalPty();
        if (activePty) {
          try { activePty.write(command + '\n'); } catch {}
        }
      }
      resolve({
        ok: !err || err.code === 0,
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      });
    });
  });
}

// Spawn a command under `nono wrap --profile <name> --allow-cwd -- sh -c <command>`.
// Captures stdout/stderr via streams + applies a 30s timeout to match
// the plain exec() path. Returns the same shape as runShellCommand.
//
// --allow-cwd is load-bearing: nono v0.66's wrap otherwise resets the
// wrapped process's cwd to '/' (it does NOT honor the spawn() cwd or the
// profile's workdir.access setting without --allow-cwd). With cwd reset
// to '/', any agent command using relative paths (grep ., ls, find .,
// npm scripts, etc.) recursively walks the entire macOS filesystem,
// easily exceeding the 30s timeout and orphaning the spawn. See
// [[farnsworth-chat-agent]] § run_command nono-wrap cwd bug (Jul 14).
async function runSandboxedCommand(nonoBin, profileName, command, folder) {
  const { spawn } = require('child_process');
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(
      nonoBin,
      ['wrap', '--profile', profileName, '--allow-cwd', '--', '/bin/sh', '-c', command],
      { cwd: folder, env: { ...process.env } }
    );
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, 30000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout,
        stderr: timedOut ? stderr + '\ntimeout (30s)' : stderr,
        exitCode: timedOut ? 124 : (typeof code === 'number' ? code : 1),
      });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: stderr + '\nnono spawn error: ' + err.message,
        exitCode: 1,
      });
    });
  });
}

ipcMain.handle('terminal:runCommand', async (_event, command) => {
  return await runShellCommand(command);
});

// Close a specific terminal tab by id. Renderer sends the tabId (which is the
// PTY's cwd + an increment) when the user clicks the x on a terminal pill.
ipcMain.handle('terminal:close', async (_event, tabId) => {
  let closed = 0;
  for (const [ws, entry] of terminalPtys.entries()) {
    if (entry.tabId === tabId) {
      try { entry.pty.kill(); } catch {}
      try { ws.close(); } catch {}
      closed++;
    }
  }
  return { ok: true, closed };
});

// ------------------------------------------------------------
// Chat conversations — saved threads persisted in SQLite. The
// renderer auto-saves the active conversation on every update
// (debounced), lists them in a dropdown next to the Chat pill,
// and can switch between them or start a new one.
// ------------------------------------------------------------
function getActiveWorkspacePath() {
  return db.getSetting('currentFolder') || null;
}

ipcMain.handle('chatConv:list', async () => {
  return db.listConversations(getActiveWorkspacePath());
});

ipcMain.handle('chatConv:load', async (_event, id) => {
  const row = db.getConversation(id);
  if (!row) return null;
  try { return { ...row, messages: JSON.parse(row.messages) }; }
  catch { return null; }
});

ipcMain.handle('chatConv:create', async (_event, { id, title, messages } = {}) => {
  const convId = id || 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  db.createConversation(convId, getActiveWorkspacePath(), title || 'New chat', messages || []);
  return { id: convId };
});

ipcMain.handle('chatConv:save', async (_event, { id, title, messages } = {}) => {
  if (!id) return { ok: false, error: 'no_id' };
  db.saveConversation(id, title || 'Untitled', messages || []);
  return { ok: true };
});

ipcMain.handle('chatConv:delete', async (_event, id) => {
  if (!id) return { ok: false, error: 'no_id' };
  db.deleteConversation(id);
  return { ok: true };
});

// ============================================================================
// Credential surfaces — secure secret storage via OS keychain (keytar).
//
// Used by the `credential` chat surface when Claude needs an API key or
// other secret the user must enter. The renderer-side form captures the
// value; main-side IPCs write to / read from keychain. Secret values are
// NEVER logged or persisted to chat history.
// ============================================================================

ipcMain.handle('credential:promptSecret', async (_event, { service, account, value } = {}) => {
  if (!service) return { ok: false, error: 'no_service' };
  if (!value || typeof value !== 'string') return { ok: false, error: 'no_value' };
  try {
    await keytar.setPassword(service, account || 'farnsworth', value);
    return { ok: true, service, account: account || 'farnsworth' };
  } catch (e) {
    console.warn('[credential] keytar write failed: ' + (e?.message || e));
    return { ok: false, error: e.message || 'storage_failed' };
  }
});

ipcMain.handle('credential:readSecret', async (_event, { service, account } = {}) => {
  if (!service) return { ok: false, error: 'no_service' };
  try {
    const value = await keytar.getPassword(service, account || 'farnsworth');
    if (value == null) return { ok: false, error: 'not_found' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e.message || 'read_failed' };
  }
});

ipcMain.handle('credential:deleteSecret', async (_event, { service, account } = {}) => {
  if (!service) return { ok: false, error: 'no_service' };
  try {
    const removed = await keytar.deletePassword(service, account || 'farnsworth');
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e.message || 'delete_failed' };
  }
});
