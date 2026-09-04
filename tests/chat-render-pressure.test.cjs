#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const db = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

test('in-flight chat persistence is minutes apart, while idle saves remain prompt', () => {
  assert.match(app, /CHAT_HISTORY_IDLE_SAVE_DELAY_MS = 750/);
  assert.match(app, /CHAT_HISTORY_ACTIVE_SAVE_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(app, /const active = isChatTurnActive\(\)/);
  assert.match(app, /CHAT_HISTORY_ACTIVE_SAVE_INTERVAL_MS - elapsed/);
  assert.match(app, /if \(state\.chatActiveId === turn\.conversationId\) scheduleChatHistorySave\(\)/);
});

test('collapsed tool groups are lazy and live groups mount only a recent window', () => {
  assert.match(app, /const LIVE_CHIP_RENDER_LIMIT = 40/);
  assert.match(app, /if \(opening\) buildChips\(true\)/);
  assert.match(app, /chips\.slice\(-LIVE_CHIP_RENDER_LIMIT\)/);
  assert.match(app, /earlier steps hidden while running/);
});

test('historical screenshots decode only when their chip is opened', () => {
  assert.match(app, /let screenshotImg = null/);
  assert.match(app, /if \(open && screenshotImg && !screenshotImg\.getAttribute\('src'\)\)/);
  assert.match(app, /screenshotImg\.setAttribute\('src', 'data:image\/png;base64,' \+ c\.screenshotBase64\)/);
  const creation = app.slice(app.indexOf("screenshotImg = el('img'"), app.indexOf("let showFullBtn", app.indexOf("screenshotImg = el('img'")));
  assert.doesNotMatch(creation, /src:/);
});

test('conversation search index rebuilds only when searchable rows changed', () => {
  assert.match(db, /function memoryConversationFtsMatches\(/);
  assert.match(db, /const ftsChanged = !memoryConversationFtsMatches\(id, ftsRows\)/);
  assert.match(db, /if \(ftsChanged\) memoryRebuildConversationFts/);
  assert.match(db, /WHERE id = \? AND \(title IS NOT \? OR messages IS NOT \?\)/);
});
