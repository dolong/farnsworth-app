/**
 * dev-live-registry.js: who owns which Go Live dev server (Oct 27 2026).
 *
 * Long's requirement: 2+ Farnsworth windows/instances running Go Live at the
 * same time. Every window picks free ports from one shared registry (the
 * dev_port_leases table in the shared SQLite DB), records the processes it
 * started, and those processes die with the window:
 *
 *   - window closes            -> killOwner(winId)
 *   - Farnsworth launches      -> reapDeadOwners() + sweepOrphans()
 *   - every 30s while running  -> reapDeadOwners() (another instance crashed,
 *                                 or one of our own windows vanished)
 *
 * Why tree kills: the project script starts `npm run dev:tools` with nohup,
 * so the pid it records is the npm wrapper. Killing only that pid (what
 * Farnsworth did before) orphaned the real Vite child, which then squatted
 * port 5174 for days and broke the next project's Go Live.
 */

'use strict';

const { execFileSync } = require('child_process');

// Harness processes Farnsworth is responsible for. Deliberately narrow:
// storybooks, the-last-draft's story Vite, and anything the user runs by hand
// with another config never match.
const HARNESS_RE = /(server-runner\.mjs|node_modules\/\.bin\/vite(\.js)? --config vite\.(devtools|farnsworth)\.config\.ts)/;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_port_leases (
      port      INTEGER PRIMARY KEY,
      repo_root TEXT NOT NULL,
      role      TEXT NOT NULL CHECK (role IN ('vite', 'server', 'devvit-watcher')),
      pid       INTEGER,
      instance  TEXT NOT NULL,
      leased_at INTEGER NOT NULL
    );
  `);
  const cols = new Set(db.prepare('PRAGMA table_info(dev_port_leases)').all().map((c) => c.name));
  if (!cols.has('window_id')) db.exec('ALTER TABLE dev_port_leases ADD COLUMN window_id INTEGER');
  if (!cols.has('child_pids')) db.exec('ALTER TABLE dev_port_leases ADD COLUMN child_pids TEXT');
}

function processTable() {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024,
    });
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], command: m[4] });
    }
    return rows;
  } catch {
    return [];
  }
}

// ps etime: [[dd-]hh:]mm:ss
function etimeSeconds(etime) {
  const m = String(etime || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}

function descendants(rootPids, table) {
  const kids = new Map();
  for (const r of table) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const seen = new Set();
  const stack = rootPids.filter((p) => Number.isInteger(p) && p > 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const k of kids.get(p) || []) stack.push(k);
  }
  return seen;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * Kill pids and everything below them. Synchronous on purpose so it also
 * works from before-quit and window 'closed'. SIGTERM first so the
 * server-runner can flush its debounced emulator state, then SIGKILL.
 */
function killTree(pids, { label = 'dev-live', graceMs = 600 } = {}) {
  const roots = (Array.isArray(pids) ? pids : [pids]).map(Number).filter((p) => p > 1 && p !== process.pid);
  if (!roots.length) return [];
  const table = processTable();
  const all = [...descendants(roots, table)].filter((p) => p !== process.pid);
  for (const p of all) { try { process.kill(p, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && all.some(alive)) sleepSync(50);
  for (const p of all) { if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} } }
  if (all.length) console.log(`[${label}] killed process tree ${all.join(',')}`);
  return all;
}

function isFarnsworthPid(pid, table) {
  if (!alive(pid)) return false;
  const row = (table || processTable()).find((r) => r.pid === pid);
  // Unknown command (ps failed) = assume alive rather than kill a live owner.
  if (!row) return true;
  return /Farnsworth|[Ee]lectron/.test(row.command);
}

function parsePids(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.map(Number).filter((p) => p > 1) : []; }
  catch { return []; }
}

/** Record the processes a window's Go Live started on its leases. */
function setOwnerPids(db, { ownerPid = process.pid, windowId, repoRoot, pids }) {
  ensureSchema(db);
  db.prepare('UPDATE dev_port_leases SET child_pids = ? WHERE pid = ? AND window_id = ? AND repo_root = ?')
    .run(JSON.stringify((pids || []).filter(Boolean)), ownerPid, windowId, repoRoot);
}

/** Kill and release everything a window owns. Returns the killed pids. */
function killOwner(db, { ownerPid = process.pid, windowId, reason = 'stop' }) {
  ensureSchema(db);
  const rows = db.prepare('SELECT port, child_pids FROM dev_port_leases WHERE pid = ? AND window_id = ?').all(ownerPid, windowId);
  const pids = [...new Set(rows.flatMap((r) => parsePids(r.child_pids)))];
  const killed = pids.length ? killTree(pids, { label: `dev-live ${reason} win${windowId}` }) : [];
  db.prepare('DELETE FROM dev_port_leases WHERE pid = ? AND window_id = ?').run(ownerPid, windowId);
  return killed;
}

/**
 * Leases whose owner is gone: another Farnsworth process that died, or (for
 * our own process) a window id that no longer exists. Kill their processes,
 * free their ports.
 */
function reapDeadOwners(db, { liveWindowIds = null } = {}) {
  ensureSchema(db);
  const rows = db.prepare('SELECT port, repo_root, pid, window_id, child_pids FROM dev_port_leases').all();
  if (!rows.length) return 0;
  const table = processTable();
  const dead = rows.filter((r) => {
    if (r.pid === process.pid) {
      return liveWindowIds && r.window_id != null && !liveWindowIds.has(r.window_id);
    }
    return !isFarnsworthPid(r.pid, table);
  });
  if (!dead.length) return 0;
  const pids = [...new Set(dead.flatMap((r) => parsePids(r.child_pids)))]
    // Pid reuse guard: only kill what still looks like a harness / npm / node.
    .filter((p) => {
      const row = table.find((t) => t.pid === p);
      return row && /(node|npm|vite|server-runner|esbuild|bash|\bsh\b)/.test(row.command);
    });
  if (pids.length) killTree(pids, { label: 'dev-live reap' });
  const del = db.prepare('DELETE FROM dev_port_leases WHERE port = ?');
  for (const r of dead) del.run(r.port);
  console.log(`[dev-live] reaped ${dead.length} lease(s) from dead owners: ${dead.map((r) => r.port).join(', ')}`);
  return dead.length;
}

/**
 * Harness processes nobody owns (left by an older Farnsworth build, a crash
 * before the lease was written, or a script run by hand and forgotten).
 * Anything younger than minAgeSec is spared so a window mid-boot in another
 * instance never loses its server.
 */
function sweepOrphans(db, { minAgeSec = 90 } = {}) {
  ensureSchema(db);
  const table = processTable();
  const owned = db.prepare('SELECT child_pids FROM dev_port_leases').all().flatMap((r) => parsePids(r.child_pids));
  const protectedSet = descendants(owned, table);
  const victims = table.filter((r) =>
    HARNESS_RE.test(r.command)
    && !protectedSet.has(r.pid)
    && r.pid !== process.pid
    && etimeSeconds(r.etime) >= minAgeSec);
  if (!victims.length) return [];
  for (const v of victims) console.log(`[dev-live] orphan harness pid ${v.pid}: ${v.command.slice(0, 160)}`);
  return killTree(victims.map((v) => v.pid), { label: 'dev-live orphan' });
}

module.exports = {
  ensureSchema,
  killTree,
  setOwnerPids,
  killOwner,
  reapDeadOwners,
  sweepOrphans,
  _test: { etimeSeconds, descendants, HARNESS_RE },
};
