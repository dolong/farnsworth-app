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
import { writeFileSync, readFileSync } from 'node:fs';
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
const esbuildPath = pathResolve(repoRoot, 'node_modules/esbuild/lib/main.js');
const { build } = await import(pathToFileURL(esbuildPath).href);

const serverEntry = pathResolve(repoRoot, 'src/server/index.ts');
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
const context = new Proxy(_ctx, {
  set() { throw new Error('devvit-emulator: context is read-only'); },
});

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
  return _nodeHttpCreateServer(serverOptions || {}, listener);
}
function getServerPort() {
  return ${port};
}

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