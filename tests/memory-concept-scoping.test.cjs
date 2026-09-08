#!/usr/bin/env node
'use strict';

// Sep 8, 2026: "farnsworth was scoped to be per folder. Are you certain?"
// Raw facts were (memory_buffer/memory_archive carry workspace_path since
// Aug 1). The consolidated layer was not: memory_concepts had no workspace
// column, so the router was handed every article in the database and could
// pick across projects -- the Aug 24 leak, where a the-last-draft article
// surfaced with a different project open.
//
// Forward-going fix only, by Long's call: articles created from here on carry
// the project their facts came from. Existing articles stay NULL = global =
// visible from every project, so nothing loses memory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbSource = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const sliceFn = (src, needle, end) => {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `missing source anchor: ${needle}`);
  const stop = src.indexOf(end, start);
  assert.notEqual(stop, -1, `missing source anchor after ${needle}: ${end}`);
  return src.slice(start, stop);
};

test('memory_concepts declares workspace_path in the schema', () => {
  const table = sliceFn(dbSource, 'CREATE TABLE IF NOT EXISTS memory_concepts (', ');');
  assert.match(table, /workspace_path TEXT/);
});

test('the post-SCHEMA migration loop covers memory_concepts', () => {
  const loop = sliceFn(dbSource, "for (const [table, col] of [['memory_buffer'", '}');
  assert.match(loop, /\['memory_concepts', 'workspace_path'\]/);
  // Ordering matters: the loop must stay AFTER db.exec(SCHEMA) or fresh
  // installs silently skip it (PRAGMA on a missing table returns nothing).
  assert.ok(dbSource.indexOf('db.exec(SCHEMA)') < dbSource.indexOf("['memory_concepts', 'workspace_path']"));
});

test('memoryListConcepts accepts a workspace and admits global articles', () => {
  const fn = sliceFn(dbSource, 'function memoryListConcepts(', '\nfunction memoryGetConcept');
  assert.match(fn, /function memoryListConcepts\(limit = 100, workspacePath = null\)/);
  assert.match(fn, /WHERE workspace_path IS NULL OR workspace_path = \?/);
  // No workspace -> no filter, so browsing the whole corpus still works.
  assert.match(fn, /workspacePath \?[^:]+:\s*''/);
});

test('memoryUpsertConcept records provenance and never re-attributes', () => {
  const fn = sliceFn(dbSource, 'function memoryUpsertConcept(', '\nfunction memoryDeleteConcept');
  assert.match(fn, /workspacePath = null/);
  assert.match(fn, /INSERT INTO memory_concepts \(slug, workspace_path,/);
  // First owner wins: an append from project B must not steal project A's
  // article, and must not demote a scoped article to global.
  assert.match(fn, /workspace_path = COALESCE\(memory_concepts\.workspace_path, excluded\.workspace_path\)/);
});

test('recall scopes both the concept lane and the derived section lane', () => {
  const fn = sliceFn(dbSource, 'async function memoryRecall(', '// ---- Bootstrap');
  assert.match(fn, /const conceptScope = workspacePath \?/);
  // Sections have no workspace of their own; they inherit their article's.
  assert.match(fn, /if \(workspacePath && sectionHits\.length\)/);
  assert.match(fn, /sectionHits = sectionHits\.filter\(h => visible\.has\(h\.slug\)\)/);
});

test('the router asks for the active folder plus global articles', () => {
  assert.match(mainSource, /db\.memoryListConcepts\(150, currentFolderSetting\(\) \|\| null\)/);
  assert.doesNotMatch(mainSource, /db\.memoryListConcepts\(150\)\s*\n?\s*\.filter/);
});

test('consolidation derives an op\'s workspace from the buffer rows it consumed', () => {
  const helper = sliceFn(mainSource, 'const bufferWorkspaceById', 'const ops =');
  assert.match(helper, /new Map\(buffer\.map\(b => \[Number\(b\.id\), b\.workspace_path \|\| null\]\)\)/);
  // Mixed or unattributed contributors -> global, the safe direction.
  assert.match(helper, /if \(owners\.size !== 1\) return null;/);
  assert.match(mainSource, /source: 'consolidation', workspacePath: opWorkspace\(op\)/);
});

test('consolidation still sees every article, annotated by owner', () => {
  const idx = sliceFn(mainSource, 'const articleIndex = concepts.map', "join('\\n')");
  assert.match(idx, /\[project: \$\{owner\}\]/);
  assert.match(idx, /\[global\]/);
  // One pass drains buffer rows from every project, so this index must NOT
  // be scoped -- annotation is what enforces the no-merge rule.
  assert.match(mainSource, /const concepts = db\.memoryListConcepts\(100\);/);
});

test('the pinned lanes stay global', () => {
  assert.match(dbSource, /const MEMORY_LANE_SLUGS = \['threads', 'recent'\]/);
  const ensure = sliceFn(dbSource, 'memoryUpsertConcept({ ...d, source:', '\n');
  assert.doesNotMatch(ensure, /workspacePath/);
});

test('the scoping predicate behaves on a real sqlite database', () => {
  const Database = require('better-sqlite3');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cscope-')), 't.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE memory_concepts (slug TEXT PRIMARY KEY, workspace_path TEXT,
    title TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  const ins = db.prepare('INSERT INTO memory_concepts (slug, workspace_path, title) VALUES (?, ?, ?)');
  ins.run('ice-cream-notes', '/p/ice-cream', 'Ice cream');
  ins.run('last-draft-notes', '/p/last-draft', 'Last draft');
  ins.run('long-profile', null, 'Long');

  const scoped = (w) => db.prepare(
    'SELECT slug FROM memory_concepts WHERE workspace_path IS NULL OR workspace_path = ? ORDER BY slug'
  ).all(w).map(r => r.slug);

  assert.deepEqual(scoped('/p/ice-cream'), ['ice-cream-notes', 'long-profile']);
  assert.deepEqual(scoped('/p/last-draft'), ['last-draft-notes', 'long-profile']);
  // Unknown folder still gets the global articles -- never an empty memory.
  assert.deepEqual(scoped('/p/brand-new'), ['long-profile']);
  // No folder open -> unfiltered, the whole corpus.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_concepts').get().c, 3);

  // First owner wins on conflict.
  db.prepare(`INSERT INTO memory_concepts (slug, workspace_path, title) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      workspace_path = COALESCE(memory_concepts.workspace_path, excluded.workspace_path),
      title = excluded.title`).run('ice-cream-notes', '/p/last-draft', 'Renamed');
  assert.equal(db.prepare("SELECT workspace_path w FROM memory_concepts WHERE slug='ice-cream-notes'").get().w, '/p/ice-cream');
  db.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
