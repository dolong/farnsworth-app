# Enabling Farnsworth Live Preview on a Devvit app

**Audience: an AI agent (Farnsworth chat agent or Claude Code) working inside a
Reddit/Devvit project that needs to render in Farnsworth's Live Preview canvas.**

If Farnsworth's "Go Live" fails with:

> This workspace has no "farnsworth:devvit" script in package.json.

…the open project has not been wired for Live Preview yet. This doc is the
complete, self-contained procedure to wire **any** Devvit app for it. You do not
need the `vibe-farnsworth-template` repo — every file's full contents are below.

The change is **additive**: it never touches `devvit.json`, the Devvit
entrypoints, or the production build. `npm run dev` / `build` / `deploy` /
`launch` keep working exactly as before.

---

## How Farnsworth detects a previewable project (the contract)

Farnsworth's main process (`dev:farnsworth:boot` in `main.js`) does this:

1. Requires the open workspace to have `package.json` with a script named
   **`farnsworth:<appType>`** (for Devvit: `farnsworth:devvit`). Missing → the
   error above.
2. Runs `npm run farnsworth:<appType>`. That script must **boot a Vite dev
   server on port `5174`** and **write `~/.cache/farnsworth-<appType>.json`**
   with `{ type, url, pid, startedAt, log, repoRoot }`, then exit `0` once the
   URL returns HTTP 200 (within ~45s).
3. Reads that meta file to find the server URL/pid and swaps the static preview
   images for live iframes.
4. Reads **`.farnsworth/config.json`** (`{"appType":"devvit"}`) to know the
   workspace type.

The canvas requests specific frames by URL query param:
`?view=post` (Reddit inline splash), `?view=mobile`, `?view=desktop`.
No param → a manual tab picker.

So "wiring a project" = adding **6 files + 1 config + 3 package.json scripts**
that satisfy this contract.

---

## What to add

```
vite.devtools.config.ts        # separate Vite config: root=dev-tools, shim alias, :5174, tRPC proxy
scripts/farnsworth-devvit.sh   # boot script → writes ~/.cache/farnsworth-devvit.json
.farnsworth/config.json        # {"appType":"devvit"} — tells Farnsworth the workspace type
dev-tools/
  index.html                   # harness entry HTML + iframe-fit CSS
  main.jsx                     # mounts <Shell/> into #root
  Shell.jsx                    # ?view= dispatcher (post / mobile / desktop / standalone)
  devvit-shim.ts               # stub for @devvit/web/client (dev-only, never ships)
  style.css                    # iframe-fit overrides (no scrollbars)
```

Plus these `package.json` script entries:

```json
{
  "scripts": {
    "dev:tools": "vite --config vite.devtools.config.ts",
    "build:tools": "vite build --config vite.devtools.config.ts",
    "farnsworth:devvit": "bash scripts/farnsworth-devvit.sh"
  }
}
```

No new dependencies are needed if the project already uses Vite + React +
Tailwind (the standard Devvit vibe-coding stack). If it doesn't use
`@tailwindcss/vite`, drop the `tailwind()` plugin line from the Vite config.

---

## ⚠️ Two things you MUST adapt per project

1. **The component import paths in `dev-tools/Shell.jsx`.** The template imports
   `@src/client/splash` (the inline/post component) and `@src/client/game`
   (the expanded/app component). **Change these two imports to wherever THIS
   project's splash/game (or equivalent) components actually live.** Inspect
   `src/` first. If the project has only one root client component, render it
   for all three views.
2. **The `@devvit/web/client` shim surface in `dev-tools/devvit-shim.ts`.** It
   must export every symbol the project imports from `@devvit/web/client`.
   Grep the project (`grep -rn "@devvit/web/client" src`) and add a stub for
   anything not already covered below.

---

## File contents (copy verbatim, then adapt the two items above)

### `.farnsworth/config.json`
The `appType` key is **required** for detection. The `live` block and `liveGameId`
are **optional** — they drive the Live/analytics right-panel tab. Omit them and
the Live tab falls back to the built-in Sword & Supper mock; fill them (or set
them later via the Live panel cogwheel) to make the tab project-accurate.
Preview itself does not need them.
```json
{
  "appType": "devvit",
  "liveGameId": null,
  "live": {
    "projectName": "",
    "subredditName": "",
    "url": "",
    "postName": ""
  }
}
```
> Read shape (app.js): `config.appType`, top-level `config.liveGameId`, and
> nested `config.live.{projectName,subredditName,url,postName}` — all strings,
> all default to empty. `subredditName` (no `r/`) feeds the analytics header and
> the Post View credit line; `postName` sets the Post View title.

### `vite.devtools.config.ts`
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, 'dev-tools'),
  publicDir: path.resolve(__dirname, 'public'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      // Stub the Devvit client so the app can render unmodified outside the
      // Devvit playtest environment.
      '@devvit/web/client': path.resolve(__dirname, 'dev-tools/devvit-shim.ts'),
      '@src': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    open: false, // Farnsworth embeds this in its canvas iframe — don't pop a tab.
    proxy: {
      // Forward tRPC to the real Devvit server (WEBBIT_PORT, default 3000) so
      // data-driven views load if `npm run dev` is also running.
      '/api/trpc': {
        target: `http://localhost:${process.env.WEBBIT_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
});
```

### `dev-tools/main.jsx`
```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './Shell.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
```

### `dev-tools/Shell.jsx`
> **Adapt the two imports below to this project's components.**
```jsx
import { useState, useMemo } from 'react';
import { Splash } from '@src/client/splash'; // ← ADAPT: inline/post component
import { App } from '@src/client/game';       // ← ADAPT: expanded/app component

const TABS = [
  { id: 'splash', label: 'Splash (Inline)', render: () => <Splash /> },
  { id: 'game', label: 'Game (Expanded)', render: () => <App /> },
];

function readView() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get('view');
  if (v === 'post' || v === 'mobile' || v === 'desktop') return v;
  return 'standalone';
}

export const Shell = () => {
  const view = useMemo(() => readView(), []);
  const [active, setActive] = useState('splash');

  if (view === 'post') return <div className="post-stage"><Splash /></div>;
  if (view === 'mobile') return <div className="mobile-stage"><App /></div>;
  if (view === 'desktop') return <div className="desktop-stage"><App /></div>;

  // Standalone — tab picker for manual iteration in a plain browser tab.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav style={{ display: 'flex', gap: 4, padding: '8px 12px', background: '#1a1a1a', borderBottom: '1px solid #333' }}>
        {TABS.map((tab) => (
          <button key={tab.id} type="button" onClick={() => setActive(tab.id)}
            style={{ padding: '6px 14px', background: active === tab.id ? '#d93900' : '#2a2a2a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
            {tab.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', alignSelf: 'center', color: '#666', fontSize: 11 }}>Dev Tools · vite · port 5174</span>
      </nav>
      <div style={{ flex: 1, overflow: 'auto', background: '#fff' }}>
        {TABS.find((t) => t.id === active)?.render()}
      </div>
    </div>
  );
};
```

### `dev-tools/devvit-shim.ts`
> **Add stubs for any other `@devvit/web/client` exports this project imports.**
```ts
/**
 * Devvit client shim — used only by `npm run dev:tools`/`farnsworth:devvit`
 * so client components render unmodified outside Devvit playtest.
 * Vite aliases `@devvit/web/client` → this file. Production uses the real one.
 */
export const context = {
  username: 'dev-user',
  postId: 'dev-post',
  subredditName: 'dev-subreddit',
};

export const requestExpandedMode = () => console.log('[devvit-shim] requestExpandedMode()');
export const navigateTo = (url: string) => console.log('[devvit-shim] navigateTo:', url);
export const showToast = (message: string) => console.log('[devvit-shim] showToast:', message);
export const showForm = (form: unknown) => console.log('[devvit-shim] showForm:', form);
export const useDevvitContext = () => context;
```

### `dev-tools/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dev Tools</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; overflow: hidden; }
      body { background: #0d0d0d; color: #e0e0e0; font-family: monospace; }
      #root { height: 100%; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.jsx"></script>
    <link rel="stylesheet" href="./style.css" />
  </body>
</html>
```

### `dev-tools/style.css`
```css
/* iframe-fit overrides. Tailwind's min-h-screen (100vh) forces scrollbars
   inside the Farnsworth iframe; neutralise it so components fill the iframe. */
html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; }
#root > * { height: 100%; }
.min-h-screen { min-height: 0 !important; }
.post-stage, .mobile-stage, .desktop-stage { width: 100%; height: 100%; overflow: hidden; }
.post-stage > *, .mobile-stage > *, .desktop-stage > * { width: 100%; height: 100%; }
```

### `scripts/farnsworth-devvit.sh`
```bash
#!/bin/bash
# farnsworth:devvit — boot the dev-tools Vite server in the background so
# Farnsworth can render the live canvas via iframe. Writes
# ~/.cache/farnsworth-devvit.json with {type,url,pid,startedAt,log,repoRoot}.
set -e

APP_TYPE="devvit"
CACHE_DIR="$HOME/.cache"
META_FILE="$CACHE_DIR/farnsworth-${APP_TYPE}.json"
LOG_FILE="$CACHE_DIR/farnsworth-${APP_TYPE}.log"
PORT=5174
URL="http://localhost:${PORT}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$CACHE_DIR"

# 1. Kill any old instance (best-effort)
if [ -f "$META_FILE" ]; then
  OLD_PID=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$META_FILE','utf8')).pid || '') } catch(e){}" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true; sleep 0.5; kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
pkill -f 'vite.devtools.config.ts' 2>/dev/null || true
sleep 0.3

# 2. Ensure npm is on PATH (Apple Silicon Homebrew)
export PATH="/opt/homebrew/bin:${PATH}"

# 3. Boot vite in the background
cd "$REPO_ROOT"
nohup npm run dev:tools > "$LOG_FILE" 2>&1 </dev/null &
VITE_PID=$!
disown

# 4. Write metadata for the Farnsworth main process
node -e "
const fs = require('fs');
fs.writeFileSync('$META_FILE', JSON.stringify({
  type: '$APP_TYPE', url: '$URL', pid: $VITE_PID,
  startedAt: new Date().toISOString(), log: '$LOG_FILE', repoRoot: '$REPO_ROOT',
}, null, 2));
"

# 5. Wait for readiness (max 30s)
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null | grep -q '^200$'; then
    echo "✓ farnsworth:${APP_TYPE} up at $URL (pid $VITE_PID)"
    exit 0
  fi
  sleep 0.5
done
echo "✗ farnsworth:${APP_TYPE} failed to respond within 30s — tail $LOG_FILE"
exit 1
```

After creating the script: `chmod +x scripts/farnsworth-devvit.sh`.

---

## Backend / server: running against the Devvit emulator

Everything above wires the **client** (splash + game UI). If the project's game
loop only needs the splash/inline view, you're done — skip this section.

But most real Devvit games have a **server** under `src/server/` that imports
`redis` / `reddit` / `context` from `@devvit/web/server` (or `@devvit/redis`,
`@devvit/public-api`). Those routes are what the client calls at `/api/...`. In
production they run inside Devvit with real Reddit auth + Redis. Locally they
have nowhere to run — so "click to start" (or any data call) fails with
`ECONNREFUSED` / 502 until you give it a backend.

**Do NOT tell the user to run `devvit playtest` for this.** Farnsworth ships a
Devvit **emulator** that runs the project's own server code against an in-memory,
JSON-persisted Redis + a Reddit stub — no playtest, no Reddit auth, no deploy.
The piece that runs it is the **server-runner**:

```
~/Documents/Farnsworth/app/devvit-emulator/server-runner.mjs
```

### How the server-runner works (and why not a loader hook)

`server-runner.mjs` **esbuild-bundles** the project's server entry, replacing
every `@devvit/*` import with emulator implementations **at build time**, then
runs the self-contained bundle. There is **no Node `--import` loader hook** and
no `tsx` involved.

> ⚠️ **Never wire the server with `NODE_OPTIONS="--import .../loader.mjs"`.**
> The loader-hook approach breaks on the `@devvit/web/server` sentinel URL
> (`TypeError: Invalid URL — input: 'devvit-emulator://web-server'`), and it
> breaks *worse* if the project runs its server under `tsx watch` (e.g.
> `tsx watch src/server/local.ts`), because `tsx` is itself an ESM loader hook
> and the two collide in the resolve pipeline. The server crashes on boot before
> it ever listens. **Always use the esbuild `server-runner.mjs` for server
> code.** (This is a settled lesson — it has bitten twice.)

Usage: `node server-runner.mjs <repoRoot>`, controlled by env vars:

| Env var | Meaning | Default |
|---|---|---|
| `DEVVIT_EMULATOR_SERVER_ENTRY` | Server entry to bundle, relative to repo root | `src/server/index.ts` |
| `DEVVIT_EMULATOR_SERVER_PORT` | Port for the emulated server | `3000` |
| `DEVVIT_EMULATOR_STATE` | JSON file the emulated Redis persists to (survives restarts) | *(in-memory only)* |
| `DEVVIT_EMULATOR_CONFIG` | Optional seed users/subreddits | *(none → single `dev-user`)* |

Requirement: `esbuild` must resolve from the project's `node_modules` (any
Vite-based Devvit project already has it transitively). A `createRequire` banner
in the bundle handles CommonJS deps (e.g. `dotenv`) that do `require('fs')`.

### Pick the right server entry (the load-bearing decision)

Two common shapes. **Inspect `src/server/` before choosing.**

1. **Devvit production entry only** — `src/server/index.ts` calls
   `serve({ fetch, createServer, port: getServerPort() })`. This is the default;
   set nothing. The server binds `DEVVIT_EMULATOR_SERVER_PORT` (3000). But note:
   `index.ts` usually does **not** load `.env`, so any local-dev identity or
   config the game reads from env won't be present — you may have to pass those
   vars explicitly (see below).

2. **The project has its own local dev entry** — e.g. `src/server/local.ts` or
   `dev.ts` that runs the Hono app directly (`serve({ fetch, port: LOCAL_PORT })`),
   loads `.env` via `dotenv.config()`, and sets CORS. **Prefer this entry**, via
   `DEVVIT_EMULATOR_SERVER_ENTRY=src/server/local.ts`, because it loads the
   project's `.env` for you — including whatever supplies the local user
   identity. (Example: dontdie-reddit resolves the player from
   `LOCAL_DEV=true` + `LOCAL_DEV_USER_ID` in `.env`, read by
   `extractUserFromRequest`. Only `local.ts` loads those; `index.ts` wouldn't.)

   When you use a local entry, match the **port** to whatever that entry binds
   (dontdie uses `LOCAL_PORT=3001`) **and** point the client proxy at the same
   port (next item).

### Match the proxy port

The client harness proxies `/api` (or `/api/trpc`) to the server. In
`vite.devtools.config.ts` the proxy `target` **must equal** the server-runner
port. Default template = `3000`; if you chose a local entry on `3001`, change
the proxy target to `3001`.

### Boot both together (the boot-script server block)

Extend `scripts/farnsworth-devvit.sh` so Go Live boots the server-runner
**alongside** the Vite harness. Add this after the `dev:tools` spawn, and record
`serverPid` in the meta file so stop/restart cleans it up. Example (dontdie
shape — local entry on 3001):

```bash
RUNNER="/Users/long/Documents/Farnsworth/app/devvit-emulator/server-runner.mjs"
SERVER_LOG="${HOME}/.cache/<project>-server.log"
DEVVIT_EMULATOR_SERVER_ENTRY="src/server/local.ts" \
  DEVVIT_EMULATOR_SERVER_PORT=3001 \
  LOCAL_PORT=3001 \
  DEVVIT_EMULATOR_STATE="${HOME}/.cache/<project>-emu-state.json" \
  nohup node "${RUNNER}" "${REPO_ROOT}" > "${SERVER_LOG}" 2>&1 < /dev/null &
SERVER_PID=$!
disown 2>/dev/null || true
```

Then add `"serverPid": ${SERVER_PID}` + `"serverLog": "${SERVER_LOG}"` to the
meta JSON, kill the old `serverPid` at the top of the script, and add a
**repo-scoped** name sweep so restarts don't stack servers *and* don't kill a
sibling project's runner:

```bash
pkill -f "server-runner.mjs ${REPO_ROOT}" 2>/dev/null || true
```

For a project using the default Devvit entry on 3000, drop
`DEVVIT_EMULATOR_SERVER_ENTRY` + `LOCAL_PORT` and set
`DEVVIT_EMULATOR_SERVER_PORT=3000`. If the game reads identity/config from env
that `index.ts` doesn't load, pass those vars inline on the spawn line too.

### Check Redis method coverage

The emulator's `RedisClientEmulator.mjs` implements ~75 methods including
`watch`/`multi`/`exec` (the `TxClient`), so atomic patterns
(`updateInventoryAtomic`, `claimOnce`, optimistic `watch`+`multi`) work. If a
route throws on a missing method, extend that file. Pre-flight the risk:

```bash
# methods the project calls, vs what the emulator implements
grep -rhoE "redis\.[a-zA-Z]+\(" src/server | sed -E 's/redis\.|\(//g' | sort -u
```

Cross-check against the method list in
`~/Documents/Farnsworth/app/devvit-emulator/RedisClientEmulator.mjs`.

### Durability caveat

The server-runner's process cmdline contains `Documents/Farnsworth/app`, so a
**full Farnsworth app relaunch** (not just Go Live) kills it via Farnsworth's
own `pkill` chain. Go Live respawns it, so it's a non-issue in normal use — but
if the server vanishes after restarting the whole IDE, just Go Live again.

---

## Verify

```bash
npm install                    # if deps changed
npm run dev:tools              # → open http://localhost:5174 (tab picker)
#   http://localhost:5174/?view=post    → inline/splash
#   http://localhost:5174/?view=mobile  → app
#   http://localhost:5174/?view=desktop → app
```

If the project has a server, verify the emulator path too:

```bash
# boot the server-runner by hand against your chosen entry/port
DEVVIT_EMULATOR_SERVER_ENTRY=src/server/local.ts DEVVIT_EMULATOR_SERVER_PORT=3001 \
  LOCAL_PORT=3001 DEVVIT_EMULATOR_STATE=~/.cache/<project>-emu-state.json \
  node ~/Documents/Farnsworth/app/devvit-emulator/server-runner.mjs "$PWD"
# then, in another shell:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/version   # → 200 direct
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5174/api/version   # → 200 through the proxy
```

A 200 **through the proxy** (:5174) is the real green light — that's the exact
path the game uses.

Then in Farnsworth: open the folder → switch the canvas to **Live Preview** →
**Go Live**. Or run `npm run farnsworth:devvit` in a terminal; Farnsworth
auto-detects the running server via the meta file.

---

## Troubleshooting

- **Blank / import error in a view** — the `@src/client/...` imports in
  `Shell.jsx` don't match this project. Fix them to the real component paths.
- **`X is not exported` from `@devvit/web/client`** — add that export to
  `dev-tools/devvit-shim.ts`.
- **`game`/data view shows nothing, or `/api` calls fail (ECONNREFUSED / 502)**
  — data routes need a backend. Boot the Devvit emulator **server-runner** (see
  "Backend / server" above); do **not** rely on `devvit playtest`. Confirm the
  client proxy `target` port matches the server-runner port. The splash/inline
  view needs no backend.
- **Server crashes on boot with `Invalid URL 'devvit-emulator://web-server'`**
  — something is wiring the server with the `--import loader.mjs` hook instead
  of the esbuild server-runner. Switch to `server-runner.mjs` (see "Backend /
  server"). This always happens when the server runs under `tsx`.
- **`Dynamic require of "fs" is not supported`** — a CommonJS dep (e.g.
  `dotenv`) got bundled to ESM without a `require` shim. The server-runner's
  `createRequire` banner handles this; make sure you're on the current
  `server-runner.mjs`.
- **A redis method throws (`... is not a function`)** — the emulator is missing
  that method. Add it to
  `~/Documents/Farnsworth/app/devvit-emulator/RedisClientEmulator.mjs`.
- **Port 5174 in use / stale server** — `pkill -f vite.devtools.config.ts`.
- **`npm: command not found` in the boot script** — it prepends
  `/opt/homebrew/bin`; adjust if node/npm live elsewhere.
- **Scrollbars in the preview** — ensure `dev-tools/index.html` links
  `style.css` and both fit-CSS blocks are intact.
- **Farnsworth doesn't detect the server** — confirm
  `~/.cache/farnsworth-devvit.json` exists and its `url` returns 200.

---

## Reference implementation

`github.com/dolong/vibe-farnsworth-template` (local:
`~/Documents/vibe-farnsworth-template`) is a full working example, with a longer
narrative writeup in its `FARNSWORTH.md`.
