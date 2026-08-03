/**
 * dev-port-allocation.js — Farnsworth port authority
 *
 * Allocates dev-server ports (Vite, server-runner, Devvit CLI watcher) via
 * a shared SQLite lease table. Cross-instance coordination is free because
 * all Farnsworth instances on this machine share the same better-sqlite3 DB.
 *
 * Usage:
 *   const { allocatePort, releasePort, releaseAllForRepo, releaseAllForInstance } =
 *     require('./dev-port-allocation');
 *
 *   // Before spawning a dev server:
 *   const vitePort = allocatePort({ repoRoot, role: 'vite',   preferred: 5174, rangeStart: 5174, rangeEnd: 5199 });
 *   const srvPort = allocatePort({ repoRoot, role: 'server',  preferred: 3000, rangeStart: 3000, rangeEnd: 3099 });
 *
 *   // Spawn with env:
 *   //   FARNSWORTH_PORT_VITE=<vitePort> FARNSWORTH_PORT_SERVER=<srvPort>
 *
 *   // On folder close / project stop:
 *   releaseAllForRepo(repoRoot);
 *
 *   // On app quit:
 *   releaseAllForInstance(instanceId);
 */

'use strict';

const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS dev_port_leases (
    port      INTEGER PRIMARY KEY,
    repo_root TEXT NOT NULL,
    role      TEXT NOT NULL CHECK (role IN ('vite', 'server', 'devvit-watcher')),
    pid       INTEGER,
    instance  TEXT NOT NULL,
    leased_at INTEGER NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Produce a human-readable label for logs. */
function tag(repoRoot, role) {
  return `[port-alloc ${path.basename(repoRoot)}:${role}]`;
}

/**
 * Reap — delete leases whose pid is no longer alive (crash recovery).
 * Safe to call from any allocation path because it's idempotent.
 */
function reapStaleLeases(db) {
  // Get all leases with a pid
  const rows = db.prepare('SELECT port, pid, role FROM dev_port_leases WHERE pid IS NOT NULL').all();
  const deadPorts = [];
  for (const row of rows) {
    try {
      // Sending signal 0 tests whether the process exists without killing it.
      process.kill(row.pid, 0);
    } catch (_) {
      // ESRCH = process does not exist
      deadPorts.push(row.port);
    }
  }
  if (deadPorts.length > 0) {
    const placeholders = deadPorts.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM dev_port_leases WHERE port IN (${placeholders})`).run(...deadPorts);
    if (info.changes > 0) {
      console.warn(`[port-alloc] reaped ${info.changes} stale lease(s): ${deadPorts.join(', ')}`);
    }
  }
}

/**
 * Probe whether something is already listening on `port`.
 *
 * NOTE: This is intentionally SIMPLE — it uses the first `lsof` match. The two-stage
 * allocatePort() algorithm uses the SQLite UNIQUE constraint as its primary mutex and
 * only calls this to detect non-Farnsworth processes (e.g. a leftover dev server from
 * a non-Farnsworth session). The INSERT-then-probe race (port bound between our INSERT
 * and the lsof) is handled: if it's a Farnsworth process, the port was leased correctly;
 * if it's non-Farnsworth, the child process will crash on `strictPort:true` with a clear
 * EADDRINUSE, which is acceptable UX.
 */
function isPortBound(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().length > 0;
  } catch (_) {
    // lsof not available or no listeners — treat as free
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Allocate a port for a dev-server role.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db — open better-sqlite3 handle
 * @param {string} opts.repoRoot — absolute path to the project repo
 * @param {'vite'|'server'|'devvit-watcher'} opts.role — what the port is for
 * @param {number} opts.preferred — the port the project currently hardcodes
 * @param {number} opts.rangeStart — start of search range (inclusive)
 * @param {number} opts.rangeEnd — end of search range (inclusive)
 * @param {string} opts.instanceId — current Farnsworth instance ID
 * @returns {number} the assigned port
 * @throws {Error} if no port is available in range
 */
function allocatePort(opts) {
  const { db, repoRoot, role, preferred, rangeStart, rangeEnd, instanceId } = opts;

  if (typeof db !== 'object' || !db) {
    throw new Error('allocatePort: db handle is required');
  }

  // Ensure schema exists (idempotent)
  db.exec(SCHEMA_SQL);

  // Step 1: Reap stale leases
  reapStaleLeases(db);

  const now = Math.floor(Date.now() / 1000);
  const t = tag(repoRoot, role);

  // Step 2: Try preferred port
  if (preferred >= rangeStart && preferred <= rangeEnd) {
    try {
      db.prepare(
        'INSERT INTO dev_port_leases (port, repo_root, role, pid, instance, leased_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(preferred, repoRoot, role, process.pid, instanceId, now);
      console.log(`${t} allocated preferred port ${preferred}`);
      return preferred;
    } catch (_) {
      // UNIQUE violation — someone else has it
      console.warn(`${t} preferred port ${preferred} taken, scanning range ${rangeStart}-${rangeEnd}`);
    }
  }

  // Step 3: Scan range for first free port
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (port === preferred) continue; // already tried above
    try {
      db.prepare(
        'INSERT INTO dev_port_leases (port, repo_root, role, pid, instance, leased_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(port, repoRoot, role, process.pid, instanceId, now);
      // Lease acquired. Log if something non-Farnsworth is already on the port
      // (child process will crash on EADDRINUSE with strictPort:true — acceptable).
      if (isPortBound(port)) {
        console.warn(`${t} port ${port} leased but external listener detected —` +
          ' child process may EADDRINUSE');
      }
      console.log(`${t} allocated port ${port}`);
      return port;
    } catch (_) {
      // UNIQUE violation — another instance claimed it before us
      continue;
    }
  }

  throw new Error(
    `${t} no free port available in range ${rangeStart}-${rangeEnd}`
  );
}

/**
 * Release a specific port lease.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} port
 * @param {string} repoRoot — for safety, scoped to this repo
 * @param {string} role — for safety, scoped to this role
 */
function releasePort(db, port, repoRoot, role) {
  const info = db.prepare(
    'DELETE FROM dev_port_leases WHERE port = ? AND repo_root = ? AND role = ?'
  ).run(port, repoRoot, role);
  if (info.changes > 0) {
    const t = tag(repoRoot, role);
    console.log(`${t} released port ${port}`);
  }
}

/**
 * Release all port leases for a given repo root (folder close / project stop).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repoRoot
 */
function releaseAllForRepo(db, repoRoot) {
  const info = db.prepare('DELETE FROM dev_port_leases WHERE repo_root = ?').run(repoRoot);
  if (info.changes > 0) {
    console.log(`[port-alloc ${path.basename(repoRoot)}:*] released ${info.changes} port lease(s)`);
  }
}

/**
 * Release all port leases for a given instance (app quit).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} instanceId
 */
function releaseAllForInstance(db, instanceId) {
  const info = db.prepare('DELETE FROM dev_port_leases WHERE instance = ?').run(instanceId);
  if (info.changes > 0) {
    console.log(`[port-alloc inst:${instanceId}] released ${info.changes} port lease(s)`);
  }
}

/**
 * Release all port leases (clean shutdown, or boot-time recovery).
 *
 * @param {import('better-sqlite3').Database} db
 */
function releaseAll(db) {
  const info = db.prepare('DELETE FROM dev_port_leases').run();
  if (info.changes > 0) {
    console.log(`[port-alloc] released ALL ${info.changes} port lease(s)`);
  }
}

/**
 * List active leases (for debugging / companion display).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{port: number, repoRoot: string, role: string, pid: number|null, instance: string, leasedAt: number}>}
 */
function listLeases(db) {
  return db.prepare(
    'SELECT port, repo_root AS repoRoot, role, pid, instance, leased_at AS leasedAt FROM dev_port_leases ORDER BY port'
  ).all();
}

module.exports = {
  allocatePort,
  releasePort,
  releaseAllForRepo,
  releaseAllForInstance,
  releaseAll,
  listLeases,
};
