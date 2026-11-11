#!/usr/bin/env node
'use strict';

// Regression test for the write_file/read_file path bug.
//
// The agent tools used `path.join(folder, input.path)`. Node's path.join does
// NOT honour an absolute second argument — it concatenates — so an agent that
// asked for "/tmp/df-infernal/issue.md" got
// "<workspace>/tmp/df-infernal/issue.md" and a {ok:true}. That silently wrote
// scratch files into the user's checkout (three separate times by Nov 11 2026)
// and was a way around the nono workdir boundary that run_command enforces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in main.js`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const resolveAgentPath = new Function(
  'path',
  `${extractFunction(mainSource, 'resolveAgentPath')}; return resolveAgentPath;`
)(path);

const ROOT = '/Users/someone/projects/MyGame';

test('an absolute path outside the workspace is refused, not re-anchored', () => {
  // The exact shape that caused the incident.
  const r = resolveAgentPath(ROOT, '/tmp/df-infernal/issue.md');
  assert.equal(r.ok, false, 'an outside-workspace absolute path must not resolve');
  assert.equal(r.rel, null);
});

test('negative control: the old path.join behaviour put that file in the checkout', () => {
  // If this ever stops being true the bug class is gone for a different reason
  // than the fix, so the assertion above is no longer testing what it claims.
  assert.equal(path.join(ROOT, '/tmp/df-infernal/issue.md'), `${ROOT}/tmp/df-infernal/issue.md`);
});

test('an absolute path inside the workspace still resolves', () => {
  const r = resolveAgentPath(ROOT, `${ROOT}/src/app.js`);
  assert.equal(r.ok, true);
  assert.equal(r.full, `${ROOT}/src/app.js`);
  assert.equal(r.rel, 'src/app.js');
});

test('workspace-relative paths resolve and are reported back relative', () => {
  const r = resolveAgentPath(ROOT, 'tmp/notes.md');
  assert.equal(r.ok, true);
  assert.equal(r.full, `${ROOT}/tmp/notes.md`);
  assert.equal(r.rel, 'tmp/notes.md');
});

test('traversal out of the workspace is refused', () => {
  assert.equal(resolveAgentPath(ROOT, '../secrets.env').ok, false);
  assert.equal(resolveAgentPath(ROOT, 'src/../../outside.txt').ok, false);
});

test('a dotfile name containing ".." is no longer a false positive', () => {
  // The old guard was `input.path.includes('..')`, which rejected legal names.
  const r = resolveAgentPath(ROOT, 'notes..v2.md');
  assert.equal(r.ok, true);
  assert.equal(r.rel, 'notes..v2.md');
});

test('the workspace root itself is allowed', () => {
  const r = resolveAgentPath(ROOT, '.');
  assert.equal(r.ok, true);
  assert.equal(r.full, ROOT);
});

test('the agent tool branches no longer join the raw input path', () => {
  assert.doesNotMatch(mainSource, /const full = path\.join\(folder, input\.path\)/);
  assert.doesNotMatch(mainSource, /fs\.readFile\(path\.join\(folder, input\.path\)/);
  assert.match(mainSource, /const target = resolveAgentPath\(folder, input\.path\)/);
  assert.match(mainSource, /error: 'outside_workspace'/);
});
