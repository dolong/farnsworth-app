#!/usr/bin/env node
'use strict';

// Sep 21, 2026: "Inside farnsworth i opened claude code after switching
// folders to a different game. It was reading files from the previous
// folder."
//
// Three defects, one symptom:
//   1. claudeCode.tabs / codex.tabs were ONE global setting, so a switch
//      carried the previous project's tabs (and their sessionIds) over.
//   2. The PTY cwd was captured when the panel's websocket opened, but a
//      restored tab spawns its PTY lazily -- on first click, which can be
//      long after a folder switch. claude then started in the old folder.
//   3. With the old cwd, `--resume <sessionId>` found the old project's
//      JSONL, so the agent replayed that project's transcript and kept
//      reading its files.
//
// Restarting the app papered over it (fresh spawn, current folder). These
// tests hold the real fixes: tab state is per folder, and the cwd is read at
// SPAWN time, not at socket-open time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

const sliceFn = (src, needle, end) => {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `missing source anchor: ${needle}`);
  const stop = src.indexOf(end, start);
  assert.notEqual(stop, -1, `missing source anchor after ${needle}: ${end}`);
  return src.slice(start, stop);
};

// ---- behaviour: the byFolder tab store -----------------------------------
// Lift the two helpers straight out of main.js and run them against a stub
// db, so this tests the shipped implementation rather than a copy of it.
function loadTabStore(initial) {
  const read = sliceFn(mainSource, 'function readAgentTabState(', '\nfunction writeAgentTabState(');
  const write = sliceFn(mainSource, 'function writeAgentTabState(', '\nipcMain.handle(');
  const store = new Map(Object.entries(initial || {}));
  const factory = new Function('db', 'currentFolderSetting', `
    ${read}
    ${write}
    return { readAgentTabState, writeAgentTabState };
  `);
  const db = {
    getSetting: (k) => (store.has(k) ? store.get(k) : null),
    setSetting: (k, v) => store.set(k, v),
  };
  let current = null;
  const api = factory(db, () => current);
  return {
    ...api,
    store,
    setCurrentFolder: (f) => { current = f; },
  };
}

test('a legacy flat tab list is migrated to the folder that was open', () => {
  const legacy = { tabs: [{ id: 'cc-11', sessionId: 'a' }], activeId: 'cc-11' };
  const s = loadTabStore({ 'claudeCode.tabs': legacy });
  s.setCurrentFolder('/Users/long/Documents/dontdie-reddit');

  const got = s.readAgentTabState('claudeCode.tabs', '/Users/long/Documents/dontdie-reddit');
  assert.deepEqual(got.tabs, legacy.tabs, 'upgrading must not lose the tabs you had');
  assert.equal(got.activeId, 'cc-11');

  // And the migration is written back, not recomputed on every read.
  const persisted = s.store.get('claudeCode.tabs');
  assert.ok(persisted.byFolder, 'migrated value must carry byFolder');
  assert.equal(Object.keys(persisted.byFolder).length, 1);
});

test('another folder does not see the previous project\'s agent tabs', () => {
  const s = loadTabStore({
    'claudeCode.tabs': { tabs: [{ id: 'cc-11', sessionId: 'a' }], activeId: 'cc-11' },
  });
  s.setCurrentFolder('/Users/long/Documents/dontdie-reddit');
  s.readAgentTabState('claudeCode.tabs', '/Users/long/Documents/dontdie-reddit');

  // This is the bug Long hit: switching to a different game used to inherit
  // the tab (and its resumable sessionId) from the game he left.
  const other = s.readAgentTabState('claudeCode.tabs', '/Users/long/Documents/my-devvit-game');
  assert.deepEqual(other.tabs, []);
  assert.equal(other.activeId, null);
});

test('each folder keeps its own tabs across writes', () => {
  const s = loadTabStore();
  s.setCurrentFolder('/a');
  s.writeAgentTabState('claudeCode.tabs', '/a', [{ id: 'cc-1' }], 'cc-1');
  s.writeAgentTabState('claudeCode.tabs', '/b', [{ id: 'cc-2' }, { id: 'cc-3' }], 'cc-3');

  assert.deepEqual(s.readAgentTabState('claudeCode.tabs', '/a').tabs, [{ id: 'cc-1' }]);
  const b = s.readAgentTabState('claudeCode.tabs', '/b');
  assert.equal(b.tabs.length, 2);
  assert.equal(b.activeId, 'cc-3');
});

test('a corrupt or empty setting degrades to an empty list, not a throw', () => {
  const s = loadTabStore({ 'claudeCode.tabs': 'not json {{' });
  s.setCurrentFolder('/a');
  assert.deepEqual(s.readAgentTabState('claudeCode.tabs', '/a').tabs, []);
});

// ---- contract: cwd is resolved at spawn time ------------------------------

test('both agent panels take the cwd from the spawn message', () => {
  // Root cause. The init-at-socket-open cwd stays as the fallback, but a
  // lazily spawned PTY must use the folder as of the spawn.
  const occurrences = mainSource.match(
    /if \(typeof msg\.cwd === 'string' && msg\.cwd\.length > 0\) cwd = msg\.cwd;\s*\n\s*spawnFor\(/g
  );
  assert.ok(occurrences && occurrences.length >= 2,
    'Claude Code and Codex spawn handlers must both honour msg.cwd');
});

test('the renderer restates its folder on every spawn message', () => {
  const spawnSends = appSource.match(/type: 'spawn'[\s\S]{0,160}?\}\)\)/g) || [];
  assert.ok(spawnSends.length >= 2, 'expected the Claude Code + Codex spawn sends');
  for (const send of spawnSends) {
    assert.match(send, /cwd: currentWorkspaceFolder\(\)/,
      'every spawn message must carry the current workspace folder');
  }
});

test('no panel hands main a null cwd (main would fall back to $HOME)', () => {
  // Three stray `claude` PTYs were found running in /Users/long because a
  // null init cwd fell through to the homedir fallback.
  assert.doesNotMatch(appSource, /type: 'init', cwd: state\.folder \|\| null/);
  const helper = sliceFn(appSource, 'function currentWorkspaceFolder()', '\n}');
  assert.match(helper, /state\.folder \|\| window\.__farnsworthCurrentFolder/);
});

// ---- contract: tabs follow the folder ------------------------------------

test('folder switch parks the old project\'s agent tabs and loads this one\'s', () => {
  const handler = sliceFn(appSource, 'async function handleFolderPicked(', '\n}');
  assert.match(handler, /swapAgentTabsToFolder\(folderPath, previousFolder\)/);

  const swap = sliceFn(appSource, 'async function swapAgentTabsToFolder(', '\n}');
  // Save under the OUTGOING folder before tearing anything down...
  assert.match(swap, /persistClaudeCodeTabs\(previousFolder\)/);
  assert.match(swap, /persistCodexTabs\(previousFolder\)/);
  // ...tear down without letting the teardown overwrite that save...
  assert.match(swap, /closeClaudeCodeTab\(tabId, \{ persist: false \}\)/);
  assert.match(swap, /closeCodexTab\(tabId, \{ persist: false \}\)/);
  // ...then bring up the tabs belonging to the folder just opened.
  assert.match(swap, /restoreClaudeCodeTabs\(folderPath\)/);
  assert.match(swap, /restoreCodexTabs\(folderPath\)/);
});

test('teardown honours persist:false so a parked list is not clobbered', () => {
  for (const fn of ['async function closeClaudeCodeTab(', 'async function closeCodexTab(']) {
    const body = sliceFn(appSource, fn, '\n}');
    assert.match(body, /opts = \{\}/);
    assert.match(body, /if \(opts\.persist !== false\) persist/);
  }
});

test('the tab list IPC is folder-addressed end to end', () => {
  assert.match(preloadSource, /claudeCodeListTabs: \(folder\)/);
  assert.match(preloadSource, /codexListTabs: \(folder\)/);
  for (const anchor of ["ipcMain.handle('claudeCode:listTabs'", "ipcMain.handle('codex:listTabs'"]) {
    const body = sliceFn(mainSource, anchor, '});');
    assert.match(body, /folder \|\| folderForEvent\(event\)/);
    assert.match(body, /readAgentTabState/);
  }
  for (const anchor of ["ipcMain.handle('claudeCode:saveTabs'", "ipcMain.handle('codex:saveTabs'"]) {
    const body = sliceFn(mainSource, anchor, '});');
    // state.folder lets the renderer name the outgoing project explicitly.
    assert.match(body, /state\.folder \|\| folderForEvent\(event\)/);
    assert.match(body, /writeAgentTabState/);
  }
});

test('a live session records the folder it was spawned for', () => {
  assert.match(appSource, /claudeCodeSessions\.set\(tabId, \{[^}]*cwd: currentWorkspaceFolder\(\)/);
  assert.match(appSource, /codexSessions\.set\(tabId, \{[^}]*cwd: currentWorkspaceFolder\(\)/);
});
