#!/usr/bin/env node
'use strict';
// Oct 23 2026: stop_processes lets the sandboxed agent stop background
// processes it left behind (devvit playtest watchers) without touching
// Farnsworth's own children or unrelated processes. Runs the real helpers
// from main.js against real processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const asyncStart = main.lastIndexOf('async ', start) === start - 6 ? start - 6 : start;
  const next = main.indexOf('\nfunction ', start + 1);
  const nextAsync = main.indexOf('\nasync function ', start + 1);
  const ends = [next, nextAsync].filter((n) => n !== -1);
  return main.slice(asyncStart, ends.length ? Math.min(...ends) : undefined);
}
const src = ['killCommandTree', 'workspaceProcessTable', 'processCwds', 'classifyWorkspaceProcess', 'stopWorkspaceProcesses'].map(extract).join('\n');
const make = new Function('require', 'path', 'process', 'commandLeftoverGroups',
  src + '\nreturn { stopWorkspaceProcesses, classifyWorkspaceProcess };');

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function orphanIn(dir) {
  // Detached + unref'd sleep, cwd in dir: an orphan like a leftover playtest.
  const c = spawn('/bin/sh', ['-c', 'sleep 120'], { cwd: dir, detached: true, stdio: 'ignore' });
  c.unref();
  return c.pid;
}

test('lists and stops an orphan running in the workspace, refuses one outside', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fw-ws-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fw-other-')));
  // A fake "Farnsworth" pid so the test process's own children are not treated as Farnsworth's.
  const fakeProc = { pid: 999999999, kill: process.kill.bind(process) };
  const h = make(require, path, fakeProc, new Set());
  const inside = orphanIn(ws);
  const outside = orphanIn(other);
  await new Promise((r) => setTimeout(r, 300));
  try {
    const listed = await h.stopWorkspaceProcesses(ws);
    assert.ok(listed.processes.some((p) => p.pid === inside), 'inside orphan listed');
    assert.ok(!listed.processes.some((p) => p.pid === outside), 'outside orphan not listed');
    const r = await h.stopWorkspaceProcesses(ws, [inside, outside, 2147483000]);
    assert.deepEqual(r.stopped, [inside]);
    assert.equal(r.refused[0].pid, outside);
    assert.deepEqual(r.notRunning, [2147483000]);
    assert.equal(alive(inside), false);
    assert.equal(alive(outside), true);
  } finally {
    try { process.kill(-outside, 'SIGKILL'); } catch {}
    try { process.kill(-inside, 'SIGKILL'); } catch {}
  }
});

test('Farnsworth descendants outside agent command groups are protected', () => {
  const h = make(require, path, { pid: 100 }, new Set([300]));
  const table = new Map([
    [100, { pid: 100, ppid: 1, pgid: 100 }],
    [200, { pid: 200, ppid: 100, pgid: 200 }], // PTY shell
    [201, { pid: 201, ppid: 200, pgid: 200 }], // dev server in that PTY
    [300, { pid: 300, ppid: 100, pgid: 300 }], // agent command wrapper
    [301, { pid: 301, ppid: 300, pgid: 300 }], // its playtest
    [400, { pid: 400, ppid: 1, pgid: 400 }],   // orphan
  ]);
  assert.equal(h.classifyWorkspaceProcess(table.get(201), table, '/ws', '/ws'), 'farnsworth');
  assert.equal(h.classifyWorkspaceProcess(table.get(301), table, '/ws', '/elsewhere'), 'agent');
  assert.equal(h.classifyWorkspaceProcess(table.get(400), table, '/ws', '/ws/sub'), 'workspace');
  assert.equal(h.classifyWorkspaceProcess(table.get(400), table, '/ws', '/wsx'), null);
  assert.equal(h.classifyWorkspaceProcess(table.get(100), table, '/ws', '/ws'), 'farnsworth');
});
