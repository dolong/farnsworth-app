# Devvit emulator (Phase 1)

In-memory stand-in for `@devvit/redis` and `@devvit/public-api` so a Devvit
app runs locally with **no playtest, no Reddit auth, no deployment**. Farnsworth
injects this loader hook into the user's `scripts.dev` subprocess via
`NODE_OPTIONS=--import` whenever the open workspace has a `package.json`
with a `farnsworth:devvit` script.

The hook intercepts the two package imports and returns synthesized modules
backed by in-memory emulators. Templates stay clean — they never import this
code.

## Architecture

```
src/server/...
       │
       │  import { redis } from '@devvit/redis'
       │  import { reddit } from '@devvit/public-api'
       ▼
[ Node.js module loader hook ]  ←  devvit-emulator/emulator-hook.mjs
       │
       ▼
[ Synthesized ESM module ]  ←  import { RedisClientEmulator } from './RedisClientEmulator.mjs'
       │
       ▼
[ In-memory store + persistence ]
```

The user's Devvit code runs unchanged. The hook fires before the real
`@devvit/*` packages resolve, so `import { redis } from '@devvit/redis'`
returns our emulator instance.

## Files

| File | Purpose |
|------|---------|
| `loader.mjs` | Entry point. `register(new URL('./emulator-hook.mjs'))` from `node:module`. |
| `emulator-hook.mjs` | Resolve + load hooks that intercept `@devvit/redis` and `@devvit/public-api`. Synthesizes the module source with seed data + state path inlined. |
| `RedisClientEmulator.mjs` | Full `RedisClient` API (strings + hashes + sorted sets + bitfield + transactions + global scope). ~75 methods including TxClient. |
| `RedditAPIClientEmulator.mjs` | Tier 1 (user/subreddit) + Tier 2 (posts/comments/flairs/subreddit actions + GraphQL stub). |
| `test.mjs` | 49-check verification harness covering every method class. |

## Environment variables (set by Farnsworth's `dev:farnsworth:boot` IPC)

| Var | Purpose |
|-----|---------|
| `DEVVIT_EMULATOR_CONFIG` | Path to JSON file with seed users/subreddits/current identity. Written by Farnsworth from SQLite user library. |
| `DEVVIT_EMULATOR_STATE` | Path to JSON file for emulator-internal state (Redis store + Reddit posts/comments/flairs). Hydrated on boot, written-back debounced. Survives dev server restarts so the game doesn't reset between code reloads. |
| `NODE_OPTIONS` | `--import <path-to-loader.mjs>` so the hook fires on subprocess startup. |
| `VITE_DEVVIT_EMULATOR_CONFIG_JSON` | Same data as `DEVVIT_EMULATOR_CONFIG` but inlined as JSON so Vite can substitute it at build time for the client-side shim. |

## Phase 1 scope

✅ **All `RedisClient` methods** — strings (15), hashes (10), sorted sets (11), bitfield, transactions, global scope.
✅ **Tier 1 Reddit** — `getCurrentUser`/`getCurrentUsername`/`getCurrentSubreddit`/`getUserByUsername`/`getUserById`/`getAppUser`/`getSnoovatarUrl`/`getSubredditByName/Id`.
✅ **Tier 2 Reddit** — `submitPost`/`submitComment`/`submitCustomPost`/`getPostById`/`getPostsByUser`/`getCommentsByUser`/`getComments`/`getCommentById`/`setUserFlair`/`removeUserFlair`/`getNewPosts`/`getHotPosts`/`getTopPosts`/`getControversialPosts`/`getRisingPosts`/`getWikiPage`/`getWikiPages`/`getApprovedUsers`/`getBannedUsers`/`getModerators`/`query` (GraphQL stub).
✅ **Persistence** — debounced JSON snapshot to `~/.cache/farnsworth-devvit-<hash>-state.json`. Hydrated on boot.
✅ **Verification** — 49/49 unit tests pass + persistence round-trip verified across processes.

## Phase 1 limitations (deferred to Phase 2+)

❌ **Lists** (`LPUSH`/`LPOP`/`LRANGE`/etc.). Not used by the-last-draft. Phase 2 if a game needs them.
❌ **Sets** (`SADD`/`SMEMBERS`/etc.). Same.
❌ **Streams** (`XADD`/`XRANGE`/etc.). Uncommon.
❌ **Pub/sub** (`SUBSCRIBE`/`PUBLISH`). No Devvit app uses this for production state.
❌ **Lua scripting** (`EVAL`/`EVALSHA`). Uncommon.
❌ **Full Reddit Tier 3** — mod actions (`getModerationLog`, `getModNotes`, `addModNote`), modmail, wiki revisions, widgets, vault, leaderboard.
❌ **GraphQL `query`** — Phase 1 returns empty `data` + error. The-the-last-draft doesn't use it.
❌ **Mod queue, spam queue, reports queue** (`getModQueue`/`getSpam`/`getReports`/`getUnmoderated`/`getEdited`).
❌ **`devvit-shim.ts` client-side integration** — already shipped Jul 4 (`import.meta.env.VITE_DEVVIT_EMULATOR_CONFIG_JSON`). Works.

## Verification

Run the test harness:

```bash
cd /tmp/devvit-emulator-test
DEVVIT_EMULATOR_CONFIG=/path/to/config.json \
DEVVIT_EMULATOR_STATE=/path/to/state.json \
NODE_OPTIONS='--import /path/to/loader.mjs' \
node test.mjs
```

Should print `49 passed, 0 failed`. Run it twice in a row to verify persistence:
the second run sees the values written by the first run.

## Future work

- **Phase 2 (Tier 2 Reddit completion)**: Mod actions, modmail, wiki, widgets, vault, leaderboard. Adds ~30 methods.
- **Phase 3 (Redis extensions)**: Lists, sets, streams, pub/sub, Lua scripting. Only if a real game needs them.
- **Phase 4 (Cloud Pro integration)**: Same code runs in a Cloud Pro sandbox per workspace. State file becomes cloud storage. The loader hook is the only thing that differs (sandbox-injected config vs. Farnsworth-injected env vars).

## Caveats

- `module.register()` is deprecated in Node 26 — use `module.registerHooks()` instead. Phase 2 migration. The deprecation warning fires but the hook works.
- The `setRange` padding logic strips NULs — Redis semantics are "pad with zero bytes" but our representation doesn't store them. Acceptable for games that don't rely on bit-level string manipulation.
- Bitfield encoding is full-featured for `u`/`i` 1-64 widths. The `fail` overflow mode silently wraps (no exception) — the Phase 1 simplification.
- Sorted set lex range parsing is simplified; complex lex queries (`[a (z`) work but the `(score` and `[score` variants of `zRemRangeByScore` are not implemented (game doesn't use them).