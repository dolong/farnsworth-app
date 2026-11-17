#!/usr/bin/env node
'use strict';
// Long, Nov 17: Farnsworth always works in the open project folder, never a copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf('function projectCopyViolation(');
const end = main.indexOf('\n}\n', start) + 3;
const projectCopyViolation = new Function(`${main.slice(start, end)}; return projectCopyViolation;`)();
const F = '/Users/long/Documents/DiceFightReddit';

test('blocks the ways a job made a project copy on Nov 17', () => {
  for (const c of [
    'rm -rf /tmp/df153-src && mkdir -p /tmp/df153-src && git archive origin/dev | tar -x -C /tmp/df153-src',
    'git worktree add /tmp/df-ph origin/dev',
    'git clone . /tmp/df-ph',
    'cp -R . /tmp/df-ph',
    `rsync -a ${F}/ /tmp/df-ph`,
    'cd /tmp/df-ph\nexport DEVVIT_EMULATOR_CONFIG=/tmp/df-emu/config.json',
    'node /Applications/Farnsworth.app/Contents/Resources/app.asar.unpacked/devvit-emulator/server-runner.mjs /tmp/df-ph',
    'cd /tmp/df-ph && npx vite --port 5461',
  ]) assert.ok(projectCopyViolation(c, F), c);
});

test('normal work in the project is untouched', () => {
  for (const c of [
    'git fetch origin && git pull --autostash',
    'npm install', 'npm test', 'npx vite build',
    'cp -R public/assets/dice /tmp/frames',
    'ffmpeg -i in.mp4 /tmp/out.mp4',
    'git status --porcelain > /tmp/status.txt',
    'git clone https://github.com/foo/bar ../bar',
  ]) assert.equal(projectCopyViolation(c, F), null, c);
});

// Long, Nov 17: preview tools aim at the job's folder window, never the focused one.
test('preview tools target the job folder window, not the focused window', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  for (const tool of ['open_testview', 'go_live', 'set_canvas_view', 'set_preview']) {
    const i = src.indexOf(`if (name === '${tool}')`);
    const body = src.slice(i, i + 700);
    assert.ok(body.includes('agentTargetWindow(folder)'), `${tool} must use agentTargetWindow(folder)`);
    assert.ok(!body.includes('BrowserWindow.getFocusedWindow()'), `${tool} must not use the focused window`);
  }
});
