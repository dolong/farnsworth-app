#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function extractFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = main.indexOf('\nfunction ', start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

test('automatic Python selection checks websocket-client before accepting an interpreter', () => {
  const fn = extractFunction('resolvePythonBin');
  assert.match(fn, /const hasWebsocket = \(f\) =>/);
  assert.match(fn, /execFileSync\(f, \['-c', 'import websocket'\]/);
  assert.match(fn, /if \(hasWebsocket\(c\)\)/);
  assert.match(fn, /firstExecutable/);
});

test('an explicit FARNSWORTH_PYTHON override remains authoritative', () => {
  const fn = extractFunction('resolvePythonBin');
  assert.match(fn, /const explicit = process\.env\.FARNSWORTH_PYTHON/);
  assert.match(fn, /if \(explicit && isExec\(explicit\)\)/);
  assert.match(fn, /_pythonBinCache = explicit/);
});

test('ordinary Desktop tests remain Node-native while switchUser is the Python-only boundary', () => {
  assert.match(main, /Try the Node-native path first \(no Python\/websocket-client/);
  assert.match(main, /recursivelyHasUnsupportedAction\(steps, mod\.UNSUPPORTED_ACTIONS\)/);
  const runner = fs.readFileSync(path.join(root, 'src', 'farnsworth-test-runner.mjs'), 'utf8');
  assert.match(runner, /UNSUPPORTED_ACTIONS = new Set\(\['switchUser', 'switchDevvitUser', 'llm-step'\]\)/);
});
