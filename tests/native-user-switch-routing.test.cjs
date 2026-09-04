#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'AGENT-TOOLS.md'), 'utf8');

function extractAgentTool(name) {
  const marker = `name: '${name}'`;
  const at = main.indexOf(marker);
  assert.notEqual(at, -1, `missing ${name} tool`);
  const start = main.lastIndexOf('{', at);
  const end = main.indexOf('\n  },', at);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return main.slice(start, end + 4);
}

test('direct emulator-user requests are forced through the native tool', () => {
  const tool = extractAgentTool('switch_devvit_user');
  assert.match(tool, /call this tool directly/i);
  assert.match(tool, /Never create or run a test/i);
  assert.match(tool, /request Python/i);

  assert.match(app, /direct request[\s\S]{0,260}MUST call this tool directly/i);
  assert.match(app, /Never create or run a test[\s\S]{0,180}request Python/i);
  assert.match(app, /JSON-test action switchUser is separate/i);
  assert.match(docs, /Direct user requests always use this native tool/i);
});

test('native switch dispatch persists through the renderer restart path', () => {
  const start = main.indexOf("if (name === 'switch_devvit_user')");
  assert.notEqual(start, -1, 'missing native switch dispatch');
  const block = main.slice(start, main.indexOf("if (name === 'ui_show')", start));
  assert.match(block, /db\.devvitListUsers\(\)/);
  assert.match(block, /devvit:agentSwitchUser/);
  assert.match(block, /Switching user and restarting the dev server/);

  assert.match(app, /onDevvitAgentSwitchUser\(async \(payload\) =>/);
  assert.match(app, /devvitSetProjectSettings/);
  assert.match(app, /await stopFarnsworthDev\(\)/);
  assert.match(app, /await bootFarnsworthDev\(\)/);
});
