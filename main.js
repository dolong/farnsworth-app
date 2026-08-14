// Farnsworth — main process
// Electron desktop shell. SQLite-backed persistence (db.js), folder-based workspace,
// Claude auth (manual API key + OAuth PKCE via claude.ai), real file operations.

const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, shell, dialog, safeStorage, Menu, session, clipboard, nativeImage } = require('electron');
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

// ---- Instance identity (Jul 30) ------------------------------------------
// Farnsworth can now run more than once on a machine:
//
//     open -n -a Farnsworth --args --instance=lastdraft
//
// Each named instance is independently addressable from the companion, so
// "mini running last-draft" and "mini running dontdie" are two things you can
// pick between on your phone.
//
// What actually blocked this before: three fixed WebSocket ports
// (9223/9224/9225), a fixed CDP port, one SQLite DB, and
// app.requestSingleInstanceLock(). The lock was added Jul 28 because without
// it a second launch collided on all of them and half-initialized.
//
// The split below is deliberately narrow. Only the CHROMIUM PROFILE is
// per-instance; the SQLite DB, memory and settings stay shared. That gets us:
//   - an independent single-instance lock per name (Chromium's ProcessSingleton
//     is keyed on the user-data dir, so this comes for free and still stops
//     the SAME instance opening twice)
//   - an independent DevToolsActivePort per instance
//   - independent window state
// while keeping one set of API keys, one memory store and one conversation
// history across every instance. Splitting the DB too would mean re-entering
// credentials per instance, which is not what anyone wants.
function resolveInstanceName() {
  const fromArgv = process.argv.find((a) => a.startsWith('--instance='));
  const raw = fromArgv
    ? fromArgv.slice('--instance='.length)
    : (process.env.FARNSWORTH_INSTANCE || '');
  // Used in file paths and a relay identity, so keep it boring.
  const cleaned = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return cleaned || 'default';
}
const INSTANCE_NAME = resolveInstanceName();
const IS_DEFAULT_INSTANCE = INSTANCE_NAME === 'default';

// Captured BEFORE setPath so shared state keeps resolving to the canonical
// location for every instance. Must run before app ready and before anything
// touches userData.
const SHARED_USER_DATA = app.getPath('userData');
if (!IS_DEFAULT_INSTANCE) {
  app.setPath('userData', path.join(SHARED_USER_DATA, 'instances', INSTANCE_NAME));
  process.env.FARNSWORTH_INSTANCE = INSTANCE_NAME; // inherited by child processes
}

// The workspace folder is per-instance — that is the whole point of running
// two. Everything else in settings stays global. Reads and writes both go
// through this so the renderer can keep saying 'currentFolder'.
// Settings that describe "what this window is looking at" rather than a user
// preference. They must not be shared across instances: SHARED_USER_DATA gives
// every instance the same SQLite file, so an unscoped key means a named dev
// instance silently reassigns the default app's open folder / active chat.
// (Aug 5: a test instance clobbered chat.activeId for exactly this reason.)
const PER_INSTANCE_SETTING_KEYS = new Set(['currentFolder', 'chat.activeId']);

// Runtime view state that lives in the settings table but is NOT a user
// preference. These must never ride the bulk settings:get/settings:set path.
//
// The renderer seeds state.settings from getAllSettings() at boot and later
// writes the WHOLE object back via persistSettings(). That means every one of
// these keys gets frozen at boot and re-stamped on any unrelated settings
// change -- so opening a folder, then toggling a setting, silently restored
// the PREVIOUS folder and pointed the chat agent at the wrong repo while the
// UI still showed the right one. (Aug 7: Long, one window, the-last-draft on
// screen, agent running in my-devvit-game.)
//
// Written and read through the single-key setting:get / setting:set IPCs only.
const RUNTIME_STATE_KEY_PREFIXES = ['currentFolder', 'chat.activeId', 'claudeCode.tabs', 'codex.tabs'];
function isRuntimeStateKey(key) {
  if (typeof key !== 'string') return false;
  // Covers both the bare key and its per-instance form ('currentFolder:dev').
  return RUNTIME_STATE_KEY_PREFIXES.some((p) => key === p || key.startsWith(p + ':'));
}

function scopedSettingKey(key) {
  if (PER_INSTANCE_SETTING_KEYS.has(key) && !IS_DEFAULT_INSTANCE) {
    return `${key}:${INSTANCE_NAME}`;
  }
  return key;
}
// Per-window workspace registry. The settings table holds ONE currentFolder,
// but Farnsworth is multi-window: with two windows open, that single value
// describes only whichever opened a folder last, so every agent action in the
// other window ran in the wrong repo. The renderer announces its folder on
// every open/close via workspace:setActive; main keys it by webContents id.
const windowWorkspaces = new Map(); // webContents.id -> folder path

// The folder for the window that made THIS request. Falls back to the global
// setting for callers with no event (timers, relay, companion bridges).
function folderForEvent(event) {
  const id = event && event.sender && !event.sender.isDestroyed() ? event.sender.id : null;
  if (id != null && windowWorkspaces.has(id)) return windowWorkspaces.get(id) || null;
  return currentFolderSetting();
}

ipcMain.handle('workspace:setActive', async (event, folder) => {
  const id = event && event.sender ? event.sender.id : null;
  if (id == null) return { ok: false, error: 'no_sender' };
  if (folder) windowWorkspaces.set(id, folder);
  else windowWorkspaces.delete(id);
  return { ok: true };
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('destroyed', () => windowWorkspaces.delete(contents.id));
});

function currentFolderSetting() {
  if (!db.getSetting) return null;
  const v = db.getSetting(scopedSettingKey('currentFolder'));
  // Heal DBs that already contain the stringified-null poison described on
  // db.deleteSetting -- 'null' is truthy and would be used as a real path.
  if (!v || v === 'null' || v === 'undefined' || v === '""') return null;
  return v;
}

// Fixed WebSocket ports are the reason only one Farnsworth could run per
// machine. The DEFAULT instance keeps its historic ports so anything pointing
// at 9223/9224/9225 by hand still works; every named instance binds port 0 and
// lets the OS assign. The renderer never hardcoded these -- it always asked
// main via terminal:getWsUrl / claudeCode:getWsUrl / codex:getWsUrl -- so this
// is invisible to the UI.
function preferredWsPort(defaultPort) {
  return IS_DEFAULT_INSTANCE ? defaultPort : 0;
}

// Resolves to the port the OS actually bound, or null if the server failed to
// start. getWsUrl awaits this so a renderer that asks early doesn't race the
// bind.
function wsBoundPort(wss) {
  return new Promise((resolve) => {
    if (!wss) return resolve(null);
    const addr = wss.address && wss.address();
    if (addr && addr.port) return resolve(addr.port);
    wss.on('listening', () => resolve(wss.address().port));
    wss.on('error', () => resolve(null));
  });
}

// ---- CDP debugging port for the test runner (Jul 29) --------------------
// farnsworth-test.py drives the canvas preview over the Chrome DevTools
// Protocol, so Electron has to be LISTENING on a debugging port. Nothing in
// main.js ever enabled one. It only ever worked on the dev machine because
// that tree gets launched by hand with --remote-debugging-port=9222, so every
// installed build refused the connection -- surfacing as a 40-line Python
// traceback ending in "[Errno 61] Connection refused" that read like a bug in
// the runner rather than a missing flag in the host app.
//
// Must be appended BEFORE app ready. Chromium binds this to loopback only.
// Set FARNSWORTH_CDP_PORT to move it, or to "off" to disable entirely.
function resolveCdpPortRequest() {
  const fromArgv = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
  if (fromArgv) return { port: fromArgv.split('=')[1], alreadySet: true };
  const fromEnv = process.env.FARNSWORTH_CDP_PORT;
  if (fromEnv === 'off' || fromEnv === '0') return { port: null, alreadySet: false };
  if (fromEnv) return { port: fromEnv, alreadySet: false };
  // Named instances must not fight the default instance for 9222 -- the loser
  // gets "bind() failed: Address already in use" and no devtools server at
  // all. '0' asks Chromium for any free port; activeCdpPort() reads the real
  // one back from DevToolsActivePort, which is per-instance now.
  return { port: IS_DEFAULT_INSTANCE ? '9222' : '0', alreadySet: false };
}
const CDP_REQUEST = resolveCdpPortRequest();
if (CDP_REQUEST.port && !CDP_REQUEST.alreadySet) {
  app.commandLine.appendSwitch('remote-debugging-port', CDP_REQUEST.port);
}
// Chromium >=111 REJECTS any CDP WebSocket handshake that carries an Origin
// header ("403 Rejected an incoming WebSocket connection from the ... origin")
// unless that origin is allow-listed. Python's websocket-client sends one by
// default, so an open port alone is not enough -- found Jul 29 while verifying
// the port fix, and it would have shipped as a second silent failure. Scoped to
// loopback only; NOT '*'.
if (CDP_REQUEST.port && CDP_REQUEST.port !== '0') {
  app.commandLine.appendSwitch(
    'remote-allow-origins',
    ['http://127.0.0.1:' + CDP_REQUEST.port, 'http://localhost:' + CDP_REQUEST.port].join(',')
  );
}

// The port Chromium ACTUALLY bound is written to DevToolsActivePort in
// userData. Prefer it over the requested value: they differ when the
// requested port was already taken (e.g. a dev-tree instance on 9222).
function activeCdpPort() {
  try {
    const f = path.join(app.getPath('userData'), 'DevToolsActivePort');
    const first = fsSync.readFileSync(f, 'utf8').split('\n')[0].trim();
    if (first) return first;
  } catch {}
  return CDP_REQUEST.port;
}

// Probe the port before spawning python. Without this the failure arrives as
// a Python traceback; with it, one readable line.
function checkCdpReachable(port) {
  return new Promise((resolve) => {
    if (!port) return resolve({ ok: false, reason: 'disabled' });
    const req = require('http').get(
      { host: '127.0.0.1', port: Number(port), path: '/json/version', timeout: 2000 },
      (res) => { res.resume(); resolve({ ok: res.statusCode === 200 }); }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', () => resolve({ ok: false, reason: 'refused' }));
  });
}

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

// ---------------------------------------------------------------------------
// Update state, broadcast to the renderer (Jul 29).
//
// Before this, the three updater events only called console.log/console.warn.
// Nothing reached the UI, so an update downloaded silently and the user had no
// way to know it was waiting, no progress while 350 MB came down, and a FAILED
// update was completely invisible (that is how ERR_UPDATER_ZIP_FILE_NOT_FOUND
// hid for nine releases: the only handler was a warn nobody reads).
//
// Why a RETAINED state object rather than pure event forwarding: the updater
// starts checking as soon as the app is ready, which is BEFORE the renderer has
// finished loading and subscribed. Any event fired in that gap is lost forever.
// The renderer asks for updater:state on init and catches up to whatever
// already happened.
// ---------------------------------------------------------------------------
let updaterState = {
  status: 'idle',   // idle | checking | available | downloading | ready | current | error | offline
  version: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: null,
  checkedAt: null,
};

function broadcastUpdaterState(patch) {
  updaterState = { ...updaterState, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send('updater:state', updaterState); } catch {}
  }
}

// A user who is simply offline must not get an error banner every few hours.
// Network failures are expected and uninteresting; anything else is a real bug
// worth showing, because the whole reason macOS auto-update was broken for nine
// releases is that its errors were silent.
function isNetworkError(err) {
  const s = ((err && (err.code || err.message)) || '').toString();
  return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETDOWN|ENETUNREACH|net::|getaddrinfo|socket hang up/i.test(s);
}

autoUpdater.on('checking-for-update', () => {
  console.log('[autoUpdater] checking for update');
  broadcastUpdaterState({ status: 'checking', message: null });
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[autoUpdater] up to date:', info?.version);
  broadcastUpdaterState({ status: 'current', version: info?.version || app.getVersion(), checkedAt: Date.now() });
});

autoUpdater.on('update-available', (info) => {
  console.log('[autoUpdater] update available:', info?.version);
  broadcastUpdaterState({ status: 'available', version: info?.version || null, percent: 0, checkedAt: Date.now() });
});

// This is the event that makes a 350 MB download feel like something is
// happening instead of nothing. autoDownload is true, so it fires on its own.
autoUpdater.on('download-progress', (p) => {
  broadcastUpdaterState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round(p?.percent || 0))),
    transferred: p?.transferred || 0,
    total: p?.total || 0,
    bytesPerSecond: p?.bytesPerSecond || 0,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[autoUpdater] update downloaded:', info?.version, '- restart to apply');
  broadcastUpdaterState({ status: 'ready', version: info?.version || null, percent: 100 });
});

autoUpdater.on('error', (err) => {
  const msg = (err && (err.message || err.code)) || String(err);
  if (isNetworkError(err)) {
    console.log('[autoUpdater] check skipped (offline/network):', msg);
    broadcastUpdaterState({ status: 'offline', message: null });
    return;
  }
  console.error('[autoUpdater] error:', msg);
  broadcastUpdaterState({ status: 'error', message: msg });
});

// Renderer asks for this on init so it can catch up on events that fired
// before it was listening (see the comment on updaterState above).
ipcMain.handle('updater:state', async () => ({ ...updaterState, currentVersion: app.getVersion() }));

// `app.isPackaged` LIES in this dev tree. Electron implements it as
// `path.basename(process.execPath) !== 'electron'` -- and we renamed the dev
// Electron bundle to Farnsworth.app (for the Dock icon), so execPath ends in
// "Farnsworth" and isPackaged reports TRUE while running from source.
//
// Result: the boot update check fired on the dev tree and electron-updater
// died on ENOENT app-update.yml, leaving a permanent "Update failed" pill.
//
// `process.defaultApp` is the honest signal (set when Electron is launched
// with a path argument, i.e. `electron <dir>`), and the app-update.yml probe
// is belt-and-braces: it is the exact file electron-updater needs, so if it
// is absent there is nothing to check against no matter how we got here.
function updatesSupported() {
  if (process.defaultApp) return false;
  if (!app.isPackaged) return false;
  try {
    return fsSync.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch {
    return false;
  }
}

// Manual "check now", for the user who does not want to wait for the timer.
ipcMain.handle('updater:check', async () => {
  if (!updatesSupported()) return { ok: false, error: 'Updates are disabled in a dev build.' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    const msg = (err && (err.message || err.code)) || String(err);
    // The event handler already broadcast this; just report it back to the call.
    return { ok: false, error: msg };
  }
});

// Install now. autoInstallOnAppQuit is also true, so if quitAndInstall is ever
// blocked the update still lands on the next normal quit. Verified end to end:
// a SIGTERM quit was enough for ShipIt to swap the bundle.
ipcMain.handle('updater:restart', async () => {
  if (updaterState.status !== 'ready') {
    return { ok: false, error: 'No downloaded update is waiting.' };
  }
  // Let the reply reach the renderer before the app goes away.
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      console.error('[autoUpdater] quitAndInstall failed:', err?.message || err);
      broadcastUpdaterState({ status: 'error', message: 'Could not restart to install: ' + (err?.message || err) });
    }
  }, 250);
  return { ok: true };
});

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
    // Login-shell PATH (nvm/fnm/volta/asdf/mise) -- `which` above runs with
    // Electron's launchd PATH, which never sees a version manager's shims.
    ...getUserShellPathDirs().map((d) => path.join(d, 'claude')),
    // npm -g installs land in the version manager's bin dir, which the
    // shell probe can miss (it skips .zshrc). Independent discovery.
    ...discoverToolchainDirs().map((d) => path.join(d, 'claude')),
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
    // Login-shell PATH (nvm/fnm/volta/asdf/mise) -- `which` above runs with
    // Electron's launchd PATH, which never sees a version manager's shims.
    ...getUserShellPathDirs().map((d) => path.join(d, 'codex')),
    // npm -g installs land in the version manager's bin dir, which the
    // shell probe can miss (it skips .zshrc). Independent discovery.
    ...discoverToolchainDirs().map((d) => path.join(d, 'codex')),
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
    // Login-shell PATH (nvm/fnm/volta/asdf/mise) -- `which` above runs with
    // Electron's launchd PATH, which never sees a version manager's shims.
    ...getUserShellPathDirs().map((d) => path.join(d, 'nono')),
    // npm -g installs land in the version manager's bin dir, which the
    // shell probe can miss (it skips .zshrc). Independent discovery.
    ...discoverToolchainDirs().map((d) => path.join(d, 'nono')),
    '/opt/homebrew/bin/nono',
    '/usr/local/bin/nono',
    path.join(process.env.HOME || '', '.local', 'bin', 'nono'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Resolve a nono profile to an absolute PATH inside the app (Jul 28).
//
// Both nono spawn sites used to pass a bare profile NAME, which nono resolves
// against ~/.config/nono/profiles/ — a directory that only ever existed on the
// one machine where the profiles were hand-authored. Everywhere else the
// Claude Code panel died at spawn with "nono: Profile not found:
// farnsworth-claude", and chat-agent run_command silently fell back to
// UNSANDBOXED exec. Same class as index.html / devvit-emulator missing from
// the asar: it worked only on the machine that had the un-shipped file.
//
// nono's --profile takes <NAME_OR_PATH>, so hand it a path to the copy that
// ships in nono-profiles/. The path must point at app.asar.unpacked in
// packaged builds — nono is a separate process with no asar support, exactly
// like the devvit-emulator loader. No-op in the dev tree.
function resolveNonoProfile(name) {
  const fs = require('fs');
  const path = require('path');
  const bundled = path
    .join(__dirname, 'nono-profiles', `${name}.json`)
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  try { if (fs.existsSync(bundled)) return bundled; } catch {}
  // Fall back to the bare name so a hand-authored profile in
  // ~/.config/nono/profiles/ still resolves if the bundled copy is missing.
  console.warn(`[nono] bundled profile missing at ${bundled} — falling back to name "${name}"`);
  return name;
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
const devicePairing = require('./src/device-pairing');

let mainWindow;
// Track all open Farnsworth windows so the Window menu can list them and
// "New Window" can spawn a sibling instead of stealing focus from the
// focused one. mainWindow stays as a reference for single-window flows.
const openWindows = [];
// Deliberately SHARED_USER_DATA, not app.getPath('userData').
//
// A named instance calls app.setPath('userData', .../instances/<name>) so
// Chromium gets its own profile (and, usefully, its own ProcessSingleton
// lock). But this path is the DATA root -- SQLite db, settings, memory,
// encrypted API keys. Deriving it from the relocated userData gave every
// named instance a brand-new EMPTY database: no API keys, no chat history,
// no workspace folder. Verified: launching --instance=<name> silently
// created .../instances/<name>/farnsworth/farnsworth.db.
//
// It also made "the shared DB is untouched" look true when checked by mtime,
// because the instance was busy writing a different file entirely.
const userDataPath = () => path.join(SHARED_USER_DATA, 'farnsworth');

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
        { label: 'New Window', accelerator: 'Cmd+N', click: () => createWindow({ fresh: true }) },
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
        // Preview devtools is a DIFFERENT webContents from the app renderer —
        // ⌥⌘I inspects Farnsworth's own UI, ⇧⌘I inspects the game/app running
        // in the canvas. Falls back to the focused window's devtools when no
        // WebContentsView preview is open (e.g. Post View). (Jul 25)
        {
          label: 'Inspect Canvas Preview',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const view = canvasWebContentsViews.values().next().value;
            if (view) {
              try {
                const wc = view.webContents;
                wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
              } catch {}
              return;
            }
            const w = BrowserWindow.getFocusedWindow();
            if (w) { try { w.webContents.toggleDevTools(); } catch {} }
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // ---- Window ----
    {
      label: 'Window',
      submenu: [
        { label: 'New Window', accelerator: 'Cmd+Shift+N', click: () => createWindow({ fresh: true }) },
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
          label: 'Check for Updates…',
          // Manual trigger for the same autoUpdater.checkForUpdates() the
          // 6-hour background timer calls (Jul 29, v0.1.13). Routed through
          // 'menu:action' -> renderer so the result can surface as a toast:
          // the pill itself stays silent for 'current'/'offline' on purpose
          // (see updaterState comments), but a user who explicitly asked
          // deserves an answer even when the answer is "nothing to do".
          click: () => sendMenuAction('checkForUpdates'),
        },
        { type: 'separator' },
        {
          label: 'Farnsworth on GitHub',
          // Was TheAnomalyXYZ/farnsworth, which 404s -- wrong org and wrong
          // repo name. The real repo is dolong/farnsworth-app.
          click: () => openExternalSafe('https://github.com/dolong/farnsworth-app'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// `fresh: true` opens a window in the unopened-folder state (welcome overlay,
// no project loaded) instead of restoring the most recent folder. Every window
// used to restore recent[0], so File > New Window produced a second copy of the
// project you were already in, canvas and all -- there was no way to open a
// window FOR a different folder. The flag rides in as a query param because the
// renderer needs it during init(), before any IPC round-trip would resolve.
function createWindow({ fresh = false } = {}) {
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
  mainWindow.loadFile(
    path.join(__dirname, 'index.html'),
    fresh ? { query: { fresh: '1' } } : undefined,
  );

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
  // Capture THIS window. Every reference below used the module-global
  // `mainWindow`, which createWindow() reassigns -- so once a second window
  // existed, closing the FIRST one read the second window's _closeInProgress
  // flag, flushed the second window's renderer, and marked it mid-close.
  const win = mainWindow;
  win.on('close', async (event) => {
    if (win._closeInProgress) return;
    event.preventDefault();
    win._closeInProgress = true;
    try {
      try { if (prodSession?.owner === win) { prodCanvasActive = false; await stopProdSession('window-close'); } } catch {}
      // Ask the renderer to flush any pending save synchronously. The
      // 500ms debounce in saveActiveConversation would otherwise lose
      // data on a quick X-click. executeJavaScript awaits the promise,
      // so we know the DB write has flushed before we close.
      await win.webContents.executeJavaScript(
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
      // Quit only when this was the last window. Unconditional app.quit()
      // meant closing any one window killed every other open window with it,
      // which made multi-window unusable the moment you used it.
      const others = BrowserWindow.getAllWindows()
        .filter((w) => w !== win && !w.isDestroyed());
      if (others.length === 0) app.quit();
      else { try { win.destroy(); } catch { /* already gone */ } }
    }
  });

  // Track this window in openWindows so the Window menu can list it.
  // When a window closes, remove it and rebuild the menu so the list
  // stays accurate.
  openWindows.push(win);
  win.on('closed', () => {
    const idx = openWindows.indexOf(win);
    if (idx >= 0) openWindows.splice(idx, 1);
    // Was `mainWindow === openWindows[0]` then reassigned to openWindows[0]:
    // a no-op that left the global pointing at a destroyed window.
    if (mainWindow === win) mainWindow = openWindows[0] || null;
    try { Menu.setApplicationMenu(buildMenu()); } catch {}
  });
  // Rebuild the menu whenever a new window opens so the Window list
  // shows the latest count and titles.
  try { Menu.setApplicationMenu(buildMenu()); } catch {}
}

// ============================================================
// IPC: Settings (SQLite-backed)
// ============================================================
ipcMain.handle('settings:get', async () => {
  // Strip runtime view state so the renderer never holds it in state.settings
  // and therefore cannot write a stale copy back. See isRuntimeStateKey().
  const all = db.getAllSettings() || {};
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (!isRuntimeStateKey(k)) out[k] = v;
  }
  return out;
});

ipcMain.handle('settings:set', async (_event, settings) => {
  // Defence in depth: even if a stale renderer still carries these keys, the
  // bulk path must not be able to write them. The single-key setting:set IPC
  // below is the only supported writer.
  if (settings && typeof settings === 'object') {
    for (const k of Object.keys(settings)) {
      if (isRuntimeStateKey(k)) delete settings[k];
    }
  }
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
  // Must scope identically to setting:set below, or a named instance writes
  // 'chat.activeId:<name>' and then reads the DEFAULT instance's value back.
  // Verified safe: nothing reads 'currentFolder' through this path (main uses
  // currentFolderSetting(), which already scopes).
  return db.getSetting(scopedSettingKey(key));
});
ipcMain.handle('setting:set', async (_event, key, value) => {
  if (!key || typeof key !== 'string') return { ok: false, error: 'bad_key' };
  // Clearing means removing the row, not writing the string 'null'.
  if (value === null || value === undefined) {
    if (db.deleteSetting) db.deleteSetting(scopedSettingKey(key));
    return { ok: true, cleared: true };
  }
  // scopedSettingKey maps 'currentFolder' to a per-instance key when this
  // process was launched with --instance=<name>. The renderer is unaware.
  db.setSetting(scopedSettingKey(key), value);
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
// ---------------------------------------------------------------------------
// Dev servers THIS Farnsworth process started (Jul 30)
// ---------------------------------------------------------------------------
// Quitting Farnsworth used to leave the Devvit dev server + server-runner
// running forever: `dev:farnsworth:stop` kills them, but nothing calls it on
// quit, so every quit leaked a Vite process and a server-runner. Long's mini
// had one 10h51m old, still serving the-last-draft with the IDE closed.
//
// Tracked in memory rather than re-read from ~/.cache/farnsworth-<type>.json at
// quit time ON PURPOSE: that meta path is shared across instances, so a second
// Farnsworth (--instance=<name>) overwrites it. Killing whatever pid the file
// currently holds would let one instance kill another instance's dev server.
// This map only ever holds pids we spawned ourselves.
const spawnedDevServers = new Map(); // type -> { pid, serverPid, metaPath, repoRoot }

// Port authority (Aug 3 2026) — see farnsworth-multi-window-dev-servers.
// Lazily required so a module-load error here can't take down boot; the
// allocator degrades to "always return the preferred/hardcoded port" if
// unavailable, which is exactly today's pre-port-authority behavior.
let _portAlloc = null;
function portAlloc() {
  if (_portAlloc === null) {
    try { _portAlloc = require('./src/dev-port-allocation'); }
    catch (e) { console.warn('[port-alloc] module unavailable:', e.message); _portAlloc = false; }
  }
  return _portAlloc || null;
}

function killTrackedDevServers(reason) {
  if (spawnedDevServers.size === 0) return;
  const fsSyncLocal = require('fs');
  for (const [type, rec] of spawnedDevServers) {
    for (const pid of [rec.pid, rec.serverPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[dev:farnsworth] ${reason}: killed ${type} pid ${pid}`);
      } catch {
        // already gone — nothing to do
      }
    }
    // Clear the meta so the next launch reports unavailable instead of
    // pointing the canvas at a dead pid.
    if (rec.metaPath) { try { fsSyncLocal.unlinkSync(rec.metaPath); } catch {} }
    // Release any leased ports for this repo (port authority, Aug 3 2026).
    if (rec.repoRoot) {
      const pa = portAlloc();
      try { if (pa) pa.releaseAllForRepo(db.getRawDb(), rec.repoRoot); } catch (e) {
        console.warn('[port-alloc] release-on-quit failed:', e.message);
      }
    }
  }
  spawnedDevServers.clear();
}

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
// ---- node/npm discovery (Jul 28) ---------------------------------------
// A GUI-launched Electron app inherits PATH from LaunchServices, which on
// macOS is just /usr/bin:/bin:/usr/sbin:/sbin -- no Homebrew, no version
// manager. Anything we spawn that needs node/npm has to be told where they
// actually are. Rather than hardcoding a guess, ask the user's own login
// shell, which is the one place that definitively knows (it's where nvm/fnm/
// volta/asdf install their shims).
let _userShellPathDirs = null;
function getUserShellPathDirs() {
  if (_userShellPathDirs) return _userShellPathDirs;
  _userShellPathDirs = [];
  try {
    const { execFileSync } = require('child_process');
    const shell = process.env.SHELL || '/bin/zsh';
    // Ask BOTH shell flavors and union the answers. This is load-bearing:
    // `zsh -lc` sources .zprofile but NOT .zshrc, and nvm/fnm/asdf init
    // snippets conventionally live in .zshrc (it's what the installers append).
    // So a plain -l probe on a Mac whose .zprofile runs `brew shellenv`
    // returned exactly '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:...'
    // -- a PATH with no version manager in it. It looked like a success and
    // silently produced the same broken result as no probe at all (Jul 29,
    // reported from a real machine after v0.1.9 shipped). -i sources the rc
    // file; the union keeps whichever flavor actually knows about the
    // toolchain. Markers let us ignore banner noise an rc file prints (p10k,
    // nvm, conda all do). stderr dropped for the same reason -- an interactive
    // shell without a TTY warns about job control. Timeboxed per flavor: a slow
    // rc file must not stall Go Live.
    const seen = new Set();
    for (const flags of ['-ilc', '-lc']) {
      try {
        const out = execFileSync(shell, [flags, 'printf "__FWP__%s__FWP__" "$PATH"'], {
          encoding: 'utf8',
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const parts = out.split('__FWP__');
        if (parts.length < 2) continue;
        for (const d of parts[1].split(':')) {
          if (d && !seen.has(d)) { seen.add(d); _userShellPathDirs.push(d); }
        }
      } catch {
        // This flavor refused (some rc files exit non-interactively, or -i
        // without a TTY is rejected). Try the other one.
      }
    }
  } catch {
    // Non-fatal: fall through to the static candidates below.
  }
  return _userShellPathDirs;
}

// The shell probe must NOT be the only way we find a toolchain. It failed
// exactly that way once already (see getUserShellPathDirs above), and because
// BOTH the child PATH and the sandbox read grants were derived from it, one
// silent miss broke both halves at once. Discover version-manager installs
// directly on disk so the two mechanisms are independent.
//
// Newest version first, so a machine with several installed node versions gets
// the one the user most likely means. Capped: this feeds argv.
let _discoveredToolchainDirs = null;
function discoverToolchainDirs() {
  if (_discoveredToolchainDirs) return _discoveredToolchainDirs;
  const fs = require('fs');
  const home = os.homedir();
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    try { if (fs.statSync(d).isDirectory()) out.push(d); } catch {}
  };

  // Managers that keep one bin dir per installed version.
  const versioned = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
    path.join(home, '.local', 'share', 'mise', 'installs', 'node'),
    path.join(home, '.asdf', 'installs', 'nodejs'),
    path.join(home, '.volta', 'tools', 'image', 'node'),
    path.join(home, 'n', 'n', 'versions', 'node'),
  ];
  for (const base of versioned) {
    let versions;
    try { versions = fs.readdirSync(base); } catch { continue; }
    // Numeric-aware sort so v22 beats v9, newest first.
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions.slice(0, 4)) {
      add(path.join(base, v, 'bin'));
      add(path.join(base, v, 'installation', 'bin')); // fnm layout
    }
  }
  // Managers with a single stable shim dir.
  for (const d of [
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, 'n', 'bin'),
    '/usr/local/n/versions/node',
  ]) add(d);

  _discoveredToolchainDirs = out.slice(0, 24);
  return _discoveredToolchainDirs;
}

// ---- toolchain PATH + sandbox grants (Jul 29) ---------------------------
// Every child-process PATH in this file used to be hand-assembled from
// '/opt/homebrew/bin' + '/usr/local/bin'. That is only correct on a machine
// where the toolchain came from Homebrew. On a Mac using a Node version
// manager (nvm/fnm/volta/asdf/mise/bun), node + npm live under $HOME and are
// invisible -- the chat agent reported "npm: command not found ... no node
// under homebrew or nvm" while node v22 was installed and working in Terminal.
// composeChildPath() puts the user's real login-shell PATH first, then the
// static fallbacks.
// One line, once per session, naming what we actually resolved. Every toolchain
// bug this month was invisible until someone reported a symptom: the v0.1.9 fix
// silently no-op'd because the shell probe returned a PATH with no version
// manager in it and nothing said so. Cheap to print, expensive to be without.
let _toolchainLogged = false;
function logToolchainOnce() {
  if (_toolchainLogged) return;
  _toolchainLogged = true;
  try {
    const fs = require('fs');
    const shellDirs = getUserShellPathDirs();
    const discovered = discoverToolchainDirs();
    const findIn = (dirs, bin) => dirs.find((d) => {
      try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; }
    });
    const nodeFrom = findIn(shellDirs, 'node') ? 'login-shell'
      : findIn(discovered, 'node') ? 'discovered:' + findIn(discovered, 'node')
      : 'NOT FOUND';
    console.log('[toolchain] login-shell dirs=' + shellDirs.length +
      ' discovered=' + discovered.length +
      ' node=' + nodeFrom +
      ' sandboxReadGrants=[' + toolchainReadDirs().join(', ') + ']' +
      ' devvitGrants=[' + devvitStateDirs().join(', ') + ']');
  } catch (err) {
    console.warn('[toolchain] resolution log failed:', err && err.message);
  }
}

function composeChildPath(extra = [], base = process.env.PATH) {
  logToolchainOnce();
  const seen = new Set();
  return [
    ...extra,
    ...getUserShellPathDirs(),
    // Independent of the shell probe on purpose -- see discoverToolchainDirs().
    ...discoverToolchainDirs(),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    ...(base || '/usr/bin:/bin:/usr/sbin:/sbin').split(':'),
  ]
    .filter((d) => d && !seen.has(d) && (seen.add(d), true))
    .join(':');
}

// A correct PATH is necessary but NOT sufficient inside nono: its Seatbelt
// profile denies reading $HOME outside the workspace, so a version-manager
// node is unreadable even when PATH points straight at it -- a PATH lookup
// returns nothing because access(X_OK) is denied. Proven by experiment Jul 29:
// with PATH alone the sandboxed shell found nothing; adding a read-only grant
// on the manager root made node -v + npm -v work.
//
// Grant READ-ONLY (never write), scoped to the toolchain root rather than all
// of $HOME: ~/.nvm, ~/.volta, ~/.asdf, ~/.bun, ~/.local/<x>, and for ~/Library
// three levels deep (never all of ~/Library).
function toolchainGrantRoot(dir) {
  const home = os.homedir();
  if (!dir || !dir.startsWith(home + path.sep)) return null; // system dirs need no grant
  const rel = dir.slice(home.length + 1).split(path.sep).filter(Boolean);
  if (!rel.length) return null;
  // ~/Library needs care: grant the specific named subtree, never ~/Library
  // itself. 'Application Support/<tool>' needs 3 levels; '~/Library/pnpm'
  // is only 2 and would otherwise get PATH but no read grant (denied at exec).
  if (rel[0] === 'Library') {
    if (rel.length >= 3) return path.join(home, rel[0], rel[1], rel[2]);
    if (rel.length === 2) return path.join(home, rel[0], rel[1]);
    return null;
  }
  if (rel[0] === '.local') return rel.length >= 2 ? path.join(home, rel[0], rel[1]) : null;
  return path.join(home, rel[0]);
}

function toolchainReadDirs() {
  const fs = require('fs');
  const out = [];
  const seen = new Set();
  for (const dir of [...getUserShellPathDirs(), ...discoverToolchainDirs()]) {
    const root = toolchainGrantRoot(dir);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    try { if (fs.statSync(root).isDirectory()) out.push(root); } catch {}
    if (out.length >= 12) break; // sanity cap on argv length
  }
  return out;
}

// Git reads its user-level config from $HOME, which the Seatbelt profile denies
// (the profile opens the workspace + toolchain roots, nothing else in $HOME).
// A denied config read is NOT a soft miss: git treats EPERM on a config path as
// fatal and exits 128 with
//   fatal: unable to access '/Users/<u>/.gitconfig': Operation not permitted
// so EVERY git subcommand dies -- status, commit, diff, all of it. The failure
// is invisible on a machine with no ~/.gitconfig (the Mac mini has none, which
// is why this never reproduced here) and total on one that has it (Long's
// MacBook Pro, Jul 29). Worse, the chat agent sees a bare non-zero exit and
// invents an explanation -- it told Long no workspace folder was open.
//
// Grant READ-ONLY on the config files only. Deliberately NOT granted:
//   ~/.git-credentials  -- plaintext tokens
//   ~/.ssh              -- profile denies it, keep it denied
// and deliberately read-only rather than --allow-file, because `credential.helper`
// in a writable .gitconfig is an arbitrary-command-execution vector for a
// prompt-injected agent. `git config --global` therefore still fails, which is
// the correct trade: the agent has no business rewriting global git config.
function gitConfigReadFiles() {
  const fs = require('fs');
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const out = [];
  for (const f of [
    path.join(home, '.gitconfig'),
    path.join(home, '.gitignore_global'),
    path.join(xdg, 'git', 'config'),
    path.join(xdg, 'git', 'ignore'),
    path.join(xdg, 'git', 'attributes'),
  ]) {
    try { if (fs.statSync(f).isFile()) out.push(f); } catch {}
  }
  return out;
}

// The devvit CLI keeps its state in two places outside the workspace, and it
// touches BOTH during startup -- before it does any useful work:
//   ~/.devvit                  session-id (telemetry UUID) + token (Reddit OAuth)
//   ~/Library/Caches/devvit    version-check cache + error.log
// The Seatbelt profile denies $HOME outside the workspace, so EVERY devvit
// subcommand died in `getTelemetrySessionId` with
//   Error: EPERM: operation not permitted, mkdir '/Users/<u>/.devvit'
// making the whole CLI unusable from the chat agent (Long, Jul 30, on the
// MacBook Pro). Same class as the git-config EPERM above: a denial during
// startup, so the failure is total rather than partial, and the agent sees a
// crash it can't attribute.
//
// These are --allow (read+WRITE), not read-only, and that is forced by the
// tool's own behavior rather than chosen for convenience. Verified by
// experiment Jul 30, all three cases:
//   - no grant          -> EPERM mkdir ~/.devvit
//   - --read (RO) grant -> gets past that, then EPERM mkdir ~/Library/Caches/devvit
//   - --allow on both   -> `devvit whoami` succeeds
// Read-only cannot work even in principle: `devvit whoami` ROTATES the token
// and rewrites it ("Your Devvit authentication token has been saved to
// ~/.devvit/token"), and the cache dir takes version + error.log writes.
//
// Deliberately NOT stat-gated, unlike gitConfigReadFiles(). The dirs are
// frequently ABSENT on a machine where devvit hasn't run yet -- which is
// exactly the reported failure -- so they must be granted so the CLI can
// CREATE them. nono accepts a grant on a not-yet-existing path (verified with
// a throwaway HOME: devvit created session-id + the cache dir itself and then
// reached its own honest "Not currently logged in" instead of an EPERM crash).
//
// SECURITY TRADE, stated plainly: this makes ~/.devvit/token readable to the
// sandboxed agent, and the profile's network allowlist is best-effort only
// (nono 0.66 enforces strict egress from a CLI flag, not the profile field),
// so the token is exfiltratable by a prompt-injected agent. Accepted because
// the point of the grant is to let the agent run devvit AS the user -- upload,
// playtest, publish -- which is already that same authority. Not narrowed by
// sniffing the command string for "devvit": the agent authors the command, so
// it could name anything devvit-something to earn the grant. That would be
// theater, not a control. The real containment remains the profile's deny list
// (~/.aws, ~/.ssh, ~/.gnupg, ~/.config/gh) and the workspace write boundary.
function devvitStateDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.devvit'),
    path.join(home, 'Library', 'Caches', 'devvit'),
  ];
}

// The full argv fragment of Seatbelt grants every nono wrap site needs:
// toolchain dirs so node/npm resolve at all (v0.1.9), plus the git config files
// so git doesn't exit 128, plus the devvit state dirs so the devvit CLI can
// start at all. nono flags: --read is directories only (read-only), --read-file
// is the single-file form (passing a file to --read is a hard config error),
// --allow is read+write.
function sandboxGrantArgs() {
  const args = [];
  for (const d of toolchainReadDirs()) args.push('--read', d);
  for (const f of gitConfigReadFiles()) args.push('--read-file', f);
  for (const d of devvitStateDirs()) args.push('--allow', d);
  return args;
}

let _npmBinCache;
function resolveNpmBin() {
  if (_npmBinCache !== undefined) return _npmBinCache;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const isExec = (f) => {
    try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); }
    catch { return false; }
  };

  const candidates = [];
  // 1. Explicit escape hatch, so a user with an exotic setup is never stuck.
  if (process.env.FARNSWORTH_NPM) candidates.push(process.env.FARNSWORTH_NPM);
  // 2. Whatever the user's login shell actually resolves (nvm/fnm/volta/asdf).
  for (const d of getUserShellPathDirs()) candidates.push(path.join(d, 'npm'));
  // Independent of the shell probe -- see discoverToolchainDirs().
  for (const d of discoverToolchainDirs()) candidates.push(path.join(d, 'npm'));
  // 3. Static fallbacks for the common installs.
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    candidates.push(path.join(d, 'npm'));
  }
  // 4. Version managers, newest version first, in case the shell probe failed
  //    (e.g. a login shell that refuses to run non-interactively).
  const home = os.homedir();
  const versionDirs = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
  ];
  for (const base of versionDirs) {
    try {
      const versions = fs.readdirSync(base).sort().reverse();
      for (const v of versions) {
        candidates.push(path.join(base, v, 'bin', 'npm'));
        candidates.push(path.join(base, v, 'installation', 'bin', 'npm'));
      }
    } catch {}
  }
  candidates.push(path.join(home, '.volta', 'bin', 'npm'));

  for (const c of candidates) {
    if (isExec(c)) {
      console.log(`[dev:farnsworth:boot] resolved npm -> ${c}`);
      _npmBinCache = c;
      return c;
    }
  }
  console.error('[dev:farnsworth:boot] npm NOT FOUND. Searched:', candidates.length, 'candidates');
  _npmBinCache = null;
  return null;
}

// ============================================================
// Go Live dependency preflight (Aug 5 2026)
// ------------------------------------------------------------
// Go Live used to validate the workspace, package.json, the farnsworth:<type>
// script and the npm binary -- then spawn the script and hope. On a machine
// where `npm install` had never run (or had failed halfway, or where a git
// pull moved the lockfile), the script died with `sh: vite: command not
// found` inside a terminal the user has to think to go look at. Farnsworth's
// first external user hit exactly that on day one.
//
// node_modules is not a user decision: there is one correct fix and no reason
// to make a person type it. So detect the state cheaply and install only when
// needed -- NOT on every press, which would put seconds of npm work behind a
// button that should feel instant.
//
// Deliberately conservative: if deps still look incomplete after installing,
// boot anyway and let the script speak. A project whose script calls a
// globally-installed binary is unusual but legitimate, and a preflight must
// never be the thing that blocks a setup that would have worked.

// Local binaries a package script will actually exec, following one level of
// `npm run <other>` indirection. Tokens we can't classify are skipped rather
// than guessed at, because a false "missing" means a pointless reinstall.
function binariesUsedByScript(pkg, scriptName, depth = 0, seen = new Set()) {
  const out = new Set();
  const cmd = pkg?.scripts?.[scriptName];
  if (!cmd || depth > 2 || seen.has(scriptName)) return out;
  seen.add(scriptName);
  const PASSTHROUGH = new Set([
    'npm', 'npx', 'pnpm', 'yarn', 'node', 'sh', 'bash', 'zsh', 'env', 'cd',
    'echo', 'printf', 'wait', 'kill', 'pkill', 'rm', 'mkdir', 'cp', 'mv',
    'true', 'false', 'set', 'export', 'trap', 'open', 'sleep', 'test', 'if',
    'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'exit', 'exec',
  ]);
  for (const seg of String(cmd).split(/&&|\|\||[;|&]/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Skip leading VAR=value env prefixes.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const head = tokens[i];
    if (!head) continue;
    if ((head === 'npm' || head === 'pnpm' || head === 'yarn') && tokens[i + 1] === 'run' && tokens[i + 2]) {
      for (const b of binariesUsedByScript(pkg, tokens[i + 2], depth + 1, seen)) out.add(b);
      continue;
    }
    if (PASSTHROUGH.has(head)) continue;
    // Paths, flags, quotes and shell expansions aren't bare bin names.
    if (/^[-"'$(]/.test(head) || head.includes('/') || head.includes('$')) continue;
    if (!/^[A-Za-z0-9@._-]+$/.test(head)) continue;
    out.add(head);
  }
  return out;
}

function inspectProjectDeps(repoRoot, pkg, scriptName) {
  const fs = require('fs');
  const path = require('path');
  const nm = path.join(repoRoot, 'node_modules');
  // .package-lock.json is written by npm only when an install COMPLETES, so
  // it's a better "did this finish" signal than the directory existing.
  const stamp = path.join(nm, '.package-lock.json');

  if (!fs.existsSync(nm)) return { needsInstall: true, reason: 'this project has no node_modules yet' };
  if (!fs.existsSync(path.join(nm, '.bin'))) return { needsInstall: true, reason: 'node_modules has no .bin directory' };
  if (!fs.existsSync(stamp)) return { needsInstall: true, reason: 'a previous npm install never finished' };

  // Declared dependencies that aren't on disk. This is the check that
  // actually catches the real cases, because the template's Go Live script is
  // `bash scripts/farnsworth-devvit.sh` -- the binaries it calls are inside
  // the shell file, invisible to script parsing.
  //
  // Presence, not timestamps: an earlier version of this compared the
  // lockfile mtime to the install stamp, and it reported "stale" on a
  // perfectly working project (the-last-draft) because the lockfile had been
  // rewritten after install. A newly-pulled dependency is missing from disk
  // anyway, so presence catches that failure without the false positives.
  // Version drift where the package IS installed is deliberately ignored:
  // that's a much milder problem and not something to fix behind the user's
  // back on a button press.
  for (const field of ['dependencies', 'devDependencies']) {
    const declared = pkg?.[field];
    if (!declared || typeof declared !== 'object') continue;
    for (const name of Object.keys(declared)) {
      // Skip non-registry specs: file:/link:/git deps and workspace protocol
      // resolve to places this check can't reason about.
      const spec = String(declared[name] || '');
      if (/^(file:|link:|workspace:|git|github:|https?:)/i.test(spec)) continue;
      if (!fs.existsSync(path.join(nm, ...name.split('/')))) {
        return { needsInstall: true, reason: `${name} is not installed` };
      }
    }
  }

  // The binaries this script is about to call. An interrupted install leaves
  // node_modules present with bins missing -- the exact shape that produces
  // "vite: command not found".
  for (const bin of binariesUsedByScript(pkg, scriptName)) {
    if (!fs.existsSync(path.join(nm, '.bin', bin))) {
      return { needsInstall: true, reason: `${bin} is missing from node_modules/.bin` };
    }
  }
  return { needsInstall: false, reason: null };
}

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
  let pkg;
  try {
    pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
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

  // Port authority (Aug 3 2026): a project opts in with a `farnsworth.ports`
  // manifest block in package.json (see port-authority-implementation-plan).
  // Projects WITHOUT the manifest keep today's behavior exactly — their own
  // scripts hardcode 5174/3000 and nothing here changes. Only when the
  // manifest declares a port do we lease one from the shared SQLite table
  // and hand it back via FARNSWORTH_PORT_<ROLE> env vars, so two windows on
  // the same or different projects stop colliding.
  const portEnv = {};
  const portsManifest = pkg?.farnsworth?.ports;
  if (portsManifest && typeof portsManifest === 'object') {
    const pa = portAlloc();
    if (pa) {
      const rawDb = db.getRawDb();
      for (const [role, spec] of Object.entries(portsManifest)) {
        if (!spec || typeof spec.default !== 'number') continue;
        try {
          const assigned = pa.allocatePort({
            db: rawDb,
            repoRoot,
            role,
            preferred: spec.default,
            rangeStart: spec.rangeStart || spec.default,
            rangeEnd: spec.rangeEnd || (spec.default + 25),
            instanceId: INSTANCE_NAME,
          });
          portEnv[`FARNSWORTH_PORT_${role.toUpperCase()}`] = String(assigned);
        } catch (e) {
          console.warn(`[port-alloc] allocation failed for ${role}:`, e.message);
        }
      }
    }
  }

  // Resolve npm to an ABSOLUTE path and build a PATH that actually reflects
  // how the user installed node (Jul 28). The old code just prepended
  // /opt/homebrew/bin + /usr/local/bin, which silently assumes Homebrew or a
  // pkg install. On a Mac using nvm / fnm / volta / asdf, npm is under
  // ~/.nvm/versions/node/<v>/bin (etc.), so `spawn('npm')` threw
  // "spawn npm ENOENT" -- an error that blames npm when the real problem is
  // that we never looked where this machine keeps it.
  //
  // Same class as the nono-profile and server-runner path bugs: a hardcoded
  // location that happened to be true on the dev machine.
  const npmBin = resolveNpmBin();
  const env = { ...process.env, ...portEnv };
  // composeChildPath() is the single source of truth for child PATHs: login
  // shell (both flavors) + discovered version managers + static fallbacks.
  // This site used to assemble the list by hand and so missed the discovery
  // pass entirely.
  env.PATH = composeChildPath(npmBin ? [path.dirname(npmBin)] : [], env.PATH);

  if (!npmBin) {
    return {
      ok: false,
      error: 'npm_not_found',
      message:
        'Could not find npm. Farnsworth looked in your login shell PATH, ' +
        'Homebrew, /usr/local/bin, and the common nvm/fnm/volta/asdf ' +
        'locations. If node is installed, set FARNSWORTH_NPM to the full ' +
        'path of your npm binary and relaunch.',
    };
  }

  // Dependency preflight -- see inspectProjectDeps() above. Runs before the
  // emulator wiring so a fresh clone or a half-finished install becomes a
  // progress message on the Go Live button instead of a dead dev server.
  {
    const deps = inspectProjectDeps(repoRoot, pkg, scriptName);
    if (deps.needsInstall) {
      console.log(`[dev:farnsworth:boot] installing dependencies (${deps.reason})`);
      const notify = (payload) => {
        try { _event.sender.send('dev:farnsworth:progress', { repoRoot, ...payload }); } catch {}
      };
      notify({ phase: 'installing', reason: deps.reason });
      const startedAt = Date.now();
      try {
        await execFileAsync(npmBin, ['install', '--no-audit', '--no-fund'], {
          cwd: repoRoot,
          timeout: 900000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...env,
            // Same reason as the scaffold path: redis-memory-server's
            // postinstall compiles from source and needs GNU Make >= 4, but
            // macOS ships 3.81, so it fails the whole install. The emulator
            // replaces Redis locally anyway.
            REDISMS_DISABLE_POSTINSTALL: '1',
          },
        });
        console.log(`[dev:farnsworth:boot] npm install ok in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      } catch (e) {
        const detail =
          String(e.stderr || e.message || '')
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-1)[0] || 'npm install failed';
        console.warn('[dev:farnsworth:boot] npm install failed:', detail);
        notify({ phase: 'install-failed', reason: deps.reason });
        return {
          ok: false,
          error: 'install_failed',
          message: `Dependencies could not be installed (${deps.reason}). npm said: ${detail}`,
        };
      }
      notify({ phase: 'starting' });
      const after = inspectProjectDeps(repoRoot, pkg, scriptName);
      if (after.needsInstall) {
        // Not fatal on purpose: a script calling a globally-installed binary
        // is unusual but valid, and the preflight must not block a setup that
        // would otherwise have worked.
        console.warn(`[dev:farnsworth:boot] deps still look incomplete (${after.reason}) — booting anyway`);
      }
    }
  }

  // Tell the project's farnsworth:<type> script where OUR server-runner lives
  // (Jul 28). The scripts historically hardcoded
  // $HOME/Documents/Farnsworth/app/devvit-emulator/server-runner.mjs — a DEV
  // TREE path that only exists on the machine Farnsworth was developed on.
  // On a normal install the runner ships inside the .app, so the script
  // printed "server-runner not found (skipping)" and the game booted with no
  // backend: every /api/trpc call ECONNREFUSED, nothing persisted.
  // Farnsworth knows its own layout, so it should say so rather than making
  // every template repo guess. Path is asar.unpacked-aware because the runner
  // is executed by a plain node child process.
  {
    const runnerPath = path
      .join(__dirname, 'devvit-emulator', 'server-runner.mjs')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(runnerPath)) env.FARNSWORTH_DEVVIT_RUNNER = runnerPath;
    else console.warn(`[dev:farnsworth:boot] server-runner missing at ${runnerPath}`);
  }

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
      // In a packaged build __dirname is inside app.asar. Electron's fs shim
      // can read that, but the loader path below is handed to the user's dev
      // server — a plain node child process with NO asar support. Point it at
      // the app.asar.unpacked copy (electron-builder unpacks devvit-emulator
      // for exactly this reason). No-op in the dev tree, where there's no asar.
      const loaderPath = path2
        .join(__dirname, 'devvit-emulator', 'loader.mjs')
        .replace(`${path2.sep}app.asar${path2.sep}`, `${path2.sep}app.asar.unpacked${path2.sep}`);
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
    // Absolute path, not the bare name: a GUI-launched Electron app inherits
    // a minimal PATH from LaunchServices, so bare-name resolution is exactly
    // what failed here.
    const child = spawn(npmBin, ['run', scriptName], {
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
        // Remember what we started so before-quit can clean it up. The npm
        // script daemonizes, so the child we spawned has already exited by
        // now -- these pids in the meta are the only handle on the real
        // processes.
        spawnedDevServers.set(type, {
          pid: meta.pid || null,
          serverPid: meta.serverPid || null,
          metaPath,
          repoRoot,
        });
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
  // Release any leased ports (port authority, Aug 3 2026) before dropping
  // the record — repoRoot only lives on the tracked record, not this
  // handler's params.
  const rec = spawnedDevServers.get(type);
  if (rec?.repoRoot) {
    const pa = portAlloc();
    try { if (pa) pa.releaseAllForRepo(db.getRawDb(), rec.repoRoot); } catch (e) {
      console.warn('[port-alloc] release-on-stop failed:', e.message);
    }
  }
  // Already killed above -- drop the record so before-quit doesn't re-kill
  // pids that may have been recycled onto unrelated processes by then.
  spawnedDevServers.delete(type);
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
  const userData = SHARED_USER_DATA; // the db is shared across instances
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
// NEW PROJECT SCAFFOLD (Aug 1 2026)
// "Start from scratch" on the welcome screen clones Long's Devvit
// vibe-coding template fork, personalizes it, gives it fresh git
// history and a .farnsworth config, then installs dependencies.
// ============================================================

const FARNSWORTH_TEMPLATE_REPO = 'https://github.com/dolong/vibe-farnsworth-template.git';
// Offline fallback. We clone the local repo's COMMITTED state (file:// clone),
// never the working tree, so a dirty checkout can't leak into a new project.
const FARNSWORTH_TEMPLATE_LOCAL = path.join(os.homedir(), 'Documents', 'vibe-farnsworth-template');
const TEMPLATE_NAME_TOKEN = '<% name %>';

// devvit.json's schema constrains the app name: ^[a-z][a-z0-9-]*$, 3-20 chars.
// (Verified against developers.reddit.com/schema/config-file.v1.json.) An
// invalid name here fails much later at `devvit upload`, so normalize now.
function devvitSafeName(raw) {
  let n = String(raw || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z]+/, '')      // must start with a letter
    .replace(/-+$/, '');
  if (n.length > 20) n = n.slice(0, 20).replace(/-+$/, '');
  if (n.length < 3) n = 'my-devvit-app';
  return n;
}

function execFileAsync(file, args, opts = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

ipcMain.handle('dialog:newProject', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showSaveDialog(win, {
    title: 'Create new Farnsworth project',
    defaultPath: path.join(app.getPath('documents'), 'my-devvit-game'),
    buttonLabel: 'Create',
    nameFieldLabel: 'Project name:',
    properties: ['createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('project:scaffold', async (event, targetPath) => {
  const send = (detail) => {
    try { event.sender.send('project:scaffold-progress', { detail }); } catch {}
  };
  try {
    if (!targetPath) return { ok: false, error: 'No project path given.' };

    const parent = path.dirname(targetPath);
    if (!fsSync.existsSync(parent)) return { ok: false, error: `Parent folder does not exist: ${parent}` };
    if (fsSync.existsSync(targetPath)) {
      const entries = fsSync.readdirSync(targetPath).filter((f) => f !== '.DS_Store');
      if (entries.length) return { ok: false, error: 'That folder already exists and is not empty.' };
      fsSync.rmdirSync(targetPath); // git clone wants to create it itself
    }

    const name = devvitSafeName(path.basename(targetPath));

    // 1. Clone the template (network first, local committed state as fallback).
    send('Fetching the Devvit template…');
    let cloneErr = null;
    try {
      await execFileAsync('git', ['clone', '--depth', '1', FARNSWORTH_TEMPLATE_REPO, targetPath], {
        timeout: 180000,
        env: { ...process.env, PATH: composeChildPath(), GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      cloneErr = e;
      if (fsSync.existsSync(path.join(FARNSWORTH_TEMPLATE_LOCAL, '.git'))) {
        send('Network unavailable — using the local template copy…');
        try {
          if (fsSync.existsSync(targetPath)) fsSync.rmSync(targetPath, { recursive: true, force: true });
          await execFileAsync('git', ['clone', '--depth', '1', `file://${FARNSWORTH_TEMPLATE_LOCAL}`, targetPath], {
            timeout: 180000,
            env: { ...process.env, PATH: composeChildPath(), GIT_TERMINAL_PROMPT: '0' },
          });
          cloneErr = null;
        } catch (e2) { cloneErr = e2; }
      }
    }
    if (cloneErr) {
      const detail = String(cloneErr.stderr || cloneErr.message || '').trim().split('\n').slice(-1)[0];
      return { ok: false, error: `Could not fetch the template: ${detail || cloneErr.message}` };
    }

    // 2. Replace the template's <% name %> placeholders.
    send('Personalizing project files…');
    const TEXT_EXT = new Set(['.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.html', '.css', '.yml', '.yaml', '.txt']);
    let replaced = 0;
    const walk = (dir) => {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!TEXT_EXT.has(path.extname(entry.name))) continue;
        try {
          const txt = fsSync.readFileSync(p, 'utf8');
          if (!txt.includes(TEMPLATE_NAME_TOKEN)) continue;
          fsSync.writeFileSync(p, txt.split(TEMPLATE_NAME_TOKEN).join(name));
          replaced++;
        } catch {}
      }
    };
    walk(targetPath);
    console.log(`[scaffold] personalized ${replaced} file(s) with name "${name}"`);

    // 3. Fresh git history — this is the user's project, not a fork of ours.
    send('Initializing a fresh git repository…');
    try {
      fsSync.rmSync(path.join(targetPath, '.git'), { recursive: true, force: true });
      const gitEnv = { ...process.env, PATH: composeChildPath() };
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: targetPath, env: gitEnv, timeout: 30000 });
      await execFileAsync('git', ['add', '-A'], { cwd: targetPath, env: gitEnv, timeout: 60000 });
      await execFileAsync('git', ['commit', '-m', `Initial commit — ${name} from vibe-farnsworth-template`], {
        cwd: targetPath, env: gitEnv, timeout: 60000,
      });
    } catch (e) {
      // Non-fatal: a missing user.name/user.email shouldn't block the project.
      console.warn('[scaffold] git init/commit skipped:', e.message);
    }

    // 4. Farnsworth workspace config, so the app-type picker doesn't appear.
    send('Writing the Farnsworth config…');
    try {
      const cfgDir = path.join(targetPath, '.farnsworth');
      fsSync.mkdirSync(cfgDir, { recursive: true });
      const cfgPath = path.join(cfgDir, 'config.json');
      let cfg = {};
      try { cfg = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8')); } catch {}
      cfg.appType = 'devvit';
      cfg.createdAt = new Date().toISOString();
      cfg.liveGameId = cfg.liveGameId ?? null;
      // Aug 4: seed a human-readable postName. Post View's render gate needs a
      // subredditName or postName to be non-empty, so shipping empty strings
      // made every freshly scaffolded project fall through to the "No Live
      // config" empty state — even though the template harness serves
      // ?view=post (the splash) perfectly well from the first Go Live.
      const prettyName = String(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      // Default the preview subreddit to the project name (Long, Aug 4: new
      // projects should read r/<project title>), so Post View's Reddit chrome
      // is about THIS game from the first Go Live instead of showing a
      // placeholder. Both fields also satisfy the renderPostView() gate on
      // builds that predate the harness-aware gate.
      cfg.live = { projectName: name, subredditName: name, url: '', postName: prettyName, ...(cfg.live || {}) };
      cfg.live.projectName = name;
      if (!cfg.live.subredditName || !String(cfg.live.subredditName).trim()) cfg.live.subredditName = name;
      if (!cfg.live.postName || !String(cfg.live.postName).trim()) cfg.live.postName = prettyName;
      fsSync.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    } catch (e) {
      console.warn('[scaffold] config write failed:', e.message);
    }

    // 5. Dependencies. Without node_modules, Go Live can't work.
    send('Installing dependencies… (this can take a minute)');
    let installError = null;
    try {
      const npmBin = resolveNpmBin();
      if (!npmBin) throw new Error('npm not found on PATH');
      await execFileAsync(npmBin, ['install', '--no-audit', '--no-fund'], {
        cwd: targetPath,
        timeout: 600000,
        env: {
          ...process.env,
          PATH: composeChildPath(path.dirname(npmBin) ? [path.dirname(npmBin)] : []),
          // @devvit/test pulls redis-memory-server, whose postinstall compiles
          // RedisJSON/RedisTimeSeries from source and needs GNU Make >= 4.
          // macOS ships Make 3.81 (2006, GPLv2), so that build always fails
          // here and would fail the whole install. Skip it: the emulator
          // replaces Redis locally, and the package fetches on demand if a
          // test ever genuinely needs it.
          REDISMS_DISABLE_POSTINSTALL: '1',
        },
      });
    } catch (e) {
      installError = String(e.stderr || e.message || '').trim().split('\n').slice(-1)[0] || 'npm install failed';
      console.warn('[scaffold] npm install failed:', installError);
    }

    console.log(`[scaffold] created ${targetPath} (name=${name}, install=${installError ? 'FAILED' : 'ok'})`);
    return { ok: true, path: targetPath, name, installError };
  } catch (e) {
    console.error('[scaffold] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
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

// Companion WCV WebRTC capture (Aug 12 2026). A dedicated, invisible
// BrowserWindow owns getDisplayMedia() + RTCPeerConnection. Main only selects
// the active WebContentsView frame and carries signaling over the relay.
// Post View is intentionally excluded because it needs an element crop.
let canvasDisplayCaptureGrant = null;
let canvasCaptureWindow = null;
let canvasCaptureReady = null;
function activeCanvasWebContentsView() {
  const entries = [...canvasWebContentsViews.entries()];
  return entries.length ? entries[entries.length - 1][1] : null;
}
function createCanvasCaptureWindow() {
  canvasCaptureWindow = new BrowserWindow({
    width: 180,
    height: 80,
    show: false,
    frame: false,
    transparent: true,
    opacity: 0,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'canvas-capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  canvasCaptureReady = canvasCaptureWindow.loadFile(path.join(__dirname, 'canvas-capture.html'));
}
function installCanvasDisplayMediaHandler() {
  const ses = canvasCaptureWindow?.webContents?.session;
  if (!ses || !ses.setDisplayMediaRequestHandler) return;
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const grant = canvasDisplayCaptureGrant;
    canvasDisplayCaptureGrant = null; // one request per relay start
    const requester = request?.frame;
    const trustedRequester = requester && canvasCaptureWindow && !canvasCaptureWindow.isDestroyed() &&
      requester === canvasCaptureWindow.webContents.mainFrame;
    const trustedOrigin = trustedRequester && requester.url === canvasCaptureWindow.webContents.getURL();
    const view = activeCanvasWebContentsView();
    if (!grant || grant.expiresAt < Date.now() || !request.userGesture || !trustedOrigin ||
        !view || view.webContents.isDestroyed()) {
      callback({});
      return;
    }
    callback({ video: view.webContents.mainFrame });
  }, { useSystemPicker: false });
}
async function startCanvasCapturePeer(companionId) {
  if (!canvasCaptureWindow || canvasCaptureWindow.isDestroyed()) {
    createCanvasCaptureWindow();
    installCanvasDisplayMediaHandler();
  }
  await canvasCaptureReady;
  canvasDisplayCaptureGrant = { companionId, expiresAt: Date.now() + 10000 };
  await canvasCaptureWindow.webContents.executeJavaScript(
    `window.__setCanvasCompanion(${JSON.stringify(companionId)}); true`, true,
  );
  // Electron marks the request as user-initiated only when getDisplayMedia()
  // runs from a trusted renderer input event. The window is fully transparent
  // and shown inactive for this click, then hidden again immediately.
  canvasCaptureWindow.showInactive();
  canvasCaptureWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 90, y: 40, button: 'left', clickCount: 1 });
  canvasCaptureWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 90, y: 40, button: 'left', clickCount: 1 });
  setTimeout(() => { try { canvasCaptureWindow?.hide(); } catch {} }, 100);
}
const _CANVAS_IFRAME_RECT_JS =
  '(function(){var f=document.querySelector("iframe[src*=localhost]")' +
  '||document.querySelector("iframe");' +
  'if(!f)return null;var r=f.getBoundingClientRect();' +
  'return {x:Math.max(0,Math.round(r.left)),y:Math.max(0,Math.round(r.top)),' +
  'width:Math.round(r.width),height:Math.round(r.height)};})()';

// ============================================================
// Prod browser surface (Aug 12 2026)
// ============================================================
// Operator-facing mirror of a real, visible agent-browser Chrome session.
// This is intentionally separate from Test View's Electron WebContentsView
// backend. Human input may travel over CDP; automated production tests must
// keep the frame-aware browser-native adapter described in DEVVIT-TESTS.md.
const PROD_DEFAULT_URL = 'https://www.reddit.com/r/social_poker_game/comments/1vfrajp/';
const PROD_IDENTITY_DIR = path.join(SHARED_USER_DATA, 'prod-identities');
const PROD_REGISTRY_PATH = path.join(PROD_IDENTITY_DIR, 'profiles.json');
const PROD_ANOMALY_SOURCE = path.join(os.homedir(), 'Documents', 'Anomaly Intelligence', 'anomalyint', 'reddit-data-logs', '.reddit-auth.json');
const PROD_ANOMALY_COPY = path.join(PROD_IDENTITY_DIR, 'state', 'anomalyint-reddit-auth.json');
let prodSession = null;
let latestProdFrame = null; // { buffer, width, height, metadata, ts }
let prodCanvasActive = false;
let prodCdpSeq = 0;
const prodCdpPending = new Map();

function prodAgentBrowserBin() {
  // Explicit override is authoritative. This gives packaged verification a
  // deterministic unavailable-browser path instead of silently trying a
  // different binary than the operator configured.
  if (process.env.AGENT_BROWSER_BIN) {
    return fsSync.existsSync(process.env.AGENT_BROWSER_BIN) ? process.env.AGENT_BROWSER_BIN : null;
  }
  const candidates = [
    '/opt/homebrew/bin/agent-browser',
    '/usr/local/bin/agent-browser',
    'agent-browser',
  ];
  for (const c of candidates) {
    if (c === 'agent-browser' || fsSync.existsSync(c)) return c;
  }
  return null;
}
function prodSlug(raw) {
  return String(raw || 'profile').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'profile';
}
function prodReadRegistry() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(PROD_REGISTRY_PATH, 'utf8'));
    return Array.isArray(parsed?.profiles) ? parsed : { profiles: [] };
  } catch { return { profiles: [] }; }
}
function prodWriteRegistry(registry) {
  fsSync.mkdirSync(PROD_IDENTITY_DIR, { recursive: true });
  const tmp = PROD_REGISTRY_PATH + '.tmp';
  fsSync.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: registry.profiles || [] }, null, 2), { mode: 0o600 });
  fsSync.renameSync(tmp, PROD_REGISTRY_PATH);
}
function prodStateMetadata(filePath) {
  try {
    const st = fsSync.statSync(filePath);
    const json = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    return {
      available: true,
      sourceName: path.basename(filePath),
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      cookieCount: Array.isArray(json.cookies) ? json.cookies.length : 0,
      originCount: Array.isArray(json.origins) ? json.origins.length : 0,
    };
  } catch (e) {
    return { available: false, sourceName: path.basename(filePath || ''), error: e.code || 'unavailable' };
  }
}
function prodPublicProfile(profile) {
  const base = {
    id: profile.id,
    label: profile.label,
    username: profile.username || null,
    mode: profile.mode,
    createdAt: profile.createdAt,
    lastUsedAt: profile.lastUsedAt || null,
  };
  if (profile.mode === 'state') return { ...base, metadata: prodStateMetadata(profile.statePath) };
  let available = false, modifiedAt = null;
  try { const st = fsSync.statSync(profile.profilePath); available = st.isDirectory(); modifiedAt = st.mtime.toISOString(); } catch {}
  return { ...base, metadata: { available, sourceName: path.basename(profile.profilePath || ''), modifiedAt } };
}
function prodSeedProfiles() {
  fsSync.mkdirSync(path.join(PROD_IDENTITY_DIR, 'state'), { recursive: true });
  fsSync.mkdirSync(path.join(PROD_IDENTITY_DIR, 'chrome-profiles'), { recursive: true });
  const registry = prodReadRegistry();
  if (!registry.profiles.some((x) => x.id === 'anomalyint')) {
    if (fsSync.existsSync(PROD_ANOMALY_SOURCE) && !fsSync.existsSync(PROD_ANOMALY_COPY)) {
      fsSync.copyFileSync(PROD_ANOMALY_SOURCE, PROD_ANOMALY_COPY);
      try { fsSync.chmodSync(PROD_ANOMALY_COPY, 0o600); } catch {}
    }
    registry.profiles.unshift({
      id: 'anomalyint', label: 'AnomalyInt', username: null, mode: 'state',
      statePath: PROD_ANOMALY_COPY, createdAt: new Date().toISOString(), lastUsedAt: null,
    });
    prodWriteRegistry(registry);
  } else if (!fsSync.existsSync(PROD_ANOMALY_COPY) && fsSync.existsSync(PROD_ANOMALY_SOURCE)) {
    // Repair a missing managed snapshot, but never keep it synchronized with
    // AnomalyInt's live scraper state. Prod and the scraper must not race.
    try { fsSync.copyFileSync(PROD_ANOMALY_SOURCE, PROD_ANOMALY_COPY); fsSync.chmodSync(PROD_ANOMALY_COPY, 0o600); } catch {}
  }
  return prodReadRegistry();
}
function prodBroadcast(channel, payload) {
  const owner = prodSession?.owner;
  if (owner && !owner.isDestroyed()) { try { owner.webContents.send(channel, payload); } catch {} }
}
function prodStatus(extra = {}) {
  if (!prodSession) return { running: false, state: 'stopped', ...extra };
  return {
    running: true,
    state: prodSession.state,
    profileId: prodSession.profileId,
    sessionName: prodSession.sessionName,
    url: prodSession.url || null,
    title: prodSession.title || null,
    viewport: prodSession.viewport || null,
    webdriver: prodSession.webdriver,
    headed: true,
    engine: 'agent-browser',
    frame: latestProdFrame ? { width: latestProdFrame.width, height: latestProdFrame.height, ts: latestProdFrame.ts } : null,
    error: prodSession.error || null,
    ...extra,
  };
}
function prodEmitStatus(extra = {}) { const status = prodStatus(extra); prodBroadcast('prod:status', status); return status; }
function prodExec(args, timeout = 45000) {
  const bin = prodAgentBrowserBin();
  if (!bin) return Promise.reject(Object.assign(new Error('agent-browser unavailable'), { code: 'agent_browser_unavailable' }));
  return new Promise((resolve, reject) => {
    child_process.execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); return; }
      resolve(stdout);
    });
  });
}
function prodParseJsonOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\n+/).reverse();
  for (const line of lines) { try { return JSON.parse(line); } catch {} }
  throw new Error('agent-browser returned invalid JSON');
}
function prodCdpCall(method, params = {}, sessionId = null, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!prodSession?.ws || prodSession.ws.readyState !== WebSocket.OPEN) return reject(new Error('prod CDP unavailable'));
    const id = ++prodCdpSeq;
    const timer = setTimeout(() => { prodCdpPending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    prodCdpPending.set(id, { resolve, reject, timer });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    prodSession.ws.send(JSON.stringify(msg));
  });
}
async function prodAttachCdp(browserWsUrl) {
  const ws = new WebSocket(browserWsUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  prodSession.ws = ws;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id && prodCdpPending.has(msg.id)) {
      const p = prodCdpPending.get(msg.id); prodCdpPending.delete(msg.id); clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message || 'CDP error')) : p.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Page.screencastFrame' && prodSession && msg.sessionId === prodSession.pageSessionId) {
      const data = msg.params?.data;
      if (data) {
        const buffer = Buffer.from(data, 'base64');
        let width = 0, height = 0;
        try { const n = nativeImage.createFromBuffer(buffer); const z = n.getSize(); width = z.width; height = z.height; } catch {}
        latestProdFrame = { buffer, width, height, metadata: msg.params?.metadata || {}, ts: Date.now() };
        prodBroadcast('prod:frame', { data, width, height, metadata: latestProdFrame.metadata, ts: latestProdFrame.ts });
      }
      try { prodCdpCall('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, prodSession.pageSessionId, 5000).catch(() => {}); } catch {}
    }
  });
  ws.on('close', () => {
    if (prodSession) { prodSession.error = 'CDP connection closed'; prodSession.state = 'error'; prodEmitStatus(); }
  });
  const targets = await prodCdpCall('Target.getTargets');
  const pages = (targets.targetInfos || []).filter((t) => t.type === 'page');
  const page = pages.find((t) => /reddit\.com/i.test(t.url || '')) || pages.find((t) => t.url && t.url !== 'about:blank') || pages[0];
  if (!page) throw new Error('No Chrome page target found');
  const attached = await prodCdpCall('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  prodSession.pageTargetId = page.targetId;
  prodSession.pageSessionId = attached.sessionId;
  await prodCdpCall('Page.enable', {}, attached.sessionId);
  await prodCdpCall('Runtime.enable', {}, attached.sessionId);
  const evalResult = await prodCdpCall('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title,webdriver:navigator.webdriver,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:devicePixelRatio}})',
    returnByValue: true,
  }, attached.sessionId);
  try {
    const health = JSON.parse(evalResult.result?.value || '{}');
    prodSession.url = health.url || page.url;
    prodSession.title = health.title || page.title;
    prodSession.webdriver = health.webdriver;
    prodSession.viewport = health.viewport || null;
  } catch { prodSession.url = page.url; prodSession.title = page.title; }
  await prodCdpCall('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1440, maxHeight: 1200, everyNthFrame: 1 }, attached.sessionId);
}
async function stopProdSession(reason = 'stop') {
  const current = prodSession;
  if (!current) return { ok: true, stopped: false };
  prodSession = null;
  latestProdFrame = null;
  try { if (current.onOwnerReload) current.owner?.webContents?.removeListener('did-start-loading', current.onOwnerReload); } catch {}
  for (const [id, p] of prodCdpPending) { clearTimeout(p.timer); p.reject(new Error('Prod session stopped')); prodCdpPending.delete(id); }
  try { if (current.ws && current.ws.readyState === WebSocket.OPEN) current.ws.close(); } catch {}
  try { await prodExec(['--session', current.sessionName, 'close', '--json'], 15000); } catch {}
  // agent-browser can transiently leave a daemon/session record after close; one idempotent retry closes the real Chrome tree without touching other sessions.
  try { await new Promise((r) => setTimeout(r, 250)); await prodExec(['--session', current.sessionName, 'close', '--json'], 10000); } catch {}
  try { if (current.owner && !current.owner.isDestroyed()) current.owner.webContents.send('prod:status', { running: false, state: 'stopped', reason }); } catch {}
  return { ok: true, stopped: true };
}
function stopProdSessionSync(reason = 'quit') {
  prodCanvasActive = false;
  const current = prodSession;
  prodSession = null; latestProdFrame = null;
  if (!current) return;
  try { current.ws?.terminate(); } catch {}
  const bin = prodAgentBrowserBin();
  if (bin) {
    try { child_process.spawnSync(bin, ['--session', current.sessionName, 'close', '--json'], { timeout: 10000, stdio: 'ignore', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } }); } catch {}
  }
}
async function startProdSession(event, { profileId, url } = {}) {
  await stopProdSession('replace');
  const registry = prodSeedProfiles();
  const profile = registry.profiles.find((x) => x.id === profileId) || registry.profiles[0];
  if (!profile) return { ok: false, error: 'profile_not_found' };
  if (!['state', 'profile'].includes(profile.mode)) return { ok: false, error: 'invalid_persistence_mode' };
  const targetUrl = /^https?:\/\//i.test(String(url || '')) ? String(url) : PROD_DEFAULT_URL;
  const sessionName = `farnsworth-prod-${INSTANCE_NAME}-${profile.id}-${Date.now().toString(36)}`;
  prodSession = { owner: BrowserWindow.fromWebContents(event.sender), profileId: profile.id, sessionName, state: 'launching', url: targetUrl, webdriver: null, viewport: null, error: null, ws: null };
  const ownedSession = prodSession;
  ownedSession.onOwnerReload = () => {
    if (prodSession === ownedSession) {
      prodCanvasActive = false;
      stopProdSession('renderer-reload').catch(() => {});
    }
  };
  try { ownedSession.owner?.webContents?.once('did-start-loading', ownedSession.onOwnerReload); } catch {}
  prodEmitStatus();
  try {
    const identityArgs = profile.mode === 'state' ? ['--state', profile.statePath] : ['--profile', profile.profilePath];
    const openArgs = ['--session', sessionName, ...identityArgs, '--headed', '--args', '--disable-blink-features=AutomationControlled', 'open', targetUrl, '--json'];
    const opened = prodParseJsonOutput(await prodExec(openArgs, 60000));
    if (opened.success === false) throw new Error(opened.error || 'browser launch failed');
    prodSession.state = 'connecting'; prodEmitStatus();
    const cdp = prodParseJsonOutput(await prodExec(['--session', sessionName, 'get', 'cdp-url', '--json'], 15000));
    const browserWsUrl = cdp?.data?.cdpUrl;
    if (!browserWsUrl) throw new Error('agent-browser did not expose a CDP endpoint');
    await prodAttachCdp(browserWsUrl);
    prodSession.state = 'ready';
    profile.lastUsedAt = new Date().toISOString(); prodWriteRegistry(registry);
    return { ok: true, status: prodEmitStatus(), profile: prodPublicProfile(profile) };
  } catch (e) {
    if (prodSession) { prodSession.state = 'error'; prodSession.error = e.message || String(e); }
    const status = prodEmitStatus();
    await stopProdSession('launch-error');
    return { ok: false, error: e.code || 'launch_failed', message: e.message || String(e), status };
  }
}

ipcMain.handle('prod:profile:list', () => {
  const registry = prodSeedProfiles();
  return { ok: true, profiles: registry.profiles.map(prodPublicProfile), defaultUrl: PROD_DEFAULT_URL };
});
ipcMain.handle('prod:profile:create', async (_event, { label, mode, username, sourcePath } = {}) => {
  const cleanMode = mode === 'state' ? 'state' : 'profile';
  const registry = prodSeedProfiles();
  const idBase = prodSlug(label || `${cleanMode}-profile`);
  let id = idBase, n = 2; while (registry.profiles.some((x) => x.id === id)) id = `${idBase}-${n++}`;
  const rec = { id, label: String(label || id).trim().slice(0, 80), username: String(username || '').trim().slice(0, 80) || null, mode: cleanMode, createdAt: new Date().toISOString(), lastUsedAt: null };
  if (cleanMode === 'state') {
    let picked = sourcePath;
    if (!picked) {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const result = await dialog.showOpenDialog(win, { title: 'Import agent-browser saved state', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
      picked = result.filePaths[0];
    }
    try { JSON.parse(fsSync.readFileSync(picked, 'utf8')); } catch { return { ok: false, error: 'invalid_state_json' }; }
    rec.statePath = path.join(PROD_IDENTITY_DIR, 'state', `${id}.json`);
    fsSync.copyFileSync(picked, rec.statePath); try { fsSync.chmodSync(rec.statePath, 0o600); } catch {}
  } else {
    rec.profilePath = path.join(PROD_IDENTITY_DIR, 'chrome-profiles', id);
    fsSync.mkdirSync(rec.profilePath, { recursive: true });
  }
  registry.profiles.push(rec); prodWriteRegistry(registry);
  return { ok: true, profile: prodPublicProfile(rec), profiles: registry.profiles.map(prodPublicProfile) };
});
ipcMain.handle('prod:session:start', (event, payload) => { prodCanvasActive = true; return startProdSession(event, payload || {}); });
ipcMain.handle('prod:session:stop', (_event, { reason } = {}) => { prodCanvasActive = false; return stopProdSession(reason || 'renderer'); });
ipcMain.handle('prod:session:status', () => prodStatus());
// Shared by the renderer's live mirror (prod:session:input) and the chat
// agent's prod_input tool. Coordinates are NORMALIZED (0..1) so a caller
// that only has a screenshot can aim without knowing the real viewport.
async function prodInput(msg = {}) {
  if (!prodSession?.pageSessionId) return { ok: false, error: 'not_ready' };
  try {
    const nx = Math.max(0, Math.min(1, Number(msg.nx) || 0));
    const ny = Math.max(0, Math.min(1, Number(msg.ny) || 0));
    const width = prodSession.viewport?.width || latestProdFrame?.width || 1200;
    const height = prodSession.viewport?.height || latestProdFrame?.height || 800;
    const x = Math.round(nx * width), y = Math.round(ny * height);
    if (msg.kind === 'wheel') {
      await prodCdpCall('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(msg.deltaX) || 0, deltaY: Number(msg.deltaY) || 0 }, prodSession.pageSessionId);
    } else if (msg.kind === 'type') {
      // Whole-string entry. Input.insertText is one IME-style commit, which
      // is what React-controlled Reddit inputs actually want; per-char
      // dispatchKeyEvent drops characters on fast typing.
      const text = String(msg.text ?? '');
      if (!text) return { ok: false, error: 'missing_text' };
      await prodCdpCall('Input.insertText', { text }, prodSession.pageSessionId);
    } else if (msg.kind === 'key') {
      const key = String(msg.key || '');
      const text = key.length === 1 ? key : undefined;
      await prodCdpCall('Input.dispatchKeyEvent', { type: 'keyDown', key, code: String(msg.code || ''), text, modifiers: Number(msg.modifiers) || 0 }, prodSession.pageSessionId);
      await prodCdpCall('Input.dispatchKeyEvent', { type: 'keyUp', key, code: String(msg.code || ''), modifiers: Number(msg.modifiers) || 0 }, prodSession.pageSessionId);
    } else {
      await prodCdpCall('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, prodSession.pageSessionId);
      await prodCdpCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, prodSession.pageSessionId);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
ipcMain.handle('prod:session:input', async (_event, msg = {}) => prodInput(msg));

// ─── Prod script runner (Aug 13) ─────────────────────────────────────────────
// Runs the SAME <project>/.farnsworth/devvit-tests/*.json cases Test View runs,
// but against the real Reddit post's Devvit app instead of the local emulator.
//
// The production game renders in a cross-origin *.webview.devvit.net OOPIF, so
// parent-page JS cannot reach it — we resolve and attach to that target
// directly. Verified Aug 13: CDP Input dispatched to an OOPIF session uses
// FRAME-LOCAL coordinates and produces isTrusted events, which is exactly the
// contract src/farnsworth-test-runner.mjs already assumes. So we reuse the
// entire 16-action runner through a shim that speaks prodCdpCall instead of
// Electron's webContents.debugger, rather than maintaining a second runner.
const PROD_DEVVIT_HOST_RE = /webview\.devvit\.net/i;

async function prodDevvitTargets() {
  const { targetInfos = [] } = await prodCdpCall('Target.getTargets');
  return targetInfos.filter((t) => PROD_DEVVIT_HOST_RE.test(t.url || ''));
}
const prodPickGameTarget = (targets) => targets.find((t) => /\/game\.html/i.test(t.url || '')) || null;
const prodPickSplashTarget = (targets) => targets.find((t) => /\/splash\.html/i.test(t.url || '')) || null;

async function prodAttachTarget(targetId) {
  const { sessionId } = await prodCdpCall('Target.attachToTarget', { targetId, flatten: true });
  await prodCdpCall('Runtime.enable', {}, sessionId).catch(() => {});
  await prodCdpCall('Page.enable', {}, sessionId).catch(() => {});
  return sessionId;
}

// A custom post renders splash.html until it is clicked; the desktop app view
// (game.html) is a DIFFERENT target that only exists afterwards. This is the
// programmatic equivalent of clicking the post into the app.
async function prodOpenAppView({ timeout = 25000 } = {}) {
  let targets = await prodDevvitTargets();
  let game = prodPickGameTarget(targets);
  if (game) return game;
  const splash = prodPickSplashTarget(targets);
  if (!splash) throw new Error('no Devvit webview on this page — open a custom post first');
  const splashSession = await prodAttachTarget(splash.targetId);
  let point = {};
  try {
    const r = await prodCdpCall('Runtime.evaluate', {
      expression: `(()=>{const el=document.querySelector('[data-testid="game-root"]')||document.body;const r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`,
      returnByValue: true,
    }, splashSession);
    point = JSON.parse(r.result?.value || '{}');
  } catch {}
  const x = Number(point.x) || 100, y = Number(point.y) || 100;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await prodCdpCall('Input.dispatchMouseEvent', {
      type, x, y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    }, splashSession).catch(() => {});
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    targets = await prodDevvitTargets();
    game = prodPickGameTarget(targets);
    if (game) return game;
  }
  throw new Error('app view did not open within timeout');
}

async function prodResolveGameSession({ open = true } = {}) {
  const targets = await prodDevvitTargets();
  let game = prodPickGameTarget(targets);
  if (!game && open) game = await prodOpenAppView();
  if (!game) throw new Error('no Devvit app view target');
  const sessionId = await prodAttachTarget(game.targetId);
  // A freshly created app view — first open, or the frame recreated by a reload
  // step — needs its JWT and remote assets before any selector can match. Waiting
  // for the app root here means a test's own first step doesn't burn its timeout
  // on boot, which is what made a 15s lobby wait fail while the very next step
  // found the lobby fine.
  const bootDeadline = Date.now() + 20000;
  while (Date.now() < bootDeadline) {
    try {
      const r = await prodCdpCall('Runtime.evaluate', {
        expression: `!!document.querySelector('[data-testid="game-root"]')`,
        returnByValue: true,
      }, sessionId, 10000);
      if (r.result?.value === true) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return { targetId: game.targetId, sessionId, url: game.url };
}

// webContents.debugger stand-in backed by the Prod CDP socket. Also recovers
// from the two ways an OOPIF session legitimately dies mid-run: an explicit
// reload step, and the frame being torn down and recreated under us.
function prodRunnerShim(initial) {
  const state = { ...initial };
  const isStale = (m) => /Session with given id not found|No target with given id|Inspected target navigated or closed|Target closed/i.test(m || '');
  async function sendCommand(method, params = {}) {
    // Screenshots go through the top-level page so a test captures the whole
    // production post (Reddit chrome + app view), not just the bare frame —
    // and because an OOPIF session cannot capture its own surface.
    if (method === 'Page.captureScreenshot' && prodSession?.pageSessionId) {
      return await prodCdpCall(method, params, prodSession.pageSessionId, 30000);
    }
    if (method === 'Page.reload') {
      try { await prodCdpCall(method, params, state.sessionId, 20000); } catch {}
      await new Promise((r) => setTimeout(r, 2500));
      Object.assign(state, await prodResolveGameSession({ open: true }));
      return {};
    }
    try {
      return await prodCdpCall(method, params, state.sessionId, 30000);
    } catch (e) {
      if (!isStale(e.message)) throw e;
      Object.assign(state, await prodResolveGameSession({ open: true }));
      return await prodCdpCall(method, params, state.sessionId, 30000);
    }
  }
  return { state, wc: { debugger: { isAttached: () => true, attach() {}, detach() {}, sendCommand } } };
}

// Production identity is whoever the Chrome profile/state is signed in as —
// there is no emulator to switch users in. Instead of rejecting tests that
// carry a switchUser step, rewrite it into a recorded read of the REAL
// signed-in user, so a single test file runs in both lanes unchanged.
const PROD_USER_EXPR = `(()=>{try{const t=new URLSearchParams(location.search).get('token');const p=JSON.parse(atob(t.split('.')[1]));return (p&&p.devvit&&p.devvit.user&&p.devvit.user.name)||'';}catch(e){return '';}})()`;

function prodAdaptSteps(steps, notes = []) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    if (!step || typeof step !== 'object') return step;
    if (step.action === 'switchUser' || step.action === 'switchDevvitUser') {
      notes.push(`switchUser("${step.username || ''}") skipped — production runs as the signed-in Reddit user`);
      return { action: 'extract', expression: PROD_USER_EXPR, into: 'prodUser' };
    }
    const next = { ...step };
    if (Array.isArray(step.steps)) next.steps = prodAdaptSteps(step.steps, notes);
    return next;
  });
}

// Open a production URL and expand its custom post into the desktop app view.
// Shared by the Scripts panel button and the chat agent's prod_open_app_view.
async function prodAppOpen({ url } = {}) {
  if (!prodSession?.pageSessionId) return { ok: false, error: 'not_ready' };
  try {
    if (url && /^https?:\/\//i.test(String(url))) {
      await prodCdpCall('Page.navigate', { url: String(url) }, prodSession.pageSessionId, 30000);
      await new Promise((r) => setTimeout(r, 5000));
      prodSession.url = String(url);
    }
    const game = await prodResolveGameSession({ open: true });
    prodSession.gameTargetId = game.targetId;
    prodSession.gameUrl = game.url;
    prodEmitStatus();
    return { ok: true, appView: { url: game.url } };
  } catch (e) {
    return { ok: false, error: 'app_view_failed', message: e.message || String(e) };
  }
}
ipcMain.handle('prod:app:open', async (_event, payload = {}) => prodAppOpen(payload));

// Shared by the Scripts panel Run button and the chat agent's prod_run_script.
async function prodRunScript({ path: testPath, timeout } = {}) {
  if (!prodSession?.pageSessionId) return { ok: false, error: 'not_ready' };
  if (!testPath || typeof testPath !== 'string') return { ok: false, error: 'missing_path' };
  const mod = await getNodeTestRunner();
  if (!mod) return { ok: false, error: 'runner_unavailable' };
  let raw;
  try { raw = await require('fs').promises.readFile(testPath, 'utf8'); }
  catch (e) { return { ok: false, error: 'read_failed', message: e.message }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: 'invalid_json', message: e.message }; }
  const rawSteps = Array.isArray(parsed) ? parsed : (parsed?.steps ?? []);
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return { ok: false, error: 'no_steps' };
  const notes = [];
  const steps = prodAdaptSteps(rawSteps, notes);
  try {
    const game = await prodResolveGameSession({ open: true });
    const shim = prodRunnerShim(game);
    prodBroadcast('prod:test:state', { status: 'running', path: testPath, total: steps.length, ts: Date.now() });
    const result = await mod.runTest(shim.wc, steps, { timeout: Number(timeout) || 20 * 60 * 1000 });
    const vars = { ...result.vars };
    delete vars.__lastScreenshot; // base64 blobs never cross the IPC boundary
    const payload = {
      ok: result.ok,
      steps: result.steps,
      total: result.total,
      errors: result.errors,
      notes,
      vars,
      screenshots: result.screenshots?.length || 0,
      appViewUrl: shim.state.url,
    };
    prodBroadcast('prod:test:state', { status: result.ok ? 'passed' : 'failed', path: testPath, ...payload, ts: Date.now() });
    return payload;
  } catch (e) {
    const message = e.message || String(e);
    prodBroadcast('prod:test:state', { status: 'failed', path: testPath, error: message, ts: Date.now() });
    return { ok: false, error: 'run_failed', message, notes };
  }
}
ipcMain.handle('prod:test:run', async (_event, payload = {}) => prodRunScript(payload));

const captureCanvasPNG = async () => {
  if (prodCanvasActive && latestProdFrame?.buffer) {
    const image = nativeImage.createFromBuffer(latestProdFrame.buffer);
    return image && !image.isEmpty() ? image : null;
  }
  const entries = [...canvasWebContentsViews.entries()];
  if (entries.length) {
    const img = await entries[entries.length - 1][1].webContents.capturePage();
    return (img && !img.isEmpty()) ? img : null;
  }
  try {
    const r = await mainWindow.webContents.executeJavaScript(_CANVAS_IFRAME_RECT_JS, true);
    if (!r || r.width <= 0) return null;
    const img = await mainWindow.webContents.capturePage(r);
    return (img && !img.isEmpty()) ? img : null;
  } catch { return null; }
};
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
  if (!view) {
    // Post View is a plain DOM <iframe> living in the MAIN renderer, not a
    // WebContentsView — so its DOM is inspectable from the main window's
    // devtools (expand the iframe node in the Elements tree). Falling back
    // beats the old "No preview open" dead end. (Jul 25)
    try {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
      return { ok: true, target: 'renderer' };
    } catch (e) { return { ok: false, error: 'No preview open' }; }
  }
  try {
    const wc = view.webContents;
    if (wc.isDevToolsOpened()) { wc.closeDevTools(); return { ok: true, target: 'preview', closed: true }; }
    wc.openDevTools({ mode: 'detach' });
    return { ok: true, target: 'preview' };
  }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Right-click menu on a preview view — gives the canvas the same affordances
// as a real Chrome tab, most importantly **Inspect Element**.
//
// Why this is worth having: the preview is a WebContentsView, a separate
// composited layer with its own webContents. Without a context-menu handler
// it swallows right-clicks entirely, so the only way in was the command
// palette (whole-page devtools, no node targeting). `params.x`/`params.y`
// arrive already view-relative, so `inspectElement` lands on the exact node
// under the cursor.
//
// The Styles/Computed panes are also the ONLY practical way to see
// user-agent-origin rules, which no diff of author CSS can reveal — see the
// Jul 25 `.squad-slot { align-items }` bug where Chromium 126 kept a UA rule
// Chrome 150 had dropped. (Jul 25)
function attachPreviewContextMenu(view, devToolsEnabled) {
  view.webContents.on('context-menu', (_event, params) => {
    const wc = view.webContents;
    const template = [];

    if (params.selectionText) {
      template.push(
        { role: 'copy' },
        { label: 'Copy selection', click: () => { try { clipboard.writeText(params.selectionText); } catch {} } },
      );
    }
    if (params.linkURL) {
      template.push({ label: 'Copy link address', click: () => { try { clipboard.writeText(params.linkURL); } catch {} } });
    }
    if (params.srcURL) {
      template.push({ label: 'Copy image address', click: () => { try { clipboard.writeText(params.srcURL); } catch {} } });
    }
    if (template.length) template.push({ type: 'separator' });

    template.push(
      { label: 'Reload Preview', click: () => { try { wc.reload(); } catch {} } },
      { label: 'Reload, Ignoring Cache', click: () => { try { wc.reloadIgnoringCache(); } catch {} } },
    );

    if (devToolsEnabled) {
      template.push(
        { type: 'separator' },
        { label: 'Inspect Element', click: () => { try { wc.inspectElement(params.x, params.y); } catch {} } },
        {
          label: wc.isDevToolsOpened() ? 'Close Preview DevTools' : 'Open Preview DevTools',
          click: () => {
            try { wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' }); } catch {}
          },
        },
      );
    }

    try { Menu.buildFromTemplate(template).popup({ window: mainWindow }); } catch {}
  });
}


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
    attachPreviewContextMenu(view, !opts || opts.devTools !== false);
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

// ------------------------------------------------------------
// Clipboard image — paste into AI chat + Claude Code panel
// (Jul 16 ~23:30 ET). The renderer's paste handler reads the image
// directly via `e.clipboardData.items` for small/typical cases, but
// Electron's main-process clipboard is the reliable path for images
// copied from native macOS apps (Lightshot, Safari, Finder, Preview)
// where the dataTransfer is empty or only carries a file promise.
// ------------------------------------------------------------
// 10MB hard ceiling — Anthropic's image API rejects >5MB and a
// 10MB cap leaves headroom for base64 expansion.
const CLIPBOARD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
ipcMain.handle('clipboard:readImage', async () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, error: 'no_image' };
    const size = img.getSize();
    if (!size || !size.width || !size.height) return { ok: false, error: 'no_image' };
    // Prefer PNG (lossless + transparent). Fall back to JPEG if PNG
    // encoding fails (some clipboard sources carry JPEG natively).
    let buf = img.toPNG();
    let mime = 'image/png';
    if (!buf || buf.length === 0) {
      buf = img.toJPEG(85);
      mime = 'image/jpeg';
    }
    if (!buf || buf.length === 0) return { ok: false, error: 'encode_failed' };
    if (buf.length > CLIPBOARD_IMAGE_MAX_BYTES) {
      return { ok: false, error: 'too_large', sizeBytes: buf.length, maxBytes: CLIPBOARD_IMAGE_MAX_BYTES };
    }
    const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    return {
      ok: true,
      dataUrl,
      mime,
      width: size.width,
      height: size.height,
      sizeBytes: buf.length,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'read_failed' };
  }
});

// Write a base64 data URL to disk inside the workspace's
// `.farnsworth-clipboard/` directory. Used by the Claude Code panel to
// produce a file reference the running `claude` CLI can read via
// `@/path` paste-style attachment. Falls back to the user-data dir if
// no workspace folder is open.
ipcMain.handle('clipboard:saveImage', async (_event, { dataUrl, name } = {}) => {
  try {
    if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, error: 'missing_dataUrl' };
    const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!m) return { ok: false, error: 'bad_dataUrl' };
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return { ok: false, error: 'empty' };
    if (buf.length > CLIPBOARD_IMAGE_MAX_BYTES) {
      return { ok: false, error: 'too_large', sizeBytes: buf.length, maxBytes: CLIPBOARD_IMAGE_MAX_BYTES };
    }
    // Pick a folder: workspace .farnsworth-clipboard/ if a folder is
    // open, else user-data. Both are project-scoped so old refs aren't
    // left lying around forever.
    const folder = currentFolderSetting() || app.getPath('userData');
    const dir = path.join(folder, '.farnsworth-clipboard');
    await fs.mkdir(dir, { recursive: true });
    const ext = mime === 'image/jpeg' ? 'jpg'
      : mime === 'image/png' ? 'png'
      : mime === 'image/gif' ? 'gif'
      : mime === 'image/webp' ? 'webp'
      : 'img';
    const safeName = (name && typeof name === 'string')
      ? name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
      : 'clipboard';
    const filename = `${Date.now()}-${safeName}.${ext}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buf);
    return { ok: true, filePath, sizeBytes: buf.length, mime };
  } catch (e) {
    return { ok: false, error: e.message || 'write_failed' };
  }
});

// ------------------------------------------------------------
// File attachments — open file picker + read small text files for
// inline content (Jul 16 ~23:55 ET). Extends the clipboard image
// pipeline to handle arbitrary files via the paperclip button,
// drag-and-drop, and Finder "Copy" + paste.
// ------------------------------------------------------------
// 100KB inline cap for text files — past this the Anthropic message
// body gets unwieldy and we just send a `@<path>` reference instead.
const FILE_INLINE_MAX_BYTES = 100 * 1024;
// 50MB absolute ceiling on any single attachment — protects the dialog
// picker from accidentally importing a gigabyte log file.
const FILE_ATTACH_MAX_BYTES = 50 * 1024 * 1024;
ipcMain.handle('dialog:openFiles', async () => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: true, canceled: true, files: [] };
    }
    const files = [];
    for (const fp of res.filePaths) {
      try {
        const stat = await fs.stat(fp);
        if (stat.size > FILE_ATTACH_MAX_BYTES) {
          files.push({ ok: false, filePath: fp, error: 'too_large', sizeBytes: stat.size });
          continue;
        }
        files.push({
          ok: true,
          filePath: fp,
          name: path.basename(fp),
          sizeBytes: stat.size,
        });
      } catch (e) {
        files.push({ ok: false, filePath: fp, error: e.message || 'stat_failed' });
      }
    }
    return { ok: true, canceled: false, files };
  } catch (e) {
    return { ok: false, error: e.message || 'dialog_failed' };
  }
});

// Read a small text file's content for inline inclusion in a message.
// Caller is responsible for checking size — we still enforce the cap
// here as a defense-in-depth measure.
ipcMain.handle('file:read', async (_event, { filePath, maxBytes } = {}) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'missing_path' };
    const cap = Number.isFinite(maxBytes) ? Math.min(maxBytes, FILE_INLINE_MAX_BYTES) : FILE_INLINE_MAX_BYTES;
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: 'not_a_file' };
    if (stat.size > cap) {
      return { ok: false, error: 'too_large', sizeBytes: stat.size, maxBytes: cap };
    }
    const buf = await fs.readFile(filePath);
    // Decode as utf-8 with replacement so a binary file masquerading as
    // text doesn't blow up the renderer. The renderer can still detect
    // a bad decode via replacement chars if it cares.
    const content = buf.toString('utf8').replace(/\uFFFD/g, '\uFFFD\uFFFD');
    return {
      ok: true,
      content,
      sizeBytes: stat.size,
      name: path.basename(filePath),
      filePath,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'read_failed' };
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
// ---- test runner discovery (python3 + farnsworth-test.py) --------------
// Test View and the chat agent's test_run tool both shell out to
// farnsworth-test.py, an external Python process that drives the canvas
// preview over CDP. Three assumptions in here were only ever true on the
// machine that wrote them, so on an installed build EVERY test failed with
// "Exit ?" and two empty output blocks (found Jul 29 on v0.1.5):
//
//   1. cwd was app.getAppPath(). In a packaged build that resolves to
//      .../Contents/Resources/app.asar -- a FILE, not a directory. spawn()
//      rejects it before the child process exists, so there is no exit code
//      and nothing on stderr to show. That is the "Exit ?" signature.
//   2. The script was resolved inside app.asar. A plain python process has
//      no asar support and cannot read it there, so it now ships via
//      extraResources to Contents/Resources/test-runner/.
//   3. spawn('python3') trusted PATH. A GUI-launched Electron app inherits
//      only /usr/bin:/bin:/usr/sbin:/sbin from LaunchServices -- no
//      Homebrew, no pyenv, no conda. Identical to the npm ENOENT bug.
//
// Same family as the nono-profile, server-runner and npm path bugs: resolve
// against the real install, and say so out loud when the resolve fails.

function resolveTestRunnerPath() {
  // Module-scope `fs` in this file is fs/promises (see the note at the top),
  // which has no statSync. Every sync helper here shadows it locally, and this
  // one must too -- without it the statSync call threw TypeError, the catch
  // swallowed it, and the function reported "runner not found" on a machine
  // where the file was sitting right there (Jul 29, shipped broken in v0.1.6).
  const fs = require('fs');
  const candidates = [];
  if (process.env.FARNSWORTH_TEST_RUNNER) candidates.push(process.env.FARNSWORTH_TEST_RUNNER);
  if (app.isPackaged) {
    // extraResources target (electron-builder.yml) -- a real file on disk.
    candidates.push(path.join(process.resourcesPath, 'test-runner', 'farnsworth-test.py'));
    candidates.push(path.join(process.resourcesPath, 'farnsworth-test.py'));
    // asarUnpack shape, in case packaging moves to that mechanism later.
    candidates.push(path.join(app.getAppPath() + '.unpacked', 'farnsworth-test.py'));
  }
  candidates.push(path.join(__dirname, 'farnsworth-test.py'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

let _pythonBinCache;
function resolvePythonBin() {
  if (_pythonBinCache !== undefined) return _pythonBinCache;
  const os = require('os');
  const fs = require('fs'); // NOT the module-scope fs/promises -- see above.
  const isExec = (f) => {
    try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); }
    catch { return false; }
  };
  const names = ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];
  const candidates = [];
  // 1. Explicit escape hatch for exotic setups.
  if (process.env.FARNSWORTH_PYTHON) candidates.push(process.env.FARNSWORTH_PYTHON);
  // 2. The user's own login shell -- the one place that knows about pyenv,
  //    conda, uv, asdf and friends. Preferred over /usr/bin/python3, which on
  //    macOS is a Command Line Tools stub with no third-party packages.
  for (const d of getUserShellPathDirs()) for (const n of names) candidates.push(path.join(d, n));
  for (const d of discoverToolchainDirs()) for (const n of names) candidates.push(path.join(d, n));
  // 3. Static fallbacks for the common installs.
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin']) {
    for (const n of names) candidates.push(path.join(d, n));
  }
  // 4. Version managers, newest first, in case the shell probe failed.
  const home = os.homedir();
  candidates.push(path.join(home, '.pyenv', 'shims', 'python3'));
  try {
    const base = path.join(home, '.pyenv', 'versions');
    for (const v of fs.readdirSync(base).sort().reverse()) {
      candidates.push(path.join(base, v, 'bin', 'python3'));
    }
  } catch {}
  for (const d of ['miniconda3', 'anaconda3', '.local']) {
    candidates.push(path.join(home, d, 'bin', 'python3'));
  }
  // 5. System python last: it exists on every Mac but is the least likely to
  //    have websocket-client installed.
  candidates.push('/usr/bin/python3');
  for (const c of candidates) {
    if (isExec(c)) { _pythonBinCache = c; return _pythonBinCache; }
  }
  _pythonBinCache = null;
  return _pythonBinCache;
}

// Cached on SUCCESS only: if the dep gets installed mid-session, the next run
// should pick it up instead of repeating a stale complaint.
let _pyDepsOk = false;
function checkTestRunnerDeps(pythonBin, env) {
  if (_pyDepsOk) return { ok: true };
  try {
    const { execFileSync } = require('child_process');
    execFileSync(pythonBin, ['-c', 'import websocket'], {
      timeout: 15000, stdio: 'ignore', env,
    });
    _pyDepsOk = true;
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        'The test runner needs the Python package "websocket-client", which ' +
        'is not installed for the interpreter Farnsworth found:\n  ' + pythonBin +
        '\n\nInstall it with:\n  "' + pythonBin + '" -m pip install --user websocket-client' +
        '\n\nTo point Farnsworth at a different interpreter instead, set ' +
        'FARNSWORTH_PYTHON to its full path.',
    };
  }
}

// Returns { proc } on success, or { error, message } when the runner could not
// be started. Callers must surface the message field -- swallowing it is what made this
// bug class invisible for so long.
async function spawnTestRunner(testPath, runnerEnv) {
  const { spawn } = require('child_process');

  const runner = resolveTestRunnerPath();
  if (!runner) {
    return {
      error: 'runner_not_found',
      message:
        'Could not find farnsworth-test.py. Expected it next to the app, or ' +
        'at Contents/Resources/test-runner/farnsworth-test.py in an installed ' +
        'build. Set FARNSWORTH_TEST_RUNNER to override.',
    };
  }
  const pythonBin = resolvePythonBin();
  if (!pythonBin) {
    return {
      error: 'python_not_found',
      message:
        'Could not find a python3 interpreter. Farnsworth checked your login ' +
        'shell PATH, Homebrew, pyenv, conda and /usr/bin. Install Python 3 ' +
        '(brew install python) or set FARNSWORTH_PYTHON to its full path.',
    };
  }

  // Absolute interpreter path is not enough on its own: the runner shells out
  // to other tools, so the child needs a PATH that reflects this machine.
  const env = { ...runnerEnv };
  env.PATH = composeChildPath([path.dirname(pythonBin)], env.PATH);

  const deps = checkTestRunnerDeps(pythonBin, env);
  if (!deps.ok) return { error: 'python_dep_missing', message: deps.message };

  // Tell the runner which port to use rather than letting it assume 9222.
  const cdpPort = activeCdpPort();
  if (cdpPort) env.FARNSWORTH_CDP_PORT = String(cdpPort);
  const cdp = await checkCdpReachable(cdpPort);
  if (!cdp.ok) {
    return {
      error: 'cdp_unavailable',
      message:
        cdp.reason === 'disabled'
          ? 'The test runner drives the app over the DevTools protocol, but the ' +
            'debugging port is disabled (FARNSWORTH_CDP_PORT=off). Unset it and ' +
            'restart Farnsworth.'
          : 'Farnsworth is not listening on DevTools port ' + cdpPort + ', so the ' +
            'test runner has nothing to attach to (connection ' + cdp.reason + ').\n\n' +
            'This port is enabled at startup, so a restart of Farnsworth usually ' +
            'fixes it. If another Farnsworth instance already holds ' + cdpPort + ', ' +
            'quit it, or set FARNSWORTH_CDP_PORT to a free port and restart.',
    };
  }

  // cwd must be a real DIRECTORY. This is the line that broke every packaged
  // build: app.getAppPath() is app.asar, a file.
  const cwd = path.dirname(runner);
  try {
    const proc = spawn(pythonBin, [runner, testPath], { cwd, env });
    return { proc, runner, pythonBin, cwd };
  } catch (e) {
    return {
      error: e.code || 'spawn_failed',
      message: 'Could not start ' + pythonBin + ': ' + e.message,
    };
  }
}

// Settings → AI → Testing model: display name → API id for the runner env
// (FARNSWORTH_TEST_MODEL). Mirrors src/app.js modelToApiId — keep in sync.
// Unknown values pass through: the runner accepts haiku/sonnet/opus aliases
// and full API ids. Returns null when the setting is unset (runner default:
// claude-sonnet-4-5).
const MODEL_DISPLAY_TO_API = {
  'Opus 5': 'claude-opus-5',
  'Opus 5 High': 'claude-opus-5',
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

// Node-native test runner (Aug 3 2026) — replaces the Python/websocket-client
// CDP runner for the actions it correctly implements. See
// src/farnsworth-test-runner.mjs header + farnsworth-node-test-runner for the
// two known gaps (switchUser is an unimplemented stub; llm-step always shells
// to the claude CLI instead of taking the direct-API fast path the Python
// runner uses). recursivelyHasUnsupportedAction() walks nested if/while steps
// so a test using either action anywhere still gets routed to the proven
// Python path — never silently degraded.
let _nodeTestRunnerMod = null;
async function getNodeTestRunner() {
  if (_nodeTestRunnerMod === null) {
    try { _nodeTestRunnerMod = await import('./src/farnsworth-test-runner.mjs'); }
    catch (e) { console.warn('[test-runner] Node module unavailable:', e.message); _nodeTestRunnerMod = false; }
  }
  return _nodeTestRunnerMod || null;
}

function recursivelyHasUnsupportedAction(steps, unsupportedSet) {
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (unsupportedSet.has(step.action)) return true;
    if (Array.isArray(step.steps) && recursivelyHasUnsupportedAction(step.steps, unsupportedSet)) return true;
  }
  return false;
}

// Attempts the Node-native path. Returns the formatted {ok, code, failed,
// stdout, stderr} result on success, or null if the test isn't eligible
// (unsupported action present, no canvas preview, module unavailable, or the
// run itself threw) — null means "fall back to the Python runner below".
async function tryNodeTestRunner(testPath) {
  const mod = await getNodeTestRunner();
  if (!mod) return null;

  const view = canvasWebContentsViews.values().next().value;
  if (!view || view.webContents.isDestroyed()) return null;

  let raw;
  try {
    raw = await require('fs').promises.readFile(testPath, 'utf8');
  } catch {
    return null; // let the Python path produce the real "file not found" error
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const steps = Array.isArray(parsed) ? parsed : (parsed?.steps ?? []);
  if (!Array.isArray(steps) || steps.length === 0) return null;
  if (recursivelyHasUnsupportedAction(steps, mod.UNSUPPORTED_ACTIONS)) {
    console.log('[test-runner] test uses switchUser/llm-step — routing to Python runner');
    return null;
  }

  const wc = view.webContents;
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.1');
      attachedHere = true;
    }
    const result = await mod.runTest(wc, steps, { timeout: 60000 });
    const lines = result.errors.map((e) => `[error] ${e}`);
    return {
      ok: result.ok,
      code: result.ok ? 0 : 1,
      failed: result.errors.length,
      stdout: [`[test-runner:node] ${result.steps}/${result.total} steps completed`, ...lines].join('\n').slice(-4000),
      stderr: '',
    };
  } catch (e) {
    console.warn('[test-runner] Node path threw, falling back to Python:', e.message);
    return null;
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch {}
    }
  }
}

ipcMain.handle('test:run', async (_event, { path: testPath }) => {
  // test:run takes an absolute test path (not a folder) — the renderer
  // already knows the per-project dir from the test:list response, and
  // passes the full path through. This lets the IPC work for tests that
  // live anywhere, not just the active project's dir.
  try {
    if (!testPath || typeof testPath !== 'string') return { ok: false, error: 'missing_path' };

    // Try the Node-native path first (no Python/websocket-client
    // dependency, no CDP-over-WebSocket hop). Falls through to the
    // existing Python runner untouched if not eligible or if it errors.
    const nodeResult = await tryNodeTestRunner(testPath);
    if (nodeResult) {
      try {
        const rc = getRelayClient();
        if (rc && rc.status === 'connected') {
          rc.send({
            type: 'test:state',
            testId: testPath,
            status: nodeResult.ok ? 'passed' : 'failed',
            code: nodeResult.code, failed: nodeResult.failed, ts: Date.now(),
          });
        }
      } catch {}
      return nodeResult;
    }
    // Spawn the Python test runner. Capture stdout+stderr, resolve with
    // the merged output. Exit code 0 = pass, non-zero = fail (but a test
    // can also exit 0 with "X failed" in stdout — treat that as partial).
    // Runner path, interpreter and cwd are all resolved by
    // spawnTestRunner() -- see the notes on that helper for why each one
    // needed fixing for installed builds.
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
    const launch = await spawnTestRunner(testPath, runnerEnv);
    if (launch.error) {
      try {
        const rc = getRelayClient();
        if (rc && rc.status === 'connected') {
          rc.send({ type: 'test:state', testId: testPath, status: 'failed', error: launch.error, ts: Date.now() });
        }
      } catch {}
      return { ok: false, error: launch.error, message: launch.message };
    }
    return await new Promise((resolve) => {
      const proc = launch.proc;
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
        resolve({ ok: false, error: err.code || 'spawn_error', message: err.message });
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
  consolidation: { enabled: true, model: 'Sonnet 5',  tier: 'balanced', schedule: 'Daily', autoOnBuffer: true, bufferThreshold: 50, batchSize: 12, maxTokens: 8192 },
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

// Recover the complete op objects from a TRUNCATED ops array. The model emits
// ops in order, so everything before the cut is perfectly good — but the old
// all-or-nothing JSON.parse threw away an entire pass because the last op was
// half-written. Scans balanced braces outside of string literals.
function memorySalvageOps(text) {
  if (!text || typeof text !== 'string') return [];
  const key = text.indexOf('"ops"');
  if (key === -1) return [];
  const arrStart = text.indexOf('[', key);
  if (arrStart === -1) return [];
  const ops = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { ops.push(JSON.parse(text.slice(objStart, i + 1))); } catch {}
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return ops;
}

// One inference call for a pipeline stage, on the stage's configured model.
// Returns the response text, or null (stage disabled / no auth / API error).
// Callers MUST degrade to their non-model behavior on null.
async function memoryStageInference(stage, system, user, maxTokens = 512, meta = null) {
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
    const blocks = data.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
    // A 200 OK is NOT success for this pipeline. Two silent failure modes,
    // both of which stalled consolidation from Jul 14 → Aug 1 2026 while
    // lastError stayed null and the run counter kept climbing:
    //   1. the model burns the whole budget on thinking blocks → text is ''
    //      → the caller sees a falsy result and reports 'inference_unavailable'
    //   2. the model stops mid-JSON at max_tokens → JSON.parse throws
    //      → the caller reports 'bad_model_output'
    // Neither was an HTTP error, so neither was ever recorded. Record them.
    const truncated = data.stop_reason === 'max_tokens';
    if (meta) {
      meta.stopReason = data.stop_reason;
      meta.blockTypes = blocks.map(b => b.type);
      meta.textLen = text.length;
      meta.outputTokens = data.usage?.output_tokens ?? null;
      meta.truncated = truncated;
    }
    const softError = !text
      ? `empty_text (stop=${data.stop_reason}, blocks=${blocks.map(b => b.type).join('+') || 'none'}, max_tokens=${maxTokens})`
      : truncated
        ? `truncated at max_tokens=${maxTokens} (output_tokens=${data.usage?.output_tokens ?? '?'})`
        : null;
    db.memoryStageStatsPatch(stage, { lastRun: new Date().toISOString(), ms, model, lastError: softError }, true);
    if (softError) console.warn(`[memory tier3] ${stage}: ${softError}`);
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
    return await drainConsolidation(reason);
  } finally {
    consolidationRunning = false;
  }
}

// Drain the buffer in bounded batches. One batch per invocation meant a buffer
// growing faster than the schedule could never catch up — with a daily tick and
// a stuck pass, 228 rows had piled up by Aug 1 2026.
async function drainConsolidation(reason) {
  const MAX_BATCHES = 25;
  const totals = { append: 0, create: 0, essential: 0, drop: 0, lane: 0 };
  let processed = 0, batches = 0, last = null;
  for (let i = 0; i < MAX_BATCHES; i++) {
    last = await runConsolidationBatch(reason);
    if (!last.ok || !last.processed) break; // error, or no forward progress
    batches++;
    processed += last.processed;
    for (const k of Object.keys(totals)) totals[k] += (last.applied?.[k] || 0);
    if (db.memoryUnconsolidatedCount() === 0) break;
  }
  const remaining = db.memoryUnconsolidatedCount();
  console.log(`[memory tier3] consolidation drain (${reason}): ${processed} rows in ${batches} batches → ${JSON.stringify(totals)}; ${remaining} remaining`);
  if (!batches && last && !last.ok) return { ...last, reason };
  return { ok: true, processed, batches, applied: totals, remaining, reason };
}

function normalizeExplicitMemorySlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// Explicit memory writes are durable before they are applied: the directive is
// appended to the buffer and the human-readable request is written to the
// immutable archive first. Applying it synchronously makes "remember this"
// visible in the same turn; leaving the buffer row unconsolidated until after
// the concept write gives the normal consolidation loop crash recovery.
function queueExplicitMemoryDirective(op, input, folderOverride = null) {
  const slug = normalizeExplicitMemorySlug(input?.slug);
  const scope = input?.scope;
  if (!['global', 'project'].includes(scope)) {
    return { ok: false, error: 'bad_input', message: 'scope must be global or project' };
  }
  const workspacePath = scope === 'project' ? (folderOverride || currentFolderSetting()) : null;
  if (!slug) return { ok: false, error: 'bad_input', message: 'slug required' };
  if (scope === 'project' && !workspacePath) {
    return { ok: false, error: 'no_folder', message: 'Project-scoped memory requires an open workspace folder.' };
  }
  const directive = {
    version: 1,
    op,
    slug,
    title: String(input?.title || '').trim() || slug.replace(/-/g, ' '),
    section: String(input?.section || '').trim() || (op === 'upsert' ? 'procedure' : 'notes'),
    content: String(input?.content || '').trim(),
    match: String(input?.match || '').trim(),
    replacement: String(input?.replacement || '').trim(),
    reason: String(input?.reason || '').trim(),
    scope,
    requestedAt: new Date().toISOString(),
  };
  if ((op === 'upsert' || op === 'append') && !directive.content) {
    return { ok: false, error: 'bad_input', message: 'content required' };
  }
  if (op === 'forget' && !directive.match) {
    return { ok: false, error: 'bad_input', message: 'match required' };
  }

  const context = `explicit-memory:${op}:${slug}`;
  const buffered = db.memoryBufferAppend(JSON.stringify(directive), context, 'agent.memory.explicit', workspacePath);
  if (!buffered?.ok) return buffered;
  const summary = op === 'forget'
    ? `Forget from ${slug}: ${directive.match}${directive.replacement ? ` → ${directive.replacement}` : ''}`
    : `${op === 'upsert' ? 'Save' : 'Append'} to ${slug}: ${directive.content}`;
  const archived = db.memoryArchiveAppend(
    op === 'forget' ? 'correction' : 'fact',
    summary,
    { source: 'agent.memory.explicit', tool: `memory_${op}`, directive },
    null,
    workspacePath
  );
  if (!archived?.ok) {
    console.warn('[memory explicit] archive write failed after buffer append:', archived?.error || 'unknown');
  }
  return { ok: true, directive, bufferId: buffered.id, archiveId: archived?.id || null, workspacePath };
}

function replaceMemorySection(body, heading, content) {
  const h = String(heading || 'procedure').trim();
  const text = String(content || '').trim();
  const source = String(body || '');
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*$`, 'm');
  const match = re.exec(source);
  if (!match) return (source ? source.replace(/\s*$/, '\n\n') : '') + `## ${h}\n\n${text}\n`;
  const afterHeading = match.index + match[0].length;
  const tail = source.slice(afterHeading);
  const nextSection = tail.search(/^##\s+/m);
  const end = nextSection === -1 ? source.length : afterHeading + nextSection;
  return source.slice(0, afterHeading) + `\n\n${text}\n\n` + source.slice(end).replace(/^\s+/, '');
}

function archiveExplicitMemoryRevision(directive, existing, workspacePath) {
  if (!existing) return null;
  const snapshot = {
    version: 1,
    slug: existing.slug,
    title: existing.title || null,
    lead: existing.lead || null,
    body: existing.body || '',
    sections: existing.sections || null,
    tags: existing.tags || null,
    source: existing.source || null,
    confidence: existing.confidence ?? null,
    replacedBy: directive,
  };
  return db.memoryArchiveAppend(
    'correction',
    `Revision snapshot before memory_${directive.op} on ${directive.slug}`,
    { source: 'agent.memory.revision', tool: `memory_${directive.op}`, snapshot },
    null,
    workspacePath || null
  );
}

function applyExplicitMemoryDirectives(rows) {
  const applied = { append: 0, create: 0, essential: 0, drop: 0, lane: 0 };
  const doneIds = [];
  const terminalIds = [];
  const results = [];
  for (const row of rows || []) {
    if (!['agent.memory.explicit', 'mcp-explicit'].includes(row?.source)) continue;
    let d = null;
    try { d = JSON.parse(row.content); } catch {
      terminalIds.push(row.id);
      results.push({ id: row.id, ok: false, terminal: true, error: 'invalid_directive_json' });
      continue;
    }
    const slug = normalizeExplicitMemorySlug(d.slug);
    if (!slug || !['upsert', 'append', 'forget'].includes(d.op)) {
      terminalIds.push(row.id);
      results.push({ id: row.id, ok: false, terminal: true, error: 'invalid_directive' });
      continue;
    }
    try {
      const existing = db.memoryGetConcept(slug);
      if (d.op === 'forget') {
        if (!existing) {
          terminalIds.push(row.id);
          results.push({ id: row.id, ok: false, terminal: true, error: 'concept_not_found', slug });
          continue;
        }
        const body = String(existing.body || '');
        if (!body.includes(d.match)) {
          terminalIds.push(row.id);
          results.push({ id: row.id, ok: false, terminal: true, error: 'match_not_found', slug });
          continue;
        }
        const revision = archiveExplicitMemoryRevision(d, existing, row.workspace_path);
        if (revision && !revision.ok) console.warn('[memory explicit] revision archive failed:', revision.error || 'unknown');
        const nextBody = body.replace(d.match, d.replacement || '').replace(/\n{3,}/g, '\n\n').trim();
        const r = db.memoryUpsertConcept({
          slug,
          title: existing.title || d.title || slug.replace(/-/g, ' '),
          lead: existing.lead || null,
          body: nextBody,
          sections: null,
          tags: existing.tags || null,
          source: 'explicit-correction',
          confidence: 1.0,
        });
        if (!r?.ok) throw new Error(r?.error || 'concept update failed');
        applied.drop++;
        results.push({ id: row.id, ok: true, op: d.op, slug, replaced: !!d.replacement });
      } else if (existing) {
        const body = String(existing.body || '');
        if (d.op === 'upsert') {
          const revision = archiveExplicitMemoryRevision(d, existing, row.workspace_path);
          if (revision && !revision.ok) console.warn('[memory explicit] revision archive failed:', revision.error || 'unknown');
          const nextBody = replaceMemorySection(body, d.section || 'procedure', d.content);
          const r = db.memoryUpsertConcept({
            slug,
            title: d.title || existing.title || slug.replace(/-/g, ' '),
            lead: d.content.slice(0, 240),
            body: nextBody,
            sections: null,
            tags: existing.tags || null,
            source: 'explicit',
            confidence: 1.0,
          });
          if (!r?.ok) throw new Error(r?.error || 'concept upsert failed');
          applied.append++;
          results.push({ id: row.id, ok: true, op: d.op, slug, updated: true });
        } else {
          if (!body.includes(d.content)) {
            const revision = archiveExplicitMemoryRevision(d, existing, row.workspace_path);
            if (revision && !revision.ok) console.warn('[memory explicit] revision archive failed:', revision.error || 'unknown');
            const r = db.memoryAppendToSection(slug, d.section || 'notes', d.content);
            if (!r?.ok) throw new Error(r?.error || 'concept append failed');
          }
          applied.append++;
          results.push({ id: row.id, ok: true, op: d.op, slug, deduplicated: body.includes(d.content) });
        }
      } else {
        const section = d.section || (d.op === 'upsert' ? 'procedure' : 'notes');
        const r = db.memoryUpsertConcept({
          slug,
          title: d.title || slug.replace(/-/g, ' '),
          lead: d.content.slice(0, 240),
          body: `## ${section}\n\n${d.content}\n`,
          source: 'explicit',
          confidence: 1.0,
        });
        if (!r?.ok) throw new Error(r?.error || 'concept create failed');
        applied.create++;
        results.push({ id: row.id, ok: true, op: d.op, slug, created: true });
      }
      doneIds.push(row.id);
    } catch (e) {
      results.push({ id: row.id, ok: false, error: e.message, slug });
    }
  }
  const finalizedIds = [...new Set([...doneIds, ...terminalIds])];
  if (finalizedIds.length) db.memoryConsolidate(finalizedIds);
  return { processed: finalizedIds.length, succeeded: doneIds.length, failed: terminalIds.length, applied, results };
}

async function runConsolidationBatch(reason = 'manual') {
  {
    const conf = memoryStageConf('consolidation');
    // Every buffered fact has to round-trip through the model's OUTPUT budget
    // as a JSON op, so the batch size and the token ceiling are one decision.
    // 50 rows never fit in the old hardcoded 2048 tokens.
    const batchSize = Math.max(1, Math.min(50, Number(conf.batchSize) || 12));
    const maxTokens = Math.max(2048, Math.min(16384, Number(conf.maxTokens) || 8192));
    let buffer = db.memoryBufferList(true, batchSize);
    if (!buffer.length) return { ok: true, processed: 0, reason };

    // Explicit memory directives are deterministic and must never be handed to
    // the consolidation model as opaque JSON. Apply them through db.js so the
    // canonical concept body and derived memory_sections index stay in sync.
    const explicitSources = new Set(['agent.memory.explicit', 'mcp-explicit']);
    const explicit = applyExplicitMemoryDirectives(buffer.filter(row => explicitSources.has(row.source)));
    buffer = buffer.filter(row => !explicitSources.has(row.source));
    if (!buffer.length) {
      return {
        ok: true,
        processed: explicit.processed,
        total: explicit.results.length,
        applied: explicit.applied,
        explicit: explicit.results,
        explicitFailures: explicit.results.filter(r => !r.ok).length,
        reason,
      };
    }
    if (!conf.enabled) {
      const ordinary = db.memoryConsolidate(buffer.map(row => row.id));
      return {
        ...ordinary,
        processed: explicit.processed + (ordinary.count || 0),
        total: explicit.results.length + buffer.length,
        applied: explicit.applied,
        explicit: explicit.results,
        explicitFailures: explicit.results.filter(r => !r.ok).length,
        reason,
      };
    } // Tier-1: flip ordinary rows only
    const concepts = db.memoryListConcepts(100);
    const articleIndex = concepts.map(c => `- ${c.slug} — ${c.title}${c.lead ? ': ' + String(c.lead).slice(0, 120) : ''}`).join('\n') || '(no articles yet)';
    // Facts carry the project they came from so the model can attribute them
    // instead of blending two codebases into one article.
    const projectOf = (p) => (p ? String(p).split('/').filter(Boolean).pop() : null);
    const bufferLines = buffer.map(b => {
      const proj = projectOf(b.workspace_path);
      return `[${b.id}] (${b.source || 'chat'}${proj ? `, project: ${proj}` : ''}) ${String(b.content).slice(0, 400)}`;
    }).join('\n');
    const system = `You are the consolidation stage of an IDE assistant's memory system. Merge buffered facts into wiki-style concept articles. Prefer appending to existing articles; create an article only for a genuinely new durable topic. Use "essential" only for identity-level facts that must load every session. Use "drop" for noise, duplicates, and transient status.
Two special always-loaded articles exist: 'threads' (open loops — active commitments, follow-ups, waiting-on-someone) and 'recent' (rolling digest of notable events, newest first). Keep them current: file open-loop facts into 'threads' and notable events into 'recent' (append, or a "lane" op to REPLACE the whole body when entries resolved or went stale — keep each lane under ~20 lines). "lane" ops take ids:[] and don't consume buffer ids.
Buffer lines may carry "project: <name>" — that is the workspace the fact came from. Keep project-specific facts in project-specific articles (prefer a slug that names the project) and never merge facts from two different projects into one article. Facts about the user, their preferences, or their tools are global and carry no project.
Every buffer id must appear in exactly one non-lane op. Return ONLY JSON:
{"ops":[
 {"op":"append","ids":[1],"slug":"existing-slug","section":"section heading","content":"markdown to append"},
 {"op":"create","ids":[2,3],"slug":"kebab-slug","title":"Title","lead":"1-2 sentence standalone summary","body":"markdown with ## section headings"},
 {"op":"essential","ids":[4],"key":"snake_case_key","value":"short value"},
 {"op":"lane","ids":[],"slug":"threads","body":"full replacement markdown"},
 {"op":"drop","ids":[5]}
]}`;
    const user = `EXISTING ARTICLES:\n${articleIndex}\n\nBUFFER (unconsolidated facts):\n${bufferLines}`;
    const meta = {};
    const text = await memoryStageInference('consolidation', system, user, maxTokens, meta);
    if (!text) {
      db.memoryStageStatsSetGlobal('lastConsolidationError', `inference_unavailable (stop=${meta.stopReason || '?'}, blocks=${(meta.blockTypes || []).join('+') || 'none'})`);
      return { ok: false, error: 'inference_unavailable', reason, meta };
    }
    const parsed = memoryParseJson(text);
    // Truncated output is still partially usable — salvage the complete ops
    // rather than discarding the whole pass.
    const ops = (parsed && Array.isArray(parsed.ops)) ? parsed.ops : memorySalvageOps(text);
    if (!ops.length) {
      db.memoryStageStatsSetGlobal('lastConsolidationError', `bad_model_output (stop=${meta.stopReason || '?'}, textLen=${text.length})`);
      return { ok: false, error: 'bad_model_output', reason, meta };
    }
    const applied = { append: 0, create: 0, essential: 0, drop: 0, lane: 0 };
    const doneIds = new Set();
    for (const op of ops) {
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
    const mergedApplied = {};
    for (const key of new Set([...Object.keys(applied), ...Object.keys(explicit.applied)])) {
      mergedApplied[key] = (applied[key] || 0) + (explicit.applied[key] || 0);
    }
    const processed = doneIds.size + explicit.processed;
    const total = buffer.length + explicit.results.length;
    db.memoryStageStatsSetGlobal('lastConsolidationAt', new Date().toISOString());
    db.memoryStageStatsSetGlobal('lastConsolidationError', processed ? null : `applied_nothing (ops=${ops.length}, stop=${meta.stopReason || '?'})`);
    console.log(`[memory tier3] consolidation batch (${reason}): ${processed}/${total} buffer rows → ${JSON.stringify(mergedApplied)}${meta.truncated ? ' [salvaged from truncated output]' : ''}`);
    return { ok: true, processed, total, applied: mergedApplied, explicit: explicit.results, explicitFailures: explicit.results.filter(r => !r.ok).length, reason, meta };
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
    db.memoryBufferAppend(`[${item.kind || 'fact'}] ${item.content}`, `retrospective: ${conv.title || convId}`, 'retrospective', conv.workspace_path || currentFolderSetting());
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
  const wsPath = opts?.workspacePath || currentFolderSetting();
  db.memoryArchiveAppend(kind, content, ctx ? { context: ctx, source: src } : { source: src }, null, wsPath);

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
            last = db.memoryBufferAppend(`[${item.kind || 'fact'}] ${item.content}`, ctx, 'extraction', wsPath);
          }
          maybeAutoConsolidate();
          return { ok: true, extracted: parsed.items.length, id: last?.id };
        }
      }
    } catch (e) {
      console.warn('[memory tier3] extraction failed, raw buffering:', e.message);
    }
  }
  const bufferRes = db.memoryBufferAppend(content, ctx, src, wsPath);
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

// Authenticated production Chrome cleanup on app quit. Synchronous because before-quit is not awaited.
app.on('before-quit', () => { try { stopProdSessionSync('before-quit'); } catch (e) { console.warn('[prod] quit cleanup failed:', e.message); } });

// Devvit dev server + server-runner cleanup on app quit (Jul 30). Synchronous
// on purpose: before-quit does not await async listeners, so a promise-based
// kill would lose the race with process exit -- which is how these leaked in
// the first place.
app.on('before-quit', () => {
  try { killTrackedDevServers('before-quit'); } catch (e) {
    console.warn('[dev:farnsworth] quit cleanup failed:', e.message);
  }
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
  // `.farnsworth` is deliberately NOT skipped: it holds the project's test
  // scripts (.farnsworth/devvit-tests/*.json), which are real source files the
  // user edits. Excluding it made them invisible to quick-open, so the only
  // way to reach a script was expanding two levels of the file tree. It is a
  // small directory (config + test JSON), not a cache.
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.DS_Store']);
  const files = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxEntries) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (files.length >= maxEntries) { truncated = true; return; }
      // `.farnsworth` is allowed through the dotfile filter for the same
      // reason it is not in skipDirs: it contains editable test scripts.
      if (ent.name.startsWith('.') && ent.name !== '.env' && ent.name !== '.farnsworth' && !opts.includeHidden) continue;
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
  if (API_KEY_PROVIDERS.includes(p)) return p;
  // Jul 19: per-endpoint key slots for custom inference (custom-<id>).
  if (typeof p === 'string' && /^custom-[A-Za-z0-9_.-]+$/.test(p)) return p;
  return 'anthropic-console';
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

// ---- Claude Code CLI login (shared: Settings + the Claude Code panel) -----
// Aug 5: a friend's fresh install could not sign in — the card showed
// "`claude login` exited with code 1". Two bugs, both here:
//
//   1. Claude Code 2.x has no top-level `login` subcommand. `claude login`
//      is parsed as a *prompt*, so the CLI answers "Not logged in · Please
//      run /login" and exits 1. The real command is `claude auth login`.
//   2. `claude auth login` does NOT capture a loopback callback (verified on
//      2.1.204 both with and without a TTY): it opens the browser with
//      redirect_uri=platform.claude.com/oauth/code/callback, prints the URL,
//      then blocks on "Paste code here if prompted >". With stdio:'ignore'
//      that flow can never complete, and the CLI's real error text was
//      thrown away, leaving a bare exit code on screen.
//
// So: pipe stdio, forward the URL + the code prompt to the renderer, and
// accept the pasted code back over claudeCode:submitLoginCode.
let activeClaudeLoginChild = null;
let claudeLoginCancelled = false;

function stripTerminalEscapes(s) {
  return String(s)
    // OSC-8 hyperlink wrappers (claude wraps the auth URL in one)
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function extractClaudeAuthUrl(text) {
  const m = stripTerminalEscapes(text).match(/https:\/\/claude\.(?:com|ai)\/\S*oauth\S*/);
  return m ? m[0] : null;
}

// Spawns `claude auth login`, streams the URL + code prompt to `sender`,
// resolves with { ok, exitCode, output }. Never throws.
function runClaudeCliLogin(claudePath, sender) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudePath, ['auth', 'login'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed', message: 'Failed to spawn `claude auth login`: ' + e.message });
    }
    activeClaudeLoginChild = child;
    claudeLoginCancelled = false;

    const emit = (channel, payload) => {
      try { if (sender && !sender.isDestroyed()) sender.send(channel, payload); } catch {}
    };

    let out = '';
    let sentUrl = null;
    let askedForCode = false;
    let rejections = 0;

    const onChunk = (buf) => {
      out += buf.toString();
      const clean = stripTerminalEscapes(out);
      const url = extractClaudeAuthUrl(out);
      if (url && url !== sentUrl) {
        sentUrl = url;
        emit('claudeCode:login:url', { url });
      }
      if (!askedForCode && /Paste code/i.test(clean)) {
        askedForCode = true;
        emit('claudeCode:login:needCode', { url: sentUrl });
      }
      // A wrong code does not exit — the CLI prints "Invalid code" and
      // prompts again. Re-open the prompt with the reason instead of leaving
      // the user waiting on a child that is silently still running.
      const seen = (clean.match(/Invalid code/gi) || []).length;
      if (seen > rejections) {
        rejections = seen;
        emit('claudeCode:login:needCode', { url: sentUrl, error: 'That code was rejected. Copy the full code from the browser and try again.' });
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeClaudeLoginChild === child) activeClaudeLoginChild = null;
      emit('claudeCode:login:done', { ok: !!res.ok });
      resolve({ ...res, output: stripTerminalEscapes(out) });
    };

    // 5-minute cap — covers the browser-authorize round trip plus margin.
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ ok: false, error: 'timeout', message: '`claude auth login` timed out after 5 minutes. You can also run `claude auth login` in Terminal, then hit Re-check.' });
    }, 5 * 60 * 1000);

    child.on('exit', (code) => {
      if (claudeLoginCancelled) {
        return finish({ ok: false, error: 'cancelled', message: 'Sign-in cancelled.' });
      }
      finish({ ok: code === 0, exitCode: code });
    });
    child.on('error', (err) => finish({ ok: false, error: 'spawn_failed', message: '`claude auth login` child error: ' + err.message }));
  });
}

// Surface the CLI's own last words instead of a bare exit code.
function claudeLoginFailureMessage(res) {
  if (res.error === 'cancelled') return res.message || 'Sign-in cancelled.';
  const tail = String(res.output || '')
    .split('\n')
    .map((l) => l.trim())
    // Drop the noise lines: the 400-char auth URL and the paste prompt.
    .filter((l) => l && !/https:\/\/claude\.(?:com|ai)/.test(l) && !/^Paste code/i.test(l) && !/^Opening browser/i.test(l))
    .slice(-3)
    .join(' · ');
  const base = res.message || ('`claude auth login` exited with code ' + res.exitCode);
  return tail ? base + ' — ' + tail : base;
}

// The renderer hands back the code the browser showed, into the child's stdin.
ipcMain.handle('claudeCode:submitLoginCode', async (_event, code) => {
  const child = activeClaudeLoginChild;
  if (!child || child.killed) {
    return { ok: false, error: 'no_active_login', message: 'No sign-in is running. Click Sign in again.' };
  }
  const value = String(code || '').trim();
  if (!value) return { ok: false, error: 'empty_code', message: 'Paste the code from the browser first.' };
  try {
    child.stdin.write(value + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'write_failed', message: 'Could not hand the code to the CLI: ' + e.message };
  }
});

ipcMain.handle('claudeCode:cancelLogin', async () => {
  const child = activeClaudeLoginChild;
  claudeLoginCancelled = true;
  try { if (child && !child.killed) child.kill('SIGTERM'); } catch {}
  return { ok: true };
});

// Settings -> "Sign in with Claude Code CLI". Runs the CLI login, then reads
// the freshly-written credential-store entry via the same keychain-import
// path as the manual Import button.
ipcMain.handle('auth:runClaudeLogin', async (event) => {
  const claudePath = findClaudePath();
  if (!claudePath) {
    return {
      ok: false,
      error: 'claude_not_found',
      message: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code — then click this button again.',
    };
  }

  const res = await runClaudeCliLogin(claudePath, event && event.sender);
  if (!res.ok) {
    return { ok: false, error: res.error || 'claude_login_failed', message: claudeLoginFailureMessage(res) };
  }
  // The CLI wrote a fresh entry to the OS credential store. Re-read it via
  // the same path as auth:importFromKeychain so the renderer doesn't need to
  // call two IPCs in sequence.
  const result = await importFromKeychainCore();
  if (result.ok) result.claudeLoginRan = true;
  return result;
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
}

// Both `auth:checkClaudeCode` (Settings → AI) and `claudeCode:checkAuth`
// (the Claude Code panel's pre-launch gate) used to report "signed in" the
// instant a Keychain entry with an `accessToken` field existed — a presence
// check, not a validity check. That false-positives hard on a second Mac
// where iCloud Keychain sync carries the item over from another device:
// the blob "exists" but its access token may be expired AND its refresh
// token may already be rotated-invalid (Anthropic issues a new refresh
// token on every refresh and kills the old one — if the mini refreshed
// after the sync snapshot was taken, the synced copy is dead on arrival).
// Symptom Long hit Jul 28: Settings said "Signed in via Claude Code CLI"
// on a machine he'd never signed into; opening the real Claude Code panel
// still prompted the full login-method chooser because the actual `claude`
// binary does its own (correct) validation and found nothing usable.
// Fix: actually attempt a live refresh when the access token looks stale,
// and only report hasAuth:true if the credential is proven to still work.
async function verifyClaudeCodeKeychainAuth() {
  const { execSync } = require('child_process');
  if (process.platform !== 'darwin') return null; // caller falls back to file-path check
  let out;
  try {
    out = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return { ok: true, hasAuth: false, source: 'keychain_empty' };
  }
  if (!out || !out.startsWith('{')) return { ok: true, hasAuth: false, source: 'keychain_empty' };
  let blob;
  try {
    blob = JSON.parse(out);
  } catch {
    return { ok: true, hasAuth: false, source: 'keychain_corrupt', message: 'Keychain entry is not valid JSON.' };
  }
  const oauth = blob.claudeAiOauth || blob;
  if (!oauth.accessToken) return { ok: true, hasAuth: false, source: 'keychain_empty' };

  const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt) : null;
  const stillFresh = expiresAt && expiresAt.getTime() - Date.now() > 60 * 1000; // >1min left
  if (stillFresh) {
    return { ok: true, hasAuth: true, source: 'keychain', subscriptionType: oauth.subscriptionType || null, expiresAt: oauth.expiresAt || null };
  }
  // Access token is expired, missing an expiry, or expiring within 60s —
  // don't trust presence alone. Try a live refresh against Anthropic;
  // that's the only way to tell "just needs a refresh" apart from
  // "refresh token already dead" (cross-device rotation race).
  if (!oauth.refreshToken) {
    return { ok: true, hasAuth: false, source: 'keychain_expired', message: 'Stored credential has no refresh token and its access token is expired.' };
  }
  try {
    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: OAUTH_CLIENT_ID, refresh_token: oauth.refreshToken }).toString(),
    });
    if (!tokenRes.ok) {
      return { ok: true, hasAuth: false, source: 'keychain_stale', message: `Synced credential no longer works (refresh rejected, HTTP ${tokenRes.status}). Sign in again.` };
    }
    const tokenData = await tokenRes.json();
    const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
    // Write the refreshed token back so this machine's Keychain (and any
    // future sync) carries a live credential instead of the dead snapshot.
    const refreshedBlob = {
      claudeAiOauth: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || oauth.refreshToken,
        expiresAt: newExpiresAt,
        scopes: oauth.scopes,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      },
    };
    try {
      execSync('security delete-generic-password -s "Claude Code-credentials"', { encoding: 'utf8', timeout: 5000 });
    } catch {}
    try {
      execSync('security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w ' + "'" + JSON.stringify(refreshedBlob).replace(/'/g, "'\\''") + "'", { encoding: 'utf8', timeout: 5000, shell: true });
    } catch (e) {
      console.warn('[auth] refreshed token verified but failed to write back to Keychain: ' + e.message);
    }
    return { ok: true, hasAuth: true, source: 'keychain_refreshed', subscriptionType: oauth.subscriptionType || null, expiresAt: newExpiresAt };
  } catch (e) {
    return { ok: true, hasAuth: false, source: 'keychain_refresh_error', message: 'Could not reach Anthropic to verify the synced credential: ' + e.message };
  }
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
  // macOS: read + validate Keychain entry "Claude Code-credentials" (same
  // helper the claudeCode:checkAuth panel gate uses below) — a live
  // refresh check, not just presence. See verifyClaudeCodeKeychainAuth()
  // for why presence alone false-positives on synced-but-dead credentials.
  if (process.platform === 'darwin') {
    const result = await verifyClaudeCodeKeychainAuth();
    if (result) return result;
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
    description: 'Run a shell command in the workspace directory. Returns stdout, stderr, and exit code. Defaults to a 30s timeout; pass timeout_ms for slow commands (builds, test suites, installs, deploys/uploads) so they are not killed mid-flight.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g. "ls -la", "node -v")' },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Default 30000 (30s), maximum 900000 (15 min). Use a larger value for npm install / builds / test suites / publish or deploy commands, which routinely exceed 30s.'
        }
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
  },
  {
    name: 'memory_upsert',
    description: 'Explicitly remember a durable procedure, decision, preference, or fact. Creates the target concept if absent or immediately replaces the named section through Farnsworth\'s indexed memory path. Use when the user says remember or save this. Do not ask for confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Stable kebab-case concept slug, for example "updating-devvit-apps".' },
        title: { type: 'string', description: 'Human-readable concept title.' },
        content: { type: 'string', description: 'The durable memory content to store. Include the complete procedure or fact.' },
        section: { type: 'string', description: 'Optional target section heading.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'global for reusable procedures/user knowledge; project for the open workspace.' }
      },
      required: ['slug', 'title', 'content', 'scope']
    }
  },
  {
    name: 'memory_append',
    description: 'Append a durable observation or additional instruction to memory without replacing the existing concept. Use for new details, exceptions, and history that belong under an existing topic.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Target concept slug.' },
        content: { type: 'string', description: 'New durable content to append.' },
        section: { type: 'string', description: 'Optional target section heading. Defaults to notes.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'global or the open project.' }
      },
      required: ['slug', 'content', 'scope']
    }
  },
  {
    name: 'memory_forget',
    description: 'Correct or remove an obsolete memory. First use memory_recall to identify the concept and exact claim. This records an immutable correction and asks consolidation to remove the matching text, optionally replacing it with corrected text.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Concept slug containing the obsolete claim.' },
        match: { type: 'string', description: 'Exact obsolete text or claim to remove.' },
        replacement: { type: 'string', description: 'Optional corrected text that replaces the obsolete claim.' },
        reason: { type: 'string', description: 'Short reason for the correction.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'global or the open project.' }
      },
      required: ['slug', 'match', 'scope']
    }
  },
  {
    name: 'take_canvas_screenshot',
    description: 'Take a screenshot of the active canvas preview and return the image so you can see what the app currently looks like. Returns the image directly — use this to verify UI state, discover selectors for test automation, inspect layout, or confirm the result of a code change. Must have an active preview (set_preview or set_canvas_view first if needed).',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Optional PNG filename saved to /tmp/ (e.g. "lobby.png"). Defaults to canvas-<timestamp>.png.' }
      }
    }
  },
  {
    name: 'set_canvas_view',
    description: 'Switch the canvas preview\'s top-level view. "live" shows the running app/game (Live Preview), "storybook" shows the component storybook, "code" shows the Monaco code editor, and "prod" shows the real headed Reddit browser. Use when the user asks to switch canvas views.',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['live', 'storybook', 'code', 'prod'], description: 'Which top-level canvas view to show.' }
      },
      required: ['view']
    }
  },
  {
    name: 'set_preview',
    description: 'Within Live Preview, switch which surface shape is shown: "post" (Reddit post view), "mobile" (app mobile), "desktop" (app desktop), "fullscreen", or "testview" (test runner). Auto-switches the canvas into live view if it is not already. Use when the user asks to see the mobile view, desktop view, post view, etc.',
    input_schema: {
      type: 'object',
      properties: {
        preview: { type: 'string', enum: ['post', 'mobile', 'desktop', 'fullscreen', 'testview'], description: 'Which live-preview surface to show.' }
      },
      required: ['preview']
    }
  },
  {
    name: 'switch_devvit_user',
    description: 'Switch the active Devvit emulator user for the open project (the user the running game/app sees as the current Reddit user). Restarts the dev server so the change takes effect. Requires an open workspace folder with a Devvit project. Use when the user asks to switch to a different emulator user (e.g. "switch to u/bob").',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'The Devvit emulator username to switch to. Case-insensitive; the leading "u/" is optional.' }
      },
      required: ['username']
    }
  },
  // ─── Prod tools (Aug 13) ───────────────────────────────────────────────
  // These drive the REAL signed-in Reddit session in a headed Chrome, not
  // the local emulator. Actions here are visible to Reddit and permanent.
  {
    name: 'prod_open_url',
    description: 'Open a real Reddit URL in Prod view — a headed Chrome signed in as the real Reddit account. Starts the Prod session if it is not already running and switches the canvas to Prod so the user can watch. Use for "open r/foo in prod", "go to this reddit post in the real browser". This is the REAL Reddit, not the local emulator: actions are visible to Reddit and permanent.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full https:// Reddit URL to open.' },
        profileId: { type: 'string', description: 'Optional identity profile id from prod_status. Omit to use the default signed-in profile.' }
      },
      required: ['url']
    }
  },
  {
    name: 'prod_status',
    description: 'Report the Prod session state: running or stopped, current URL, page title, viewport size, the identity profiles available, and whether an app view is open. Call this FIRST when unsure whether Prod is running, and after actions to confirm where the browser actually is.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'prod_open_app_view',
    description: 'On a Reddit custom-post page, click the post\'s splash image to load its interactive Devvit app view (the playable game), then attach to that app frame. Required before prod_run_script or before interacting with a game. Optionally navigates to a post URL first. Returns the resolved app-view URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional post URL to navigate to first. Omit to use the page already open.' }
      }
    }
  },
  {
    name: 'prod_input',
    description: 'Send a click, scroll, keypress, or text into the live Prod browser. Coordinates are NORMALIZED 0..1 (nx=0.5, ny=0.5 is dead center), so take a screenshot with take_canvas_screenshot first and aim by eye. kind="click" needs nx+ny; "type" needs text (click the field first); "key" needs key (e.g. "Enter"); "wheel" needs deltaY plus nx+ny. This drives the REAL signed-in account — do not click things the user did not ask for.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['click', 'type', 'key', 'wheel'], description: 'What kind of input to send.' },
        nx: { type: 'number', description: 'Normalized X, 0..1 (left..right). For click and wheel.' },
        ny: { type: 'number', description: 'Normalized Y, 0..1 (top..bottom). For click and wheel.' },
        text: { type: 'string', description: 'Text to type, for kind="type". Click the target field first.' },
        key: { type: 'string', description: 'Key name for kind="key", e.g. "Enter", "Escape", "a".' },
        deltaY: { type: 'number', description: 'Scroll amount for kind="wheel". Positive scrolls down.' }
      },
      required: ['kind']
    }
  },
  {
    name: 'prod_run_script',
    description: 'Run one of the project\'s .farnsworth/devvit-tests/*.json scripts against the REAL Reddit app view instead of the local emulator. Call prod_open_app_view first. Accepts a bare script name (e.g. "lobby-recover") or an absolute path; use test_list to see what exists. Returns steps passed/total, errors, and captured vars. These scripts take real actions on the real account.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Script name without .json, or an absolute path to the JSON file.' },
        timeout: { type: 'number', description: 'Optional overall timeout in milliseconds. Defaults to 20 minutes.' }
      },
      required: ['name']
    }
  },
  {
    name: 'prod_stop',
    description: 'Stop the Prod browser session and close its headed Chrome window. Use when the user says they are done with prod, or to recover from a stuck session before starting a fresh one.',
    input_schema: { type: 'object', properties: {} }
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

async function executeAgentTool(name, input, folderOverride) {
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

  if (name === 'memory_upsert' || name === 'memory_append' || name === 'memory_forget') {
    const op = name.replace('memory_', '');
    const queued = queueExplicitMemoryDirective(op, input, folderOverride);
    if (!queued?.ok) return queued;
    const applied = applyExplicitMemoryDirectives([{
      id: queued.bufferId,
      source: 'agent.memory.explicit',
      content: JSON.stringify(queued.directive),
      workspace_path: queued.workspacePath,
    }]);
    const result = applied.results[0];
    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error || 'memory_write_failed',
        message: `Memory ${op} was archived but could not be applied: ${result?.error || 'unknown error'}`,
        slug: queued.directive.slug,
        bufferId: queued.bufferId,
        archiveId: queued.archiveId,
      };
    }
    db.memoryConceptEmbed(queued.directive.slug).catch((e) => console.warn('[memory explicit] embed failed:', e.message));
    return {
      ok: true,
      message: `Memory ${op} applied to ${queued.directive.slug}.`,
      slug: queued.directive.slug,
      scope: queued.directive.scope,
      bufferId: queued.bufferId,
      archiveId: queued.archiveId,
      result,
    };
  }

  if (name === 'take_canvas_screenshot') {
    const img = await captureCanvasPNG();
    if (!img) return { ok: false, error: 'no_canvas', message: 'No active canvas view. Switch to a preview mode first (e.g. set_preview("mobile") or set_canvas_view("live")).' };
    const ts = Date.now();
    const raw = (typeof input?.filename === 'string' && input.filename.trim())
      ? input.filename.replace(/[^a-z0-9._-]/gi, '_')
      : `canvas-${ts}.png`;
    const filename = raw.endsWith('.png') ? raw : raw + '.png';
    const outPath = path.join('/tmp', filename);
    const pngBuf = img.toPNG();
    await fs.writeFile(outPath, pngBuf);
    const sz = img.getSize();
    return { ok: true, path: outPath, base64: pngBuf.toString('base64'), width: sz.width, height: sz.height };
  }
  // ─── Prod tools (Aug 13) ───────────────────────────────────────────────
  // Above the folder gate on purpose: driving the real Reddit browser does
  // not require an open project. Only prod_run_script needs a folder, and
  // only to resolve a bare script name — it takes absolute paths without one.
  if (name === 'prod_status') {
    const registry = prodSeedProfiles();
    return {
      ok: true,
      status: prodStatus(),
      appViewOpen: !!prodSession?.gameTargetId,
      appViewUrl: prodSession?.gameUrl || null,
      profiles: registry.profiles.map(prodPublicProfile),
    };
  }
  if (name === 'prod_open_url') {
    const url = String(input?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'bad_input', message: 'url must be a full http(s) URL' };
    }
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    // Show the user what we're driving.
    target.webContents.send('canvas:setMode', { mode: 'prod' });
    // Reuse a live session when we have one; a restart would drop the
    // already-attached app frame and cost a fresh browser launch.
    if (prodSession?.pageSessionId && !input?.profileId) {
      try {
        await prodCdpCall('Page.navigate', { url }, prodSession.pageSessionId, 30000);
        await new Promise((r) => setTimeout(r, 3000));
        prodSession.url = url;
        prodSession.gameTargetId = null; prodSession.gameUrl = null; // new page, old app frame is gone
        prodCanvasActive = true;
        return { ok: true, reused: true, status: prodEmitStatus() };
      } catch (e) {
        return { ok: false, error: 'navigate_failed', message: e.message || String(e) };
      }
    }
    prodCanvasActive = true;
    const started = await startProdSession({ sender: target.webContents }, { profileId: input?.profileId, url });
    if (!started?.ok) { prodCanvasActive = false; return started; }
    return { ok: true, reused: false, ...started };
  }
  if (name === 'prod_open_app_view') {
    const res = await prodAppOpen({ url: input?.url });
    if (!res?.ok && res?.error === 'not_ready') {
      return { ok: false, error: 'not_ready', message: 'Prod session is not running. Call prod_open_url first.' };
    }
    return res;
  }
  if (name === 'prod_input') {
    const kind = String(input?.kind || 'click');
    if (!['click', 'type', 'key', 'wheel'].includes(kind)) {
      return { ok: false, error: 'bad_input', message: 'kind must be one of: click, type, key, wheel' };
    }
    if ((kind === 'click' || kind === 'wheel') && (input?.nx == null || input?.ny == null)) {
      return { ok: false, error: 'bad_input', message: `kind="${kind}" requires normalized nx and ny (0..1)` };
    }
    if (kind === 'type' && !String(input?.text || '')) {
      return { ok: false, error: 'bad_input', message: 'kind="type" requires text' };
    }
    if (kind === 'key' && !String(input?.key || '')) {
      return { ok: false, error: 'bad_input', message: 'kind="key" requires key' };
    }
    const res = await prodInput({
      kind, nx: input?.nx, ny: input?.ny,
      text: input?.text, key: input?.key, code: input?.code,
      deltaX: input?.deltaX, deltaY: input?.deltaY,
    });
    if (!res?.ok && res?.error === 'not_ready') {
      return { ok: false, error: 'not_ready', message: 'Prod session is not running. Call prod_open_url first.' };
    }
    return res;
  }
  if (name === 'prod_stop') {
    prodCanvasActive = false;
    const res = await stopProdSession('agent');
    return { ok: true, stopped: true, result: res ?? null };
  }
  if (name === 'prod_run_script') {
    const raw = String(input?.name || '').trim();
    if (!raw) return { ok: false, error: 'bad_input', message: 'name required' };
    let testPath = raw;
    if (!path.isAbsolute(testPath)) {
      const f = folderOverride || currentFolderSetting();
      if (!f) {
        return { ok: false, error: 'no_folder', message: 'No workspace folder open, so a bare script name cannot be resolved. Open a folder or pass an absolute path.' };
      }
      const file = testPath.endsWith('.json') ? testPath : `${testPath}.json`;
      testPath = path.join(f, '.farnsworth', 'devvit-tests', file);
    }
    try { await fs.access(testPath); }
    catch { return { ok: false, error: 'not_found', message: `No script at ${testPath}. Use test_list to see available scripts.` }; }
    const res = await prodRunScript({ path: testPath, timeout: input?.timeout });
    if (!res?.ok && res?.error === 'not_ready') {
      return { ok: false, error: 'not_ready', message: 'Prod session is not running. Call prod_open_url, then prod_open_app_view, before running a script.' };
    }
    return res;
  }

  const folder = folderOverride || currentFolderSetting();
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
      folder,
      pipeToActiveTerminal: false,
      sandboxProfile: 'farnsworth-chat-run',
      timeoutMs: input.timeout_ms,
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
    // Same auth injection as the test:run IPC — llm-step direct-API fast path.
    const llmAuth = await getValidAccessToken().catch(() => null);
    const runnerEnv = { ...process.env };
    if (llmAuth && llmAuth.token) {
      runnerEnv.FARNSWORTH_AUTH_TOKEN = llmAuth.token;
      runnerEnv.FARNSWORTH_AUTH_KIND = llmAuth.kind || 'api_key';
    }
    const testModel = testingModelApiId();
    if (testModel) runnerEnv.FARNSWORTH_TEST_MODEL = testModel;
    const launch = await spawnTestRunner(input.path, runnerEnv);
    if (launch.error) return { ok: false, error: launch.error, message: launch.message };
    return await new Promise((resolve) => {
      const proc = launch.proc;
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
        resolve({ ok: false, error: err.code || 'spawn_error', message: err.message });
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
  if (name === 'set_canvas_view') {
    const view = input?.view;
    if (!['live', 'storybook', 'code', 'prod'].includes(view)) {
      return { ok: false, error: 'bad_view', message: 'view must be one of: live, storybook, code, prod' };
    }
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    target.webContents.send('canvas:setMode', { mode: view });
    return { ok: true, view };
  }
  if (name === 'set_preview') {
    const preview = input?.preview;
    if (!['post', 'mobile', 'desktop', 'fullscreen', 'testview'].includes(preview)) {
      return { ok: false, error: 'bad_preview', message: 'preview must be one of: post, mobile, desktop, fullscreen, testview' };
    }
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    // Reuse the existing canvas:setPreview channel (also auto-switches to live).
    target.webContents.send('canvas:setPreview', { preview });
    return { ok: true, preview };
  }
  if (name === 'switch_devvit_user') {
    const raw = String(input?.username || '').trim().replace(/^u\//i, '');
    if (!raw) return { ok: false, error: 'no_username', message: 'username is required' };
    let users = [];
    try { users = db.devvitListUsers() || []; }
    catch (e) { return { ok: false, error: 'db_error', message: String(e && e.message || e) }; }
    const match = users.find(u => String(u.username || '').replace(/^u\//i, '').toLowerCase() === raw.toLowerCase());
    if (!match) {
      return { ok: false, error: 'user_not_found', message: `No emulator user "${raw}". Available: ${users.map(u => u.username).join(', ') || '(none)'}`, available: users.map(u => u.username) };
    }
    const target = BrowserWindow.getFocusedWindow() || mainWindow || openWindows[0];
    if (!target || target.isDestroyed()) return { ok: false, error: 'no_window' };
    target.webContents.send('devvit:agentSwitchUser', { userId: match.id, username: match.username });
    return { ok: true, username: match.username, note: 'Switching user and restarting the dev server.' };
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

// ============================================================
// OpenAI provider (Jul 19) -- GPT-5.6 Sol/Terra/Luna + any
// OpenAI-compatible chat model. Routed when the model id looks like
// an OpenAI model so the Anthropic path stays untouched. Uses the
// OpenAI-compatible /v1/chat/completions endpoint, adapts
// Anthropic-shaped messages/tools in and OpenAI responses out, and
// re-emits Anthropic-shaped stream events so the renderer's existing
// consumer + tool loop need zero changes.
// ============================================================
const OPENAI_BASE = 'https://api.openai.com/v1';

function isOpenAIModel(model) {
  return typeof model === 'string' && /^(gpt-|o[0-9]|chatgpt-|openai\/)/i.test(model);
}

// Jul 19: OpenAI reasoning models (o-series, gpt-5.x) REJECT function tools
// in /v1/chat/completions unless reasoning_effort is 'none' (the API points
// to /v1/responses otherwise). Farnsworth's chat is agentic -- it always
// sends tools -- so without this, selecting a GPT-5.6 model + sending a
// message 400s. We set reasoning_effort:'none' only for reasoning models
// when tools are present; gpt-4o and non-OpenAI custom models are untouched.
function isReasoningModel(model) {
  return typeof model === 'string' && /(^|\/)(o[0-9]|gpt-5)/i.test(model);
}

function getOpenAIKey() {
  const t = db.getAuthToken('openai-api');
  if (t && t.accessToken) return t.accessToken;
  // Fallback: an API-key codex login stores { OPENAI_API_KEY } in auth.json.
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    if (fsSync.existsSync(p)) {
      const raw = JSON.parse(fsSync.readFileSync(p, 'utf8'));
      if (raw && raw.OPENAI_API_KEY) return raw.OPENAI_API_KEY;
    }
  } catch {}
  return null;
}

// Jul 19: custom-inference connection registry. The renderer registers
// OpenAI-compatible endpoints (name + baseURL + keyRef) in settings and
// passes the resolved connection as opts.endpoint on each inference call.
// The base URL + key come from the connection; everything else (message /
// tool / response translation) is already provider-agnostic below.
// endpoint shape: { name, baseURL, keyRef }.
function endpointBase(ep) {
  if (ep && typeof ep.baseURL === 'string' && ep.baseURL.trim()) {
    return ep.baseURL.trim().replace(/\/+$/, '');
  }
  return OPENAI_BASE;
}
function resolveEndpointKey(ep) {
  // A custom endpoint stores its key in its own encrypted slot (keyRef).
  if (ep && ep.keyRef) {
    const t = db.getAuthToken(ep.keyRef);
    if (t && t.accessToken) return t.accessToken;
    return null;
  }
  // No endpoint (built-in GPT models) -> the shared OpenAI key.
  return getOpenAIKey();
}

// Aug 7 2026: returns null (not {}) when the accumulated argument JSON doesn't
// parse, so the caller can report a truncated tool call instead of dispatching
// one with no arguments. An absent/empty string is still a legitimate no-arg
// call and stays {}. See the matching note at content_block_stop.
function oaSafeJson(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch (e) {
    console.warn(`[inference] OpenAI tool arguments failed to parse after ${s.length} chars: ${e.message}`);
    return null;
  }
}

function mapOpenAIUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}

function mapOpenAIFinish(fr) {
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'stop') return 'end_turn';
  return fr || 'end_turn';
}

// Anthropic-shaped messages / content blocks -> OpenAI chat messages.
function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const role = m.role;
    const content = m.content;
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content)) { out.push({ role, content: '' }); continue; }
    if (role === 'user') {
      const parts = [];
      const toolMsgs = [];
      for (const b of content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
        else if (b.type === 'image' && b.source) {
          const mt = b.source.media_type || 'image/png';
          const url = b.source.type === 'url' ? b.source.url : `data:${mt};base64,${b.source.data || ''}`;
          parts.push({ type: 'image_url', image_url: { url } });
        } else if (b.type === 'tool_result') {
          const c = b.content;
          const txt = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n')
            : JSON.stringify(c);
          toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: txt || '' });
        }
      }
      // OpenAI needs tool responses as their own messages, before user text.
      for (const tm of toolMsgs) out.push(tm);
      if (parts.length) out.push({ role: 'user', content: parts });
    } else if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of content) {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') toolCalls.push({
          id: b.id, type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        });
        // thinking blocks are dropped for OpenAI
      }
      const msg = { role: 'assistant' };
      if (text) msg.content = text;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (!text && !toolCalls.length) msg.content = '';
      out.push(msg);
    } else {
      out.push({ role, content: '' });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// Blocking send against OpenAI. Returns the same shape as the Anthropic path.
async function openAISend(opts) {
  const model = opts.model;
  const ep = opts.endpoint || null;
  const base = endpointBase(ep);
  const key = resolveEndpointKey(ep);
  if (!key) return { ok: false, error: 'no_auth', message: ep ? `No API key for endpoint "${ep.name || base}" -- add one in Settings > AI > Custom inference.` : 'No OpenAI API key -- paste one in Settings > AI > OpenAI.' };
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const system = typeof opts.system === 'string' ? opts.system : null;
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 16384;
  const body = { model, messages: toOpenAIMessages(messages, system), max_completion_tokens: maxTokens };
  const tools = toOpenAITools(opts.tools);
  if (tools) { body.tools = tools; if (isReasoningModel(model)) body.reasoning_effort = 'none'; }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      let parsed = null; try { parsed = JSON.parse(errBody); } catch {}
      return { ok: false, status: res.status, error: parsed?.error?.type || 'api_error', message: parsed?.error?.message || errBody.slice(0, 500) };
    }
    const data = await res.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    const toolUses = [];
    for (const tc of (msg.tool_calls || [])) {
      const input = oaSafeJson(tc.function?.arguments);
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      toolUses.push({ id: tc.id, name: tc.function?.name, input });
    }
    return { ok: true, text, content: blocks, toolUses, model: data.model, usage: mapOpenAIUsage(data.usage), stopReason: mapOpenAIFinish(choice.finish_reason) };
  } catch (e) {
    return { ok: false, error: 'network', message: e.message };
  }
}

// Streaming send against OpenAI. Emits Anthropic-shaped events via send().
// `abortSignal` (Jul 27) lets the renderer's Stop button kill an in-flight
// turn on the OpenAI / custom-endpoint path too, not just Anthropic.
async function openAIStream(opts, send, abortSignal) {
  const model = opts.model;
  const ep = opts.endpoint || null;
  const base = endpointBase(ep);
  const key = resolveEndpointKey(ep);
  if (!key) { send({ type: 'error', error: 'no_auth', message: ep ? `No API key for endpoint "${ep.name || base}" -- add one in Settings > AI > Custom inference.` : 'No OpenAI API key -- paste one in Settings > AI > OpenAI.' }); return { ok: false }; }
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const system = typeof opts.system === 'string' ? opts.system : null;
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 16384;
  const body = { model, messages: toOpenAIMessages(messages, system), max_completion_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
  const tools = toOpenAITools(opts.tools);
  if (tools) { body.tools = tools; if (isReasoningModel(model)) body.reasoning_effort = 'none'; }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      let parsed = null; try { parsed = JSON.parse(errBody); } catch {}
      send({ type: 'error', error: parsed?.error?.type || 'api_error', message: parsed?.error?.message || errBody.slice(0, 500), status: res.status });
      return { ok: false };
    }
    send({ type: 'message_start', message: { role: 'assistant', model } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let textStarted = false;
    let textIndex = -1;
    let nextIndex = 0;
    const toolBlocks = {}; // openai tool_call index -> { anthIndex, id, name, argsJson, started }
    let stopReason = null;
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.usage) usage = mapOpenAIUsage(parsed.usage);
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length) {
          if (!textStarted) { textStarted = true; textIndex = nextIndex++; send({ type: 'block_start', index: textIndex, block: { type: 'text', text: '' } }); }
          fullText += delta.content;
          send({ type: 'text_delta', index: textIndex, text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const oaIdx = tc.index ?? 0;
            let tb = toolBlocks[oaIdx];
            if (!tb) tb = toolBlocks[oaIdx] = { anthIndex: nextIndex++, id: tc.id || ('call_' + oaIdx), name: tc.function?.name || '', argsJson: '', started: false };
            if (tc.id) tb.id = tc.id;
            if (tc.function?.name) tb.name = tc.function.name;
            if (!tb.started && tb.name) { tb.started = true; send({ type: 'block_start', index: tb.anthIndex, block: { type: 'tool_use', id: tb.id, name: tb.name, inputJson: '' } }); }
            if (tc.function?.arguments) { tb.argsJson += tc.function.arguments; send({ type: 'tool_use_delta', index: tb.anthIndex, partialJson: tc.function.arguments }); }
          }
        }
        if (choice.finish_reason) stopReason = mapOpenAIFinish(choice.finish_reason);
      }
    }
    if (textStarted) send({ type: 'block_stop', index: textIndex });
    const toolArr = Object.values(toolBlocks).sort((a, b) => a.anthIndex - b.anthIndex);
    for (const tb of toolArr) if (tb.started) send({ type: 'block_stop', index: tb.anthIndex });
    send({ type: 'message_delta', stopReason, usage });
    const blockArr = [];
    if (fullText) blockArr.push({ type: 'text', text: fullText });
    const toolUses = [];
    for (const tb of toolArr) {
      const input = oaSafeJson(tb.argsJson);
      const inputInvalid = input === null ? {
        reason: 'arguments did not parse as JSON',
        rawLength: (tb.argsJson || '').length,
        rawTail: (tb.argsJson || '').slice(-160),
      } : null;
      blockArr.push({ type: 'tool_use', id: tb.id, name: tb.name, input, inputInvalid });
      toolUses.push({ id: tb.id, name: tb.name, input, inputInvalid });
    }
    send({ type: 'done', result: { ok: true, text: fullText, content: blockArr, toolUses, stopReason, usage } });
    return { ok: true };
  } catch (e) {
    // Stop-button abort — a normal outcome, same as the Anthropic path.
    if (e?.name === 'AbortError') {
      send({ type: 'cancelled' });
      return { ok: false, cancelled: true };
    }
    send({ type: 'error', error: 'network', message: e.message });
    return { ok: false };
  }
}

ipcMain.handle('inference:send', async (_event, opts = {}) => {
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (messages.length === 0) {
    return { ok: false, error: 'No messages to send' };
  }
  const model = opts.model || 'claude-opus-4-8';
  // Jul 19: route OpenAI-compatible models (GPT-5.6 Sol/Terra/Luna, etc.)
  // to the OpenAI adapter; the Anthropic path below stays unchanged.
  if (isOpenAIModel(model) || opts.endpoint) return await openAISend({ ...opts, model });
  // Aug 7 2026: was 4096 while both OpenAI paths defaulted to 16384. The chat
  // agent writes whole source files through write_file, and a single tool call
  // carrying a real file blows past 4096 output tokens -- the model then stops
  // mid-JSON at max_tokens and the arguments never parse. Match the OpenAI
  // ceiling so the budget isn't the thing breaking tool calls.
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 16384;
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

ipcMain.handle('inference:toolExecute', async (event, name, input) => {
  try {
    return await executeAgentTool(name, input || {}, folderForEvent(event));
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
  const c = explicit || currentFolderSetting();
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
// Jul 27: in-flight stream registry so the renderer's Stop button can kill a
// turn mid-flight. requestId -> AbortController. Aborting rejects the pending
// fetch / reader.read() with AbortError, which the handlers below report as
// type:'cancelled' (a normal outcome) rather than type:'error'.
const activeInferenceStreams = new Map();

// Cancel one in-flight stream, or every one when requestId is omitted.
// Idempotent: cancelling an already-finished request is a no-op.
ipcMain.handle('inference:cancel', async (_event, requestId) => {
  const ids = requestId ? [requestId] : Array.from(activeInferenceStreams.keys());
  let aborted = 0;
  for (const id of ids) {
    const ctrl = activeInferenceStreams.get(id);
    if (!ctrl) continue;
    try { ctrl.abort(); aborted++; } catch {}
    activeInferenceStreams.delete(id);
  }
  return { ok: true, aborted };
});

ipcMain.on('inference:stream', async (event, opts = {}) => {
  const requestId = opts.requestId || ('stream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('inference:chunk', { requestId, ...payload });
  };
  const abortCtrl = new AbortController();
  activeInferenceStreams.set(requestId, abortCtrl);
  const clearStream = () => { activeInferenceStreams.delete(requestId); };

  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (messages.length === 0) {
    clearStream();
    send({ type: 'error', error: 'No messages to send' });
    return { ok: false };
  }
  const model = opts.model || 'claude-opus-4-8';
  // Jul 19: route OpenAI-compatible models to the streaming OpenAI adapter.
  if (isOpenAIModel(model) || opts.endpoint) {
    try { await openAIStream({ ...opts, model }, send, abortCtrl.signal); }
    finally { clearStream(); }
    return;
  }
  // Aug 7 2026: see the matching note on inference:send -- 4096 was too small
  // for a write_file carrying a real source file, and truncation surfaced as a
  // bogus "path required" instead of a token-limit error.
  const maxTokens = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 16384;
  const system = typeof opts.system === 'string' ? opts.system : null;

  const auth = await getValidAccessToken();
  if (!auth) {
    clearStream();
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
      signal: abortCtrl.signal,
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
            try {
              blocks[idx].input = JSON.parse(blocks[idx].inputJson);
            } catch (err) {
              // Aug 7 2026: this used to fall back to `{}`, which was the whole
              // bug. A tool_use whose arguments don't parse is nearly always the
              // model hitting max_tokens mid-JSON -- the stream just stops in the
              // middle of a half-written argument object. Substituting {} meant
              // the tool got DISPATCHED with no arguments at all, so write_file
              // answered "path required" and run_command answered "command
              // required". The agent had no way to see it had been truncated, so
              // it blamed payload size and retried the same call forever.
              // Flag it instead and let the renderer report the real cause.
              blocks[idx].input = null;
              blocks[idx].inputInvalid = {
                reason: err.message,
                rawLength: blocks[idx].inputJson.length,
                rawTail: blocks[idx].inputJson.slice(-160),
              };
              console.warn(`[inference] tool_use "${blocks[idx].name}" arguments failed to parse after ${blocks[idx].inputJson.length} chars: ${err.message}`);
            }
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
    // Aug 7 2026: a hard truncation can end the stream without ever delivering
    // content_block_stop for the open tool_use, so the parse above never runs.
    // Treat "accumulated JSON but no parsed input" as invalid for the same
    // reason -- never hand a half-specified tool call to the executor.
    for (const b of blockArr) {
      if (b.type === 'tool_use' && !b.inputInvalid && b.input == null && b.inputJson) {
        b.inputInvalid = {
          reason: 'stream ended before the arguments were complete',
          rawLength: b.inputJson.length,
          rawTail: b.inputJson.slice(-160),
        };
        console.warn(`[inference] tool_use "${b.name}" never completed its arguments (${b.inputJson.length} chars, stop=${stopReason})`);
      }
    }
    const toolUses = blockArr.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id,
      name: b.name,
      input: b.inputInvalid ? null : (b.input || {}),
      inputInvalid: b.inputInvalid || null,
    }));
    const result = { ok: true, text, content: blockArr, toolUses, stopReason, usage };
    send({ type: 'done', result });
    return { ok: true, requestId };
  } catch (e) {
    // A Stop-button abort lands here as AbortError. That's a normal outcome,
    // not a failure -- report it as 'cancelled' so the renderer can mark the
    // message stopped instead of painting a red error bubble.
    if (e?.name === 'AbortError') {
      send({ type: 'cancelled' });
      return { ok: false, cancelled: true };
    }
    send({ type: 'error', error: 'network', message: e.message });
    return { ok: false };
  } finally {
    clearStream();
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

// Single-instance lock. Farnsworth binds three fixed WebSocket ports (9223
// terminal / 9224 Claude Code / 9225 Codex) and one SQLite DB in userData, so
// a second instance collides on all of them. Before this lock, launching
// Farnsworth twice produced an EADDRINUSE uncaught-exception dialog and a
// half-initialized app. Focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // app.quit() above is not guaranteed to prevent this callback from firing,
  // so bail explicitly rather than binding ports / opening the DB twice.
  if (!gotSingleInstanceLock) return;
  // Make "Farnsworth → About Farnsworth" show FARNSWORTH's version. Without
  // this, role:'about' falls back to the running bundle's Info.plist -- and
  // on the dev tree that bundle is node_modules/electron/dist/Farnsworth.app,
  // whose CFBundleShortVersionString is Electron's own version (31.7.7). So
  // About reported the Electron version, not the app version. app.getVersion()
  // reads package.json and is correct on both the dev tree and packaged builds.
  app.setAboutPanelOptions({
    applicationName: 'Farnsworth',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron} · ${process.platform}-${process.arch}`,
  });
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
  createCanvasCaptureWindow();
  installCanvasDisplayMediaHandler();
  startTerminalServer();
  startClaudeCodeServer();
  startCodexServer();

  // Health daemon (Aug 3 2026) — self-healing watchdog for three recurring
  // failure classes: blank renderer windows (arch-mismatch native modules
  // after a release build), orphaned/unresponsive dev servers (leases from
  // the port authority above), and stale config watchers. See
  // farnsworth-health-daemon. isDevTree reuses updatesSupported()'s honest
  // signal (process.defaultApp / app.isPackaged lies on this renamed dev
  // tree, see farnsworth-dev-tree-electron-binary) — the renderer watchdog
  // is a release-build-only concern; a dev-tree black window is the user's
  // own npm workflow to fix.
  try {
    const healthDaemon = require('./src/health-daemon');
    const hd = healthDaemon.create(mainWindow, {
      db: db.getRawDb(),
      instanceId: INSTANCE_NAME,
      isDevTree: !updatesSupported(),
    });
    hd.start();
    ipcMain.handle('health:status', () => hd.getStatus());
  } catch (e) {
    console.warn('[health] daemon failed to start:', e.message);
  }

  // ====================================================================
  // Auto-updater (packaged builds only; dev mode skips it).
  //
  // The boot check alone is not enough: Farnsworth is an app you leave open
  // for days, and a one-shot check at launch means a long-running session
  // never learns about a release that shipped an hour later. Re-check on a
  // timer, and skip the check once something is already downloading or
  // waiting to install so we do not restart a 350 MB download.
  // ====================================================================
  if (updatesSupported()) {
    const runUpdateCheck = (reason) => {
      if (updaterState.status === 'downloading' || updaterState.status === 'ready') return;
      console.log('[autoUpdater] check (' + reason + ')');
      autoUpdater.checkForUpdates().catch((err) => {
        // The 'error' event already classified and broadcast this. Logging the
        // rejection too would double-report it.
        console.log('[autoUpdater] check rejected:', err?.message || err);
      });
    };
    runUpdateCheck('boot');
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const updateTimer = setInterval(() => runUpdateCheck('periodic'), SIX_HOURS);
    // Do not hold the event loop open on quit.
    if (updateTimer.unref) updateTimer.unref();
    app.on('before-quit', () => clearInterval(updateTimer));
  }

  // Start the relay client (outbound WS to farnsworth-relay). No-op if
  // RELAY_DISABLED=1 or the relay isn't reachable — Farnsworth keeps
  // working locally, the relay just won't be in the picture.
  try {
    const relayClient = getRelayClient();
    relayClient.start();

    // Hydrate the device token from the Keychain when the environment did not
    // supply one.
    //
    // RELAY_DEVICE_TOKEN is injected by the /Applications wrapper script,
    // which is only one of several ways this app starts: a dev-tree launch, a
    // second instance started with --instance=<name>, or anything spawned
    // outside that wrapper all begin life UNPAIRED and quietly fall back to
    // shared-secret tenantId routing -- so they never show up under the
    // account in the companion picker.
    //
    // Settings -> Account reads the Keychain directly, so without this the UI
    // would report "Paired" while the live relay socket was anything but.
    if (!process.env.RELAY_DEVICE_TOKEN) {
      devicePairing.readStoredToken()
        .then(({ token, locked }) => {
          if (locked) {
            console.warn('[relay] Keychain locked; staying unpaired until unlock');
            return;
          }
          if (!token) return;
          relayClient.applyDeviceToken(token);
          console.log('[relay] device token hydrated from Keychain');
        })
        .catch((e) => console.warn('[relay] Keychain token read failed:', e.message));
    }
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
      // Snapshot recent output BEFORE hooking the live listener. JS is
      // single-threaded and there are no awaits here, so no PTY 'data'
      // event can fire between this snapshot and the hook below — the
      // replay is zero-loss and stays ordered ahead of live bytes.
      const replay = (typeof entry.getBuffer === 'function') ? entry.getBuffer() : '';
      entry.term.on('data', onData);
      companionClaudeAttachments.set(companionId, { term: entry.term, onData, tabId: entry.tabId });
      // Send the desktop's CURRENT cols/rows so the companion adopts the
      // desktop's winsize (and scales its font to fit) instead of resizing
      // the shared PTY down. The desktop is the sole size owner.
      relayClient.send({ type: 'claudeCode:attached', companionId, tabId: entry.tabId, ok: true, sessionId: entry.sessionId, cwd: entry.cwd, cols: entry.cols || 80, rows: entry.rows || 24 });
      // Replay the buffered screen AFTER the attached ack so the companion
      // has already sized its xterm to the desktop grid. This reconstructs
      // the current screen; subsequent incremental TUI updates then paint
      // correctly instead of into a blank buffer (Jul 21 fix for the blank
      // companion Claude Code tab on an already-running session).
      if (replay) relayClient.send({ type: 'claudeCode:output', companionId, tabId: entry.tabId, data: replay });
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
    const companionCanvasStreams = new Map(); // companionId -> { transport, timer?, inFlight? }
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
      if (!s) return;
      if (s.timer) { try { clearInterval(s.timer); } catch {} }
      if (s.transport === 'webrtc' && canvasCaptureWindow && !canvasCaptureWindow.isDestroyed()) {
        canvasCaptureWindow.webContents.send('canvas-capture:stop', { companionId });
      }
      companionCanvasStreams.delete(companionId);
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
      const companionId = msg?.companionId || msg?._from || msg?.from || 'companion';
      const fps = Math.min(Math.max(Number(msg?.fps) || 6, 1), 15);
      const quality = Math.min(Math.max(Number(msg?.quality) || 50, 20), 90);
      const maxWidth = Math.min(Math.max(Number(msg?.maxWidth) || 720, 240), 1280);
      const forceJpeg = msg?.forceJpeg === true;
      stopCanvasStream(companionId); // clean re-subscribe

      // WCV previews get a direct browser-surface MediaStreamTrack. The
      // companion can explicitly request JPEG after a negotiation timeout;
      // Post View always takes this fallback because it needs a DOM crop.
      const view = activeCanvasWebContentsView();
      if (view && !forceJpeg && canvasCaptureWindow && !canvasCaptureWindow.isDestroyed()) {
        companionCanvasStreams.set(companionId, { transport: 'webrtc' });
        relayClient.send({
          type: 'canvas:screencast:started', companionId,
          ok: true, transport: 'webrtc', ts: Date.now(),
        });
        try {
          await startCanvasCapturePeer(companionId);
        } catch (e) {
          relayClient.send({ type: 'canvas:webrtc:error', companionId, reason: e?.message || String(e), ts: Date.now() });
        }
        return;
      }

      const hasTarget = !!view || !!(await getIframeRect());
      relayClient.send({
        type: 'canvas:screencast:started', companionId,
        ok: hasTarget, transport: 'jpeg',
        reason: hasTarget ? undefined : 'no-active-view', ts: Date.now(),
      });
      if (!hasTarget) return;
      const stream = { transport: 'jpeg', timer: null, inFlight: false };
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
      stopCanvasStream(msg?.companionId || msg?._from || msg?.from || 'companion');
    });
    for (const type of ['canvas:webrtc:answer', 'canvas:webrtc:ice', 'canvas:webrtc:close']) {
      relayClient.on(type, (msg) => {
        if (canvasCaptureWindow && !canvasCaptureWindow.isDestroyed()) {
          canvasCaptureWindow.webContents.send('canvas-capture:signal', msg);
        }
      });
    }
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
let terminalWsReady = null;

function startTerminalServer() {
  if (!pty) {
    console.error('[terminal] node-pty unavailable; terminal panel disabled');
    return;
  }
  if (terminalWss) return;
  terminalWss = new WebSocket.Server({ port: preferredWsPort(TERMINAL_WS_PORT) });
  terminalWsReady = wsBoundPort(terminalWss);
  // Without an 'error' listener, an EADDRINUSE on this port becomes an
  // unhandled 'error' event -> uncaught exception -> the "A JavaScript error
  // occurred in the main process" dialog, and it ABORTS the rest of
  // app.whenReady() (Claude Code server, Codex server, auto-updater all
  // silently never start). Degrade to "terminal panel disabled" instead.
  terminalWss.on('error', (err) => {
    const code = err && err.code;
    console.error(
      `[terminal] WebSocket server error on :${TERMINAL_WS_PORT}` +
        (code === 'EADDRINUSE' ? ' — port in use (another Farnsworth running?); terminal panel disabled' : ''),
      err?.message || err
    );
    try { terminalWss?.close(); } catch {}
    terminalWss = null;
  });
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
        || currentFolderSetting()
        || os.homedir();
      // Prepend homebrew to PATH so `npm`, `node`, `claude`, etc. resolve.
      // Electron's process.env.PATH from a `open`-launched bundle does NOT
      // include /opt/homebrew/bin (LaunchServices doesn't load shell rc
      // files), which is why `npm run dev` was giving "command not found".
      // Login-shell PATH first so version-manager node/npm resolve here too
      // (was Homebrew-only, which broke on Macs using nvm/fnm/volta/asdf).
      const pathWithBrew = composeChildPath();
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
  wsBoundPort(terminalWss).then((p) => console.log(`[terminal] WebSocket server listening on ws://localhost:${p ?? '(bind failed)'}`));
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
let claudeCodeWsReady = null;
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
  markWorkspaceTrusted(currentFolderSetting() || os.homedir());
  if (claudeCodeWss) return;

  // Locate the `claude` binary. Electron's main process inherits a minimal
  // Locate the `claude` binary (bundled Resources/bin/claude first, Jul 7 ~21:02 ET).
  const claudePath = findClaudePath();
  if (!claudePath) {
    console.error('[claude-code] claude binary not found on PATH or candidate paths; Claude Code panel will fail to spawn');
  } else {
    console.log(`[claude-code] using claude at: ${claudePath}`);
  }

  claudeCodeWss = new WebSocket.Server({ port: preferredWsPort(CLAUDE_CODE_WS_PORT) });
  claudeCodeWsReady = wsBoundPort(claudeCodeWss);
  // See startTerminalServer() — an unhandled 'error' here crashes the whole
  // main process and aborts the remainder of app.whenReady().
  claudeCodeWss.on('error', (err) => {
    const code = err && err.code;
    console.error(
      `[claude-code] WebSocket server error on :${CLAUDE_CODE_WS_PORT}` +
        (code === 'EADDRINUSE' ? ' — port in use (another Farnsworth running?); Claude Code panel disabled' : ''),
      err?.message || err
    );
    try { claudeCodeWss?.close(); } catch {}
    claudeCodeWss = null;
  });
  claudeCodeWss.on('connection', (ws) => {
    // [DEBUG Jul 6 ~00:05 ET] trace cwd at connection
    const initialCwd = currentFolderSetting() || os.homedir();
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
    let cwd = currentFolderSetting() || os.homedir();
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
        // Same Seatbelt grants the chat-agent path gets. This site never got the
        // v0.1.9 toolchain fix, so Claude Code on a machine with a version-manager
        // node saw no toolchain at all, and git inside the panel exited 128 on any
        // machine with a ~/.gitconfig. See sandboxGrantArgs().
        spawnArgs = ['wrap', '--profile', resolveNonoProfile('farnsworth-claude'), '--allow-cwd',
          ...sandboxGrantArgs(), '--', claudeBin, ...args];
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
        const newPath = composeChildPath([bundledBin]);
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
      // Ring buffer of recent PTY output for the companion bridge. When a
      // companion subscribes to an already-running session we replay this
      // so its xterm reconstructs the CURRENT screen instead of showing
      // blank until the next keystroke — the alt-screen TUI only emits
      // incremental cursor-addressed updates, which need a base to paint
      // onto (Jul 21 fix for the blank companion Claude Code tab).
      let outBuf = '';
      const OUT_BUF_CAP = 256 * 1024;
      let promptSeen = false;
      term.onData((data) => {
        send({ type: 'data', data });
        outBuf += data;
        if (outBuf.length > OUT_BUF_CAP) outBuf = outBuf.slice(outBuf.length - OUT_BUF_CAP);
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
      claudeCodePtys.set(tabId, { tabId, term, send, sessionId: useSessionId, cwd, cols: 80, rows: 24, getBuffer: () => outBuf });
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
  wsBoundPort(claudeCodeWss).then((p) => console.log(`[claude-code] WebSocket server listening on ws://localhost:${p ?? '(bind failed)'}`));
}

ipcMain.handle('claudeCode:getWsUrl', async () => {
  const port = await wsBoundPort(claudeCodeWss);
  return port ? `ws://localhost:${port}` : null;
});
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
  // Validated (live refresh if stale), not just presence — see
  // verifyClaudeCodeKeychainAuth() above auth:checkClaudeCode.
  try {
    const result = await verifyClaudeCodeKeychainAuth();
    return result || { ok: true, hasAuth: false, source: 'keychain_empty', message: 'No OAuth token in Keychain' };
  } catch (e) {
    return { ok: false, hasAuth: false, source: 'keychain_error', message: 'Keychain lookup failed: ' + e.message };
  }
});

ipcMain.handle('claudeCode:runLogin', async (event) => {
  // Same shared runner as Settings' auth:runClaudeLogin, then verify through
  // the exact check the sign-in gate uses — so "signed in" here can never
  // disagree with claudeCode:checkAuth.
  const claudePath = findClaudePath();
  if (!claudePath) {
    return { ok: false, error: 'claude_not_found', message: 'Claude Code CLI not found. Install with: npm i -g @anthropic-ai/claude-code' };
  }

  const res = await runClaudeCliLogin(claudePath, event && event.sender);
  if (!res.ok) {
    return { ok: false, error: res.error || 'claude_login_failed', message: claudeLoginFailureMessage(res) };
  }

  try {
    const check = await verifyClaudeCodeKeychainAuth();
    if (check && check.hasAuth) {
      return { ok: true, hasAuth: true, claudeLoginRan: true, source: check.source };
    }
  } catch {}
  return {
    ok: false,
    error: 'no_keychain_after_login',
    message: '`claude auth login` finished but no credentials landed in the OS credential store. Try Re-check, or run `claude auth login` in Terminal.',
  };
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
let codexWsReady = null;

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
  markCodexTrusted(currentFolderSetting() || os.homedir());
  if (codexWss) return;

  const codexPathAtBoot = findCodexPath();
  if (!codexPathAtBoot) {
    console.error('[codex] codex binary not found on PATH or candidate paths; Codex panel will show the install/sign-in card');
  } else {
    console.log(`[codex] using codex at: ${codexPathAtBoot}`);
  }

  codexWss = new WebSocket.Server({ port: preferredWsPort(CODEX_WS_PORT) });
  codexWsReady = wsBoundPort(codexWss);
  // See startTerminalServer() — an unhandled 'error' here crashes the whole
  // main process and aborts the remainder of app.whenReady().
  codexWss.on('error', (err) => {
    const code = err && err.code;
    console.error(
      `[codex] WebSocket server error on :${CODEX_WS_PORT}` +
        (code === 'EADDRINUSE' ? ' — port in use (another Farnsworth running?); Codex panel disabled' : ''),
      err?.message || err
    );
    try { codexWss?.close(); } catch {}
    codexWss = null;
  });
  codexWss.on('connection', (ws) => {
    // cwd protocol mirrors the Claude Code panel: renderer sends `init`
    // with state.folder before `spawn`, so the PTY lands in the project
    // folder even when the panel mounts before a folder is opened.
    let cwd = currentFolderSetting() || os.homedir();
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
        const newPath = composeChildPath([bundledBin]);
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
  wsBoundPort(codexWss).then((p) => console.log(`[codex] WebSocket server listening on ws://localhost:${p ?? '(bind failed)'}`));
}

ipcMain.handle('codex:getWsUrl', async () => {
  const port = await wsBoundPort(codexWss);
  return port ? `ws://localhost:${port}` : null;
});
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

ipcMain.handle('terminal:getWsUrl', async () => {
  const port = await wsBoundPort(terminalWss);
  return port ? `ws://localhost:${port}` : null;
});

// --- Account / device pairing (Settings → Account) -------------------------
// Pairing used to require dropping to a terminal and running
// `node src/pair-device.js`. These IPCs run the same RFC 8628 flow in-app.
// The long poll lives in main (not the renderer) so it survives the settings
// overlay being closed mid-flow.
let pairingAbort = null;

// The renderer had no way to open a URL in the real browser — links only
// escaped via setWindowOpenHandler. The pairing panel needs an explicit one.
// Restricted to http/https so a compromised renderer can't launch file:// or
// a custom scheme handler.
ipcMain.handle('app:openExternal', (_event, url) => {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'unsupported scheme' };
    }
    openExternalSafe(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: 'invalid url' };
  }
});

function broadcastPairing(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('account:pairing', payload);
  }
}

ipcMain.handle('account:status', async () => {
  try {
    return await devicePairing.pairingStatus();
  } catch (e) {
    return { paired: false, locked: false, error: e.message };
  }
});

ipcMain.handle('account:pairStart', async () => {
  if (pairingAbort) return { ok: false, error: 'Pairing already in progress.' };
  const controller = new AbortController();
  pairingAbort = controller;

  // Kick the flow off without awaiting it — the renderer gets the user code
  // through the 'account:pairing' broadcast and the poll continues in main.
  (async () => {
    try {
      const result = await devicePairing.runDeviceFlow({
        signal: controller.signal,
        onCode: (code) => broadcastPairing({ state: 'awaiting', ...code }),
      });
      if (result.status === 'approved') {
        // Reconnect the relay with the new identity so pairing takes effect
        // without a relaunch.
        let reconnected = false;
        try {
          reconnected = getRelayClient().applyDeviceToken(result.token);
        } catch (e) {
          console.warn('[account] relay reconnect after pairing failed:', e.message);
        }
        broadcastPairing({
          state: 'paired',
          instanceId: result.instanceId,
          reconnected,
        });
      } else {
        broadcastPairing({ state: result.status });
      }
    } catch (e) {
      broadcastPairing({ state: 'error', error: e.message });
    } finally {
      pairingAbort = null;
    }
  })();

  return { ok: true };
});

ipcMain.handle('account:pairCancel', async () => {
  if (pairingAbort) {
    pairingAbort.abort();
    pairingAbort = null;
    broadcastPairing({ state: 'cancelled' });
  }
  return { ok: true };
});

ipcMain.handle('account:unpair', async () => {
  try {
    await devicePairing.deleteStoredToken();
    try {
      getRelayClient().applyDeviceToken(null);
    } catch (e) {
      console.warn('[account] relay reset after unpair failed:', e.message);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Relay IPC: renderer → main → relay
ipcMain.handle('relay:send', async (_event, msg) => {
  const rc = getRelayClient();
  return rc.send(msg);
});
ipcMain.handle('canvas-capture:send', async (event, msg) => {
  if (!canvasCaptureWindow || canvasCaptureWindow.isDestroyed() || event.sender !== canvasCaptureWindow.webContents) {
    return false;
  }
  return getRelayClient().send(msg);
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

// ---- Folder switch: retarget live terminals (Aug 5) -----------------------
// A PTY's cwd is fixed at spawn, so every terminal tab opened before an Open
// Folder kept sitting in the previous project. New tabs were fine (the
// renderer sends the current folder in its WS init), which is exactly why
// this stayed invisible for so long.
//
// An idle shell gets a real `cd` typed into it: non-destructive, keeps the
// shell, its env and its history, and the user can see what happened. A shell
// with a running foreground child (dev server, test watcher, npm install) is
// left strictly alone -- writing to it would inject keystrokes into that
// program -- and reported back so the renderer can say so out loud.
function shQuoteSingle(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// True when the shell has at least one child process, i.e. something is
// running in the foreground. `pgrep -P` is cheap and present on macOS/Linux.
function ptyHasRunningChild(pid) {
  if (!pid) return false;
  try {
    const out = require('child_process').execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch (e) {
    // pgrep exits 1 with no output when there are no children -- that is the
    // common, healthy "idle shell" case, not an error.
    if (e && e.status === 1) return false;
    // Anything else (pgrep missing, timeout): treat as busy. Skipping a
    // retarget is recoverable; typing into a running program is not.
    return true;
  }
}

ipcMain.handle('terminal:retarget', async (event, requestedCwd) => {
  const cwd = requestedCwd || folderForEvent(event);
  if (!cwd) return { ok: false, error: 'no_folder' };
  const moved = [];
  const busy = [];
  for (const [ws, entry] of terminalPtys.entries()) {
    if (!ws || ws.readyState !== 1 /* OPEN */ || !entry || !entry.pty) continue;
    if (ptyHasRunningChild(entry.pty.pid)) { busy.push(entry.tabId); continue; }
    try {
      // \x15 (Ctrl-U) clears any half-typed command first so the cd cannot
      // get appended to it.
      entry.pty.write('\x15cd ' + shQuoteSingle(cwd) + '\n');
      moved.push(entry.tabId);
    } catch (e) {
      busy.push(entry.tabId);
    }
  }
  // Claude Code sessions cannot be moved at all: `claude` is the PTY's own
  // process and its cwd is fixed for its lifetime. Worse, a stale one is an
  // agent pointed at the wrong repo. Report them so the user is told rather
  // than silently letting an agent edit the previous project.
  const staleAgents = [];
  for (const entry of claudeCodePtys.values()) {
    if (entry && entry.cwd && entry.cwd !== cwd) staleAgents.push(entry.tabId);
  }
  return { ok: true, cwd, moved, busy, staleAgents };
});

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

// Command timeout budget. The default stays 30s so ordinary commands still
// fail fast, but a hardcoded 30s made whole classes of real work impossible
// from the chat agent: `npm install`, a full build, a test suite, or
// `npm run launch` (type-check && lint && test && devvit upload && publish)
// all blow past it and got SIGTERM'd mid-flight, which for an upload or a
// publish means killing it partway through a network operation.
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

function resolveCommandTimeout(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_COMMAND_TIMEOUT_MS);
}

async function runShellCommand(command, opts = {}) {
  const folder = opts.folder || currentFolderSetting();
  if (!folder) return { ok: false, error: 'no_folder', message: 'No workspace folder open' };
  if (!command || typeof command !== 'string') return { ok: false, error: 'bad_input', message: 'command required' };
  const pipeToActiveTerminal = opts.pipeToActiveTerminal !== false;
  const sandboxProfile = opts.sandboxProfile || null;
  const timeoutMs = resolveCommandTimeout(opts.timeoutMs);
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
      return await runSandboxedCommand(nonoBin, sandboxProfile, command, folder, timeoutMs);
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
    exec(command, { cwd: folder, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
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
async function runSandboxedCommand(nonoBin, profileName, command, folder, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const { spawn } = require('child_process');
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Farnsworth launched from Finder inherits launchd's bare PATH, so the
    // toolchain is invisible to the sandboxed shell. composeChildPath() adds
    // the user's login-shell PATH (version managers included) and the --read
    // grants make those dirs readable through Seatbelt. BOTH halves are
    // required: see toolchainReadDirs(). sandboxGrantArgs() adds the git config
    // --read-file grants on top (see gitConfigReadFiles) -- without them every
    // git command exits 128 on any machine that has a ~/.gitconfig.
    const readGrants = sandboxGrantArgs();
    const child = spawn(
      nonoBin,
      // --silent suppresses nono's capabilities banner, which it prints to
      // STDERR on every single call (~15 lines). That banner is machine-consumed
      // here: run_command feeds stderr straight to the model, so the banner both
      // burned tokens on every command AND buried the real error underneath it --
      // in Long's Jul 29 report the agent said "the git command failed (no stderr
      // details)" while git had in fact printed a precise fatal. Verified that
      // --silent still surfaces BOTH the command's own stderr and nono's own
      // config/profile errors, so nothing diagnostic is lost.
      ['wrap', '--silent', '--profile', resolveNonoProfile(profileName), '--allow-cwd',
       ...readGrants, '--', '/bin/sh', '-c', command],
      {
        cwd: folder,
        // Farnsworth launched from Finder / `open .app` inherits launchd's bare
        // PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew tools (node, npm,
        // git, python3, uv, ...) are invisible to the sandboxed shell and the
        // chat agent sees `command -v node` return nothing even though Node is
        // installed. Prepend the Homebrew + /usr/local bins. Same class of fix
        // as the terminal PTY PATH fix (Jul 4) — this call site never got it.
        env: { ...process.env, PATH: composeChildPath() },
      }
    );
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout,
        // Name the budget and how to raise it. A bare "timeout" reads like the
        // command failed, and the agent then invents a reason it failed.
        stderr: timedOut
          ? stderr + `\ntimeout: killed after ${Math.round(timeoutMs / 1000)}s.`
            + ` If this command is legitimately slow (build, test suite, install, upload/publish),`
            + ` re-run it with a larger timeout_ms (max ${MAX_COMMAND_TIMEOUT_MS / 1000}s).`
          : stderr,
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

ipcMain.handle('terminal:runCommand', async (event, command) => {
  return await runShellCommand(command, { folder: folderForEvent(event) });
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
function getActiveWorkspacePath(event) {
  return folderForEvent(event);
}

ipcMain.handle('chatConv:list', async (event) => {
  return db.listConversations(getActiveWorkspacePath(event));
});

ipcMain.handle('chatConv:load', async (_event, id) => {
  const row = db.getConversation(id);
  if (!row) return null;
  try { return { ...row, messages: JSON.parse(row.messages) }; }
  catch { return null; }
});

ipcMain.handle('chatConv:create', async (event, { id, title, messages } = {}) => {
  const convId = id || 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  db.createConversation(convId, getActiveWorkspacePath(event), title || 'New chat', messages || []);
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
