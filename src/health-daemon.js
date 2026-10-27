// src/health-daemon.js — Farnsworth self-healing watchdog
//
// Three monitors:
//   1. RendererWatchdog  — detects blank-window (renderer process absent on macOS)
//   2. DevServerProbe    — health-checks dev-port leases from port-authority table
//   3. ConfigWatcherGuard — detects stale config watchers
//
// Runs in main process. Loaded from app.whenReady() in main.js.
//
// API:
//   const daemon = require('./health-daemon');
//   const hd = daemon.create(mainWindow, { db, instanceId, isDevTree });
//   hd.start();
//   hd.stop();
//   hd.getStatus();  // snapshot

const { execFileSync, execSync } = require('child_process');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');

// ─── Constants ────────────────────────────────────────────────────────────

const TICK_MS = 5000;
const RENDERER_TIMEOUT_MS = 30000; // wait up to 30s for first renderer
const DEV_PROBE_DELAY_MS = 30000;  // don't probe leases younger than 30s
const DEV_PROBE_INTERVAL_MS = 15000;
const DEV_PROBE_TIMEOUT_MS = 5000;  // HTTP health check timeout
const WATCHER_GUARD_INTERVAL_MS = 30000;
const WATCHER_HEARTBEAT_STALE_MS = 60000;

// ─── Helpers ──────────────────────────────────────────────────────────────

function countRendererProcesses() {
  try {
    const out = execFileSync('ps', ['aux'], { encoding: 'utf8', timeout: 3000 });
    return (out.match(/Farnsworth.*--type=renderer/g) || []).length;
  } catch {
    return -1; // ps failed — can't determine
  }
}

function electronRebuildPath() {
  // In the packaged app, node_modules is relative to process.resourcesPath
  // In dev tree, relative to app root. check both.
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'node_modules', '.bin', 'electron-rebuild'),
    path.join(process.resourcesPath || '', '..', 'node_modules', '.bin', 'electron-rebuild'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* not here */ }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpHealthCheck(port, timeoutMs = DEV_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const req = http.get(
      `http://localhost:${port}/__farnsworth_health`,
      { signal: controller.signal },
      (res) => {
        clearTimeout(timer);
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    req.on('timeout', () => {
      clearTimeout(timer);
      req.destroy();
      resolve(false);
    });
  });
}

function rendererOverlayHtml() {
  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8">
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #1a1a2e; color: #e0e0e0; padding: 40px; margin: 0;
        display: flex; align-items: center; justify-content: center; min-height: 100vh;
      }
      .card { max-width: 540px; background: #222244; padding: 32px; border-radius: 12px; }
      h1 { font-size: 18px; margin: 0 0 12px; color: #ff6b6b; }
      p { font-size: 14px; line-height: 1.6; margin: 8px 0; color: #b0b0c0; }
      code { background: #2a2a44; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    </style></head><body>
    <div class="card">
      <h1>Renderer failed to start</h1>
      <p>This may indicate a native module architecture mismatch.</p>
      <p>Try rebuilding native modules:</p>
      <p><code>cd node_modules/.bin && ./electron-rebuild --arch arm64</code></p>
      <p>Check Console.app for crash reports from the renderer process.</p>
      <p>If this persists, restart Farnsworth and try again.</p>
    </div></body></html>
  `.trim();
}

// ─── RendererWatchdog ─────────────────────────────────────────────────────

function createRendererWatchdog(mainWindow, { isDevTree } = {}) {
  let intervalId = null;
  let startTime = 0;
  let state = 'idle';
  let lastError = null;
  let lastCheck = null;

  function isActive() {
    return state === 'idle' || state === 'running' || state === 'recovering';
  }

  return {
    start() {
      // Only activate on Darwin packaged builds
      if (process.platform !== 'darwin') {
        console.log('[health] renderer watchdog disabled — not macOS');
        return;
      }
      if (isDevTree) {
        console.log('[health] dev tree — renderer watchdog disabled');
        return;
      }

      state = 'running';
      startTime = Date.now();
      console.log('[health] renderer watchdog active');

      intervalId = setInterval(() => {
        try {
          lastCheck = Date.now();

          // Phase 1: waiting for first renderer
          if (state === 'running') {
            const count = countRendererProcesses();
            if (count === -1) {
              console.warn('[health] ps aux failed — retrying next tick');
              return;
            }
            if (count >= 1) {
              state = 'recovered';
              console.log(`[health] renderer process detected after ${Date.now() - startTime}ms`);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('health:event', { type: 'renderer-recovered' });
              }
              return;
            }

            // 30s timeout
            if (Date.now() - startTime >= RENDERER_TIMEOUT_MS) {
              state = 'recovering';
              const elapsed = Date.now() - startTime;
              console.log(`[health] no renderer after ${elapsed}ms — attempting recovery`);

              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('health:event', { type: 'renderer-recovering', message: 'Rebuilding native modules...' });
              }

              // Spawn electron-rebuild
              const erPath = electronRebuildPath();
              if (erPath) {
                console.log(`[health] running electron-rebuild at ${erPath}`);
                try {
                  execFileSync(erPath, ['--arch', 'arm64'], { timeout: 120000, stdio: 'pipe' });
                  console.log('[health] electron-rebuild succeeded — relaunching');
                } catch (err) {
                  console.warn(`[health] electron-rebuild failed: ${err.message} — relaunching anyway`);
                }
              } else {
                console.log('[health] electron-rebuild not found — relaunching without rebuild');
              }

              // Relaunch
              setTimeout(() => {
                try {
                  app.relaunch();
                  app.exit(0);
                } catch (err) {
                  console.error(`[health] relaunch failed: ${err.message}`);
                  state = 'failed';
                  lastError = err;
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadURL(`data:text/html;base64,${Buffer.from(rendererOverlayHtml()).toString('base64')}`);
                    mainWindow.webContents.send('health:event', { type: 'renderer-failed', message: err.message });
                  }
                }
              }, 1000);
              return;
            }
          }

          // Phase 2: after recovery attempt, relaunched. Check again.
          if (state === 'recovering') {
            // We'll be in a new process — this interval was cleared by stop()
            // The relaunched app creates a fresh daemon. Nothing to do here.
          }
        } catch (err) {
          console.error('[health] renderer watchdog error:', err.message);
          lastError = err;
        }
      }, TICK_MS);
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      state = 'idle';
    },

    getStatus() {
      return { state, lastCheck, lastError: lastError?.message || null, startTime };
    },
  };
}

// ─── DevServerProbe ────────────────────────────────────────────────────────

function createDevServerProbe() {
  // Disabled Oct 27 2026. The old probe (defined twice in this file; the
  // second copy won) killed the lease's `pid` when a leased port did not
  // answer GET /__farnsworth_health with 200. No project serves that route,
  // the lease pid is the Farnsworth process itself, and leased_at (seconds)
  // was read as milliseconds so the 30s grace never applied: with multi-live
  // leases for every Go Live, it SIGTERMed Farnsworth ~15s after two windows
  // went live. Dev server lifecycle lives in src/dev-live-registry.js.
  return {
    start() {},
    stop() {},
    getStatus() { return { state: 'disabled', servers: [], lastCheck: null, lastError: null }; },
  };
}

// ─── ConfigWatcherGuard ───────────────────────────────────────────────────

function createConfigWatcherGuard(mainWindow) {
  let intervalId = null;
  let state = 'idle';
  let lastError = null;
  let lastCheck = null;
  let lastMtimes = {}; // folder -> config.json mtime
  let lastHeartbeat = null;

  return {
    start() {
      state = 'running';
      console.log('[health] config watcher guard active');

      intervalId = setInterval(async () => {
        try {
          lastCheck = Date.now();

          if (!mainWindow || mainWindow.isDestroyed()) {
            return;
          }

          // Ask the renderer for its current folder
          let currentFolder = null;
          try {
            currentFolder = await mainWindow.webContents.executeJavaScript(
              'window.__farnsworthCurrentFolder || null',
              true
            );
          } catch {
            // Renderer may be mid-navigation or not listening
            return;
          }

          if (!currentFolder) {
            // No folder open — nothing to guard
            state = 'idle';
            return;
          }

          state = 'running';
          const configPath = path.join(currentFolder, '.farnsworth', 'config.json');

          let currentMtime = null;
          try {
            currentMtime = fs.statSync(configPath).mtimeMs;
          } catch {
            // Config doesn't exist yet (fresh project scaffold?)
            return;
          }

          const prevMtime = lastMtimes[currentFolder];
          if (prevMtime && currentMtime > prevMtime) {
            // Config changed. Check if watcher is still alive by seeing if
            // the renderer acknowledges recent watcher heartbeats.
            let heartbeatOk = false;
            try {
              const hb = await mainWindow.webContents.executeJavaScript(
                'window.__farnsworthWatcherHeartbeat || 0',
                true
              );
              if (hb > (lastHeartbeat || 0)) {
                heartbeatOk = true;
                lastHeartbeat = hb;
              }
            } catch { /* ignore */ }

            if (!heartbeatOk) {
              console.log(`[health] config.json changed but watcher heartbeat not detected — ${configPath}`);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('health:event', {
                  type: 'config-watcher-stale',
                  folder: currentFolder,
                  message: 'Config changed but liveConfig may not have reloaded',
                });
              }
            }
          }

          lastMtimes[currentFolder] = currentMtime;
        } catch (err) {
          console.error('[health] config watcher guard error:', err.message);
          lastError = err;
        }
      }, WATCHER_GUARD_INTERVAL_MS);
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      state = 'idle';
      lastMtimes = {};
    },

    getStatus() {
      return { state, lastCheck, lastError: lastError?.message || null };
    },
  };
}

// ─── Exports ───────────────────────────────────────────────────────────────

function create(mainWindow, { db, instanceId, isDevTree } = {}) {
  const rendererWatchdog = createRendererWatchdog(mainWindow, { isDevTree });
  const devServerProbe = createDevServerProbe(mainWindow, db, instanceId);
  const configWatcherGuard = createConfigWatcherGuard(mainWindow);

  let started = false;
  let startTime = 0;

  return {
    start() {
      if (started) return;
      started = true;
      startTime = Date.now();
      rendererWatchdog.start();
      devServerProbe.start();
      configWatcherGuard.start();
      console.log('[health] daemon started');
    },

    stop() {
      if (!started) return;
      rendererWatchdog.stop();
      devServerProbe.stop();
      configWatcherGuard.stop();
      started = false;
      console.log('[health] daemon stopped');
    },

    getStatus() {
      return {
        uptime: started ? Date.now() - startTime : 0,
        started,
        renderer: rendererWatchdog.getStatus(),
        devServers: devServerProbe.getStatus(),
        watchers: configWatcherGuard.getStatus(),
      };
    },
  };
}

module.exports = { create };
