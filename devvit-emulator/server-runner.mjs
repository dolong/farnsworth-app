#!/usr/bin/env node
/**
 * Devvit emulator server-runner — Phase 2 of the emulator build.
 *
 * Approach: bundle the user's `src/server/index.ts` with esbuild, with
 * a custom plugin that REPLACES `@devvit/*` imports with our emulator
 * implementations. The bundle is self-contained — no Node loader hook
 * required, no recursion, no Node 26 / registerHooks gotchas.
 *
 * Why no loader hook:
 *   Phase 1 used a Node module loader hook to intercept @devvit/redis
 *   and @devvit/public-api imports at runtime. Phase 2 adds @devvit/web/server
 *   which needs createServer/getServerPort/context stubs. Node 26's loader
 *   pipeline (both register() and registerHooks()) recursed on nextResolve
 *   calls in our case (Maximum call stack size exceeded). Esbuild-side
 *   resolution sidesteps the issue entirely.
 *
 * Why this exists:
 *   `farnsworth:devvit` only starts Vite (port 5174, client-only). None
 *   of the user's src/server/ code runs in Farnsworth dev mode, so all
 *   redis writes happen client-side in-memory only — u/carol's save
 *   data vanishes on iframe reload. This runner starts the actual tRPC
 *   + Hono server on port 3000 so user code's `import { redis } from
 *   '@devvit/web/server'` writes hit the emulator's JSON-persisted
 *   Redis state.
 *
 * Usage:
 *   node server-runner.mjs <repoRoot>
 *
 * Required env (set by Farnsworth's dev:farnsworth:boot IPC):
 *   DEVVIT_EMULATOR_CONFIG  — JSON file with active user/sub
 *   DEVVIT_EMULATOR_STATE   — JSON file for persistent Redis writes
 *   DEVVIT_EMULATOR_SERVER_PORT — port to bind (default 3000)
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error('[server-runner] FATAL: missing repoRoot argument');
  console.error('[server-runner] Usage: node server-runner.mjs <repoRoot>');
  process.exit(1);
}

// Resolve esbuild from the user's project node_modules (it's a Devvit
// transitive dep). Farnsworth's own project doesn't ship esbuild.
// Oct 8: newer projects (Devvit 0.13 + Vite 8, which bundles with rolldown)
// no longer hoist esbuild to the top level; it only exists nested under
// @devvit/build-pack. Look in the usual places before giving up, so Go Live
// doesn't silently lose the server on every new project.
function findEsbuild() {
  const candidates = [
    pathResolve(repoRoot, 'node_modules/esbuild/lib/main.js'),
    pathResolve(repoRoot, 'node_modules/@devvit/build-pack/node_modules/esbuild/lib/main.js'),
    pathResolve(repoRoot, 'node_modules/@devvit/start/node_modules/esbuild/lib/main.js'),
    pathResolve(repoRoot, 'node_modules/vite/node_modules/esbuild/lib/main.js'),
    pathResolve(repoRoot, 'node_modules/tsx/node_modules/esbuild/lib/main.js'),
    pathResolve(__dirname, '..', 'node_modules/esbuild/lib/main.js'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const req = createRequire(pathResolve(repoRoot, 'package.json'));
    return req.resolve('esbuild');
  } catch {}
  return null;
}
const esbuildPath = findEsbuild();
if (!esbuildPath) {
  console.error('[server-runner] FATAL: esbuild not found in ' + repoRoot + '/node_modules (checked top-level and nested Devvit/Vite copies). Run npm install, or add esbuild as a devDependency.');
  process.exit(1);
}
const { build } = await import(pathToFileURL(esbuildPath).href);

// Entry override: default is the Devvit production entry (src/server/index.ts),
// which the-last-draft uses. Projects with their own local dev entry (e.g.
// dontdie-reddit's src/server/local.ts, which loads .env via dotenv + binds its
// own LOCAL_PORT + sets CORS) can override via DEVVIT_EMULATOR_SERVER_ENTRY.
const serverEntryRel = process.env.DEVVIT_EMULATOR_SERVER_ENTRY || 'src/server/index.ts';
const serverEntry = pathResolve(repoRoot, serverEntryRel);
const port = Number(process.env.DEVVIT_EMULATOR_SERVER_PORT || 3000);
const configPath = process.env.DEVVIT_EMULATOR_CONFIG || '(unset)';
const statePath = process.env.DEVVIT_EMULATOR_STATE || '(unset)';

console.log('[server-runner] starting');
console.log('[server-runner]   repoRoot:    ', repoRoot);
console.log('[server-runner]   entry:       ', serverEntry);
console.log('[server-runner]   config:      ', configPath);
console.log('[server-runner]   state:       ', statePath);
console.log('[server-runner]   port:        ', port);
console.log('[server-runner]   node:        ', process.version);

// Read the per-project emulator config (same file the loader-hook path reads)
// so the server operates as the ACTIVE user/subreddit the cogwheel selected —
// and knows about every user in the library. Without this, the server would
// fall back to a hardcoded 'dev-user' with zero seeded users, so every
// cogwheel switch was silently ignored server-side. Mapping matches
// emulator-hook.mjs exactly (config field names → emulator seed shape).
let emulatorSeed = {
  currentUsername: process.env.DEVVIT_EMULATOR_USERNAME || 'dev-user',
  currentSubredditName: process.env.DEVVIT_EMULATOR_SUBREDDIT || 'dev-subreddit',
  seedUsers: [],
  seedSubreddits: [],
};
try {
  if (configPath && configPath !== '(unset)') {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    emulatorSeed = {
      currentUsername: cfg.currentUsername || emulatorSeed.currentUsername,
      currentSubredditName: cfg.currentSubredditName || emulatorSeed.currentSubredditName,
      seedUsers: (cfg.users || []).map((u) => ({
        id: u.reddit_id,
        username: u.username,
        snoovatar: u.snoovatar_url ?? null,
        createdUtc: Math.floor(new Date(u.created_at || '2024-01-01').getTime() / 1000),
        linkKarma: u.link_karma || 0,
        commentKarma: u.comment_karma || 0,
        isEmployee: !!u.is_employee,
      })),
      seedSubreddits: (cfg.subreddits || []).map((s) => ({
        id: s.reddit_id,
        name: s.name,
        type: s.type || 'public',
        memberCount: s.member_count || 0,
      })),
    };
    console.log('[server-runner]   active user: ', emulatorSeed.currentUsername,
      `(${emulatorSeed.seedUsers.length} users, ${emulatorSeed.seedSubreddits.length} subreddits seeded)`);
  } else {
    console.log('[server-runner]   active user:  (no config — defaulting to dev-user)');
  }
} catch (err) {
  console.error('[server-runner] WARN: failed to read config, defaulting to dev-user:', err.message);
}

// The user's index.ts gates dev-admin routes on `process.env.NODE_ENV !== 'production'`.
// Force NODE_ENV=development so the user's full route surface is mounted.
// (Vite sets this automatically for its dev server; we need to do it explicitly.)
process.env.NODE_ENV = 'development';

// Load the emulator modules as plain CommonJS-shaped objects. We'll embed
// their source directly into the bundle via esbuild's plugin API.
const emulatorDir = pathResolve(__dirname);
const redisEmulatorSource = readFileSync(pathResolve(emulatorDir, 'RedisClientEmulator.mjs'), 'utf8');
const redditEmulatorSource = readFileSync(pathResolve(emulatorDir, 'RedditAPIClientEmulator.mjs'), 'utf8');

const tmpBundle = pathResolve(tmpdir(), `farnsworth-server-${process.pid}.mjs`);
console.log('[server-runner] bundling user server →', tmpBundle);

// Plugin that replaces @devvit/* imports with our emulator implementations.
// We use esbuild's onResolve + onLoad to inject virtual modules.
const emulatorPlugin = {
  name: 'devvit-emulator',
  setup(build) {
    const filter = /^@devvit\/(redis|public-api|web\/server)$/;

    build.onResolve({ filter }, () => ({
      path: 'devvit-emulator',
      namespace: 'devvit-emulator',
    }));

    build.onLoad({ filter: /.*/, namespace: 'devvit-emulator' }, () => {
      const se = JSON.stringify({
        seedUsers: emulatorSeed.seedUsers,
        seedSubreddits: emulatorSeed.seedSubreddits,
        currentUsername: emulatorSeed.currentUsername,
        currentSubredditName: emulatorSeed.currentSubredditName,
        statePath: process.env.DEVVIT_EMULATOR_STATE || null,
      });
      // Synthesize a module that:
      // 1. Imports our emulator classes (inlined as source)
      // 2. Exports redis/reddit/context/createServer/getServerPort for
      //    @devvit/web/server consumers
      // Strip import statements from the inlined emulator sources so we don't
// duplicate the ones we add below.
const stripImports = (src) => src.replace(/^import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');

const source = `
${stripImports(redisEmulatorSource)}
${stripImports(redditEmulatorSource)}
import { createServer as _nodeHttpCreateServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const _seed = ${se};
const _redis = new RedisClientEmulator('INSTALLATION', _seed.statePath, null);
const _reddit = new RedditAPIClientEmulator({
  currentUsername: _seed.currentUsername,
  currentSubredditName: _seed.currentSubredditName,
  persistPath: _seed.statePath,
  seedUsers: _seed.seedUsers,
  seedSubreddits: _seed.seedSubreddits,
});
const _ctx = {
  subredditName: _seed.currentSubredditName,
  postId: undefined,
  userId: 'dev-user',
  appName: 'devvit-emulator',
  appVersion: '0.0.0',
};
// Per-request post context. Real Devvit gives every request the context of
// the post it came from (context.postId / context.postData). The preview
// harness identifies the post with an x-farnsworth-post-id header, and each
// request runs inside its own AsyncLocalStorage store so concurrent requests
// from different mock posts never see each other's post.
const _reqCtx = new AsyncLocalStorage();
const context = new Proxy(_ctx, {
  get(t, k) {
    const store = _reqCtx.getStore();
    if (store && Object.prototype.hasOwnProperty.call(store, k)) return store[k];
    return t[k];
  },
  set() { throw new Error('devvit-emulator: context is read-only'); },
});
function _withPostContext(listener) {
  if (typeof listener !== 'function') return listener;
  return (req, res) => {
    const h = req.headers || {};
    const postId = h['x-farnsworth-post-id'] || h['devvit-post-id'];
    if (!postId) return listener(req, res);
    const p = _reddit._posts.get(String(postId));
    return _reqCtx.run({ postId: String(postId), postData: p ? p.postData : undefined }, () => listener(req, res));
  };
}

// Inline @hono/node-server adapter — small enough to drop in directly,
// avoids the external module dependency during bundling.
function _adaptRequest(nodeReq) {
  const url = \`http://\${nodeReq.headers.host || 'localhost'}\${nodeReq.url}\`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  let body;
  if (!['GET', 'HEAD'].includes(nodeReq.method || '')) {
    body = new ReadableStream({
      start(controller) {
        nodeReq.on('data', (c) => controller.enqueue(c));
        nodeReq.on('end', () => controller.close());
        nodeReq.on('error', (e) => controller.error(e));
      },
    });
  }
  return new Request(url, { method: nodeReq.method, headers, body, duplex: 'half' });
}

function createServer(serverOptions, listener) {
  // @hono/node-server v1.13+ signature: (serverOptions, listener) → http.Server
  // The listener is already a pre-built Node-style request listener that
  // wraps the Hono app's fetch handler. We just create an http.Server with
  // serverOptions + listener.
  return _nodeHttpCreateServer(serverOptions || {}, _withPostContext(listener));
}
function getServerPort() {
  return ${port};
}

// ---- Farnsworth IDE admin surface -------------------------------------
// A second, independent listener so the IDE can read and mutate the Reddit
// emulator's mock posts and comments against the LIVE in-memory instance.
// Deliberately NOT mounted on the user's app: it has to work regardless of
// how a project builds its server (dontdie's local.ts never calls the
// createServer shim above), and it must never collide with user routes.
// Port is derived so no template script change is needed to discover it.
const _adminPort = Number(process.env.DEVVIT_EMULATOR_ADMIN_PORT || ${port} + 100);
function _adminSend(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}
async function _adminReadBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}; }
  catch { return {}; }
}
const _adminServer = _nodeHttpCreateServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return _adminSend(res, 204, {});
    if (u.pathname === '/emulator/ping') {
      return _adminSend(res, 200, { ok: true, kind: 'farnsworth-devvit-emulator-admin', serverPort: ${port} });
    }
    if (u.pathname === '/emulator/state' && req.method === 'GET') {
      return _adminSend(res, 200, { ok: true, ..._reddit.adminSnapshot() });
    }
    if (u.pathname === '/emulator/post' && req.method === 'POST') {
      const b = await _adminReadBody(req);
      if (!b.title || !String(b.title).trim()) {
        return _adminSend(res, 400, { ok: false, error: 'title_required' });
      }
      // A post with an entry, postData, or type label is a custom post, the
      // same thing the app's own submitCustomPost would create.
      const isCustom = b.entry || b.postData !== undefined || b.postType;
      const p = isCustom
        ? await _reddit.submitCustomPost({
          title: String(b.title),
          subredditName: b.subredditName || undefined,
          entry: b.entry ? String(b.entry) : undefined,
          postData: b.postData,
          farnsworthPostType: b.postType ? String(b.postType) : undefined,
        })
        : await _reddit.submitPost({
          title: String(b.title),
          text: b.body ? String(b.body) : undefined,
          subredditName: b.subredditName || undefined,
        });
      return _adminSend(res, 200, { ok: true, id: p.id, post: _reddit.adminSnapshot().posts.find((x) => x.id === p.id) || null });
    }
    if (u.pathname === '/emulator/comment' && req.method === 'POST') {
      const b = await _adminReadBody(req);
      const target = b.postId || b.parentId;
      if (!target) return _adminSend(res, 400, { ok: false, error: 'postId_required' });
      if (!b.text || !String(b.text).trim()) {
        return _adminSend(res, 400, { ok: false, error: 'text_required' });
      }
      // submitComment reads options.id as the parent thing id, which is how
      // the real Devvit API is shaped (t3_* for a post, t1_* for a reply).
      const c = await _reddit.submitComment({ id: String(target), text: String(b.text) });
      return _adminSend(res, 200, { ok: true, id: c.id, comments: _reddit.adminSnapshot().comments });
    }
    return _adminSend(res, 404, { ok: false, error: 'unknown_route', path: u.pathname });
  } catch (e) {
    return _adminSend(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});
_adminServer.on('error', (e) => {
  console.error('[server-runner] admin surface failed to bind on', _adminPort, '-', e.message);
});
_adminServer.listen(_adminPort, '127.0.0.1', () => {
  console.log('[server-runner] emulator admin surface on http://127.0.0.1:' + _adminPort);
});

const cache = { get: async () => null, set: async () => {}, del: async () => {} };
const media = { upload: async () => ({ mediaUrl: '' }), get: async () => null };
const notifications = { send: async () => ({ id: '' }), readAll: async () => {} };
const realtime = { send: () => {}, broadcast: () => {} };
const scheduler = { run: async () => {}, cancel: () => {} };
const settings = { get: async () => undefined, set: async () => {} };
const payments = { fulfillOrder: async () => ({ success: true }), refundOrder: async () => ({ success: true }) };

export const redis = _redis;
export const redisCompressed = _redis;
export const RedisKeyScope = { Local: 0, Installation: 1, Global: 2 };
export const reddit = _reddit;
export { context, createServer, getServerPort, cache, media, notifications, realtime, scheduler, settings, payments };
`;
      return {
        contents: source,
        loader: 'js',
        // Resolve relative imports in our synthesized source from the
        // user's project so @hono/node-server (and RedisClientEmulator.mjs
        // via './RedisClientEmulator.mjs') resolve correctly.
        resolveDir: repoRoot,
      };
    });
  },
};

try {
  await build({
    entryPoints: [serverEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: tmpBundle,
    logLevel: 'warning',
    // No packages: 'external' — bundle everything including @hono/node-server
    // so the bundle is self-contained and Node can import it from /tmp/.
    absWorkingDir: repoRoot,
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    // Provide a real `require` at module top-level so esbuild's __require
    // helper delegates to it instead of throwing "Dynamic require of X is not
    // supported". CJS deps bundled into the ESM output (e.g. dotenv, which
    // dontdie's local.ts imports and which does require('fs')) need this.
    // Harmless for entries with no dynamic requires (the-last-draft's index.ts).
    banner: {
      js: [
        "import { createRequire as __fwCreateRequire } from 'node:module';",
        "const require = __fwCreateRequire(import.meta.url);",
      ].join('\n'),
    },
    plugins: [emulatorPlugin],
  });
  console.log('[server-runner] bundle complete');
} catch (err) {
  console.error('[server-runner] FATAL: esbuild bundle failed');
  console.error('[server-runner]', err.message || err);
  process.exit(1);
}

try {
  await import(pathToFileURL(tmpBundle).href);
  console.log('[server-runner] user server loaded — Hono is listening on', port);
} catch (err) {
  console.error('[server-runner] FATAL: user server failed to load');
  console.error('[server-runner]', err.stack || err.message || err);
  process.exit(1);
}

setInterval(() => {}, 1 << 30);