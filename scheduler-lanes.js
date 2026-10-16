'use strict';

// Citadel runs MULTIPLE scheduled agent turns at once — one per lane.
//
// Until v0.2.53 the scheduler had exactly one slot. Three single-value globals
// enforced it: `globalChatTurn` (one agent turn app-wide), `pendingScheduledOffer`
// (one queued offer), and `scheduledJobRun` (one active run), all served by ONE
// hidden renderer. Two schedules due at 2:00 AM ran back to back, not together:
// the second sat pending until the first released the lease. v0.2.52 removed the
// same limit one layer down (Prod now runs a browser per identity), so the turn
// lease was the last thing serializing independent identities.
//
// A LANE is one hidden renderer plus the turn it currently owns. Lanes are the
// unit of concurrency because `sendChatMessage()` — the real agent loop, with
// tools, memory, model routing, and a persisted conversation — is renderer-owned
// and single-threaded per renderer. Two concurrent runs therefore need two
// renderers, not two promises.
//
// Three invariants, in the same spirit as the Prod session registry:
//
//   1. JOB EXCLUSIVITY. One live run per scheduled job, always. A job whose
//      previous fire is still running must never start a second copy: both
//      would drive the same identity, the same runbook, and the same upvote.
//      This is the scheduler's version of the Prod registry's identity
//      exclusivity, and it is enforced here rather than trusted to callers.
//   2. ONE TURN PER RENDERER. A lease is keyed by webContents. A renderer that
//      already owns a turn cannot take another — that is what kept a manual
//      chat coherent when the lease was global, and it stays true per lane.
//   3. A BOUNDED POOL. Lanes are lazily created and capped. Each one is a real
//      hidden Electron renderer running the whole app; an unbounded pool would
//      let a burst of due jobs spawn renderers until the Mac swaps.
//
// Deliberately Electron-free so it unit-tests as plain Node: a lane's window is
// an opaque handle this module never calls into.

// Total concurrent agent turns, manual and scheduled together. Three lets two
// schedules fire while the operator still has a live chat.
const DEFAULT_MAX_TURNS = 3;
// Hidden scheduled renderers. Lane 0 exists from boot (that is the historical
// single renderer); the rest are created only when work actually overlaps.
const DEFAULT_MAX_LANES = 2;

// A scheduled job bound to a workspace runs ONLY while that workspace is open
// in a real window. Long's rule (Sep 10 2026): closing citadel-ops must stop
// its recurring tasks, and opening an unrelated project must never fire them.
// The occurrence is skipped, not consumed -- `next_run_at` stays put, so the
// job catches up when its folder is opened again, which is the same
// catch-up-on-reopen contract the scheduler already had for a closed app.
//
// A job with NO workspace is global context: there is no folder to require, so
// it always runs.
function jobWorkspaceOpen(job, openFolders) {
  const wanted = normalizeFolder(job && (job.workspacePath || job.workspace_path));
  if (!wanted) return true;
  for (const folder of openFolders || []) {
    if (normalizeFolder(folder) === wanted) return true;
  }
  return false;
}

// Trailing slashes only: a folder path is compared as the app stored it, never
// resolved or case-folded, because a symlinked or differently-cased path is a
// different workspace as far as every other Citadel subsystem is concerned.
function normalizeFolder(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function createChatTurnRegistry({ maxConcurrent = DEFAULT_MAX_TURNS, uuid = () => `${Date.now()}-${Math.random()}` } = {}) {
  const turns = new Map(); // token -> turn

  function list() { return [...turns.values()]; }
  function count() { return turns.size; }
  function get(token) { return turns.get(String(token || '')) || null; }
  function byWebContents(id) {
    if (id == null) return null;
    for (const turn of turns.values()) if (turn.webContentsId === id) return turn;
    return null;
  }
  function byJob(jobId) {
    const id = String(jobId || '');
    if (!id) return null;
    for (const turn of turns.values()) if (String(turn.jobId || '') === id) return turn;
    return null;
  }

  function capacity() {
    return { count: turns.size, max: maxConcurrent, available: turns.size < maxConcurrent };
  }

  // Refusals are typed so the caller can tell "try again later" (at capacity)
  // from "never going to work" (this renderer or this job already has a turn).
  function acquire({ webContentsId, kind = 'manual', jobId = null, runId = null } = {}) {
    if (webContentsId == null) return { ok: false, error: 'bad_input', message: 'A turn needs a webContents.' };
    if (byWebContents(webContentsId)) {
      return { ok: false, error: 'turn_in_progress', message: 'This window already has an agent turn running.' };
    }
    if (jobId && byJob(jobId)) {
      return { ok: false, error: 'job_in_progress', message: 'That scheduled task is already running.' };
    }
    if (turns.size >= maxConcurrent) {
      return { ok: false, error: 'agent_busy', retry: true, message: `Citadel is already running ${turns.size} agent turns (max ${maxConcurrent}).` };
    }
    const token = `turn-${uuid()}`;
    const turn = {
      token,
      webContentsId,
      kind: kind === 'schedule' ? 'schedule' : 'manual',
      jobId: jobId || null,
      runId: runId || null,
      startedAt: Date.now(),
    };
    turns.set(token, turn);
    return { ok: true, token, turn };
  }

  // Released by token (normal completion) or by webContents (renderer died).
  // Passing both requires them to agree, so a stale token cannot evict the
  // turn that replaced it.
  function release(token, webContentsId) {
    const key = String(token || '');
    if (key) {
      const turn = turns.get(key);
      if (!turn) return false;
      if (webContentsId != null && turn.webContentsId !== webContentsId) return false;
      turns.delete(key);
      return true;
    }
    if (webContentsId == null) return false;
    const turn = byWebContents(webContentsId);
    if (!turn) return false;
    turns.delete(turn.token);
    return true;
  }

  function setRunId(token, runId) {
    const turn = turns.get(String(token || ''));
    if (!turn) return false;
    turn.runId = runId;
    return true;
  }

  function clear() { turns.clear(); }

  return { acquire, release, get, byWebContents, byJob, list, count, capacity, setRunId, clear };
}

function createSchedulerLanePool({ maxLanes = DEFAULT_MAX_LANES } = {}) {
  const lanes = new Map(); // laneId -> lane
  let seq = 0;

  function list() { return [...lanes.values()]; }
  function count() { return lanes.size; }
  function get(laneId) { return lanes.get(String(laneId || '')) || null; }

  function create(win) {
    if (lanes.size >= maxLanes) return null;
    seq += 1;
    const lane = {
      id: `lane-${seq}`,
      win,
      webContentsId: null,
      ready: false,
      offer: null,
      run: null,
      createdAt: Date.now(),
      lastUsedAt: 0,
    };
    lanes.set(lane.id, lane);
    return lane;
  }

  function remove(laneId) { return lanes.delete(String(laneId || '')); }

  function byWebContents(id) {
    if (id == null) return null;
    for (const lane of lanes.values()) if (lane.webContentsId === id) return lane;
    return null;
  }
  function byWindow(win) {
    if (!win) return null;
    for (const lane of lanes.values()) if (lane.win === win) return lane;
    return null;
  }

  function markReady(laneId, webContentsId) {
    const lane = get(laneId);
    if (!lane) return null;
    lane.ready = true;
    lane.webContentsId = webContentsId;
    return lane;
  }

  // A lane is free when its renderer is up and it holds neither an outstanding
  // offer nor a live run. Offers count: a lane that has been offered work but
  // has not accepted yet is spoken for.
  function isFree(lane) { return !!lane && lane.ready && !lane.offer && !lane.run; }
  function free() { return list().filter(isFree); }
  function freeLane() { return free()[0] || null; }
  function canGrow() { return lanes.size < maxLanes; }

  function runs() { return list().map((lane) => lane.run).filter(Boolean); }
  function offers() { return list().map((lane) => lane.offer).filter(Boolean); }

  // Job exclusivity at the dispatch layer: a job already offered or running
  // anywhere is never handed to a second lane.
  function jobBusy(jobId) {
    const id = String(jobId || '');
    if (!id) return null;
    for (const lane of lanes.values()) {
      if (lane.run && String(lane.run.jobId) === id) return { lane, state: 'running' };
      if (lane.offer && String(lane.offer.jobId) === id) return { lane, state: 'offered' };
    }
    return null;
  }

  function laneForOffer(offerId) {
    const id = String(offerId || '');
    if (!id) return null;
    for (const lane of lanes.values()) if (lane.offer && lane.offer.id === id) return lane;
    return null;
  }

  function laneForRun(runId) {
    for (const lane of lanes.values()) if (lane.run && Number(lane.run.runId) === Number(runId)) return lane;
    return null;
  }

  function clearLane(lane) {
    if (!lane) return;
    lane.offer = null;
    lane.run = null;
    lane.lastUsedAt = Date.now();
  }

  function capacity() {
    return { lanes: lanes.size, max: maxLanes, busy: list().filter((lane) => !isFree(lane)).length };
  }

  return {
    create, remove, get, list, count, capacity,
    byWebContents, byWindow, markReady,
    isFree, free, freeLane, canGrow,
    runs, offers, jobBusy, laneForOffer, laneForRun, clearLane,
  };
}

module.exports = {
  createChatTurnRegistry,
  createSchedulerLanePool,
  jobWorkspaceOpen,
  normalizeFolder,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_LANES,
};
