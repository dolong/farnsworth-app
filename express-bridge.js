'use strict';
// express-bridge.js — the Express chat tools for an app that already has
// scheduler lanes (Citadel, Philo; Farnsworth once lanes are ported).
// IDENTICAL copy in each app; source of truth: dolong/express hub/lib/.
//
// Electron-free: main.js injects everything Electron-shaped (lanes, turn
// registry, renderer calls, db). A delegated chat is a TASK. A task is queued
// here, offered to a free hidden lane (same offer path scheduled jobs use,
// with offer.kind = 'express'), run by the lane renderer through the real
// sendChatMessage loop, and finished back here. Tasks live in memory: they
// are the live queue, the conversation itself is the durable record.

const crypto = require('node:crypto');
const fs = require('node:fs');

const MAX_TASKS_KEPT = 200;
const toMs = (v) => (typeof v === 'number' ? v : (Date.parse(v || '') || 0));
const OFFER_STALE_MS = 180000;

function err(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

function createExpressBridge(deps) {
  const {
    app,                    // 'citadel' | 'philo' | 'farnsworth'
    rawDb,                  // () => better-sqlite3 handle
    readConversation,       // (input) => transcript (conversationReadTool)
    recentFolders,          // () => [{path,name,opened_at}]
    openFolders,            // () => Iterable<string>
    callMainRenderer,       // (method, args) => Promise<any>
    callRenderer,           // (win, method, args) => Promise<any>
    lanes,                  // schedulerLanes
    acquireLane,            // () => lane|null
    sendOffer,              // (lane) => bool
    chatTurns,              // chatTurns registry
    releaseTurn,            // (token, webContentsId)
    afterLaneFree,          // (lane) => void  (prod cleanup + broadcast + tick)
    scheduledRuns,          // ({limit}) => runs
    onTaskStop = () => {},  // () => void  (end in-flight tool work, e.g. a test run)
    openFolderWindow = null, // (folder) => Promise<{folder, window}>  focus the window holding it, else open a new one
    emit = () => {},
  } = deps;

  const tasks = new Map(); // taskId -> task
  const waiters = new Map(); // taskId -> [resolve]

  function view(t) {
    if (!t) return null;
    const { offerId, laneId, ...rest } = t;
    return { ...rest, lane: laneId || null };
  }

  function prune() {
    if (tasks.size <= MAX_TASKS_KEPT) return;
    const done = [...tasks.values()].filter((t) => t.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const t of done.slice(0, tasks.size - MAX_TASKS_KEPT)) tasks.delete(t.id);
  }

  function publish(t, extra) {
    emit('chat.task', { ...view(t), ...(extra || {}) });
  }

  function finish(t, patch) {
    if (t.finishedAt) return;
    Object.assign(t, patch, { finishedAt: Date.now() });
    publish(t);
    for (const resolve of waiters.get(t.id) || []) resolve(view(t));
    waiters.delete(t.id);
    prune();
  }

  function waitFor(taskId, timeoutMs) {
    const t = tasks.get(taskId);
    if (!t || t.finishedAt || !(timeoutMs > 0)) return Promise.resolve(view(t));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(view(tasks.get(taskId))), timeoutMs);
      const list = waiters.get(taskId) || [];
      list.push((v) => { clearTimeout(timer); resolve(v); });
      waiters.set(taskId, list);
    });
  }

  // Called from the app's scheduler tick (and after every enqueue). Hands
  // queued tasks to free lanes. Offers that sat on a lane that never came up
  // are reclaimed so the task is re-offered instead of pinned.
  function tick() {
    for (const lane of lanes.list()) {
      if (lane.offer && lane.offer.kind === 'express' && !lane.run && !lane.ready
          && Date.now() - lane.offer.requestedAt > OFFER_STALE_MS) {
        const t = tasks.get(lane.offer.taskId);
        if (t && t.status === 'queued') { t.offerId = null; t.laneId = null; }
        lane.offer = null;
      }
    }
    // An offer can also be dropped by the app's own stale-offer reclaim; a
    // queued task whose offer no longer sits on any lane goes back in line.
    for (const t of tasks.values()) {
      if (t.status === 'queued' && t.offerId && !lanes.list().some((l) => l.offer && l.offer.id === t.offerId)) {
        t.offerId = null; t.laneId = null;
      }
    }
    const queued = [...tasks.values()].filter((t) => t.status === 'queued' && !t.offerId)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of queued) {
      // A conversation is single-writer: never run two tasks on it at once.
      if (t.conversationId && [...tasks.values()].some((o) => o !== t && o.status === 'running' && o.conversationId === t.conversationId)) continue;
      const lane = acquireLane();
      if (!lane) break;
      const offerId = `offer-${crypto.randomUUID()}`;
      lane.offer = { id: offerId, kind: 'express', taskId: t.id, jobId: null, trigger: 'express', requestedAt: Date.now() };
      t.offerId = offerId;
      t.laneId = lane.id;
    }
    for (const lane of lanes.list()) {
      if (lane.offer && lane.offer.kind === 'express' && !lane.run && !chatTurns.byWebContents(lane.webContentsId)) sendOffer(lane);
    }
  }

  // ---- lane renderer IPC (wired by main.js) ----
  function accept(webContentsId, offerId) {
    const lane = lanes.byWebContents(webContentsId);
    if (!lane) return { ok: false, error: 'wrong_renderer' };
    const offer = lane.offer;
    if (!offer || offer.id !== offerId || offer.kind !== 'express') return { ok: false, error: 'offer_expired' };
    const t = tasks.get(offer.taskId);
    if (!t || t.status !== 'queued') { lane.offer = null; return { ok: false, error: 'task_gone' }; }
    const lease = chatTurns.acquire({ webContentsId, kind: 'schedule', jobId: `express:${t.id}` });
    if (!lease.ok) return { ok: false, error: 'agent_busy', retry: true };
    lane.offer = null;
    lane.run = { express: true, taskId: t.id, jobId: null, runId: null, jobName: `[Express] ${t.title}`, conversationId: t.conversationId, startedAt: Date.now(), lane: lane.id, workspacePath: t.folder };
    t.status = 'running';
    t.startedAt = Date.now();
    publish(t);
    return {
      ok: true,
      token: lease.token,
      task: { id: t.id, text: t.text, title: t.title, conversationId: t.conversationId, model: t.model, folder: t.folder },
    };
  }

  function started(webContentsId, { taskId, conversationId } = {}) {
    const lane = lanes.byWebContents(webContentsId);
    const t = tasks.get(taskId);
    if (!lane || !t || lane.run?.taskId !== taskId) return { ok: false, error: 'run_mismatch' };
    t.conversationId = conversationId || t.conversationId;
    lane.run.conversationId = t.conversationId;
    publish(t);
    return { ok: true };
  }

  function progress(webContentsId, p = {}) {
    const lane = lanes.byWebContents(webContentsId);
    const t = tasks.get(p.taskId);
    if (!lane || !t || lane.run?.taskId !== p.taskId || t.status !== 'running') return { ok: false };
    t.working = p.working || null;
    t.preview = typeof p.text === 'string' ? p.text.slice(-2000) : t.preview;
    t.tools = Array.isArray(p.tools) ? p.tools.slice(-20) : t.tools;
    emit('chat.progress', { taskId: t.id, conversationId: t.conversationId, working: t.working, text: t.preview, tools: t.tools });
    return { ok: true };
  }

  function complete(webContentsId, p = {}) {
    const lane = lanes.byWebContents(webContentsId);
    if (!lane || !lane.run || lane.run.taskId !== p.taskId) return { ok: false, error: 'run_mismatch' };
    const t = tasks.get(p.taskId);
    if (t) {
      const status = t.status === 'stopping' ? 'stopped' : (p.status === 'succeeded' ? 'succeeded' : (p.status === 'stopped' ? 'stopped' : 'failed'));
      finish(t, {
        status,
        conversationId: p.conversationId || t.conversationId,
        resultText: String(p.resultText || '').slice(0, 20000),
        error: status === 'failed' ? String(p.error || 'Agent turn failed') : null,
        model: p.model || t.model,
        usage: p.usage || null,
        working: null,
      });
    }
    lanes.clearLane(lane);
    releaseTurn(null, webContentsId);
    afterLaneFree(lane);
    return { ok: true };
  }

  // A lane window died mid-task.
  function laneClosed(lane) {
    const taskId = lane?.run?.taskId || lane?.offer?.taskId;
    const t = taskId && tasks.get(taskId);
    if (!t) return;
    if (t.status === 'running' || t.status === 'stopping') finish(t, { status: 'failed', error: 'Agent renderer exited before the turn finished' });
    else if (t.status === 'queued') { t.offerId = null; t.laneId = null; }
  }

  function laneForTask(taskId) {
    return lanes.list().find((l) => l.run?.taskId === taskId) || null;
  }

  // ---- tools ----
  const str = (v) => (v == null ? '' : String(v)).trim();

  function listConversations({ folder, limit = 30, query } = {}) {
    const db = rawDb();
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    const where = [];
    const args = [];
    if (str(folder)) { where.push('workspace_path = ?'); args.push(str(folder)); }
    if (str(query)) { where.push('title LIKE ?'); args.push(`%${str(query)}%`); }
    const rows = db.prepare(`SELECT id, workspace_path, title, created_at, updated_at FROM chat_conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`).all(...args, n);
    const running = new Map([...tasks.values()].filter((t) => t.status === 'running' && t.conversationId).map((t) => [t.conversationId, t.id]));
    return {
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title || 'New chat',
        folder: r.workspace_path || null,
        kind: /^\[Scheduled\]/.test(r.title || '') ? 'scheduled' : /^\[Express\]/.test(r.title || '') ? 'express' : 'chat',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        runningTask: running.get(r.id) || null,
      })),
    };
  }

  async function chatSend(args = {}) {
    const text = str(args.text);
    if (!text) throw err('bad_input', 'text is required');
    const conversationId = str(args.conversationId) || null;
    if (conversationId) {
      const row = rawDb().prepare('SELECT id, workspace_path, title FROM chat_conversations WHERE id = ?').get(conversationId);
      if (!row) throw err('not_found', `No conversation ${conversationId}`);
      if (!args.folder && row.workspace_path) args.folder = row.workspace_path;
    }
    if (!str(args.folder) && !conversationId) {
      // A delegated job with no folder runs in the folder open in the main
      // window, like a chat typed there would. Without this the hidden lane
      // starts with no workspace and every project tool fails.
      const main = await callMainRenderer('folder', {}).catch(() => null);
      args.folder = main?.folder || [...(openFolders() || [])][0] || null;
    }
    const folder = str(args.folder) || null;
    if (folder && !fs.existsSync(folder)) throw err('bad_input', `Folder does not exist: ${folder}`);
    const id = `xt-${crypto.randomUUID()}`;
    const t = {
      id,
      app,
      status: 'queued',
      text,
      title: str(args.title) || text.replace(/\s+/g, ' ').slice(0, 60),
      conversationId,
      folder,
      model: str(args.model) || null,
      source: str(args.source) || 'express',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      resultText: null,
      error: null,
    };
    tasks.set(id, t);
    publish(t);
    tick();
    return waitFor(id, Math.min(Number(args.waitMs) || 0, 600000));
  }

  async function chatStop(args = {}) {
    const taskId = str(args.taskId);
    if (!taskId) {
      // No task: stop whatever the visible chat is doing.
      await callMainRenderer('stop', {});
      return { ok: true, target: 'main' };
    }
    const t = tasks.get(taskId);
    if (!t) throw err('not_found', `No task ${taskId}`);
    if (t.status === 'queued') {
      for (const lane of lanes.list()) if (lane.offer?.taskId === taskId) lane.offer = null;
      finish(t, { status: 'stopped' });
      return { ok: true, task: view(t) };
    }
    if (t.status !== 'running') return { ok: true, task: view(t) };
    t.status = 'stopping';
    publish(t);
    try { onTaskStop(t); } catch {}
    const lane = laneForTask(taskId);
    if (lane?.win) await callRenderer(lane.win, 'stop', {}).catch(() => {});
    return { ok: true, task: view(t) };
  }

  function activity({ limit = 30 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    const items = [...tasks.values()].map((t) => ({
      kind: 'express', id: t.id, title: t.title, status: t.status, conversationId: t.conversationId,
      folder: t.folder, at: t.finishedAt || t.startedAt || t.createdAt, error: t.error || null,
    }));
    let runs = [];
    try { runs = scheduledRuns({ limit: n }) || []; } catch {}
    for (const r of runs) {
      items.push({
        kind: 'scheduled', id: `run-${r.id}`, runId: r.id, jobId: r.jobId, title: r.jobName || r.name || `Run ${r.id}`,
        status: r.status, conversationId: r.conversationId || null, at: toMs(r.finishedAt || r.startedAt),
        error: r.error || null,
      });
    }
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return { activity: items.slice(0, n) };
  }

  const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

  const tools = {
    chat_list: {
      description: `List ${app} chat conversations, newest first. Filter by folder or title text.`,
      inputSchema: obj({ folder: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }),
      annotations: { readOnlyHint: true },
      handler: listConversations,
    },
    chat_read: {
      description: `Read a ${app} conversation transcript (or a scheduled run's) as plain text turns.`,
      inputSchema: obj({ conversationId: { type: 'string' }, runId: { type: 'number' }, maxChars: { type: 'number' }, tail: { type: 'number' } }),
      annotations: { readOnlyHint: true },
      handler: (a) => {
        const r = readConversation(a || {});
        if (r && r.ok === false) throw err(r.error || 'read_failed', r.message || 'read failed');
        return r;
      },
    },
    chat_send: {
      description: `Run a ${app} agent turn in the background (hidden lane, never the visible chat). Continues conversationId if given, else starts a new [Express] conversation. Returns the task; pass waitMs to wait for the result.`,
      inputSchema: obj({
        text: { type: 'string' }, conversationId: { type: 'string' }, title: { type: 'string' },
        folder: { type: 'string' }, model: { type: 'string' }, waitMs: { type: 'number' }, source: { type: 'string' },
      }, ['text']),
      handler: chatSend,
    },
    chat_status: {
      description: 'Status of a delegated chat task. Pass waitMs to block until it finishes.',
      inputSchema: obj({ taskId: { type: 'string' }, waitMs: { type: 'number' } }, ['taskId']),
      annotations: { readOnlyHint: true },
      handler: async ({ taskId, waitMs } = {}) => {
        if (!tasks.has(str(taskId))) throw err('not_found', `No task ${taskId}`);
        return { task: await waitFor(str(taskId), Math.min(Number(waitMs) || 0, 600000)) };
      },
    },
    chat_tasks: {
      description: 'Delegated chat tasks currently known (queued, running, recent).',
      inputSchema: obj({ status: { type: 'string' } }),
      annotations: { readOnlyHint: true },
      handler: ({ status } = {}) => ({
        tasks: [...tasks.values()].filter((t) => !status || t.status === status).sort((a, b) => b.createdAt - a.createdAt).map(view),
        lanes: lanes.capacity(),
      }),
    },
    chat_stop: {
      description: 'Stop a delegated task (taskId), or the visible chat turn when no taskId is given.',
      inputSchema: obj({ taskId: { type: 'string' } }),
      handler: chatStop,
    },
    models_list: {
      description: `Models the ${app} chat can use, and the current default.`,
      inputSchema: obj({}),
      annotations: { readOnlyHint: true },
      handler: () => callMainRenderer('models', {}),
    },
    folder_info: {
      description: `The folder open in ${app}'s main window, and every folder open in any window.`,
      inputSchema: obj({}),
      annotations: { readOnlyHint: true },
      handler: async () => {
        const main = await callMainRenderer('folder', {}).catch(() => ({ folder: null }));
        return { folder: main?.folder || null, open: [...openFolders()] };
      },
    },
    folders_list: {
      description: `Recently opened ${app} folders.`,
      inputSchema: obj({ limit: { type: 'number' } }),
      annotations: { readOnlyHint: true },
      handler: ({ limit } = {}) => ({ folders: (recentFolders(Math.max(1, Math.min(50, Number(limit) || 10))) || []).map((f) => ({ path: f.path, name: f.name, openedAt: f.opened_at })) }),
    },
    folder_switch: {
      description: `Bring a folder up in ${app}: focuses the window that already has it open, otherwise opens it in a NEW window. Never repoints a window the user is working in. Delegated tasks (chat_send with folder) do not need this.`,
      inputSchema: obj({ path: { type: 'string' } }, ['path']),
      handler: async ({ path: p } = {}) => {
        const folder = str(p);
        if (!folder || !fs.existsSync(folder)) throw err('bad_input', `Folder does not exist: ${folder}`);
        if (openFolderWindow) return { ok: true, ...(await openFolderWindow(folder)) };
        await callMainRenderer('switchFolder', { path: folder });
        return { ok: true, folder };
      },
    },
    activity_list: {
      description: `Recent ${app} agent activity: delegated tasks and scheduled runs, newest first.`,
      inputSchema: obj({ limit: { type: 'number' } }),
      annotations: { readOnlyHint: true },
      handler: activity,
    },
  };

  return { tools, tick, accept, started, progress, complete, laneClosed, tasks };
}

// Main -> renderer request/response over one IPC pair. The renderer answers
// with ipcRenderer.invoke('express:reply', {id, ok, result|error}).
function createRendererCaller({ timeoutMs = 15000 } = {}) {
  const pending = new Map();
  function call(win, method, args) {
    if (!win || win.isDestroyed?.()) return Promise.reject(err('no_window', 'Window is not available'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(err('renderer_timeout', `Renderer did not answer ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { win.webContents.send('express:call', { id, method, args: args || {} }); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  function reply(payload = {}) {
    const p = pending.get(payload.id);
    if (!p) return { ok: false };
    pending.delete(payload.id);
    clearTimeout(p.timer);
    if (payload.ok) p.resolve(payload.result ?? null);
    else p.reject(err(payload.error?.code || 'renderer_error', payload.error?.message || 'Renderer call failed'));
    return { ok: true };
  }
  return { call, reply };
}

module.exports = { createExpressBridge, createRendererCaller };
