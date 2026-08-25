/**
 * RedisClientEmulator — Phase 1 full implementation
 *
 * In-memory stand-in for Devvit's RedisClient. Same method signatures as
 * @devvit/redis's RedisClient class (per RedisClient.d.ts).
 *
 * Supports:
 *   - String ops: get, getBuffer, set, exists, del, type, rename, getRange,
 *     setRange, strLen, incrBy, expire, expireTime, mGet, mSet
 *   - Hash ops: hGet, hMGet, hSet, hSetNX, hGetAll, hDel, hScan, hKeys,
 *     hIncrBy, hLen
 *   - Sorted set ops: zAdd, zCard, zRange, zRem, zRemRangeByLex,
 *     zRemRangeByRank, zRemRangeByScore, zScore, zRank, zIncrBy, zScan
 *   - Bitfield: bitfield (basic)
 *   - Transactions: watch + TxClient (queue + exec/discard)
 *   - Scope: INSTALLATION (default) + .global → GLOBAL
 *   - Persistence: optional debounced JSON snapshot to disk
 *
 * Storage shape:
 *   _store: Map<fullKey, { type, value, expiresAt? }>
 *   fullKey = `<scope>:<userKey>`
 *
 * value shapes by type:
 *   'string': string
 *   'hash':   { [field: string]: string }
 *   'zset':   Array<{ member: string, score: number }>
 *
 * Phase 1 deliberately does NOT implement:
 *   - Pub/sub (no pSubscribe/subscribe yet)
 *   - Lists / Sets (only used by advanced patterns)
 *   - Streams
 *   - Lua scripting
 *
 * These are Phase 2+.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCOPE_PREFIX = {
  INSTALLATION: 'installation',
  GLOBAL: 'global',
};

function isExpired(entry) {
  return entry.expiresAt && entry.expiresAt <= Date.now();
}

function globToRegex(glob) {
  if (!glob || glob === '*') return () => true;
  // Translate simple Redis glob (* and ?) to regex
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return (s) => new RegExp(`^${escaped}$`).test(s);
}

export class RedisClientEmulator {
  /**
   * @param {string} scope - 'INSTALLATION' or 'GLOBAL'
   * @param {string|null} persistPath - Optional path to JSON state file
   * @param {Map|null} sharedStore - Optional shared Map for cross-instance state
   *                                 (used so installation + global can share a file)
   */
  constructor(scope = 'INSTALLATION', persistPath = null, sharedStore = null) {
    this.scope = scope;
    this._prefix = SCOPE_PREFIX[scope] || scope.toLowerCase();
    this._store = sharedStore || new Map();
    this._persistPath = persistPath;
    this._persistTimer = null;
    this._dirty = false;
    this._globalInstance = null;
    this._persistHooked = false;

    if (persistPath) {
      this._hydrate(persistPath);
      this._hookExitFlush();
    }
  }

  // ----------------------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------------------

  _hydrate(path) {
    try {
      if (!existsSync(path)) return;
      const raw = readFileSync(path, 'utf8');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const slot = parsed[this._prefix];
      if (slot && typeof slot === 'object') {
        for (const [k, v] of Object.entries(slot)) {
          this._store.set(k, v);
        }
      }
    } catch (e) {
      console.error('[redis-emulator] hydrate failed:', e.message);
    }
  }

  _schedulePersist() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._flushNow(), 50);
  }

  // See RedditAPIClientEmulator._flushNow: an instance that never mutated its
  // slot must not write it back, because a second emulator instance in the
  // same Go Live may own the newer data.
  _flushNow() {
    if (!this._persistPath) return;
    if (!this._dirty) return;
    this._persistTimer = null;
    try {
      let file = {};
      if (existsSync(this._persistPath)) {
        try {
          file = JSON.parse(readFileSync(this._persistPath, 'utf8')) || {};
        } catch {}
      }
      const slot = {};
      for (const [k, v] of this._store.entries()) {
        if (k.startsWith(`${this._prefix}:`)) slot[k] = v;
      }
      file[this._prefix] = slot;
      mkdirSync(dirname(this._persistPath), { recursive: true });
      writeFileSync(this._persistPath, JSON.stringify(file, null, 2));
      this._dirty = false;
    } catch (e) {
      console.error('[redis-emulator] persist failed:', e.message);
    }
  }

  _hookExitFlush() {
    if (this._persistHooked) return;
    this._persistHooked = true;
    const flush = () => {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      this._flushNow();
    };
    process.once('exit', flush);
    // SIGINT/SIGTERM let the process die cleanly; exit hook fires.
  }

  // ----------------------------------------------------------------------
  // Key helpers
  // ----------------------------------------------------------------------

  _key(k) {
    return `${this._prefix}:${k}`;
  }

  _ensureFresh(fullKey) {
    const entry = this._store.get(fullKey);
    if (!entry) return undefined;
    if (isExpired(entry)) {
      this._store.delete(fullKey);
      this._schedulePersist();
      return undefined;
    }
    return entry;
  }

  // ----------------------------------------------------------------------
  // Global scope proxy
  // ----------------------------------------------------------------------

  get global() {
    if (!this._globalInstance) {
      this._globalInstance = new RedisClientEmulator(
        'GLOBAL',
        this._persistPath,
        this._store, // share the underlying Map → one persist file, two scopes
      );
    }
    return this._globalInstance;
  }

  // ----------------------------------------------------------------------
  // String commands
  // ----------------------------------------------------------------------

  async get(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry) return undefined;
    if (entry.type !== 'string') return undefined;
    return entry.value;
  }

  async getBuffer(key) {
    const v = await this.get(key);
    return v === undefined ? undefined : Buffer.from(v, 'utf-8');
  }

  async set(key, value, options) {
    const fullKey = this._key(key);
    if (options?.nx && this._ensureFresh(fullKey)) return 'OK';
    if (options?.xx && !this._ensureFresh(fullKey)) return 'OK';
    this._store.set(fullKey, {
      type: 'string',
      value: String(value),
      expiresAt: options?.expiration ? new Date(options.expiration).getTime() : undefined,
    });
    this._schedulePersist();
    return 'OK';
  }

  async exists(...keys) {
    let n = 0;
    for (const k of keys) {
      if (this._ensureFresh(this._key(k))) n++;
    }
    return n;
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys) {
      if (this._ensureFresh(this._key(k))) {
        this._store.delete(this._key(k));
        n++;
      }
    }
    if (n) this._schedulePersist();
    return n;
  }

  async type(key) {
    const entry = this._ensureFresh(this._key(key));
    return entry ? entry.type : 'none';
  }

  async rename(key, newKey) {
    const src = this._key(key);
    const dst = this._key(newKey);
    const entry = this._ensureFresh(src);
    if (!entry) return undefined;
    this._store.set(dst, entry);
    this._store.delete(src);
    this._schedulePersist();
    return 'OK';
  }

  async getRange(key, start, end) {
    const v = await this.get(key);
    if (v === undefined) return '';
    // Redis getrange semantics: negative offsets count from end.
    const len = v.length;
    const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e = end < 0 ? len + end + 1 : Math.min(end + 1, len);
    return v.slice(s, e);
  }

  async setRange(key, offset, value) {
    const fullKey = this._key(key);
    const existing = (await this.get(key)) ?? '';
    // Pad to offset, then splice the new value in place. Strip ANY NULs that
    // were padding (not part of the value) from the final string.
    const padded = existing.padEnd(offset, '\0');
    const arr = padded.split('');
    for (let i = 0; i < value.length; i++) {
      arr[offset + i] = value[i];
    }
    const next = arr.join('').replace(/\0/g, '');
    this._store.set(fullKey, { type: 'string', value: next });
    this._schedulePersist();
    return next.length;
  }

  async strLen(key) {
    const v = await this.get(key);
    return v === undefined ? 0 : v.length;
  }

  async incrBy(key, value) {
    const fullKey = this._key(key);
    const entry = this._ensureFresh(fullKey);
    const current = entry && entry.type === 'string' ? Number(entry.value) : 0;
    const next = current + value;
    this._store.set(fullKey, { type: 'string', value: String(next) });
    this._schedulePersist();
    return next;
  }

  async expire(key, seconds) {
    const fullKey = this._key(key);
    const entry = this._ensureFresh(fullKey);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    this._schedulePersist();
    return 1;
  }

  async expireTime(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || !entry.expiresAt) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async mGet(keys) {
    const out = [];
    for (const k of keys) {
      const v = await this.get(k);
      out.push(v === undefined ? null : v);
    }
    return out;
  }

  async mSet(keyValues) {
    for (const [k, v] of Object.entries(keyValues)) {
      await this.set(k, v);
    }
  }

  // ----------------------------------------------------------------------
  // Hash commands
  // ----------------------------------------------------------------------

  async hGet(key, field) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'hash') return undefined;
    return entry.value[field];
  }

  async hMGet(key, fields) {
    const entry = this._ensureFresh(this._key(key));
    const out = [];
    if (!entry || entry.type !== 'hash') {
      for (let i = 0; i < fields.length; i++) out.push(null);
      return out;
    }
    for (const f of fields) out.push(f in entry.value ? entry.value[f] : null);
    return out;
  }

  async hSet(key, fieldValues) {
    const fullKey = this._key(key);
    const existing = this._ensureFresh(fullKey);
    const hash = existing && existing.type === 'hash' ? { ...existing.value } : {};
    let added = 0;
    for (const [f, v] of Object.entries(fieldValues)) {
      if (!(f in hash)) added++;
      hash[f] = String(v);
    }
    this._store.set(fullKey, { type: 'hash', value: hash });
    this._schedulePersist();
    return added;
  }

  async hSetNX(key, field, value) {
    const fullKey = this._key(key);
    const existing = this._ensureFresh(fullKey);
    const hash = existing && existing.type === 'hash' ? existing.value : null;
    if (hash && field in hash) return 0;
    const next = hash ? { ...hash } : {};
    next[field] = String(value);
    this._store.set(fullKey, { type: 'hash', value: next });
    this._schedulePersist();
    return 1;
  }

  async hGetAll(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'hash') return {};
    return { ...entry.value };
  }

  async hDel(key, fields) {
    const fullKey = this._key(key);
    const entry = this._ensureFresh(fullKey);
    if (!entry || entry.type !== 'hash') return 0;
    let removed = 0;
    for (const f of fields) {
      if (f in entry.value) {
        delete entry.value[f];
        removed++;
      }
    }
    if (Object.keys(entry.value).length === 0) this._store.delete(fullKey);
    else this._store.set(fullKey, entry);
    if (removed) this._schedulePersist();
    return removed;
  }

  async hScan(key, cursor, pattern, count) {
    const entry = this._ensureFresh(this._key(key));
    const fields = entry && entry.type === 'hash' ? Object.keys(entry.value) : [];
    const matcher = globToRegex(pattern);
    const matched = fields.filter(matcher);
    // Phase 1: single-shot (cursor 0 → all results, then cursor 0 again).
    // Real Redis uses iterative cursor pagination; we approximate it.
    const fieldValues = matched.map((f) => ({ field: f, value: entry.value[f] }));
    return { cursor: 0, fieldValues };
  }

  async hKeys(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'hash') return [];
    return Object.keys(entry.value);
  }

  async hIncrBy(key, field, value) {
    const fullKey = this._key(key);
    const existing = this._ensureFresh(fullKey);
    const hash = existing && existing.type === 'hash' ? { ...existing.value } : {};
    const current = field in hash ? Number(hash[field]) : 0;
    const next = current + value;
    hash[field] = String(next);
    this._store.set(fullKey, { type: 'hash', value: hash });
    this._schedulePersist();
    return next;
  }

  async hLen(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'hash') return 0;
    return Object.keys(entry.value).length;
  }

  // ----------------------------------------------------------------------
  // Sorted set commands
  // ----------------------------------------------------------------------

  _sortedSet(entry) {
    if (!entry || entry.type !== 'zset') return [];
    return [...entry.value].sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }

  async zAdd(key, ...members) {
    const fullKey = this._key(key);
    const existing = this._ensureFresh(fullKey);
    const arr = existing && existing.type === 'zset' ? [...existing.value] : [];
    let added = 0;
    for (const m of members) {
      const memberStr = typeof m === 'object' ? m.member : m;
      const score = typeof m === 'object' ? m.score : 0;
      const idx = arr.findIndex((x) => x.member === memberStr);
      if (idx === -1) {
        arr.push({ member: memberStr, score });
        added++;
      } else {
        arr[idx] = { member: memberStr, score };
      }
    }
    this._store.set(fullKey, { type: 'zset', value: arr });
    this._schedulePersist();
    return added;
  }

  async zCard(key) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return 0;
    return entry.value.length;
  }

  async zRange(key, start, stop, options) {
    const entry = this._ensureFresh(this._key(key));
    const sorted = this._sortedSet(entry);
    if (options?.reverse) sorted.reverse();
    const len = sorted.length;
    const s = typeof start === 'string' ? parseInt(start, 10) : start;
    const e = typeof stop === 'string' ? parseInt(stop, 10) : stop;
    const normStart = s < 0 ? Math.max(len + s, 0) : s;
    const normEnd = e < 0 ? len + e : Math.min(e, len - 1);
    return sorted.slice(normStart, normEnd + 1).map((x) => ({ member: x.member, score: x.score }));
  }

  async zRem(key, members) {
    const fullKey = this._key(key);
    const entry = this._ensureFresh(fullKey);
    if (!entry || entry.type !== 'zset') return 0;
    const memberSet = new Set(members);
    const before = entry.value.length;
    entry.value = entry.value.filter((x) => !memberSet.has(x.member));
    const removed = before - entry.value.length;
    if (entry.value.length === 0) this._store.delete(fullKey);
    else this._store.set(fullKey, entry);
    if (removed) this._schedulePersist();
    return removed;
  }

  async zRemRangeByLex(key, min, max) {
    // Simplified: assume standard lexicographic range with [ or ( prefix
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return 0;
    const minInclusive = min.startsWith('[');
    const maxInclusive = max.startsWith('[');
    const minStr = min.slice(1);
    const maxStr = max.slice(1);
    const before = entry.value.length;
    entry.value = entry.value.filter((x) => {
      const aboveMin = minInclusive ? x.member >= minStr : x.member > minStr;
      const belowMax = maxInclusive ? x.member <= maxStr : x.member < maxStr;
      return !(aboveMin && belowMax);
    });
    const removed = before - entry.value.length;
    if (entry.value.length === 0) this._store.delete(fullKey);
    else this._store.set(fullKey, entry);
    if (removed) this._schedulePersist();
    return removed;
  }

  async zRemRangeByRank(key, start, stop) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return 0;
    const sorted = this._sortedSet(entry);
    const len = sorted.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    const toRemove = new Set(sorted.slice(s, e + 1).map((x) => x.member));
    const before = entry.value.length;
    entry.value = entry.value.filter((x) => !toRemove.has(x.member));
    const removed = before - entry.value.length;
    if (entry.value.length === 0) this._store.delete(fullKey);
    else this._store.set(fullKey, entry);
    if (removed) this._schedulePersist();
    return removed;
  }

  async zRemRangeByScore(key, min, max) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return 0;
    const before = entry.value.length;
    entry.value = entry.value.filter((x) => x.score >= min && x.score <= max);
    const removed = before - entry.value.length;
    if (entry.value.length === 0) this._store.delete(fullKey);
    else this._store.set(fullKey, entry);
    if (removed) this._schedulePersist();
    return removed;
  }

  async zScore(key, member) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return undefined;
    const found = entry.value.find((x) => x.member === member);
    return found ? found.score : undefined;
  }

  async zRank(key, member) {
    const entry = this._ensureFresh(this._key(key));
    if (!entry || entry.type !== 'zset') return undefined;
    const sorted = this._sortedSet(entry);
    const idx = sorted.findIndex((x) => x.member === member);
    return idx === -1 ? undefined : idx;
  }

  async zIncrBy(key, member, value) {
    const fullKey = this._key(key);
    const existing = this._ensureFresh(fullKey);
    const arr = existing && existing.type === 'zset' ? [...existing.value] : [];
    const idx = arr.findIndex((x) => x.member === member);
    if (idx === -1) {
      arr.push({ member, score: value });
    } else {
      arr[idx] = { member, score: arr[idx].score + value };
    }
    this._store.set(fullKey, { type: 'zset', value: arr });
    this._schedulePersist();
    return arr.find((x) => x.member === member).score;
  }

  async zScan(key, cursor, pattern, count) {
    const entry = this._ensureFresh(this._key(key));
    const sorted = this._sortedSet(entry);
    const matcher = globToRegex(pattern);
    const matched = sorted.filter((x) => matcher(x.member));
    return { cursor: 0, members: matched };
  }

  // ----------------------------------------------------------------------
  // Bitfield (basic — supports get/set/incrBy/overflow for u/i encodings)
  // ----------------------------------------------------------------------

  async bitfield(key, ...cmds) {
    // cmds is a flat array: ['set', 'u8', 0, 5, 'get', 'u8', 0, ...]
    const fullKey = this._key(key);
    let bits = '';
    const existing = await this.get(key);
    if (existing) bits = existing;
    const results = [];
    let i = 0;
    let overflowMode = 'wrap';
    while (i < cmds.length) {
      const op = cmds[i++];
      if (op === 'overflow') {
        overflowMode = cmds[i++];
        continue;
      }
      const encoding = cmds[i++];
      const offsetRaw = cmds[i++];
      const m = /^([ui])(\d+)$/.exec(encoding);
      if (!m) throw new Error(`[redis-emulator] bitfield unsupported encoding: ${encoding}`);
      const signed = m[1] === 'i';
      const width = parseInt(m[2], 10);
      const isMultiplicative = typeof offsetRaw === 'string' && offsetRaw.startsWith('#');
      const offset = (isMultiplicative ? parseInt(offsetRaw.slice(1), 10) : parseInt(offsetRaw, 10)) * width;
      if (op === 'get') {
        results.push(this._bitfieldGet(bits, offset, width, signed));
      } else if (op === 'set') {
        const value = Number(cmds[i++]);
        const old = this._bitfieldGet(bits, offset, width, signed);
        bits = this._bitfieldSet(bits, offset, width, value, signed, overflowMode);
        results.push(old);
      } else if (op === 'incrBy') {
        const value = Number(cmds[i++]);
        const old = this._bitfieldGet(bits, offset, width, signed);
        const next = this._bitfieldOverflow(old + value, width, signed, overflowMode);
        bits = this._bitfieldSet(bits, offset, width, next, signed, overflowMode);
        results.push(next);
      } else {
        throw new Error(`[redis-emulator] bitfield unsupported op: ${op}`);
      }
    }
    if (bits) this._store.set(fullKey, { type: 'string', value: bits });
    else this._store.delete(fullKey);
    this._schedulePersist();
    return results;
  }

  _bitfieldGet(bits, offset, width, signed) {
    let value = 0;
    for (let i = 0; i < width; i++) {
      const byteIdx = Math.floor((offset + i) / 8);
      const bitIdx = 7 - ((offset + i) % 8);
      const ch = bits[byteIdx];
      const bit = ch ? ch.charCodeAt(0) : 0;
      value = (value << 1) | ((bit >> bitIdx) & 1);
    }
    if (signed && width < 32) {
      const signBit = 1 << (width - 1);
      if (value & signBit) value -= 1 << width;
    }
    return value;
  }

  _bitfieldSet(bits, offset, width, value, signed, overflowMode) {
    // Apply overflow clamping
    const max = signed ? (1 << (width - 1)) - 1 : (1 << width) - 1;
    const min = signed ? -(1 << (width - 1)) : 0;
    let clamped = value;
    if (overflowMode === 'sat') {
      clamped = Math.max(min, Math.min(max, value));
    } else if (overflowMode === 'fail') {
      // Phase 1: silently wrap on fail (no exception).
      clamped = value;
    }
    // wrap is default; no-op

    const arr = bits.split('');
    const needed = Math.ceil((offset + width) / 8);
    while (arr.length < needed) arr.push('\0');
    for (let i = 0; i < width; i++) {
      const bitVal = (clamped >> (width - 1 - i)) & 1;
      const byteIdx = Math.floor((offset + i) / 8);
      const bitIdx = 7 - ((offset + i) % 8);
      const ch = arr[byteIdx];
      const code = ch ? ch.charCodeAt(0) : 0;
      const next = (code & ~(1 << bitIdx)) | (bitVal << bitIdx);
      arr[byteIdx] = String.fromCharCode(next & 0xff);
    }
    return arr.join('').replace(/\0+$/, '');
  }

  _bitfieldOverflow(value, width, signed, mode) {
    const max = signed ? (1 << (width - 1)) - 1 : (1 << width) - 1;
    const min = signed ? -(1 << (width - 1)) : 0;
    if (mode === 'sat') return Math.max(min, Math.min(max, value));
    if (mode === 'fail') return value; // Phase 1: no exception
    // wrap: modulo arithmetic
    const range = (1 << width);
    let wrapped = value % range;
    if (wrapped < 0) wrapped += range;
    if (signed && wrapped >= (1 << (width - 1))) wrapped -= range;
    return wrapped;
  }

  // ----------------------------------------------------------------------
  // Transactions — watch() returns a TxClient
  // ----------------------------------------------------------------------

  async watch(...keys) {
    const watched = new Set(keys.map((k) => this._key(k)));
    return new TxClientEmulator(this, watched);
  }

  // ----------------------------------------------------------------------
  // Debug / introspection — not part of the RedisClient API
  // ----------------------------------------------------------------------

  _dump() {
    const out = {};
    for (const [k, v] of this._store.entries()) {
      if (k.startsWith(`${this._prefix}:`)) out[k] = v;
    }
    return out;
  }

  _clear() {
    const prefix = `${this._prefix}:`;
    for (const k of [...this._store.keys()]) {
      if (k.startsWith(prefix)) this._store.delete(k);
    }
    this._schedulePersist();
  }
}

/**
 * TxClientEmulator — basic transaction queue
 *
 * Phase 1: collects operations, executes them sequentially on exec().
 * Does NOT implement WATCH semantics (no rollback if watched keys change).
 * Real Devvit uses gRPC transactions; this is a sufficient stand-in for
 * games that don't rely on optimistic concurrency.
 */
export class TxClientEmulator {
  constructor(client, watchedKeys = new Set()) {
    this._client = client;
    this._watched = watchedKeys;
    this._queue = [];
    this._started = false;
  }

  async multi() {
    this._started = true;
  }

  async get(key) {
    if (!this._started) {
      // No MULTI: execute immediately and return value
      return await this._client.get(key);
    }
    this._queue.push(() => this._client.get(key));
    return this;
  }

  async getBuffer(key) {
    if (!this._started) return await this._client.getBuffer(key);
    this._queue.push(() => this._client.getBuffer(key));
    return this;
  }

  async set(key, value, options) {
    if (!this._started) return await this._client.set(key, value, options);
    this._queue.push(() => this._client.set(key, value, options));
    return this;
  }

  async del(...keys) {
    if (!this._started) return await this._client.del(...keys);
    this._queue.push(() => this._client.del(...keys));
    return this;
  }

  async exists(...keys) {
    if (!this._started) return await this._client.exists(...keys);
    this._queue.push(() => this._client.exists(...keys));
    return this;
  }

  async type(key) {
    if (!this._started) return await this._client.type(key);
    this._queue.push(() => this._client.type(key));
    return this;
  }

  async rename(key, newKey) {
    if (!this._started) return await this._client.rename(key, newKey);
    this._queue.push(() => this._client.rename(key, newKey));
    return this;
  }

  async getRange(key, start, end) {
    if (!this._started) return await this._client.getRange(key, start, end);
    this._queue.push(() => this._client.getRange(key, start, end));
    return this;
  }

  async setRange(key, offset, value) {
    if (!this._started) return await this._client.setRange(key, offset, value);
    this._queue.push(() => this._client.setRange(key, offset, value));
    return this;
  }

  async strLen(key) {
    if (!this._started) return await this._client.strLen(key);
    this._queue.push(() => this._client.strLen(key));
    return this;
  }

  async incrBy(key, value) {
    if (!this._started) return await this._client.incrBy(key, value);
    this._queue.push(() => this._client.incrBy(key, value));
    return this;
  }

  async mGet(keys) {
    if (!this._started) return await this._client.mGet(keys);
    this._queue.push(() => this._client.mGet(keys));
    return this;
  }

  async mSet(keyValues) {
    if (!this._started) return await this._client.mSet(keyValues);
    this._queue.push(() => this._client.mSet(keyValues));
    return this;
  }

  async expire(key, seconds) {
    if (!this._started) return await this._client.expire(key, seconds);
    this._queue.push(() => this._client.expire(key, seconds));
    return this;
  }

  async expireTime(key) {
    if (!this._started) return await this._client.expireTime(key);
    this._queue.push(() => this._client.expireTime(key));
    return this;
  }

  // Hash ops on TxClient
  async hGet(key, field) {
    if (!this._started) return await this._client.hGet(key, field);
    this._queue.push(() => this._client.hGet(key, field));
    return this;
  }

  async hMGet(key, fields) {
    if (!this._started) return await this._client.hMGet(key, fields);
    this._queue.push(() => this._client.hMGet(key, fields));
    return this;
  }

  async hSet(key, fieldValues) {
    if (!this._started) return await this._client.hSet(key, fieldValues);
    this._queue.push(() => this._client.hSet(key, fieldValues));
    return this;
  }

  async hSetNX(key, field, value) {
    if (!this._started) return await this._client.hSetNX(key, field, value);
    this._queue.push(() => this._client.hSetNX(key, field, value));
    return this;
  }

  async hGetAll(key) {
    if (!this._started) return await this._client.hGetAll(key);
    this._queue.push(() => this._client.hGetAll(key));
    return this;
  }

  async hDel(key, fields) {
    if (!this._started) return await this._client.hDel(key, fields);
    this._queue.push(() => this._client.hDel(key, fields));
    return this;
  }

  async hScan(key, cursor, pattern, count) {
    if (!this._started) return await this._client.hScan(key, cursor, pattern, count);
    this._queue.push(() => this._client.hScan(key, cursor, pattern, count));
    return this;
  }

  async hKeys(key) {
    if (!this._started) return await this._client.hKeys(key);
    this._queue.push(() => this._client.hKeys(key));
    return this;
  }

  async hIncrBy(key, field, value) {
    if (!this._started) return await this._client.hIncrBy(key, field, value);
    this._queue.push(() => this._client.hIncrBy(key, field, value));
    return this;
  }

  async hLen(key) {
    if (!this._started) return await this._client.hLen(key);
    this._queue.push(() => this._client.hLen(key));
    return this;
  }

  // Sorted set ops on TxClient
  async zAdd(key, ...members) {
    if (!this._started) return await this._client.zAdd(key, ...members);
    this._queue.push(() => this._client.zAdd(key, ...members));
    return this;
  }

  async zCard(key) {
    if (!this._started) return await this._client.zCard(key);
    this._queue.push(() => this._client.zCard(key));
    return this;
  }

  async zRange(key, start, stop, options) {
    if (!this._started) return await this._client.zRange(key, start, stop, options);
    this._queue.push(() => this._client.zRange(key, start, stop, options));
    return this;
  }

  async zRem(key, members) {
    if (!this._started) return await this._client.zRem(key, members);
    this._queue.push(() => this._client.zRem(key, members));
    return this;
  }

  async zRemRangeByLex(key, min, max) {
    if (!this._started) return await this._client.zRemRangeByLex(key, min, max);
    this._queue.push(() => this._client.zRemRangeByLex(key, min, max));
    return this;
  }

  async zRemRangeByRank(key, start, stop) {
    if (!this._started) return await this._client.zRemRangeByRank(key, start, stop);
    this._queue.push(() => this._client.zRemRangeByRank(key, start, stop));
    return this;
  }

  async zRemRangeByScore(key, min, max) {
    if (!this._started) return await this._client.zRemRangeByScore(key, min, max);
    this._queue.push(() => this._client.zRemRangeByScore(key, min, max));
    return this;
  }

  async zScore(key, member) {
    if (!this._started) return await this._client.zScore(key, member);
    this._queue.push(() => this._client.zScore(key, member));
    return this;
  }

  async zRank(key, member) {
    if (!this._started) return await this._client.zRank(key, member);
    this._queue.push(() => this._client.zRank(key, member));
    return this;
  }

  async zIncrBy(key, member, value) {
    if (!this._started) return await this._client.zIncrBy(key, member, value);
    this._queue.push(() => this._client.zIncrBy(key, member, value));
    return this;
  }

  async zScan(key, cursor, pattern, count) {
    if (!this._started) return await this._client.zScan(key, cursor, pattern, count);
    this._queue.push(() => this._client.zScan(key, cursor, pattern, count));
    return this;
  }

  async watch(...keys) {
    for (const k of keys) this._watched.add(this._client._key(k));
    return this;
  }

  async unwatch() {
    this._watched.clear();
    return this;
  }

  async exec() {
    const results = [];
    for (const op of this._queue) {
      results.push(await op());
    }
    this._queue = [];
    this._started = false;
    return results;
  }

  async discard() {
    this._queue = [];
    this._started = false;
    this._watched.clear();
  }
}