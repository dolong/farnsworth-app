#!/usr/bin/env node
'use strict';
// Nov 11 2026: orphaned dev-script watchers. `devvit playtest` spawns its dev
// script (`vite build --watch`) detached, in its own process group. When the
// playtest died without its exit hook, the watcher survived, reparented to
// launchd, and kept writing into dist/ (27 of them in BreachReddit), which made
// builds fail with "Directory not empty: dist/client/assets".
// Runs the real helpers from main.js against real processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const ends = ['\nfunction ', '\nasync function ', '\nconst ', '\nlet ', '\napp.on(', '\n{', '\n//']
    .map((m) => main.indexOf(m, start + 1)).filter((n) => n !== -1);
  return main.slice(start, Math.min(...ends));
}
const reLine = main.match(/^const DEV_WATCHER_RE = .*$/m);
assert.ok(reLine, 'DEV_WATCHER_RE present');
const src = [reLine[0], ...['killCommandTree', 'workspaceProcessTable', 'processCwds', 'findOrphanDevWatchers'].map(extract)].join('\n');
const fakeProc = { pid: 999999999, kill: process.kill.bind(process) };
const h = new Function('require', 'path', 'process', src + '\nreturn { killCommandTree, findOrphanDevWatchers, workspaceProcessTable, processCwds, DEV_WATCHER_RE };')(require, path, fakeProc);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function ppidOf(pid) { try { return +execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return -1; } }
function pidsMatching(marker) {
  try { return execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); } catch { return []; }
}
function project() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fw-watch-')));
  fs.mkdirSync(path.join(ws, 'node_modules', '.bin'), { recursive: true });
  const bin = path.join(ws, 'node_modules', '.bin', 'vite');
  fs.writeFileSync(bin, '#!/bin/sh\nwhile :; do sleep 1; done\n');
  fs.chmodSync(bin, 0o755);
  return ws;
}
const helper = (marker) => `
const { spawn } = require('child_process');
// like devvit: dev script in its OWN group (detached)
spawn('/bin/sh', ['./node_modules/.bin/vite', 'build', '--watch', '${marker}'], { detached: true, stdio: 'ignore' }).unref();
setInterval(() => {}, 1000);`;

test('watcher regex: project-local --watch only', () => {
  assert.ok(h.DEV_WATCHER_RE.test('node /Users/x/BreachReddit/node_modules/.bin/vite build --watch'));
  assert.ok(h.DEV_WATCHER_RE.test('/bin/sh ./node_modules/.bin/vite build --watch=true'));
  assert.ok(!h.DEV_WATCHER_RE.test('node /Users/x/BreachReddit/node_modules/.bin/vite build'));
  assert.ok(!h.DEV_WATCHER_RE.test('node /usr/local/bin/vite build --watch'));
  assert.ok(!h.DEV_WATCHER_RE.test('node /x/node_modules/.bin/vite --config v.ts --port 5174'));
});

test('killCommandTree reaches a detached grandchild after the group leader exited', async () => {
  const ws = project();
  const marker = 'fwtest-tree-' + process.pid;
  fs.writeFileSync(path.join(ws, 'helper.js'), helper(marker));
  // The agent shape: `sh -c "devvit playtest &"` exits at once, leaving the
  // playtest in the leader's group and its watcher in a group of its own.
  const leader = spawn('/bin/sh', ['-c', `"${process.execPath}" helper.js &`], { cwd: ws, detached: true, stdio: 'ignore' });
  leader.unref();
  await sleep(800);
  const watchers = pidsMatching(marker);
  try {
    assert.equal(watchers.length, 1, 'watcher started');
    assert.equal(alive(leader.pid), false, 'leader already gone');
    // Negative control: the old walk (pgrep -P <leader>) cannot see it.
    let oldKids = '';
    try { oldKids = execFileSync('/usr/bin/pgrep', ['-P', String(leader.pid)], { encoding: 'utf8' }); } catch {}
    assert.equal(oldKids.trim(), '', 'old pgrep walk finds nothing');
    h.killCommandTree(leader.pid, 'SIGKILL');
    await sleep(500);
    assert.deepEqual(pidsMatching(marker), [], 'watcher killed with the tree');
  } finally {
    for (const p of pidsMatching(marker)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    try { process.kill(-leader.pid, 'SIGKILL'); } catch {}
  }
});

test('finds only orphaned watchers inside an open workspace', async () => {
  const ws = project();
  const other = project();
  const tag = 'fwtest-orph-' + process.pid;
  // orphan inside ws: started with & from a shell that exits -> ppid 1
  spawn('/bin/sh', ['-c', `./node_modules/.bin/vite build --watch ${tag}-in &`], { cwd: ws, detached: true, stdio: 'ignore' }).unref();
  // orphan outside any open workspace
  spawn('/bin/sh', ['-c', `./node_modules/.bin/vite build --watch ${tag}-out &`], { cwd: other, detached: true, stdio: 'ignore' }).unref();
  // live playtest's watcher: parent still alive -> must be left alone
  const live = spawn('/bin/sh', ['./node_modules/.bin/vite', 'build', '--watch', `${tag}-live`], { cwd: ws, detached: true, stdio: 'ignore' });
  live.unref();
  await sleep(800);
  try {
    const inside = pidsMatching(`${tag}-in`);
    assert.equal(inside.length, 1);
    assert.equal(ppidOf(inside[0]), 1, 'inside watcher is an orphan');
    const found = h.findOrphanDevWatchers(new Set([ws]), h.workspaceProcessTable(), h.processCwds).map((p) => p.pid);
    assert.deepEqual(found, inside, 'only the orphan inside the workspace');
    assert.deepEqual(h.findOrphanDevWatchers(new Set(), h.workspaceProcessTable(), h.processCwds), [], 'no folders, nothing');
  } finally {
    for (const s of ['-in', '-out', '-live']) for (const p of pidsMatching(tag + s)) { try { process.kill(p, 'SIGKILL'); } catch {} }
  }
});
