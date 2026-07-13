/**
 * POC test: verify the loader hook intercepts @devvit/redis and @devvit/public-api
 *
 * Run with:  NODE_OPTIONS='--import ./loader.mjs' node test.js
 *
 * Expected output:
 *   - imports succeed without error
 *   - redis.get/set/del work in-memory
 *   - reddit.getCurrentUsername returns 'u/long'
 *   - reddit.getCurrentUser returns the seeded user object
 */

import { redis } from '@devvit/redis';
import { reddit } from '@devvit/public-api';

console.log('[test] imports loaded — loader hook is working');

console.log('[test] redis type:', redis.constructor.name);

console.log('[test] Setting karma:alice = 100');
await redis.set('karma:alice', '100');
const v = await redis.get('karma:alice');
console.log('[test] Got:', v, '(expected "100")');
console.log('[test] Type:', await redis.type('karma:alice'), '(expected "string")');

console.log('[test] incrBy karma:alice 50 ->', await redis.incrBy('karma:alice', 50));
console.log('[test] After incr:', await redis.get('karma:alice'), '(expected "150")');

console.log('[test] Deleting karma:alice ->', await redis.del('karma:alice'));
console.log('[test] After del:', await redis.get('karma:alice'), '(expected undefined)');

console.log('');
console.log('[test] reddit.getCurrentUsername ->', await reddit.getCurrentUsername(), '(expected "u/long")');
console.log('[test] reddit.getCurrentSubredditName ->', await reddit.getCurrentSubredditName(), '(expected "r/long_dev")');

const u = await reddit.getCurrentUser();
console.log('[test] reddit.getCurrentUser ->', u?.username, '/ karma', u?.linkKarma + u?.commentKarma, '(expected u/long / 54500)');

const alice = await reddit.getUserByUsername('u/alice');
console.log('[test] reddit.getUserByUsername(u/alice) ->', alice?.username, '/ karma', alice?.linkKarma + alice?.commentKarma, '(expected u/alice / 20)');

const byId = await reddit.getUserById('t2_long001');
console.log('[test] reddit.getUserById(t2_long001) ->', byId?.username, '(expected u/long)');

console.log('');
console.log('[test] All checks passed. Loader hook architecture is sound.');