#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
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

test('agent write completion preserves Preview or Prod', () => {
  const start = source.indexOf("if (tu.name === 'write_file' && toolRes.ok");
  assert.notEqual(start, -1, 'missing successful write_file handler');
  const block = source.slice(start, source.indexOf('\n        }', start) + 10);
  assert.match(block, /stageAgentWrittenFile\(absPath\)/);
  assert.doesNotMatch(block, /canvasMode\s*=|renderCanvas\(|updateModeToggles\(|openFileByPath\(/);
});

test('background editor staging has no navigation or focus side effects', () => {
  const helper = extractFunction('stageAgentWrittenFile');
  assert.doesNotMatch(helper, /canvasMode\s*=(?!=)/);
  assert.doesNotMatch(helper, /renderCanvas\(|updateModeToggles\(|focusActiveFile\(|monacoEditor\.focus\(/);
  assert.match(helper, /if \(file\.dirty && bufferContent !== content\)/);
  assert.match(helper, /externalChanges\.set/);
  assert.match(helper, /openFiles\.push/);
  assert.doesNotMatch(helper, /activeFileIdx\s*=/);
});

test('explicit file and agent view actions can still enter Code', () => {
  const openFile = extractFunction('openFile');
  const openScript = extractFunction('openScriptInEditor');
  assert.match(openFile, /state\.canvasMode = 'code'/);
  assert.match(openScript, /state\.canvasMode = 'code'/);
  const agentView = mainSource.slice(
    mainSource.indexOf("if (name === 'set_canvas_view')"),
    mainSource.indexOf("if (name === 'set_preview')")
  );
  assert.match(agentView, /canvas:setMode/);
  assert.match(agentView, /mode: view/);
});
