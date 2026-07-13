/**
 * Devvit Emulator loader — entry point
 *
 * Node.js loader hook that intercepts @devvit/redis, @devvit/public-api,
 * and @devvit/web/server imports and returns synthesized modules backed
 * by the in-memory emulators. Also resolves extension-less .ts relative
 * imports for the user's TypeScript server code.
 *
 * Run via:
 *   NODE_OPTIONS='--import ./loader.mjs' node script.js
 *
 * Architecture: synthesize the module on the fly with the module.register()
 * API. User code does `import { redis } from '@devvit/redis'` and gets our
 * emulator. The `import.meta.url`-based path ensures the hook resolves
 * regardless of cwd (Jul 10 fix).
 *
 * NOTE: module.register() is deprecated in Node 22+ (use registerHooks()
 * instead), but registerHooks() triggered a Maximum call stack size
 * exceeded error in our case. Keeping register() until the loader pipeline
 * settles. Jul 10.
 *
 * Phase 1: persists state to DEVVIT_EMULATOR_STATE (if set) on writes,
 * hydrates on construction. Reads seed users/subreddits from
 * DEVVIT_EMULATOR_CONFIG (if set).
 */

import { register } from 'node:module';

register(new URL('./emulator-hook.mjs', import.meta.url));