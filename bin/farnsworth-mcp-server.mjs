#!/usr/bin/env node

/**
 * Farnsworth MCP Server
 *
 * Raw MCP/JSON-RPC 2.0 over stdio. Reads canonical Farnsworth memory tables
 * and exposes explicit, provenance-bearing memory directives without mutating
 * canonical concepts directly.
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';

const require = createRequire(import.meta.url);

function writeError(message) {
  process.stderr.write(`[farnsworth-mcp] ${message}\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--check') || args.includes('--dry-run')) return { mode: 'check' };

  const index = args.indexOf('--db');
  let dbPath = index >= 0 ? args[index + 1] : null;
  if (dbPath?.startsWith('~/')) dbPath = resolve(homedir(), dbPath.slice(2));
  dbPath ||= process.env.FARNSWORTH_MCP_DB_PATH;
  if (!dbPath) {
    for (const candidate of [
      resolve(homedir(), 'Library/Application Support/Farnsworth/farnsworth/farnsworth.db'),
      resolve(homedir(), '.farnsworth/memory.db'),
    ]) {
      if (existsSync(candidate)) { dbPath = candidate; break; }
    }
  }
  return { mode: 'serve', dbPath };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function inlineParams(sql, params = {}) {
  let output = sql;
  for (const [key, value] of Object.entries(params)) {
    const pattern = new RegExp(`[@:]${key}(?=\\W|$)`, 'g');
    output = output.replace(pattern, sqlLiteral(value));
  }
  return output;
}

function findSqlite3() {
  for (const candidate of [
    process.env.FARNSWORTH_SQLITE3,
    '/opt/homebrew/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/usr/bin/sqlite3',
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', ['sqlite3'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    }).trim();
  } catch {
    return null;
  }
}

function findPython3() {
  for (const candidate of [
    process.env.FARNSWORTH_PYTHON3,
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', ['python3'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    }).trim();
  } catch {
    return null;
  }
}

// The Python bridge receives the database path and SQL as argv/stdin values,
// never through a shell. SQL values stay bound by Python's sqlite3 API.
const PYTHON_SQLITE_BRIDGE = String.raw`
import json
import sqlite3
import sys
from urllib.parse import quote


def row_dict(row):
    if row is None:
        return None
    result = {}
    for key in row.keys():
        value = row[key]
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        result[key] = value
    return result


def identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def main():
    db_path = sys.argv[1]
    writable = sys.argv[2] == "write"
    operation = json.load(sys.stdin)
    if writable:
        connection = sqlite3.connect(db_path, timeout=5.0)
    else:
        uri = "file:" + quote(db_path, safe="/") + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5.0)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA busy_timeout = 5000")
        if writable:
            connection.execute("PRAGMA journal_mode = WAL").fetchone()
        method = operation["method"]
        params = operation.get("params") or {}
        if method == "all":
            cursor = connection.execute(operation["sql"], params)
            result = [row_dict(row) for row in cursor.fetchall()]
        elif method == "get":
            cursor = connection.execute(operation["sql"], params)
            result = row_dict(cursor.fetchone())
        elif method == "run":
            cursor = connection.execute(operation["sql"], params)
            if writable:
                connection.commit()
            result = {"changes": cursor.rowcount, "lastInsertRowid": cursor.lastrowid}
        elif method == "columns":
            cursor = connection.execute("PRAGMA table_info(" + identifier(operation["table"]) + ")")
            result = [row[1] for row in cursor.fetchall()]
        elif method == "tableExists":
            cursor = connection.execute(
                "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
                (operation["table"],),
            )
            result = cursor.fetchone() is not None
        elif method == "dualWrite":
            connection.execute("BEGIN IMMEDIATE")
            try:
                buffer_cursor = connection.execute(operation["buffer"]["sql"], operation["buffer"].get("params") or {})
                archive_cursor = connection.execute(operation["archive"]["sql"], operation["archive"].get("params") or {})
                result = {
                    "buffer_id": buffer_cursor.lastrowid,
                    "archive_id": archive_cursor.lastrowid,
                }
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        else:
            raise ValueError("unknown bridge method: " + str(method))
        json.dump(result, sys.stdout, ensure_ascii=False)
    finally:
        connection.close()


try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

function wrapBetterSqlite3(nativeDb) {
  return {
    kind: 'better-sqlite3',
    all(sql, params = {}) { return nativeDb.prepare(sql).all(params); },
    get(sql, params = {}) { return nativeDb.prepare(sql).get(params) || null; },
    run(sql, params = {}) { return nativeDb.prepare(sql).run(params); },
    columns(table) {
      return nativeDb.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    },
    tableExists(table) {
      return Boolean(nativeDb.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = @name"
      ).get({ name: table }));
    },
    transaction(fn) { return nativeDb.transaction(fn)(); },
    close() { nativeDb.close(); },
  };
}

function wrapSqlite3Cli(dbPath, sqlite3Path, writable = false) {
  function query(sql, params = {}) {
    const inlined = inlineParams(sql, params);
    const sqliteArgs = ['-json'];
    if (!writable) sqliteArgs.push('-readonly');
    sqliteArgs.push(dbPath, inlined);
    const result = spawnSync(sqlite3Path, sqliteArgs, {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || `sqlite3 exited ${result.status}`).trim());
    }
    const output = (result.stdout || '').trim();
    if (!output) return [];
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(`sqlite3 returned invalid JSON: ${error.message}; output=${output.slice(0, 300)}`);
    }
  }

  query('SELECT 1 AS ok');
  return {
    kind: 'sqlite3-cli',
    all(sql, params = {}) { return query(sql, params); },
    get(sql, params = {}) { return query(`${sql} LIMIT 1`, params)[0] || null; },
    run(sql, params = {}) { query(sql, params); return { changes: 1 }; },
    columns(table) { return query(`PRAGMA table_info(${table})`).map(row => row.name); },
    tableExists(table) {
      return Boolean(query(
        "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = @name",
        { name: table },
      )[0]);
    },
    dualWrite(bufferSql, bufferParams, archiveSql, archiveParams) {
      const sql = [
        'BEGIN IMMEDIATE',
        'CREATE TEMP TABLE IF NOT EXISTS __farnsworth_mcp_ids (buffer_id INTEGER, archive_id INTEGER)',
        'DELETE FROM __farnsworth_mcp_ids',
        inlineParams(bufferSql, bufferParams),
        'INSERT INTO __farnsworth_mcp_ids(buffer_id) VALUES(last_insert_rowid())',
        inlineParams(archiveSql, archiveParams),
        'UPDATE __farnsworth_mcp_ids SET archive_id = last_insert_rowid()',
        'SELECT buffer_id, archive_id FROM __farnsworth_mcp_ids',
        'COMMIT',
      ].join(';\n');
      return query(sql)[0] || {};
    },
    close() {},
  };
}

function wrapPythonSqlite(dbPath, pythonPath, writable = false) {
  function bridge(operation) {
    const result = spawnSync(pythonPath, ['-c', PYTHON_SQLITE_BRIDGE, dbPath, writable ? 'write' : 'read'], {
      input: JSON.stringify(operation),
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || `python3 exited ${result.status}`).trim());
    }
    const output = (result.stdout || '').trim();
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(`python sqlite3 returned invalid JSON: ${error.message}; output=${output.slice(0, 300)}`);
    }
  }

  bridge({ method: 'get', sql: 'SELECT 1 AS ok' });
  return {
    kind: 'python-sqlite3',
    all(sql, params = {}) { return bridge({ method: 'all', sql, params }); },
    get(sql, params = {}) { return bridge({ method: 'get', sql, params }); },
    run(sql, params = {}) { return bridge({ method: 'run', sql, params }); },
    columns(table) { return bridge({ method: 'columns', table }); },
    tableExists(table) { return bridge({ method: 'tableExists', table }); },
    dualWrite(bufferSql, bufferParams, archiveSql, archiveParams) {
      return bridge({
        method: 'dualWrite',
        buffer: { sql: bufferSql, params: bufferParams },
        archive: { sql: archiveSql, params: archiveParams },
      }) || {};
    },
    close() {},
  };
}

function requestedBackend() {
  const value = String(process.env.FARNSWORTH_MCP_BACKEND || 'auto').toLowerCase();
  if (!['auto', 'better-sqlite3', 'sqlite3', 'python'].includes(value)) {
    throw new Error(`Unsupported FARNSWORTH_MCP_BACKEND: ${value}`);
  }
  return value;
}

function openDb(dbPath, writable = false) {
  const preference = requestedBackend();
  const errors = [];
  if (preference === 'auto' || preference === 'better-sqlite3') {
    try {
      const Database = require('better-sqlite3');
      const nativeDb = new Database(dbPath, { readonly: !writable, fileMustExist: true });
      try {
        nativeDb.pragma('busy_timeout = 5000');
        if (writable) nativeDb.pragma('journal_mode = WAL');
        return wrapBetterSqlite3(nativeDb);
      } catch (error) {
        nativeDb.close();
        throw error;
      }
    } catch (error) {
      errors.push(`better-sqlite3: ${error.message.split('\\n')[0]}`);
      if (preference === 'better-sqlite3') throw new Error(errors.join('; '));
    }
  }
  if (preference === 'auto' || preference === 'sqlite3') {
    const sqlite3Path = findSqlite3();
    if (sqlite3Path) {
      try { return wrapSqlite3Cli(dbPath, sqlite3Path, writable); }
      catch (error) {
        errors.push(`sqlite3 CLI: ${error.message.split('\\n')[0]}`);
        if (preference === 'sqlite3') throw new Error(errors.join('; '));
      }
    } else if (preference === 'sqlite3') {
      throw new Error('sqlite3 CLI not found');
    }
  }
  if (preference === 'auto' || preference === 'python') {
    const pythonPath = findPython3();
    if (pythonPath) {
      try { return wrapPythonSqlite(dbPath, pythonPath, writable); }
      catch (error) {
        errors.push(`Python sqlite3: ${error.message.split('\\n')[0]}`);
        if (preference === 'python') throw new Error(errors.join('; '));
      }
    } else if (preference === 'python') {
      throw new Error('python3 not found');
    }
  }
  throw new Error(`No usable SQLite backend: ${errors.join('; ') || 'no backend candidates found'}`);
}

function withDb(dbPath, writable, callback) {
  const db = openDb(dbPath, writable);
  try { return callback(db); } finally { db.close(); }
}

function tableColumns(db, table) {
  try { return new Set(db.columns(table)); } catch { return new Set(); }
}

function hasTable(db, table) {
  try { return db.tableExists(table); } catch { return false; }
}

function sanitizeFTSQuery(input) {
  const query = String(input || '').trim();
  let cleaned = query
    .replace(/[^\w\s"()*\-+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) cleaned = query.replace(/[^\w\s]/g, ' ').trim();
  const tokens = cleaned.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map(token => {
    if (token.startsWith('"') && token.endsWith('"')) return token;
    if (/^(AND|OR|NOT|NEAR)$/i.test(token)) return token;
    return /[-+]/.test(token) ? `"${token.replaceAll('"', '')}"` : token;
  }).join(' ') || '""';
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }] };
}

function resultText(rows, query) {
  if (!rows.length) return `No results found for "${query}".`;
  const parts = rows.map((row, index) => {
    const content = row.section_content || row.content || row.body || row.value || '(empty)';
    const excerpt = content.length > 700 ? `${content.slice(0, 700)}...` : content;
    const title = row.title || row.heading || row.slug || row.key || row.day || '(untitled)';
    const date = row.updated_at || row.created_at || row.day || 'unknown date';
    const score = row.relevance === undefined || row.relevance === null
      ? 'N/A' : Number(row.relevance).toFixed(2);
    return [
      `### ${index + 1}. ${title} (score: ${score})`,
      `**ID**: ${row.id ?? row.section_id ?? row.rowid ?? '(section)'} | **Date**: ${date}`,
      row.concept_slug || row.slug ? `**Slug**: ${row.concept_slug || row.slug}` : '',
      row.tags ? `**Tags**: ${row.tags}` : '',
      '', excerpt, '---',
    ].filter(Boolean).join('\n');
  });
  return [`## Results for "${query}"`, '', parts.join('\n'), `_Results ${rows.length}._`].join('\n');
}

function canonicalRecall(db, query, limit, recencyBias) {
  if (!hasTable(db, 'memory_sections')) return [];
  const hasConcepts = hasTable(db, 'memory_concepts');
  const columns = hasConcepts ? tableColumns(db, 'memory_concepts') : new Set();
  const conceptJoin = hasConcepts ? 'LEFT JOIN memory_concepts c ON c.slug = s.slug' : '';
  const conceptColumn = (name, alias = name) => hasConcepts && columns.has(name)
    ? `c.${name} AS ${alias}`
    : `NULL AS ${alias}`;
  const conceptColumns = [
    hasConcepts ? 'c.rowid AS id' : 'NULL AS id',
    conceptColumn('slug', 'concept_slug'),
    conceptColumn('title'),
    conceptColumn('lead'),
    conceptColumn('body'),
    conceptColumn('tags'),
    conceptColumn('source'),
    conceptColumn('confidence'),
    conceptColumn('created_at'),
    conceptColumn('updated_at'),
  ].join(', ');
  const updatedAt = hasConcepts && columns.has('updated_at') ? 'c.updated_at' : 'NULL';
  const sql = `
    SELECT s.rowid AS section_id, s.slug, s.heading, s.content AS section_content, s.position,
           ${conceptColumns}, r.relevance
      FROM memory_sections s
      ${conceptJoin}
      JOIN (
        SELECT rowid, bm25(memory_sections) AS relevance
          FROM memory_sections
         WHERE memory_sections MATCH @query
      ) r ON r.rowid = s.rowid
     ORDER BY r.relevance * (1.0 - @recencyBias)
              + COALESCE((julianday('now') - julianday(${updatedAt})) / 365.0, 0) * @recencyBias
     LIMIT @limit`;
  return db.all(sql, { query: sanitizeFTSQuery(query), limit, recencyBias });
}

function legacyRecall(db, query, limit) {
  for (const pair of [['memories_fts', 'memories'], ['memory_fts', 'memory']]) {
    const [fts, table] = pair;
    if (!hasTable(db, fts) || !hasTable(db, table)) continue;
    const sql = `
      SELECT m.id, m.content, m.category, m.topic, m.tags, m.created_at, r.relevance
        FROM ${table} m
        JOIN (SELECT rowid, bm25(${fts}) AS relevance FROM ${fts} WHERE ${fts} MATCH @query) r
          ON m.id = r.rowid
       ORDER BY relevance LIMIT @limit`;
    return db.all(sql, { query: sanitizeFTSQuery(query), limit });
  }
  return [];
}

function likeRecall(db, query, limit) {
  const needle = `%${query}%`;
  const rows = [];
  if (hasTable(db, 'memory_concepts')) {
    const columns = tableColumns(db, 'memory_concepts');
    const searchable = ['title', 'slug', 'lead', 'body', 'tags'].filter(column => columns.has(column));
    if (searchable.length) {
      const select = [
        'rowid AS id',
        ...['slug', 'title', 'lead', 'body', 'tags', 'source', 'confidence', 'created_at', 'updated_at']
          .map(column => columns.has(column) ? column : `NULL AS ${column}`),
        `CASE WHEN ${columns.has('title') ? 'title' : "''"} LIKE @needle THEN 1.0 WHEN ${columns.has('body') ? 'body' : "''"} LIKE @needle THEN 0.7 ELSE 0.4 END AS relevance`,
        columns.has('body') ? 'body AS content' : "'' AS content",
      ].join(', ');
      const order = columns.has('updated_at') ? 'updated_at DESC' : 'rowid DESC';
      rows.push(...db.all(`SELECT ${select} FROM memory_concepts WHERE ${searchable.map(column => `${column} LIKE @needle`).join(' OR ')} ORDER BY relevance DESC, ${order} LIMIT @limit`, { needle, limit }));
    }
  }
  for (const table of ['memory_essentials', 'memory_buffer', 'memory_archive']) {
    if (!hasTable(db, table)) continue;
    const columns = tableColumns(db, table);
    const searchable = ['content', 'value', 'context', 'key'].filter(column => columns.has(column));
    if (!searchable.length) continue;
    const where = searchable.map(column => `${column} LIKE @needle`).join(' OR ');
    rows.push(...db.all(`SELECT *, 0.2 AS relevance FROM ${table} WHERE ${where} LIMIT @limit`, { needle, limit }));
  }
  return rows.slice(0, limit);
}

function canonicalSupplementRecall(db, query, limit) {
  // Sections are the ranked canonical lane. These tables are canonical too,
  // but are not FTS5 sources; include matching facts/directives and essentials
  // rather than hiding them whenever a section match exists.
  const needle = `%${query}%`;
  const rows = [];
  for (const table of ['memory_essentials', 'memory_buffer', 'memory_archive']) {
    if (!hasTable(db, table)) continue;
    const columns = tableColumns(db, table);
    const searchable = ['content', 'value', 'context', 'key'].filter(column => columns.has(column));
    if (!searchable.length) continue;
    const where = searchable.map(column => `${column} LIKE @needle`).join(' OR ');
    rows.push(...db.all(
      `SELECT rowid AS _rowid, *, 0.15 AS relevance, @table AS memory_source FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT @limit`,
      { needle, table, limit },
    ));
  }
  return rows.slice(0, limit);
}

function handleMemoryRecall(dbPath, args) {
  const query = String(args?.query || '').trim();
  const limit = Math.min(Math.max(Number.parseInt(args?.max_results, 10) || 10, 1), 20);
  const recencyBias = Math.min(Math.max(Number.parseFloat(args?.recency_bias) || 0.3, 0), 1);
  if (!query) return textResult('Please provide a search query.');

  return withDb(dbPath, false, db => {
    let rows = [];
    try { rows = canonicalRecall(db, query, limit, recencyBias); } catch (error) {
      writeError(`Canonical FTS recall failed: ${error.message}`);
    }
    if (!rows.length) {
      try { rows = legacyRecall(db, query, limit); } catch (error) {
        writeError(`Legacy FTS recall failed: ${error.message}`);
      }
    }
    if (!rows.length) {
      try { rows = likeRecall(db, query, limit); } catch (error) {
        return textResult(`Search failed: ${error.message}`);
      }
    } else {
      try { rows = rows.concat(canonicalSupplementRecall(db, query, limit)); } catch (error) {
        writeError(`Canonical supplement recall failed: ${error.message}`);
      }
    }
    return textResult(resultText(rows.slice(0, limit), query));
  });
}

function formatCanonicalConcept(db, concept) {
  let sections = [];
  if (hasTable(db, 'memory_sections')) {
    sections = db.all(
      'SELECT rowid, slug, heading, content, position FROM memory_sections WHERE slug = @slug ORDER BY position',
      { slug: concept.slug },
    );
  }
  return [
    `## Memory Concept #${concept.id ?? concept.rowid ?? '(row)'}`,
    '',
    `**Title**: ${concept.title || '(untitled)'}`,
    `**Slug**: ${concept.slug || '(none)'}`,
    concept.source ? `**Source**: ${concept.source}` : '',
    concept.confidence !== undefined && concept.confidence !== null ? `**Confidence**: ${concept.confidence}` : '',
    `**Tags**: ${concept.tags || '(none)'}`,
    `**Created**: ${concept.created_at || 'unknown'}`,
    `**Updated**: ${concept.updated_at || 'unknown'}`,
    '',
    concept.lead || '',
    concept.body || '',
    sections.length ? `\n### Sections\n\n${sections.map(section => `#### ${section.heading || '(untitled)'}\n\n${section.content || ''}`).join('\n\n')}` : '',
  ].filter(Boolean).join('\n');
}

function handleMemoryRead(dbPath, args) {
  const id = Number.parseInt(args?.id, 10);
  if (!Number.isInteger(id) || id < 1) return textResult('Please provide a valid numeric memory entry ID.');

  return withDb(dbPath, false, db => {
    if (hasTable(db, 'memory_concepts')) {
      const concept = db.get('SELECT rowid AS id, * FROM memory_concepts WHERE rowid = @id', { id });
      if (concept) return textResult(formatCanonicalConcept(db, concept));
    }
    if (hasTable(db, 'memory_sections')) {
      const section = db.get('SELECT rowid, * FROM memory_sections WHERE rowid = @id', { id });
      if (section) return textResult([
        `## Memory Section #${section.rowid}`,
        `**Slug**: ${section.slug || '(none)'}`,
        `**Heading**: ${section.heading || '(untitled)'}`,
        '', section.content || '',
      ].join('\n'));
    }
    for (const table of ['memory_essentials', 'memory_buffer', 'memory_archive', 'memories', 'memory']) {
      if (!hasTable(db, table)) continue;
      const row = db.get(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid = @id`, { id });
      if (!row) continue;
      const content = row.content || row.value || row.body || '(empty)';
      return textResult(`## Memory Entry #${row.id ?? row._rowid}\n\n${content}\n\nMetadata:\n${json(row)}`);
    }
    return textResult(`No memory entry found with ID ${id}.`);
  });
}

function isoNow() { return new Date().toISOString(); }
function dayNow() { return isoNow().slice(0, 10); }

function insertSql(table, columns, values) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(column => `@${column}`).join(', ')})`;
}

function buildWriteRows(db, operation, args) {
  const now = isoNow();
  const scope = String(args?.scope || '').trim().toLowerCase();
  if (!['global', 'project'].includes(scope)) throw new Error('scope must be global or project');
  const workspacePath = args?.workspace_path ? String(args.workspace_path) : null;
  if (scope === 'project' && !workspacePath) throw new Error('project scope requires workspace_path');

  const slug = String(args?.slug || '').trim();
  const title = args?.title === undefined || args.title === null ? null : String(args.title).trim();
  const section = args?.section === undefined || args.section === null ? null : String(args.section);
  const requestedContent = args?.content === undefined || args.content === null ? null : String(args.content);
  const match = args?.match === undefined || args.match === null ? null : String(args.match);
  const replacement = args?.replacement === undefined || args.replacement === null ? null : String(args.replacement);
  const reason = args?.reason === undefined || args.reason === null ? null : String(args.reason);

  if (!slug) throw new Error(`${operation} requires slug`);
  if (operation === 'upsert' && (!title || requestedContent === null)) {
    throw new Error('upsert requires title and content');
  }
  if (operation === 'append' && requestedContent === null) throw new Error('append requires content');
  if (operation === 'forget' && match === null) throw new Error('forget requires match');

  const directive = {
    version: 1,
    op: operation,
    slug,
    title,
    section,
    content: operation === 'forget' ? null : requestedContent,
    match,
    replacement,
    reason,
    scope,
    requestedAt: now,
  };
  const content = JSON.stringify(directive);
  const metadata = {
    source: 'mcp-explicit',
    provenance: 'mcp-explicit',
    operation,
    workspace_path: workspacePath,
    requested_at: now,
    request: directive,
  };
  const metadataJson = JSON.stringify(metadata);
  const bufferColumns = tableColumns(db, 'memory_buffer');
  const archiveColumns = tableColumns(db, 'memory_archive');
  if (!bufferColumns.has('content')) throw new Error('Canonical memory_buffer.content is missing');
  if (!archiveColumns.has('content')) throw new Error('Canonical memory_archive.content is missing');

  const bufferValues = {
    content,
    context: `explicit-memory:${operation}:${slug}`,
    source: 'mcp-explicit',
    confidence: args?.confidence ?? 1,
    consolidated: 0,
    created_at: now,
    updated_at: now,
    workspace_path: workspacePath,
  };
  const archiveValues = {
    day: dayNow(),
    ts: now,
    kind: operation === 'forget' ? 'correction' : 'fact',
    content,
    metadata: metadataJson,
    context: metadataJson,
    created_at: now,
    workspace_path: workspacePath,
    source: 'mcp-explicit',
    provenance: 'mcp-explicit',
  };
  const bufferKeys = Object.keys(bufferValues).filter(key => bufferColumns.has(key));
  const archiveKeys = Object.keys(archiveValues).filter(key => archiveColumns.has(key));
  if (!bufferKeys.includes('source')) throw new Error('Canonical memory_buffer.source is missing');
  if (!archiveKeys.includes('metadata') && !archiveKeys.includes('context')) {
    throw new Error('Canonical memory_archive metadata/context provenance column is missing');
  }

  return {
    content,
    context: metadataJson,
    bufferSql: insertSql('memory_buffer', bufferKeys, bufferValues),
    bufferParams: Object.fromEntries(bufferKeys.map(key => [key, bufferValues[key]])),
    archiveSql: insertSql('memory_archive', archiveKeys, archiveValues),
    archiveParams: Object.fromEntries(archiveKeys.map(key => [key, archiveValues[key]])),
    metadata,
  };
}

function executeWrite(dbPath, operation, args) {
  return withDb(dbPath, true, db => {
    if (!hasTable(db, 'memory_buffer') || !hasTable(db, 'memory_archive')) {
      throw new Error('Canonical memory_buffer and memory_archive tables are required for writable MCP tools');
    }
    const rows = buildWriteRows(db, operation, args);
    let ids;
    if (db.kind === 'sqlite3-cli') {
      ids = db.dualWrite(
        rows.bufferSql,
        rows.bufferParams,
        rows.archiveSql,
        rows.archiveParams,
      );
    } else if (db.kind === 'python-sqlite3') {
      ids = db.dualWrite(
        rows.bufferSql,
        rows.bufferParams,
        rows.archiveSql,
        rows.archiveParams,
      );
    } else {
      ids = db.transaction(() => {
        const buffer = db.get(`${rows.bufferSql} RETURNING id`, rows.bufferParams);
        const archive = db.get(`${rows.archiveSql} RETURNING id`, rows.archiveParams);
        return { buffer_id: buffer?.id ?? null, archive_id: archive?.id ?? null };
      });
    }
    return textResult({
      ok: true,
      operation,
      source: 'mcp-explicit',
      buffer_id: ids.buffer_id ?? null,
      archive_id: ids.archive_id ?? null,
      workspace_path: args?.workspace_path || null,
      message: 'Directive/fact enqueued in memory_buffer and dual-written to immutable memory_archive; canonical concepts were not mutated.',
    });
  });
}

const TOOLS = [
  {
    name: 'farnsworth_memory_recall',
    description: 'Search canonical Farnsworth memory_sections and memory_concepts, with legacy and LIKE fallbacks.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Natural language memory search query.' },
      max_results: { type: 'number', default: 10, maximum: 20 },
      recency_bias: { type: 'number', default: 0.3, minimum: 0, maximum: 1 },
    }, required: ['query'] },
  },
  {
    name: 'farnsworth_memory_read',
    description: 'Read a canonical memory concept or section by numeric ID, with legacy fallbacks.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'farnsworth_memory_upsert',
    description: 'Enqueue an explicit consolidation directive targeting a canonical concept slug/title. Does not mutate memory_concepts directly.',
    inputSchema: { type: 'object', properties: {
      slug: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
      section: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] },
      workspace_path: { type: 'string' },
    }, required: ['slug', 'title', 'content', 'scope'] },
  },
  {
    name: 'farnsworth_memory_append',
    description: 'Enqueue an explicit fact or directive in memory_buffer and immutable memory_archive.',
    inputSchema: { type: 'object', properties: {
      slug: { type: 'string' }, content: { type: 'string' }, section: { type: 'string' },
      scope: { type: 'string', enum: ['global', 'project'] }, workspace_path: { type: 'string' },
    }, required: ['slug', 'content', 'scope'] },
  },
  {
    name: 'farnsworth_memory_forget',
    description: 'Enqueue an explicit correction or supersession directive; canonical concepts are changed only by consolidation.',
    inputSchema: { type: 'object', properties: {
      slug: { type: 'string' }, match: { type: 'string' }, replacement: { type: 'string' },
      reason: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] },
      workspace_path: { type: 'string' },
    }, required: ['slug', 'match', 'scope'] },
  },
];

const config = parseArgs();
if (config.mode === 'check') {
  writeError(`Farnsworth MCP Server syntax OK (${TOOLS.length} tools).`);
  process.exit(0);
}
if (!config.dbPath) {
  writeError('No DB path provided. Use --db <path> or FARNSWORTH_MCP_DB_PATH.');
  process.exit(1);
}
if (!existsSync(config.dbPath)) {
  writeError(`DB file not found: ${config.dbPath}`);
  process.exit(1);
}

let nextId = 1;
let transportMode = null;
function writeMessage(message) {
  const body = JSON.stringify(message);
  if (transportMode === 'jsonl') process.stdout.write(`${body}\n`);
  else process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
function respond(id, result) { writeMessage({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message, data) { writeMessage({ jsonrpc: '2.0', id, error: { code, message, data } }); }

async function handleRequest(request) {
  const id = request.id ?? nextId++;
  switch (request.method) {
    case 'initialize':
      respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'farnsworth-mcp-server', version: '0.2.0' } });
      break;
    case 'notifications/initialized':
      break;
    case 'ping':
      respond(id, {});
      break;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      try {
        let result;
        if (name === 'farnsworth_memory_recall') result = handleMemoryRecall(config.dbPath, args);
        else if (name === 'farnsworth_memory_read') result = handleMemoryRead(config.dbPath, args);
        else if (name === 'farnsworth_memory_upsert') result = executeWrite(config.dbPath, 'upsert', args);
        else if (name === 'farnsworth_memory_append') result = executeWrite(config.dbPath, 'append', args);
        else if (name === 'farnsworth_memory_forget') result = executeWrite(config.dbPath, 'forget', args);
        else { respondError(id, -32601, `Tool not found: ${name}`); break; }
        respond(id, result);
      } catch (error) {
        respondError(id, -32603, `Tool execution error: ${error.message}`);
      }
      break;
    }
    default:
      respondError(id, -32601, `Method not found: ${request.method}`);
  }
}

let inputBuffer = Buffer.alloc(0);
let requestQueue = Promise.resolve();
function queueRequest(body) {
  requestQueue = requestQueue.then(async () => {
    try { await handleRequest(JSON.parse(body)); }
    catch (error) { writeError(`Request failed: ${error.message}`); }
  });
}
process.stdin.on('data', chunk => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  while (true) {
    if (!transportMode) {
      const first = inputBuffer.findIndex(byte => ![9, 10, 13, 32].includes(byte));
      if (first < 0) break;
      transportMode = inputBuffer.subarray(first, first + 1).toString('ascii') === '{' ? 'jsonl' : 'framed';
    }
    if (transportMode === 'jsonl') {
      const newline = inputBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const body = inputBuffer.subarray(0, newline).toString('utf8').trim();
      inputBuffer = inputBuffer.subarray(newline + 1);
      if (body) queueRequest(body);
      continue;
    }
    const headerEnd = inputBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) break;
    const header = inputBuffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { inputBuffer = inputBuffer.subarray(headerEnd + 4); continue; }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + length) break;
    const body = inputBuffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    inputBuffer = inputBuffer.subarray(bodyStart + length);
    queueRequest(body);
  }
});

function shutdown() {
  requestQueue.finally(() => process.exit(0));
}
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

writeError('Farnsworth MCP Server v0.2.0 — stdio transport');
writeError(`DB: ${config.dbPath}`);
writeError(`Tool count: ${TOOLS.length}`);
