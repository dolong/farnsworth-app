/**
 * Devvit Emulator loader hook — Phase 1
 *
 * Uses Node.js module customization hooks (resolve + load) to swap
 * @devvit/redis and @devvit/public-api for in-memory emulator modules.
 *
 * Reads config from process.env.DEVVIT_EMULATOR_CONFIG (a JSON file path
 * written by Farnsworth's dev:farnsworth:boot IPC). The JSON contains:
 *   { currentUsername, currentSubredditName, users, subreddits }
 *
 * Reads/writes state at process.env.DEVVIT_EMULATOR_STATE (a JSON file
 * path sibling to the config) for cross-restart persistence:
 *   { installation: {key: entry}, global: {key: entry}, reddit: {...} }
 *
 * User code's `import { redis } from '@devvit/redis'` resolves through
 * this hook to a synthesized module exporting the in-memory emulator.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RedisClientEmulator } from './RedisClientEmulator.mjs';
import { RedditAPIClientEmulator } from './RedditAPIClientEmulator.mjs';

// Resolve emulator modules against THIS hook's location, not process.cwd().
// Earlier pathToFileURL('./X.mjs') broke when cwd was the user's repo
// (the devvit-emulator dir wasn't there). Fix Jul 10 ~16:42 ET.
const REDIS_EMULATOR_URL = new URL('./RedisClientEmulator.mjs', import.meta.url).href;
const REDDIT_EMULATOR_URL = new URL('./RedditAPIClientEmulator.mjs', import.meta.url).href;

function loadConfig() {
  const cfgPath = process.env.DEVVIT_EMULATOR_CONFIG;
  if (!cfgPath) return null;
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[devvit-emulator] failed to load config:', e.message);
    return null;
  }
}

if (process.env.DEVVIT_EMULATOR_DEBUG) {
  process.stderr.write(`[emulator-hook] loaded as URL: ${import.meta.url}\n`);
  process.stderr.write(`[emulator-hook] cfgPath: ${process.env.DEVVIT_EMULATOR_CONFIG || '(none)'}\n`);
}

const cfg = loadConfig() || {};
const statePath = process.env.DEVVIT_EMULATOR_STATE || null;

const currentUsername = cfg.currentUsername || 'dev-user';
const currentSubredditName = cfg.currentSubredditName || 'dev-subreddit';

const seedUsers = (cfg.users || []).map((u) => ({
  id: u.reddit_id,
  username: u.username,
  snoovatar: u.snoovatar_url ?? null,
  createdUtc: Math.floor(new Date(u.created_at || '2024-01-01').getTime() / 1000),
  linkKarma: u.link_karma || 0,
  commentKarma: u.comment_karma || 0,
  isEmployee: !!u.is_employee,
}));
const seedSubreddits = (cfg.subreddits || []).map((s) => ({
  id: s.reddit_id,
  name: s.name,
  type: s.type || 'public',
  memberCount: s.member_count || 0,
}));

// Sentinel URL we control — Node treats this as a unique module spec.
const REDIS_URL = 'devvit-emulator://redis';
const REDDIT_URL = 'devvit-emulator://reddit';
const WEB_SERVER_URL = 'devvit-emulator://web-server';

const REDIS_IMPORT_URL = REDIS_EMULATOR_URL;
const REDDIT_IMPORT_URL = REDDIT_EMULATOR_URL;

// Read once at hook-load time so the synthesized @devvit/web/server module
// can embed these constants directly in source.
const SERVER_PORT = Number(process.env.DEVVIT_EMULATOR_SERVER_PORT || 3000);

// We embed the seed data + state path into the synthesized module source so
// the user's subprocess sees a fully-initialized emulator on first import.
// No IPC round-trip needed.
const SEED_JSON = JSON.stringify({
  seedUsers,
  seedSubreddits,
  currentUsername,
  currentSubredditName,
  statePath,
});

export async function resolve(specifier, context, nextResolve) {
  // IMPORTANT: do NOT do dynamic imports or any I/O here — they recurse
  // through this very hook. (The earlier debug logging that wrote to
  // /tmp/devvit-emu-debug.log via `await import('node:fs')` triggered
  // Maximum call stack exceeded because the dynamic import itself
  // re-invokes resolve() for 'node:fs'.) Jul 10 lesson.
  if (process.env.DEVVIT_EMULATOR_DEBUG) {
    try {
      // Use the synchronously-imported readFileSync from the top of the
      // file (already imported as a regular module dependency) to write
      // debug output. This file-level import was resolved BEFORE the
      // hook was registered, so it doesn't recurse.
      const buf = Buffer.from(`[resolve-IN ] ${JSON.stringify(specifier)} | parent=${context.parentURL || '(none)'}\n`);
      // writeSync to fd 2 (stderr) — doesn't need fs module access.
      // globalThis.process.stderr._handle.writeSync is internal but stable.
      const handle = globalThis.process.stderr._handle;
      if (handle && typeof handle.writeSync === 'function') {
        handle.writeSync(buf, 0, buf.length, 0);
      }
    } catch {}
  }
  if (specifier === '@devvit/redis') {
    return { url: REDIS_URL, shortCircuit: true, format: 'module' };
  }
  if (specifier === '@devvit/public-api') {
    return { url: REDDIT_URL, shortCircuit: true, format: 'module' };
  }
  if (specifier === '@devvit/web/server') {
    return { url: WEB_SERVER_URL, shortCircuit: true, format: 'module' };
  }
  // Node's loader pipeline may re-invoke resolve() with our sentinel URLs
  // (e.g. when loading a synthesized module's parent chain). Short-circuit
  // so nextResolve() never sees a custom scheme. Match by prefix too in
  // case Node normalizes the URL with a trailing slash.
  if (specifier === REDIS_URL || specifier.startsWith(REDIS_URL + '/')) {
    return { url: REDIS_URL, shortCircuit: true, format: 'module' };
  }
  if (specifier === REDDIT_URL || specifier.startsWith(REDDIT_URL + '/')) {
    return { url: REDDIT_URL, shortCircuit: true, format: 'module' };
  }
  if (specifier === WEB_SERVER_URL || specifier.startsWith(WEB_SERVER_URL + '/')) {
    return { url: WEB_SERVER_URL, shortCircuit: true, format: 'module' };
  }

  // Resolve extension-less relative imports against .ts files. Devvit
  // projects use TS but write imports without the extension (Node's
  // default resolver can't find them, so we rewrite before passing to
  // nextResolve). Only applies to relative specifiers ('./' or '../').
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.[a-z]+$/i.test(specifier)) {
      const tsSpec = specifier + '.ts';
      try {
        const result = await nextResolve(tsSpec, context);
        if (result && result.url) return result;
      } catch {
        // fall through to original resolve below
      }
    }
  }

  if (process.env.DEVVIT_EMULATOR_DEBUG) {
    try {
      const fs = await import('node:fs');
      fs.appendFileSync('/tmp/devvit-emu-debug.log', `[fall-through] ${JSON.stringify(specifier)} | parent=${context.parentURL || '(none)'}\n`);
    } catch {}
  }
  if (process.env.DEVVIT_EMULATOR_DEBUG) {
    process.stderr.write(`[fall-through] ${JSON.stringify(specifier)} | parent=${context.parentURL || '(none)'}\n`);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === REDIS_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import { RedisClientEmulator } from '${REDIS_IMPORT_URL}';
        const _redis = new RedisClientEmulator('INSTALLATION', ${JSON.stringify(statePath)}, null);
        export const redis = _redis;
        export const redisCompressed = _redis;
        export const RedisKeyScope = { Local: 0, Installation: 1, Global: 2 };
      `,
    };
  }
  if (url === REDDIT_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import { RedditAPIClientEmulator } from '${REDDIT_IMPORT_URL}';
        const _seed = ${SEED_JSON};
        const _reddit = new RedditAPIClientEmulator({
          currentUsername: _seed.currentUsername,
          currentSubredditName: _seed.currentSubredditName,
          persistPath: _seed.statePath,
          seedUsers: _seed.seedUsers,
          seedSubreddits: _seed.seedSubreddits,
        });
        export const reddit = _reddit;
      `,
    };
  }
  if (url === WEB_SERVER_URL) {
    // Shim @devvit/web/server — provides redis/reddit/context/createServer/
    // getServerPort to user code. The @devvit/redis and @devvit/public-api
    // shims above are re-exported here so user code that imports from the
    // meta-package sees the same emulator instances.
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import { createAdaptorServer } from '@hono/node-server';
        // Re-export the same emulator instances that @devvit/redis and
        // @devvit/public-api synthesize — these resolve through this hook
        // to the same REDIS_URL/REDDIT_URL modules.
        import { redis } from '@devvit/redis';
        import { reddit } from '@devvit/public-api';

        // DevvitContext shape — user's core/*.ts reads context.subredditName
        // and context.postId. Empty for the emulator (no post context).
        const _ctx = ${JSON.stringify({
          subredditName: currentSubredditName,
          postId: undefined,
          userId: 'dev-user',
          appName: 'devvit-emulator',
          appVersion: '0.0.0',
        })};
        // Proxy so reads always reflect the latest config (e.g. when
        // user switches subreddits mid-session, context.subredditName
        // picks up the new value). Writes throw — context is read-only.
        const context = new Proxy(_ctx, {
          set() { throw new Error('devvit-emulator: context is read-only'); },
        });

        // createServer(options) — delegates to @hono/node-server's
        // createAdaptorServer, which wraps Hono's fetch handler in an
        // http.Server. The user's serve() call (from @hono/node-server)
        // then binds .listen() to the port returned by getServerPort().
        function createServer(options) {
          return createAdaptorServer(options);
        }

        function getServerPort() {
          return ${SERVER_PORT};
        }

        // Stubs for the rest of @devvit/web/server's re-exports — user code
        // doesn't import these today, but having them prevents accidental
        // breakage if a new project pulls in something we missed.
        const cache = { get: async () => null, set: async () => {}, del: async () => {} };
        const media = { upload: async () => ({ mediaUrl: '' }), get: async () => null };
        const notifications = { send: async () => ({ id: '' }), readAll: async () => {} };
        const realtime = { send: () => {}, broadcast: () => {} };
        const scheduler = { run: async () => {}, cancel: () => {} };
        const settings = { get: async () => undefined, set: async () => {} };
        const payments = { fulfillOrder: async () => ({ success: true }), refundOrder: async () => ({ success: true }) };

        export {
          redis,
          reddit,
          context,
          createServer,
          getServerPort,
          cache,
          media,
          notifications,
          realtime,
          scheduler,
          settings,
          payments,
        };
      `,
    };
  }
  return nextLoad(url, context);
}