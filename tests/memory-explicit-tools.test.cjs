#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
const db = require(path.join(appRoot, 'db.js'));

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name} in main.js`);
  const brace = mainSource.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = brace; i < mainSource.length; i++) {
    const ch = mainSource[i];
    const next = mainSource[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
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
    if (ch === '}' && --depth === 0) return mainSource.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const helperNames = [
  'normalizeExplicitMemorySlug',
  'queueExplicitMemoryDirective',
  'replaceMemorySection',
  'archiveExplicitMemoryRevision',
  'applyExplicitMemoryDirectives',
];
const helperSource = helperNames.map(extractFunction).join('\n\n');
const helpers = new Function('db', 'currentFolderSetting', 'console', `${helperSource}\nreturn { ${helperNames.join(', ')} };`)(
  db,
  () => '/projects/the-last-draft',
  console
);

function bufferedRow(queued, source = 'agent.memory.explicit') {
  return {
    id: queued.bufferId,
    source,
    content: JSON.stringify(queued.directive),
    workspace_path: queued.workspacePath,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farnsworth-memory-tools-'));
try {
  db.init(tmp, { isEncryptionAvailable: () => false });
  const raw = db.getRawDb();

  const created = helpers.queueExplicitMemoryDirective('upsert', {
    slug: 'Updating Devvit Apps',
    title: 'Updating Devvit Apps',
    section: 'Procedure',
    content: 'Use a bare version or app-name@version. Never pass standalone @version.',
    scope: 'global',
  });
  assert.equal(created.ok, true);
  assert.equal(created.workspacePath, null);
  let applied = helpers.applyExplicitMemoryDirectives([bufferedRow(created)]);
  assert.equal(applied.results[0].ok, true);
  assert.equal(applied.results[0].created, true);
  let concept = db.memoryGetConcept('updating-devvit-apps');
  assert(concept.body.includes('Never pass standalone @version.'));
  assert(db.memorySectionsSearch('standalone version', 5).some(row => row.slug === 'updating-devvit-apps'));

  const updated = helpers.queueExplicitMemoryDirective('upsert', {
    slug: 'updating-devvit-apps',
    title: 'Updating Devvit Apps',
    section: 'Procedure',
    content: 'Use a bare version or the full app-name@version form. Read the latest successful playtest version from the last terminal line prefixed with a checkmark.',
    scope: 'global',
  });
  applied = helpers.applyExplicitMemoryDirectives([bufferedRow(updated)]);
  assert.equal(applied.results[0].updated, true);
  concept = db.memoryGetConcept('updating-devvit-apps');
  assert(!concept.body.includes('Never pass standalone @version.'));
  assert(concept.body.includes('latest successful playtest version'));
  assert(!db.memorySectionsSearch('Never standalone', 5).some(row => row.slug === 'updating-devvit-apps'));

  const revisionsAfterUpsert = raw.prepare("SELECT COUNT(*) AS n FROM memory_archive WHERE metadata LIKE '%agent.memory.revision%'").get().n;
  assert.equal(revisionsAfterUpsert, 1);

  const externalDirective = {
    version: 1,
    op: 'upsert',
    slug: 'external-mcp-procedure',
    title: 'External MCP Procedure',
    section: 'Procedure',
    content: 'MCP directives use the same deterministic JSON contract as native chat writes.',
    match: '',
    replacement: '',
    reason: '',
    scope: 'global',
    requestedAt: new Date().toISOString(),
  };
  const externalBuffer = db.memoryBufferAppend(
    JSON.stringify(externalDirective),
    'explicit-memory:upsert:external-mcp-procedure',
    'mcp-explicit',
    null
  );
  assert.equal(externalBuffer.ok, true);
  applied = helpers.applyExplicitMemoryDirectives([{
    id: externalBuffer.id,
    source: 'mcp-explicit',
    content: JSON.stringify(externalDirective),
    workspace_path: null,
  }]);
  assert.equal(applied.results[0].ok, true);
  assert.equal(applied.results[0].created, true);
  assert(db.memoryGetConcept('external-mcp-procedure').body.includes('deterministic JSON contract'));
  assert.equal(raw.prepare('SELECT consolidated FROM memory_buffer WHERE id = ?').get(externalBuffer.id).consolidated, 1);

  const appended = helpers.queueExplicitMemoryDirective('append', {
    slug: 'updating-devvit-apps',
    section: 'CLI 0.13.4',
    content: 'The standalone @0.0.34 install shorthand throws DevvitVersion parts can only be numbers.',
    scope: 'project',
  }, '/projects/the-last-draft');
  assert.equal(appended.workspacePath, '/projects/the-last-draft');
  applied = helpers.applyExplicitMemoryDirectives([bufferedRow(appended)]);
  assert.equal(applied.results[0].ok, true);
  concept = db.memoryGetConcept('updating-devvit-apps');
  assert(concept.body.includes('DevvitVersion parts can only be numbers'));
  const appendBuffer = raw.prepare('SELECT workspace_path, consolidated FROM memory_buffer WHERE id = ?').get(appended.bufferId);
  assert.deepEqual(appendBuffer, { workspace_path: '/projects/the-last-draft', consolidated: 1 });

  const revisionsBeforeDuplicate = raw.prepare("SELECT COUNT(*) AS n FROM memory_archive WHERE metadata LIKE '%agent.memory.revision%'").get().n;
  const duplicate = helpers.queueExplicitMemoryDirective('append', {
    slug: 'updating-devvit-apps',
    section: 'CLI 0.13.4',
    content: 'The standalone @0.0.34 install shorthand throws DevvitVersion parts can only be numbers.',
    scope: 'project',
  }, '/projects/the-last-draft');
  applied = helpers.applyExplicitMemoryDirectives([bufferedRow(duplicate)]);
  assert.equal(applied.results[0].deduplicated, true);
  const revisionsAfterDuplicate = raw.prepare("SELECT COUNT(*) AS n FROM memory_archive WHERE metadata LIKE '%agent.memory.revision%'").get().n;
  assert.equal(revisionsAfterDuplicate, revisionsBeforeDuplicate);

  const forgotten = helpers.queueExplicitMemoryDirective('forget', {
    slug: 'updating-devvit-apps',
    match: 'The standalone @0.0.34 install shorthand throws DevvitVersion parts can only be numbers.',
    replacement: 'Devvit CLI 0.13.4 rejects standalone @version arguments; use a bare version or app-name@version.',
    reason: 'Replace the example-specific claim with the durable rule.',
    scope: 'global',
  });
  applied = helpers.applyExplicitMemoryDirectives([bufferedRow(forgotten)]);
  assert.equal(applied.results[0].replaced, true);
  concept = db.memoryGetConcept('updating-devvit-apps');
  assert(concept.body.includes('rejects standalone @version arguments'));
  assert(!concept.body.includes('The standalone @0.0.34 install shorthand'));
  assert(db.memorySectionsSearch('rejects standalone arguments', 5).some(row => row.slug === 'updating-devvit-apps'));

  const missed = helpers.queueExplicitMemoryDirective('forget', {
    slug: 'updating-devvit-apps',
    match: 'This text does not exist.',
    scope: 'global',
  });
  applied = helpers.applyExplicitMemoryDirectives([bufferedRow(missed)]);
  assert.equal(applied.results[0].ok, false);
  assert.equal(applied.results[0].terminal, true);
  assert.equal(applied.results[0].error, 'match_not_found');
  assert.equal(raw.prepare('SELECT consolidated FROM memory_buffer WHERE id = ?').get(missed.bufferId).consolidated, 1);

  const badScope = helpers.queueExplicitMemoryDirective('append', {
    slug: 'updating-devvit-apps',
    content: 'bad scope must not write',
  });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.error, 'bad_input');

  const archiveRows = raw.prepare("SELECT kind, metadata, workspace_path FROM memory_archive WHERE metadata LIKE '%agent.memory.%' ORDER BY id").all();
  assert(archiveRows.length >= 9, `expected request + revision archive rows, got ${archiveRows.length}`);
  assert(archiveRows.some(row => row.workspace_path === '/projects/the-last-draft'));
  assert(archiveRows.some(row => String(row.metadata).includes('snapshot')));

  console.log(JSON.stringify({
    ok: true,
    created: true,
    section_upsert: true,
    append: true,
    duplicate_suppressed: true,
    correction: true,
    terminal_failure_finalized: true,
    section_fts_rebuilt: true,
    revision_snapshots: raw.prepare("SELECT COUNT(*) AS n FROM memory_archive WHERE metadata LIKE '%agent.memory.revision%'").get().n,
    archive_rows: archiveRows.length,
  }));
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
