// Farnsworth — database
// SQLite-backed persistence for settings, folders, auth tokens, chat history, tasks, memory cache.
// Replaces flat JSON files (settings.json, recent.json, auth.bin) with proper queryable storage.
// Tokens are encrypted via Electron's safeStorage before being written.

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const Database = require('better-sqlite3');

let db = null;
let safeStorage = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recent_folders (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  provider TEXT PRIMARY KEY,
  access_token_encrypted BLOB,
  refresh_token_encrypted BLOB,
  expires_at TEXT,
  account_info TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  path TEXT PRIMARY KEY,
  app_type TEXT,
  config TEXT,
  last_opened TEXT
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_path TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  meta TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_ws ON chat_history(workspace_path);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,
  title TEXT NOT NULL,
  messages TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_ws ON chat_conversations(workspace_path);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON chat_conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_path TEXT,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  priority INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_path);

CREATE TABLE IF NOT EXISTS memory_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Cached AI-suggested JIRA-style tickets per game, so we don't have to
-- re-prompt the analyst every time the Live tab mounts. One row per
-- game_id; tickets stored as a JSON array. Updated by the Live panel's
-- "Refresh" button; loaded eagerly on Live tab mount.
CREATE TABLE IF NOT EXISTS live_tickets_cache (
  game_id TEXT PRIMARY KEY,
  tickets_json TEXT NOT NULL,
  raw_reply TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Cached Live-tab game detail (the subreddit-shaped object returned by
-- anomalyint's /api/reddit-games/<id>). One row per game_id; the data
-- column stores the raw API response as JSON. Rendered instantly on
-- tab mount, refreshed only when the user clicks the refresh icon
-- next to the Updated date.
CREATE TABLE IF NOT EXISTS live_game_cache (
  game_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Devvit emulator user library (global, workspace-agnostic). Seeded with
-- 5 default users on first init so a freshly-installed Farnsworth can
-- boot a devvit dev server with the loader without manual setup. UI
-- surfaces this list in the cogwheel popover; users can add/edit/remove.
CREATE TABLE IF NOT EXISTS devvit_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reddit_id TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  snoovatar_url TEXT,
  link_karma INTEGER DEFAULT 0,
  comment_karma INTEGER DEFAULT 0,
  is_employee INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Devvit emulator subreddit library (global). Seeded with one default
-- subreddit (r/long_dev). UI surfaces this in the cogwheel popover.
CREATE TABLE IF NOT EXISTS devvit_subreddits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reddit_id TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'public',
  member_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Per-project (per-workspace-path) settings: which user is "logged in"
-- for this devvit project + which subreddit it's running against. The
-- dev:farnsworth:boot IPC reads this row and writes it to a temp file
-- the loader hook reads on boot. Switching users mid-session writes
-- here and signals the subprocess to re-read.
CREATE TABLE IF NOT EXISTS devvit_project_settings (
  workspace_path TEXT PRIMARY KEY,
  current_user_id INTEGER REFERENCES devvit_users(id) ON DELETE SET NULL,
  current_subreddit_id INTEGER REFERENCES devvit_subreddits(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Memory system (Tier 1, Jul 5 2026) ----------
--
-- Six-layer memory pipeline compressed to a working subset for v1:
--   * essentials: always-loaded identity/preferences/corrections
--   * concepts:   long-form wiki-style articles (one per topic)
--   * buffer:     raw facts learned this session, awaits consolidation
--   * archive:    immutable daily log, never edited after write
--
-- Vector search (sqlite-vec) is deferred to Tier 2 — Tier 1 uses LIKE +
-- simple token matching for recall. The IPC surface is shaped so Tier 2
-- can swap in vec search without touching the renderer.

-- Always-loaded essentials. Each row is one short key→value pair
-- (e.g. 'long_prefers_pithy' → 'true'). Injected into the system
-- context at conversation start.
CREATE TABLE IF NOT EXISTS memory_essentials (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Concept files (long-form, wiki-style). Each row is one article.
-- 'lead' is the standalone first paragraph injected when the concept
-- is recalled. 'body' is the full markdown. 'sections' is a JSON array
-- of {heading, content} for granular retrieval.
CREATE TABLE IF NOT EXISTS memory_concepts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lead TEXT,
  body TEXT,
  sections TEXT,
  tags TEXT,
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_concepts_updated ON memory_concepts(updated_at DESC);

-- v3 section-grain index (Jul 12 2026). DERIVED data: the concept 'body'
-- column stays canonical; these rows are regenerated by
-- memoryRebuildSections() whenever a concept is written. Standalone FTS5
-- table (not external-content) so plain DELETE/INSERT keep it in sync and
-- MATCH gives bm25-ranked section-grain retrieval for the L2 selector.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_sections USING fts5(
  slug UNINDEXED, heading, content, position UNINDEXED
);

-- v3.1 conversations lane (Jul 12 2026). DERIVED: chat_conversations.messages
-- stays canonical; one FTS row per message, regenerated on every conversation
-- save (createConversation / saveConversation) and lazily backfilled at boot.
-- Gives past-chat recall alongside concept memory.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_conversations_fts USING fts5(
  conv_id UNINDEXED, title, content
);

-- Buffer: raw facts learned this session, awaits consolidation.
-- 'consolidated' flag flips to 1 when the consolidation job merges
-- this row into a concept (or drops it).
CREATE TABLE IF NOT EXISTS memory_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  context TEXT,
  source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  consolidated INTEGER DEFAULT 0,
  -- Declared here as well as in the ALTER migration below: the migration
  -- only fires for databases that already have the table, so a FRESH
  -- install would otherwise never get this column and every fact write
  -- would fail (the INSERT names workspace_path).
  workspace_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_buffer_unconsolidated ON memory_buffer(consolidated, created_at);

-- Archive: immutable daily log. Never edited after insert. 'kind' is
-- 'fact' | 'correction' | 'commitment' | 'plan' | 'note'.
CREATE TABLE IF NOT EXISTS memory_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  -- See the note on memory_buffer.workspace_path above.
  workspace_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_archive_day ON memory_archive(day);
CREATE INDEX IF NOT EXISTS idx_archive_kind ON memory_archive(kind);
CREATE INDEX IF NOT EXISTS idx_archive_ts ON memory_archive(ts DESC);
`;

// ---------- Memory Tier 2 schema (codebase indexer) ----------
//
// Two-part split:
//   1. CODEBASE_SCHEMA — always runs. Has the file/chunk/fts tables that
//      don't depend on sqlite-vec. The Tier 2 indexer works even when
//      embeddings are unavailable (FTS5 is the search path in that case).
//   2. VEC_SCHEMA — only runs when sqlite-vec loads successfully. Has the
//      vec0 virtual tables for cosine-distance search. The dimension is
//      fixed at 384 because all-MMiniLM-L6-v2 is the embedding model
//      (matches /embed/embed-worker.mjs).
const CODEBASE_SCHEMA = `
-- Per-file code chunks. One row per chunk (a chunk = ~512 chars of source).
-- (workspace_path, file_path, chunk_index) is unique. file_hash lets the
-- incremental indexer skip unchanged files.
CREATE TABLE IF NOT EXISTS memory_code_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_path, file_path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON memory_code_chunks(workspace_path, file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON memory_code_chunks(file_hash);

-- FTS5 full-text search on chunk_text. Contentless — we manually populate
-- via insert into memory_code_fts(rowid, chunk_text) when chunks are
-- written (or rebuilt on demand). This is the Tier 2 fallback path when
-- sqlite-vec isn't available — keeps recall working on macOS where
-- onnxruntime BFCArena crashes prevent embeddings from loading.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_code_fts USING fts5(
  chunk_text,
  content='',
  tokenize='unicode61'
);

-- Track which files have been indexed + their last content hash.
-- Lets the file watcher decide whether a change actually needs re-indexing.
CREATE TABLE IF NOT EXISTS memory_indexed_files (
  workspace_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0,
  last_indexed TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_path, file_path)
);
CREATE INDEX IF NOT EXISTS idx_indexed_folder ON memory_indexed_files(workspace_path);
`;

const VEC_SCHEMA = `
-- Per-concept embeddings. One row per concept_slug. Looked up via
-- memory_vec_map. vec0 virtual table does the cosine-distance similarity
-- search at query time.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  vec_id INTEGER PRIMARY KEY,
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS memory_vec_map (
  vec_id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Embeddings for code chunks. chunk_id matches memory_code_chunks.id.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_code_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[384]
);
`;

function init(userDataPath, electronSafeStorage) {
  if (db) return db;
  safeStorage = electronSafeStorage;
  const dbPath = path.join(userDataPath, 'farnsworth.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Idempotent migrations for columns added after the initial schema.
  // Each ALTER fails harmlessly if the column already exists — SQLite
  // doesn't support IF NOT EXISTS on ADD COLUMN.
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(r => r.name);
  if (!taskCols.includes('source')) {
    try { db.exec('ALTER TABLE tasks ADD COLUMN source TEXT'); } catch (_) {}
  }
  if (!taskCols.includes('assignee')) {
    try { db.exec("ALTER TABLE tasks ADD COLUMN assignee TEXT DEFAULT 'blue'"); } catch (_) {}
  }
  if (!taskCols.includes('file_link')) {
    try { db.exec('ALTER TABLE tasks ADD COLUMN file_link TEXT'); } catch (_) {}
  }
  // Per-folder provenance for conversational memory (Aug 1 2026). The Tier 2
  // code index was always per-workspace (workspace_path is part of
  // memory_indexed_files' primary key), but facts were fully global — there
  // was no way to tell a the-last-draft fact from a dontdie-reddit one.
  // These columns record WHERE a fact came from; recall still spans projects
  // so identity/preference facts stay global.
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Runs AFTER the schema so it works on both paths: a fresh database gets
  // the column from CREATE TABLE and this is a no-op, while a database
  // created before Aug 1 2026 gets it added here. Ordered before SCHEMA it
  // silently skipped fresh installs -- PRAGMA table_info on a table that
  // doesn't exist yet returns nothing, the `cols.length` guard treats that
  // as "nothing to migrate", and the column was never created.
  for (const [table, col] of [['memory_buffer', 'workspace_path'], ['memory_archive', 'workspace_path']]) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
      if (cols.length && !cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    } catch (_) {}
  }
  // Always create the codebase indexer tables (Tier 2 baseline). These
  // don't depend on sqlite-vec — they're the FTS5 search path when vec
  // is unavailable (e.g. macOS where onnxruntime BFCArena crashes
  // prevent embeddings from loading).
  db.exec(CODEBASE_SCHEMA);
  // Try loading sqlite-vec (Tier 2 vector search). Failure is non-fatal
  // — FTS5-based recall continues to work without it.
  const vecPath = path.join(__dirname, 'native', 'vec0.dylib');
  vecAvailable = false;
  try {
    if (fsSync.existsSync(vecPath)) {
      db.loadExtension(vecPath);
      vecAvailable = true;
      console.log('[db] sqlite-vec loaded from', vecPath);
    } else {
      console.warn('[db] sqlite-vec dylib not found at', vecPath, '— using FTS5-only Tier 2');
    }
  } catch (e) {
    console.warn('[db] sqlite-vec load failed — using FTS5-only Tier 2:', e.message);
  }
  if (vecAvailable) {
    db.exec(VEC_SCHEMA);
    // NOTE: backfillConceptEmbeddings() is intentionally NOT called here.
    // Spawning the embed worker at init crashed onnxruntime BFCArena on
    // macOS 26.5.1 (Jul 6 ~21:05 ET). Embeddings now run lazily — first
    // memoryRecall() call attempts to embed the query, and if that fails
    // (worker dies), we degrade to FTS5-only. The Tier 2 codebase indexer
    // still works via memory_code_fts; just no concept embeddings until
    // onnxruntime fixes the allocator bug upstream.
    console.log('[db] sqlite-vec loaded — embeddings will run lazily on first memoryRecall()');
  } else {
    console.log('[db] Tier 2: FTS5-only mode (codebase recall works via text search)');
  }
  // Seed devvit emulator defaults (5 users + 1 subreddit) on first init.
  // Idempotent — only runs when the user/subreddit tables are empty.
  devvitSeedDefaults();
  // v3 sections: build the derived section index on first boot after the
  // migration (idempotent — skips when rows already exist).
  try { memoryRebuildAllSections(false); } catch (e) { console.warn('[memory v3] boot rebuild failed:', e.message); }
  try { memoryEnsureLanes(); } catch (e) { console.warn('[memory v3.1] lane ensure failed:', e.message); }
  try { memoryBackfillWorkspacePaths(); } catch (e) { console.warn('[memory] workspace backfill failed:', e.message); }
  try { memoryRebuildAllConversationsFts(false); } catch (e) { console.warn('[memory v3.1] conversations fts backfill failed:', e.message); }
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

// ---------- Encryption helpers ----------
function encrypt(plain) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return Buffer.from(plain, 'utf8');
  return safeStorage.encryptString(plain);
}

function decrypt(cipher) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return cipher.toString('utf8');
  return safeStorage.decryptString(cipher);
}

// ---------- Settings ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

// Clearing a setting must REMOVE the row. setSetting(key, null) used to run
// JSON.stringify(null) and store the literal string 'null', which every
// reader then saw as a truthy value -- e.g. a workspace path named 'null'.
function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function setAllSettings(obj) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) setSetting(k, v);
  });
  tx(Object.entries(obj));
}

// ---------- Recent folders ----------
function getRecentFolders(limit = 10) {
  return db.prepare('SELECT path, name, opened_at FROM recent_folders ORDER BY opened_at DESC LIMIT ?').all(limit);
}

function addRecentFolder(folderPath, name) {
  db.prepare(`
    INSERT INTO recent_folders (path, name, opened_at) VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET name = excluded.name, opened_at = excluded.opened_at
  `).run(folderPath, name, new Date().toISOString());
  // Trim to 10 most recent
  db.prepare(`
    DELETE FROM recent_folders WHERE path NOT IN (
      SELECT path FROM recent_folders ORDER BY opened_at DESC LIMIT 10
    )
  `).run();
}

function clearRecentFolders() {
  db.prepare('DELETE FROM recent_folders').run();
}

// ---------- Auth tokens ----------
function setAuthToken(provider, accessToken, refreshToken, expiresAt, accountInfo) {
  const accessEnc = encrypt(accessToken);
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const accountJson = accountInfo ? JSON.stringify(accountInfo) : null;
  db.prepare(`
    INSERT INTO auth_tokens (provider, access_token_encrypted, refresh_token_encrypted, expires_at, account_info, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      access_token_encrypted = excluded.access_token_encrypted,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      expires_at = excluded.expires_at,
      account_info = excluded.account_info,
      updated_at = CURRENT_TIMESTAMP
  `).run(provider, accessEnc, refreshEnc, expiresAt, accountJson);
}

function getAuthToken(provider) {
  const row = db.prepare(`
    SELECT access_token_encrypted, refresh_token_encrypted, expires_at, account_info
    FROM auth_tokens WHERE provider = ?
  `).get(provider);
  if (!row) return null;
  return {
    accessToken: decrypt(row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted ? decrypt(row.refresh_token_encrypted) : null,
    expiresAt: row.expires_at,
    accountInfo: row.account_info ? JSON.parse(row.account_info) : null,
  };
}

function deleteAuthToken(provider) {
  db.prepare('DELETE FROM auth_tokens WHERE provider = ?').run(provider);
}

// ---------- Chat history ----------
function getChatHistory(workspacePath, limit = 100) {
  return db.prepare(`
    SELECT id, role, content, model, meta, created_at
    FROM chat_history WHERE workspace_path = ?
    ORDER BY id ASC LIMIT ?
  `).all(workspacePath, limit);
}

function addChatMessage(workspacePath, role, content, model, meta) {
  db.prepare(`
    INSERT INTO chat_history (workspace_path, role, content, model, meta)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspacePath, role, content, model || null, meta ? JSON.stringify(meta) : null);
}

function clearChatHistory(workspacePath) {
  db.prepare('DELETE FROM chat_history WHERE workspace_path = ?').run(workspacePath);
}

// ---------- Chat conversations (saved threads, switchable from the UI) ----------
function listConversations(workspacePath, limit = 100) {
  return db.prepare(`
    SELECT id, workspace_path, title, created_at, updated_at
    FROM chat_conversations
    WHERE workspace_path = ? OR workspace_path IS NULL
    ORDER BY updated_at DESC LIMIT ?
  `).all(workspacePath, limit);
}

function getConversation(id) {
  return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
}

function createConversation(id, workspacePath, title, messages) {
  db.prepare(`
    INSERT INTO chat_conversations (id, workspace_path, title, messages)
    VALUES (?, ?, ?, ?)
  `).run(id, workspacePath || null, title, JSON.stringify(messages || []));
  memoryRebuildConversationFts(id, title, messages || []);
}

function saveConversation(id, title, messages) {
  db.prepare(`
    UPDATE chat_conversations
    SET title = ?, messages = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, JSON.stringify(messages || []), id);
  memoryRebuildConversationFts(id, title, messages || []);
}

function deleteConversation(id) {
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM memory_conversations_fts WHERE conv_id = ?').run(id); } catch {}
}

// All conversations regardless of workspace — the retrospective sweep's
// candidate list (listConversations filters by workspace_path).
function listAllConversations(limit = 100) {
  return db.prepare(`
    SELECT id, title, updated_at FROM chat_conversations
    ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
}

function touchConversation(id) {
  db.prepare('UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

// ---------- Tasks ----------
function getTasks(workspacePath) {
  return workspacePath
    ? db.prepare('SELECT * FROM tasks WHERE workspace_path = ? ORDER BY priority ASC, id ASC').all(workspacePath)
    : db.prepare('SELECT * FROM tasks ORDER BY priority ASC, id ASC').all();
}

function addTask(workspacePath, status, title, detail, priority, source, assignee, fileLink) {
  const info = db.prepare(`
    INSERT INTO tasks (workspace_path, status, title, detail, priority, source, assignee, file_link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspacePath || '',
    status,
    title,
    detail || null,
    priority || 0,
    source || null,
    assignee || 'blue',
    fileLink || null
  );
  return info.lastInsertRowid;
}

function updateTask(id, fields) {
  const allowed = ['status', 'title', 'detail', 'priority', 'source', 'assignee', 'file_link'];
  const updates = [];
  const values = [];
  for (const k of allowed) {
    if (k in fields) {
      updates.push(`${k} = ?`);
      values.push(fields[k]);
    }
  }
  if (!updates.length) return;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ---------- OAuth state (short-lived PKCE storage) ----------
function putOAuthState(state, codeVerifier, redirectUri) {
  db.prepare(`
    INSERT INTO oauth_state (state, code_verifier, redirect_uri) VALUES (?, ?, ?)
    ON CONFLICT(state) DO UPDATE SET code_verifier = excluded.code_verifier, redirect_uri = excluded.redirect_uri
  `).run(state, codeVerifier, redirectUri);
}

function consumeOAuthState(state) {
  const row = db.prepare('SELECT code_verifier, redirect_uri FROM oauth_state WHERE state = ?').get(state);
  if (row) {
    db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
    return row;
  }
  return null;
}

// Non-destructive read — loopback callback flow uses this so the row stays
// available if the user wants to fall back to manual code-paste later.
function getOAuthState(state) {
  return db.prepare('SELECT code_verifier, redirect_uri FROM oauth_state WHERE state = ?').get(state) || null;
}

function cleanupOAuthState() {
  // Drop entries older than 10 minutes
  db.prepare("DELETE FROM oauth_state WHERE created_at < datetime('now', '-10 minutes')").run();
}

// ---------- Migration from legacy JSON files ----------
async function migrateLegacy(userDataPath) {
  // settings.json → settings table
  try {
    const legacySettings = JSON.parse(await fs.readFile(path.join(userDataPath, 'settings.json'), 'utf8'));
    if (legacySettings && typeof legacySettings === 'object') {
      setAllSettings(Object.entries(legacySettings));
      await fs.unlink(path.join(userDataPath, 'settings.json')).catch(() => {});
    }
  } catch {}

  // recent.json → recent_folders table
  try {
    const legacyRecent = JSON.parse(await fs.readFile(path.join(userDataPath, 'recent.json'), 'utf8'));
    if (Array.isArray(legacyRecent)) {
      for (const r of legacyRecent) {
        if (r && r.path && r.name) {
          addRecentFolder(r.path, r.name);
        }
      }
      await fs.unlink(path.join(userDataPath, 'recent.json')).catch(() => {});
    }
  } catch {}

  // auth.bin → auth_tokens table (anthropic-console provider, encrypted bytes are already encrypted)
  try {
    const authBin = await fs.readFile(path.join(userDataPath, 'auth.bin'));
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      try {
        const plaintext = safeStorage.decryptString(authBin);
        setAuthToken('anthropic-console', plaintext, null, null, { source: 'api_key', migrated: true });
      } catch {}
    }
    await fs.unlink(path.join(userDataPath, 'auth.bin')).catch(() => {});
  } catch {}
}

function getLiveTickets(gameId) {
  if (!db || !gameId) return null;
  try {
    const row = db.prepare('SELECT tickets_json, raw_reply, updated_at FROM live_tickets_cache WHERE game_id = ?').get(gameId);
    if (!row) return null;
    return {
      tickets: JSON.parse(row.tickets_json),
      rawReply: row.raw_reply || null,
      updatedAt: row.updated_at,
    };
  } catch (e) {
    return null;
  }
}

function saveLiveTickets(gameId, tickets, rawReply) {
  if (!db || !gameId) return { ok: false };
  try {
    db.prepare(`
      INSERT INTO live_tickets_cache (game_id, tickets_json, raw_reply, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(game_id) DO UPDATE SET
        tickets_json = excluded.tickets_json,
        raw_reply = excluded.raw_reply,
        updated_at = CURRENT_TIMESTAMP
    `).run(gameId, JSON.stringify(tickets || []), rawReply || null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clearLiveTickets(gameId) {
  if (!db || !gameId) return { ok: false };
  try {
    db.prepare('DELETE FROM live_tickets_cache WHERE game_id = ?').run(gameId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Live game detail cache ----------
// Read-through cache for the Live tab's primary payload (game + events +
// sentiment + posts). Rendered instantly from DB on tab mount; the
// refresh icon next to the Updated date forces a refetch + writes back.
function getLiveGameCache(gameId) {
  if (!db || !gameId) return null;
  const row = db.prepare('SELECT data_json, fetched_at FROM live_game_cache WHERE game_id = ?').get(gameId);
  if (!row) return null;
  try { return { data: JSON.parse(row.data_json), fetched_at: row.fetched_at }; }
  catch { return null; }
}

function saveLiveGameCache(gameId, data) {
  if (!db || !gameId) return { ok: false, error: 'no_db_or_id' };
  try {
    db.prepare(`
      INSERT INTO live_game_cache (game_id, data_json, fetched_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(game_id) DO UPDATE SET
        data_json = excluded.data_json,
        fetched_at = CURRENT_TIMESTAMP
    `).run(gameId, JSON.stringify(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clearLiveGameCache(gameId) {
  if (!db || !gameId) return { ok: false };
  try {
    db.prepare('DELETE FROM live_game_cache WHERE game_id = ?').run(gameId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Devvit emulator user library ----------
//
// The user/subreddit library is global — it lives across all devvit
// projects the user opens. Per-project (which user is "active" for a
// given folder) lives in devvit_project_settings and is keyed by
// workspace_path. The 5-default seeding runs once on first init() so a
// fresh Farnsworth install boots without a "no users" empty state.

const DEVVIT_DEFAULT_USERS = [
  { reddit_id: 't2_long001', username: 'u/long',     snoovatar_url: null, link_karma: 12500, comment_karma: 42000, is_employee: 0 },
  { reddit_id: 't2_alice01', username: 'u/alice',   snoovatar_url: null, link_karma: 12,    comment_karma: 8,     is_employee: 0 },
  { reddit_id: 't2_bob001',  username: 'u/bob',     snoovatar_url: null, link_karma: 340,   comment_karma: 1200,  is_employee: 0 },
  { reddit_id: 't2_carol01', username: 'u/carol',   snoovatar_url: null, link_karma: 8900,  comment_karma: 31000, is_employee: 0 },
  { reddit_id: 't2_dave001', username: 'u/dave',    snoovatar_url: null, link_karma: 67000, comment_karma: 110000,is_employee: 1 },
];

const DEVVIT_DEFAULT_SUBREDDITS = [
  { reddit_id: 't5_long001', name: 'r/long_dev', type: 'public', member_count: 1 },
];

function devvitSeedDefaults() {
  if (!db) return;
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM devvit_users').get().n;
  if (userCount === 0) {
    const ins = db.prepare(`
      INSERT INTO devvit_users (reddit_id, username, snoovatar_url, link_karma, comment_karma, is_employee)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows) => { for (const r of rows) ins.run(r.reddit_id, r.username, r.snoovatar_url, r.link_karma, r.comment_karma, r.is_employee); });
    tx(DEVVIT_DEFAULT_USERS);
  }
  const subCount = db.prepare('SELECT COUNT(*) AS n FROM devvit_subreddits').get().n;
  if (subCount === 0) {
    const ins = db.prepare(`
      INSERT INTO devvit_subreddits (reddit_id, name, type, member_count)
      VALUES (?, ?, ?, ?)
    `);
    const tx = db.transaction((rows) => { for (const r of rows) ins.run(r.reddit_id, r.name, r.type, r.member_count); });
    tx(DEVVIT_DEFAULT_SUBREDDITS);
  }
}

function devvitListUsers() {
  if (!db) return [];
  return db.prepare('SELECT id, reddit_id, username, snoovatar_url, link_karma, comment_karma, is_employee, created_at, updated_at FROM devvit_users ORDER BY username ASC').all();
}

function devvitUpsertUser(user) {
  if (!db || !user || !user.reddit_id || !user.username) return { ok: false, error: 'missing_reddit_id_or_username' };
  try {
    db.prepare(`
      INSERT INTO devvit_users (reddit_id, username, snoovatar_url, link_karma, comment_karma, is_employee, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(reddit_id) DO UPDATE SET
        username = excluded.username,
        snoovatar_url = excluded.snoovatar_url,
        link_karma = excluded.link_karma,
        comment_karma = excluded.comment_karma,
        is_employee = excluded.is_employee,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      user.reddit_id, user.username, user.snoovatar_url ?? null,
      Number(user.link_karma) || 0, Number(user.comment_karma) || 0,
      user.is_employee ? 1 : 0
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function devvitDeleteUser(id) {
  if (!db || !id) return { ok: false };
  try {
    db.prepare('DELETE FROM devvit_users WHERE id = ?').run(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function devvitListSubreddits() {
  if (!db) return [];
  return db.prepare('SELECT id, reddit_id, name, type, member_count, created_at, updated_at FROM devvit_subreddits ORDER BY name ASC').all();
}

function devvitUpsertSubreddit(sub) {
  if (!db || !sub || !sub.reddit_id || !sub.name) return { ok: false, error: 'missing_reddit_id_or_name' };
  try {
    db.prepare(`
      INSERT INTO devvit_subreddits (reddit_id, name, type, member_count, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(reddit_id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        member_count = excluded.member_count,
        updated_at = CURRENT_TIMESTAMP
    `).run(sub.reddit_id, sub.name, sub.type || 'public', Number(sub.member_count) || 0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function devvitDeleteSubreddit(id) {
  if (!db || !id) return { ok: false };
  try {
    db.prepare('DELETE FROM devvit_subreddits WHERE id = ?').run(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function devvitGetProjectSettings(workspacePath) {
  if (!db || !workspacePath) return null;
  const row = db.prepare(`
    SELECT s.workspace_path, s.current_user_id, s.current_subreddit_id, s.updated_at,
           u.username AS current_username, u.reddit_id AS current_reddit_id,
           sub.name AS current_subreddit_name, sub.reddit_id AS current_subreddit_reddit_id
    FROM devvit_project_settings s
    LEFT JOIN devvit_users u ON u.id = s.current_user_id
    LEFT JOIN devvit_subreddits sub ON sub.id = s.current_subreddit_id
    WHERE s.workspace_path = ?
  `).get(workspacePath);
  return row || null;
}

function devvitSetProjectSettings(workspacePath, currentUserId, currentSubredditId) {
  if (!db || !workspacePath) return { ok: false, error: 'no_workspace_path' };
  try {
    db.prepare(`
      INSERT INTO devvit_project_settings (workspace_path, current_user_id, current_subreddit_id, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_path) DO UPDATE SET
        current_user_id = excluded.current_user_id,
        current_subreddit_id = excluded.current_subreddit_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(workspacePath, currentUserId || null, currentSubredditId || null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function devvitInitDefaultsForProject(workspacePath) {
  if (!db || !workspacePath) return;
  const existing = db.prepare('SELECT workspace_path FROM devvit_project_settings WHERE workspace_path = ?').get(workspacePath);
  if (existing) return;
  // Pick the first user (u/long after alphabetical sort) and first subreddit as defaults.
  const u = db.prepare('SELECT id FROM devvit_users ORDER BY username ASC LIMIT 1').get();
  const s = db.prepare('SELECT id FROM devvit_subreddits ORDER BY name ASC LIMIT 1').get();
  db.prepare(`
    INSERT OR IGNORE INTO devvit_project_settings (workspace_path, current_user_id, current_subreddit_id)
    VALUES (?, ?, ?)
  `).run(workspacePath, u?.id || null, s?.id || null);
}

// ---------- Memory system ----------
//
// Tier 1 surface: essentials + concepts + buffer + archive, with
// LIKE-based recall. Tier 2 will add vec embeddings and consolidate
// the simple matchers. The IPC surface is shaped so Tier 2 can swap
// implementations without changing the renderer.

// ---- Essentials (always-loaded key→value pairs) ----
function memoryListEssentials() {
  if (!db) return [];
  return db.prepare(`
    SELECT key, value, source, confidence, created_at, updated_at
    FROM memory_essentials ORDER BY key ASC
  `).all();
}

function memoryGetEssential(key) {
  if (!db || !key) return null;
  const row = db.prepare('SELECT key, value, source, confidence, updated_at FROM memory_essentials WHERE key = ?').get(key);
  return row || null;
}

function memorySetEssential(key, value, source = 'manual', confidence = 1.0) {
  if (!db || !key) return { ok: false, error: 'missing_key' };
  try {
    db.prepare(`
      INSERT INTO memory_essentials (key, value, source, confidence, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        confidence = excluded.confidence,
        updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value), source, confidence);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memoryDeleteEssential(key) {
  if (!db || !key) return { ok: false };
  try {
    db.prepare('DELETE FROM memory_essentials WHERE key = ?').run(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Concepts (long-form wiki-style articles) ----
function memoryListConcepts(limit = 100) {
  if (!db) return [];
  return db.prepare(`
    SELECT slug, title, lead, tags, source, confidence, created_at, updated_at
    FROM memory_concepts ORDER BY updated_at DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
}

function memoryGetConcept(slug) {
  if (!db || !slug) return null;
  const row = db.prepare('SELECT * FROM memory_concepts WHERE slug = ?').get(slug);
  if (!row) return null;
  return {
    ...row,
    sections: row.sections ? JSON.parse(row.sections) : [],
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

function memoryUpsertConcept({ slug, title, lead, body, sections, tags, source = 'manual', confidence = 1.0 }) {
  if (!db || !slug || !title) return { ok: false, error: 'missing_slug_or_title' };
  try {
    db.prepare(`
      INSERT INTO memory_concepts (slug, title, lead, body, sections, tags, source, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        lead = excluded.lead,
        body = excluded.body,
        sections = excluded.sections,
        tags = excluded.tags,
        source = excluded.source,
        confidence = excluded.confidence,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      slug, title, lead || null, body || null,
      sections ? JSON.stringify(sections) : null,
      tags ? JSON.stringify(tags) : null,
      source, confidence
    );
    // v3: keep the derived section index in sync with the canonical body.
    memoryRebuildSections(slug);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memoryDeleteConcept(slug) {
  if (!db || !slug) return { ok: false };
  try {
    db.prepare('DELETE FROM memory_concepts WHERE slug = ?').run(slug);
    try { db.prepare('DELETE FROM memory_sections WHERE slug = ?').run(slug); } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Buffer (raw facts learned this session) ----
function memoryBufferAppend(content, context = null, source = null, workspacePath = null) {
  if (!db || !content) return { ok: false, error: 'missing_content' };
  try {
    const info = db.prepare(`
      INSERT INTO memory_buffer (content, context, source, workspace_path) VALUES (?, ?, ?, ?)
    `).run(content, context, source, workspacePath);
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memoryBufferList(onlyUnconsolidated = true, limit = 50) {
  if (!db) return [];
  return onlyUnconsolidated
    ? db.prepare('SELECT id, content, context, source, workspace_path, created_at FROM memory_buffer WHERE consolidated = 0 ORDER BY id ASC LIMIT ?').all(limit)
    : db.prepare('SELECT id, content, context, source, workspace_path, created_at, consolidated FROM memory_buffer ORDER BY id DESC LIMIT ?').all(limit);
}

// Recover per-folder provenance for rows written before workspace_path
// existed. Two joins: chat rows carry context 'conv=<id>' and
// chat_conversations knows the workspace; retrospective rows carry
// 'retrospective: <title>' and join on the conversation title instead.
// Idempotent — only fills rows that are still NULL.
function memoryBackfillWorkspacePaths() {
  if (!db) return { ok: false, error: 'no_db' };
  const out = { conv: 0, retro: 0 };
  try {
    const convCols = db.prepare('PRAGMA table_info(chat_conversations)').all().map(r => r.name);
    if (!convCols.includes('workspace_path')) return { ok: true, skipped: 'no_workspace_path_on_conversations' };
    out.conv = db.prepare(`
      UPDATE memory_buffer SET workspace_path = (
        SELECT c.workspace_path FROM chat_conversations c
        WHERE 'conv=' || c.id = memory_buffer.context AND c.workspace_path IS NOT NULL
      )
      WHERE workspace_path IS NULL AND context LIKE 'conv=%'
    `).run().changes;
    out.retro = db.prepare(`
      UPDATE memory_buffer SET workspace_path = (
        SELECT c.workspace_path FROM chat_conversations c
        WHERE 'retrospective: ' || c.title = memory_buffer.context AND c.workspace_path IS NOT NULL
        ORDER BY c.id DESC LIMIT 1
      )
      WHERE workspace_path IS NULL AND context LIKE 'retrospective: %'
    `).run().changes;
    if (out.conv || out.retro) console.log(`[memory] workspace backfill: ${out.conv} conv + ${out.retro} retrospective rows tagged`);
    return { ok: true, ...out };
  } catch (e) {
    console.warn('[memory] workspace backfill failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function memoryBufferMarkConsolidated(id) {
  if (!db || !id) return { ok: false };
  try {
    db.prepare('UPDATE memory_buffer SET consolidated = 1 WHERE id = ?').run(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Archive (immutable daily log) ----
function memoryArchiveAppend(kind, content, metadata = null, day = null, workspacePath = null) {
  if (!db || !kind || !content) return { ok: false, error: 'missing_kind_or_content' };
  const now = new Date();
  const d = day || now.toISOString().slice(0, 10);
  const ts = now.toISOString();
  try {
    const info = db.prepare(`
      INSERT INTO memory_archive (day, ts, kind, content, metadata, workspace_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d, ts, kind, content, metadata ? JSON.stringify(metadata) : null, workspacePath);
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memoryArchiveList({ day = null, kind = null, limit = 100 } = {}) {
  if (!db) return [];
  let sql = 'SELECT id, day, ts, kind, content, metadata FROM memory_archive';
  const args = [];
  const where = [];
  if (day) { where.push('day = ?'); args.push(day); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY ts DESC LIMIT ?';
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
}

// ---- Recall (Tier 2: vec-first, LIKE fallback) ----
//
// Embeds the query, runs cosine-distance search over memory_vec
// (concepts) + memory_code_vec (code chunks). Falls back to Tier 1
// LIKE-tokenized search when sqlite-vec isn't available OR the embed
// worker isn't ready. Always returns the same shape — renderer code
// can treat it uniformly.
async function memoryRecall(query, limit = 8) {
  if (!db || !query) return { essentials: [], concepts: [], code: [], buffer: [], sections: [] };

  const tokens = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 12);

  // Tier 1 LIKE-based results — always computed so the renderer has
  // something to show even when vec search is slow / unavailable.
  let likeConcepts = [], essentials = [], bufferRows = [];
  if (tokens.length) {
    const likeClauses = tokens.map(() => '(LOWER(title) LIKE ? OR LOWER(lead) LIKE ? OR LOWER(body) LIKE ? OR LOWER(tags) LIKE ?)').join(' OR ');
    const args = [];
    for (const t of tokens) {
      const like = `%${t}%`;
      for (let i = 0; i < 4; i++) args.push(like);
    }
    const conceptRows = db.prepare(`
      SELECT slug, title, lead, tags, source, confidence, updated_at,
             (${likeClauses}) AS hit_count
      FROM memory_concepts
      ORDER BY hit_count DESC, updated_at DESC
      LIMIT ?
    `).all(...args, limit);
    likeConcepts = conceptRows.map(r => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
      source: 'like',
    }));

    for (const t of tokens) {
      const like = `%${t}%`;
      const rows = db.prepare(`
        SELECT key, value, source, confidence, updated_at FROM memory_essentials
        WHERE LOWER(key) LIKE ? OR LOWER(value) LIKE ?
        LIMIT 4
      `).all(like, like);
      for (const r of rows) if (!essentials.find(e => e.key === r.key)) essentials.push(r);
    }

    bufferRows = db.prepare(`
      SELECT id, content, context, source, created_at FROM memory_buffer
      WHERE consolidated = 0 AND (LOWER(content) LIKE ? OR LOWER(context) LIKE ?)
      ORDER BY id DESC LIMIT 8
    `).all(`%${tokens.join('%')}%`, `%${tokens.join('%')}%`);
  }

  // Tier 2 vec search — try, fall back to LIKE/FTS5 results if it fails.
  let vecConcepts = [], vecCode = [];
  try {
    // embeddingsAvailable defaults to false. We only flip it to true if
    // we've actually verified the embed worker survives an embedding call
    // (Jul 6 ~21:18 ET — onnxruntime BFCArena crashes prevent this on
    // macOS 26.5.1). When false, we skip the worker entirely and use
    // FTS5 below.
    if (vecAvailable && embeddingsAvailable && (embedReady || ensureEmbedWorker())) {
      const queryText = String(query).slice(0, 500);
      const [queryVec] = await embedBatch([queryText]);
      if (queryVec) {
        const conceptHits = memoryConceptVecSearch(queryVec, Math.max(limit, 4));
        vecConcepts = conceptHits.map(h => ({
          slug: h.slug,
          title: h.title,
          lead: h.lead,
          body: h.body,
          tags: h.tags ? JSON.parse(h.tags) : [],
          distance: h.distance,
          source: 'vec',
        }));
        const codeHits = memoryCodeVecSearch(queryVec, limit * 2);
        vecCode = codeHits.map(h => ({
          workspace_path: h.workspace_path,
          file_path: h.file_path,
          chunk_index: h.chunk_index,
          chunk_text: h.chunk_text,
          distance: h.distance,
          source: 'vec',
        }));
      }
    } else if (!embeddingsAvailable) {
      // FTS5-only Tier 2: pull code chunks via keyword search instead of
      // trying to spawn the embed worker (which would crash onnxruntime).
      const codeHits = memoryCodeFtsSearch(String(query), limit * 2);
      vecCode = codeHits.map(h => ({
        workspace_path: h.workspace_path,
        file_path: h.file_path,
        chunk_index: h.chunk_index,
        chunk_text: h.chunk_text,
        distance: h.score != null ? -h.score : null, // bm25 is "lower = better", negate so callers can sort "lower = better"
        source: 'fts',
      }));
    }
  } catch (e) {
    console.warn('[memory tier2] recall failed:', e.message);
  }

  // Blend: vec hits first (ranked by distance), then LIKE hits not
  // already in vec results (de-duplicated by slug).
  const slugSet = new Set(vecConcepts.map(c => c.slug));
  const mergedConcepts = [
    ...vecConcepts,
    ...likeConcepts.filter(c => !slugSet.has(c.slug)),
  ].slice(0, limit);

  // v3: section-grain hits (FTS5 bm25 over memory_sections). The 5th key
  // in the recall shape — callers iterating keys must include 'sections'.
  const sectionHits = memorySectionsSearch(String(query), Math.max(limit, 8));

  // v3.1: past-conversation hits (FTS5 bm25 over memory_conversations_fts).
  const conversationHits = memoryConversationsSearch(String(query), Math.min(limit, 6));

  return {
    essentials: essentials.slice(0, 6),
    concepts: mergedConcepts,
    code: vecCode,
    buffer: bufferRows,
    sections: sectionHits,
    conversations: conversationHits,
  };
}

// ---- Bootstrap (always-loaded essentials + recent concepts) ----
function memoryBootstrap() {
  if (!db) return { essentials: [], recentConcepts: [], today: new Date().toISOString().slice(0, 10) };
  // memoryListConcepts already returns parsed tags arrays (line 813); no
  // re-parse here. (Jul 5 ~22:24 ET fix — the old double-parse threw
  // "Unexpected token 'p'" when the array was fed back to JSON.parse.)
  return {
    essentials: memoryListEssentials(),
    recentConcepts: memoryListConcepts(20),
    today: new Date().toISOString().slice(0, 10),
  };
}

// ---- Consolidate (Tier 1: simple — flip buffer rows to consolidated) ----
//
// Full consolidation (merge buffer into concept, dedupe, rewrite) is
// Tier 2. Tier 1 just flips the flag so the recall path stops returning
// rows the user has explicitly marked done.
function memoryConsolidate(bufferIds = null) {
  if (!db) return { ok: false, error: 'no_db' };
  try {
    if (Array.isArray(bufferIds) && bufferIds.length) {
      const placeholders = bufferIds.map(() => '?').join(',');
      db.prepare(`UPDATE memory_buffer SET consolidated = 1 WHERE id IN (${placeholders})`).run(...bufferIds);
      return { ok: true, count: bufferIds.length };
    }
    // No ids passed: mark all unconsolidated as done (the simple case).
    const info = db.prepare('UPDATE memory_buffer SET consolidated = 1 WHERE consolidated = 0').run();
    return { ok: true, count: info.changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Memory v3 — section-grain concepts (Jul 12 2026)
//
// The concept 'body' column is CANONICAL. memory_sections is a derived FTS5
// index at section grain, rebuilt on every concept write (memoryUpsertConcept,
// memoryAppendToSection, memoryDeleteConcept) and lazily at boot. Splitting is
// on markdown '## ' headings; bodies without headings become one 'Overview'
// section. Retrieval injects lead + selected sections instead of whole bodies.
// ============================================================================

function memorySplitSections(body) {
  const out = [];
  if (!body || typeof body !== 'string') return out;
  const lines = body.split('\n');
  let heading = 'Overview';
  let buf = [];
  const push = () => {
    const content = buf.join('\n').trim();
    if (content) out.push({ heading, content });
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) { push(); heading = m[1].trim(); }
    else buf.push(line);
  }
  push();
  return out;
}

function memoryRebuildSections(slug) {
  if (!db || !slug) return { ok: false, error: 'missing_slug' };
  try {
    const row = db.prepare('SELECT slug, body, sections FROM memory_concepts WHERE slug = ?').get(slug);
    db.prepare('DELETE FROM memory_sections WHERE slug = ?').run(slug);
    if (!row) return { ok: true, sections: 0 }; // concept gone — rows purged
    let secs = memorySplitSections(row.body);
    // Section-first concepts: respect an explicit sections JSON array when
    // the body produced nothing.
    if (!secs.length && row.sections) {
      try {
        const j = JSON.parse(row.sections);
        if (Array.isArray(j)) secs = j.filter(s => s && s.heading && s.content);
      } catch {}
    }
    const ins = db.prepare('INSERT INTO memory_sections (slug, heading, content, position) VALUES (?, ?, ?, ?)');
    secs.forEach((s, i) => ins.run(slug, String(s.heading).slice(0, 200), String(s.content), String(i)));
    return { ok: true, sections: secs.length };
  } catch (e) {
    console.warn('[memory v3] rebuild sections failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Idempotent bulk rebuild. Called at boot; skips when the index already has
// rows (unless force). This IS the v2→v3 migration for existing corpora —
// non-destructive since body stays canonical.
function memoryRebuildAllSections(force = false) {
  if (!db) return { ok: false, error: 'no_db' };
  try {
    const have = db.prepare('SELECT COUNT(*) AS n FROM memory_sections').get().n;
    if (!force && have > 0) return { ok: true, skipped: true, sections: have };
    const concepts = db.prepare('SELECT slug FROM memory_concepts').all();
    let total = 0;
    for (const c of concepts) {
      const r = memoryRebuildSections(c.slug);
      if (r.ok) total += r.sections || 0;
    }
    if (concepts.length) console.log(`[memory v3] section index rebuilt: ${concepts.length} concepts → ${total} sections`);
    return { ok: true, concepts: concepts.length, sections: total };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memorySectionsForConcept(slug) {
  if (!db || !slug) return [];
  try {
    return db.prepare('SELECT slug, heading, content, position FROM memory_sections WHERE slug = ? ORDER BY CAST(position AS INTEGER)').all(slug);
  } catch (e) {
    console.warn('[memory v3] sections read failed:', e.message);
    return [];
  }
}

// bm25-ranked section search — the raw candidate source for the L2 selector
// and the 'sections' key in memoryRecall.
function memorySectionsSearch(query, k = 10) {
  if (!db || !query) return [];
  const tokens = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 12);
  if (!tokens.length) return [];
  const ftsQuery = tokens.map(t => `"${t}"*`).join(' OR ');
  try {
    return db.prepare(`
      SELECT slug, heading, content, bm25(memory_sections) AS score
      FROM memory_sections WHERE memory_sections MATCH ? ORDER BY score LIMIT ?
    `).all(ftsQuery, k).map(r => ({ ...r, source: 'fts' }));
  } catch (e) {
    console.warn('[memory v3] section search failed:', e.message);
    return [];
  }
}

// Append content under a section heading of an existing concept. Creates the
// section when the heading doesn't exist yet. Body stays canonical — the
// derived index is rebuilt after the write. Used by consolidation ops.
function memoryAppendToSection(slug, heading, content) {
  if (!db || !slug || !content) return { ok: false, error: 'missing_args' };
  const row = db.prepare('SELECT slug, body FROM memory_concepts WHERE slug = ?').get(slug);
  if (!row) return { ok: false, error: 'no_such_concept' };
  const h = String(heading || 'notes').trim();
  let body = row.body || '';
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^##\\s+' + escaped + '\\s*$', 'm');
  const m = re.exec(body);
  if (m) {
    const afterHead = m.index + m[0].length;
    const rest = body.slice(afterHead);
    const nextIdx = rest.search(/^##\s+/m);
    const insertAt = nextIdx === -1 ? body.length : afterHead + nextIdx;
    body = body.slice(0, insertAt).replace(/\s*$/, '\n\n') + String(content).trim() + '\n\n' + body.slice(insertAt);
  } else {
    body = (body ? body.replace(/\s*$/, '\n\n') : '') + `## ${h}\n\n${String(content).trim()}\n`;
  }
  try {
    db.prepare('UPDATE memory_concepts SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?').run(body, slug);
    memoryRebuildSections(slug);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function memoryUnconsolidatedCount() {
  if (!db) return 0;
  try { return db.prepare('SELECT COUNT(*) AS n FROM memory_buffer WHERE consolidated = 0').get().n; } catch { return 0; }
}

function memorySectionsCount() {
  if (!db) return 0;
  try { return db.prepare('SELECT COUNT(*) AS n FROM memory_sections').get().n; } catch { return 0; }
}

// ---- Per-stage run stats (Tier 3 pipeline observability) ----
// One settings row: { <stage>: {lastRun, ms, model, runs, lastError?},
// lastConsolidationAt }. Read by the Settings → Memory page.
// ============================================================================
// Memory v3.1 (Jul 12 2026) — conversations lane + injection gate + pinned lanes
// ============================================================================

// Plain-text view of a stored chat message (content may be a string or an
// array of Anthropic content blocks; renderer-side messages may use .text).
function memoryMessageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ');
  if (typeof m.text === 'string') return m.text;
  return '';
}

// Rebuild the FTS rows for one conversation (DELETE + INSERT — same derived-
// index pattern as memory_sections). Last 200 messages, 2000 chars each.
function memoryRebuildConversationFts(convId, title, messages) {
  if (!db || !convId) return;
  try {
    db.prepare('DELETE FROM memory_conversations_fts WHERE conv_id = ?').run(convId);
    const msgs = (Array.isArray(messages) ? messages : []).slice(-200);
    const ins = db.prepare('INSERT INTO memory_conversations_fts (conv_id, title, content) VALUES (?, ?, ?)');
    for (const m of msgs) {
      const text = memoryMessageText(m).trim();
      if (!text) continue;
      ins.run(convId, title || 'Untitled', `${m.role || 'user'}: ${text}`.slice(0, 2000));
    }
  } catch (e) {
    console.warn('[memory v3.1] conversation fts rebuild failed:', e.message);
  }
}

// Idempotent boot backfill: only rebuilds when the FTS table is empty but
// conversations exist (mirrors memoryRebuildAllSections).
function memoryRebuildAllConversationsFts(force = false) {
  if (!db) return 0;
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_conversations_fts').get().c;
    if (count > 0 && !force) return count;
    if (force) db.prepare('DELETE FROM memory_conversations_fts').run();
    const convs = db.prepare('SELECT id, title, messages FROM chat_conversations').all();
    for (const c of convs) {
      let msgs = [];
      try { msgs = JSON.parse(c.messages || '[]'); } catch {}
      memoryRebuildConversationFts(c.id, c.title, msgs);
    }
    return db.prepare('SELECT COUNT(*) AS c FROM memory_conversations_fts').get().c;
  } catch (e) {
    console.warn('[memory v3.1] conversations fts backfill failed:', e.message);
    return 0;
  }
}

// Shared tokenizer → FTS5 prefix OR-query (same shape as memorySectionsSearch).
function memoryFtsOrQuery(text, maxTokens = 12) {
  const tokens = String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2).slice(0, maxTokens);
  if (!tokens.length) return null;
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

// bm25 search over past conversations — the 'conversations' key in memoryRecall.
function memoryConversationsSearch(query, k = 6) {
  if (!db || !query) return [];
  const q = memoryFtsOrQuery(query);
  if (!q) return [];
  try {
    return db.prepare(`
      SELECT conv_id, title, snippet(memory_conversations_fts, 2, '', '', '…', 24) AS snippet,
             bm25(memory_conversations_fts) AS score
      FROM memory_conversations_fts WHERE memory_conversations_fts MATCH ?
      ORDER BY score LIMIT ?
    `).all(q, k);
  } catch (e) {
    console.warn('[memory v3.1] conversations search failed:', e.message);
    return [];
  }
}

// v3.1 injection gate primitive: does this message share even ONE keyword
// with the memory corpus? Zero matches → the router model is never invoked
// for the turn (Vellum's absolute keyword rule: no term match can never
// open the gate). Conservative by design — any hit opens the gate.
function memoryGateCheck(text) {
  if (!db) return false;
  const q = memoryFtsOrQuery(text);
  if (!q) return false;
  try {
    if (db.prepare('SELECT rowid FROM memory_sections WHERE memory_sections MATCH ? LIMIT 1').get(q)) return true;
  } catch {}
  try {
    if (db.prepare('SELECT rowid FROM memory_conversations_fts WHERE memory_conversations_fts MATCH ? LIMIT 1').get(q)) return true;
  } catch {}
  return false;
}

// ---- Pinned lanes: 'threads' (open loops) + 'recent' (rolling digest) ----
// Ordinary concept rows with reserved slugs. Always injected at conversation
// start (alongside essentials), excluded from the router's candidate index,
// maintained by the consolidation stage via 'lane' ops.
const MEMORY_LANE_SLUGS = ['threads', 'recent'];

function memoryEnsureLanes() {
  if (!db) return;
  const defs = [
    { slug: 'threads', title: 'Threads — open loops', lead: 'Active commitments, follow-ups in progress, things waiting on someone. Loaded at the start of every conversation.', body: '## open\n\n(nothing tracked yet)\n' },
    { slug: 'recent', title: 'Recent — rolling digest', lead: 'What happened lately, newest first. Consolidation prunes stale entries. Loaded at the start of every conversation.', body: '## digest\n\n(nothing yet)\n' },
  ];
  for (const d of defs) {
    const exists = db.prepare('SELECT slug FROM memory_concepts WHERE slug = ?').get(d.slug);
    if (!exists) memoryUpsertConcept({ ...d, source: 'system' });
  }
}

function memoryGetLanes() {
  if (!db) return [];
  try {
    return MEMORY_LANE_SLUGS
      .map(s => db.prepare('SELECT slug, title, lead, body FROM memory_concepts WHERE slug = ?').get(s))
      .filter(Boolean);
  } catch { return []; }
}

function memoryStageStatsGet() {
  try {
    const raw = getSetting('memoryStageStats');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function memoryStageStatsPatch(stage, patch, countRun = false) {
  try {
    const cur = memoryStageStatsGet();
    const prev = cur[stage] || {};
    cur[stage] = { ...prev, ...patch };
    if (countRun) cur[stage].runs = (prev.runs || 0) + 1;
    setSetting('memoryStageStats', cur);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function memoryStageStatsSetGlobal(key, value) {
  try {
    const cur = memoryStageStatsGet();
    cur[key] = value;
    setSetting('memoryStageStats', cur);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ============================================================================
// Memory Tier 2 — sqlite-vec + codebase indexer
// ============================================================================

const { spawn } = require('child_process');

// Embed worker singleton. Spawned lazily on first embedBatch() call.
// Single-flight queue — concurrent embedBatch() requests are serialized
// over the worker's stdin pipe. The worker is killed on app close.
let embedWorker = null;
let embedReady = false;
let embedIdCounter = 0;
const embedPending = new Map(); // id -> {resolve, reject}

// Tier 2 search mode — true when sqlite-vec loaded (vec0 KNN available),
// false when only FTS5 / LIKE search works. Set during init() based on
// whether the vec0.dylib extension loads. Functions below check this
// flag to decide whether to attempt embedding work or skip to fallback.
let vecAvailable = false;
// embeddingsAvailable is independent of vecAvailable — sqlite-vec may
// load successfully but the embed worker may still crash. Default false
// so memoryRecall uses FTS5 until we verify a successful embedding run.
let embeddingsAvailable = false;

function ensureEmbedWorker() {
  if (embedWorker) return embedWorker;
  const workerPath = path.join(__dirname, 'embed', 'embed-worker.mjs');
  let child;
  try {
    // Spawn using process.execPath (Electron's bundled Node). The Electron binary
    // supports ESM imports in main-process mode since Electron 28+, so the
    // top-level `import { pipeline, env } from '@huggingface/transformers'` works.
    //
    // DO NOT add ELECTRON_RUN_AS_NODE=1 — that switches the binary to pure-Node
    // mode and breaks the onnxruntime native binding (compiled for Electron's
    // Node ABI), causing EXC_BREAKPOINT in onnxruntime::BFCArena::Extend.
    child = spawn(process.execPath, [workerPath, 'Xenova/all-MiniLM-L6-v2'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });
  } catch (e) {
    console.error('[embed] spawn failed:', e.message);
    return null;
  }
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') {
        embedReady = true;
        console.log('[embed] worker ready:', msg.model);
      } else if (msg.type === 'error') {
        console.error('[embed] worker boot error:', msg.error);
      } else if (msg.id != null) {
        const pending = embedPending.get(msg.id);
        if (pending) {
          embedPending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.vectors);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8').trim();
    if (s) console.warn('[embed stderr]', s);
  });
  // Catch pipe-level errors on the worker's stdio. Without this, an
  // onnxruntime BFCArena crash kills the worker mid-spawn and any
  // subsequent stdin.write throws an unhandled EPIPE/EIO that crashes
  // the main process. (Jul 6 ~20:54 ET — `Uncaught Exception: write EPIPE`.)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.on('error', (err) => {
      console.warn('[embed] pipe error:', err.code || err.message);
      if (err.code === 'EIO' || err.code === 'EPIPE') {
        // Worker pipe is gone — kill the process if it's still around,
        // and reset state so the next embedBatch can spawn a fresh worker.
        try { child.kill(); } catch (_) {}
        embedReady = false;
        embedWorker = null;
        for (const p of embedPending.values()) p.reject(new Error('pipe error: ' + err.code));
        embedPending.clear();
      }
    });
  }
  child.on('exit', (code) => {
    console.warn('[embed] worker exited with code', code);
    embedReady = false;
    embedWorker = null;
    for (const p of embedPending.values()) p.reject(new Error('worker exited'));
    embedPending.clear();
  });
  child.on('error', (err) => {
    console.error('[embed] worker spawn error:', err.message);
    embedReady = false;
    embedWorker = null;
  });
  embedWorker = child;
  return child;
}

function embedBatch(texts) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(texts) || texts.length === 0) return resolve([]);
    const child = ensureEmbedWorker();
    if (!child) return reject(new Error('embed worker not available'));
    const id = ++embedIdCounter;
    embedPending.set(id, { resolve, reject });
    const send = () => {
      const payload = JSON.stringify({ id, texts }) + '\n';
      if (!child.stdin || !child.stdin.writable) {
        embedPending.delete(id);
        return reject(new Error('worker stdin not writable'));
      }
      try {
        child.stdin.write(payload);
      } catch (e) {
        // Pipe closed between ready and write — usually means the worker
        // died in native code (e.g. onnxruntime BFCArena crash). Don't
        // bubble up as uncaught — propagate as a normal promise rejection
        // so the caller (memoryCodeUpsertFile) can fall back to FTS5.
        embedPending.delete(id);
        reject(new Error('embed write failed: ' + (e.code || e.message)));
      }
    };
    if (embedReady) send();
    else {
      const start = Date.now();
      const wait = () => {
        if (embedReady) send();
        else if (Date.now() - start > 60000) {
          embedPending.delete(id);
          reject(new Error('embed worker timeout'));
        } else setTimeout(wait, 100);
      };
      wait();
    }
  });
}

// Chunk text into ~512-char windows with 32-char overlap. Splits prefer
// newline boundaries when within 64 chars of the window size.
function chunkText(text, size = 512, overlap = 32) {
  const chunks = [];
  if (!text || text.length === 0) return chunks;
  const t = String(text).replace(/\r\n/g, '\n');
  if (t.length <= size) return [t];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + size, t.length);
    // Try to break at a newline near the end
    if (end < t.length) {
      const nl = t.lastIndexOf('\n', end);
      if (nl > i + size * 0.7) end = nl + 1;
    }
    chunks.push(t.slice(i, end));
    if (end >= t.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

// sha1 hash (fast, sufficient for change detection)
const crypto = require('crypto');
function hashContent(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

// Backfill existing memory_concepts with embeddings so vec recall works
// on the first Tier 2 boot without manual re-indexing.
async function backfillConceptEmbeddings() {
  if (!db || !embedReady && !embedWorker) ensureEmbedWorker();
  try {
    const rows = db.prepare(`
      SELECT c.slug, c.title, c.lead, c.body FROM memory_concepts c
      LEFT JOIN memory_vec_map m ON m.slug = c.slug
      WHERE m.slug IS NULL
    `).all();
    if (!rows.length) return { ok: true, count: 0 };
    const texts = rows.map(r => [r.title, r.lead || '', r.body || ''].filter(Boolean).join('\n\n').slice(0, 2000));
    const vectors = await embedBatch(texts);
    const insertMap = db.prepare('INSERT OR REPLACE INTO memory_vec_map (vec_id, slug) VALUES (?, ?)');
    const insertVec = db.prepare('INSERT OR REPLACE INTO memory_vec (vec_id, embedding) VALUES (?, ?)');
    const tx = db.transaction((entries) => {
      for (const [row, vec] of entries) {
        const info = insertVec.run(null, JSON.stringify(Array.from(vec)));
        const vecId = info.lastInsertRowid;
        insertMap.run(vecId, row.slug);
      }
    });
    tx(rows.map((r, i) => [r, vectors[i]]));
    return { ok: true, count: rows.length };
  } catch (e) {
    console.error('[memory tier2] backfill failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Upsert a file: hash + chunk + (embed if vec) + write chunks + FTS5 + embeddings.
// Returns the list of chunk ids written. When vecAvailable is false, the
// embed step is skipped (FTS5 index is populated instead) — this is the
// FTS5-only Tier 2 mode that works without sqlite-vec.
// memory_code_fts is CONTENTLESS FTS5 (content='' above) — it rejects an
// ordinary `DELETE FROM memory_code_fts WHERE rowid IN (...)` at the SQL
// level with "cannot DELETE from contentless fts5 table: memory_code_fts".
// New files indexed fine (nothing to delete yet); every RE-index of a
// previously-indexed file failed silently in the boot log and left stale
// search results. Contentless FTS5's only supported delete is the special
// 'delete' command row, and it must be issued per-rowid (no batch form).
// Fixed Aug 3 2026 — see farnsworth-tier2-fts5-delete-bug.
function deleteCodeFtsRows(workspacePath, filePath) {
  const rows = db.prepare(
    'SELECT id FROM memory_code_chunks WHERE workspace_path = ? AND file_path = ?'
  ).all(workspacePath, filePath);
  if (rows.length === 0) return 0;
  const del = db.prepare("INSERT INTO memory_code_fts(memory_code_fts, rowid, chunk_text) VALUES('delete', ?, ?)");
  for (const { id } of rows) del.run(id, '');
  return rows.length;
}

async function memoryCodeUpsertFile(workspacePath, filePath, content) {
  if (!db) return { ok: false, error: 'no_db' };
  const hash = hashContent(content);
  const existing = db.prepare('SELECT file_hash FROM memory_indexed_files WHERE workspace_path = ? AND file_path = ?').get(workspacePath, filePath);
  if (existing && existing.file_hash === hash) {
    return { ok: true, skipped: true, hash };
  }
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return memoryCodeRemoveFile(workspacePath, filePath);
  }
  // Embeddings during indexing DISABLED on Jul 6 ~21:13 ET.
  // onnxruntime-node 1.24.3 AND 1.27.0 both crash in BFCArena::Extend
  // during model load on macOS 26.5.1. Spawning the worker per-file
  // for chunk indexing would crash on every chunk of every file.
  // Code embeddings (if/when added back) will run as a separate lazy
  // background pass that doesn't block indexing or pollute the user's
  // file watcher with worker crashes.
  let vectors = null;
  const tx = db.transaction(() => {
    // Delete old chunks + embeddings + FTS5 entries for this file
    deleteCodeFtsRows(workspacePath, filePath);
    db.prepare('DELETE FROM memory_code_chunks WHERE workspace_path = ? AND file_path = ?').run(workspacePath, filePath);
    if (vecAvailable) {
      db.prepare(`
        DELETE FROM memory_code_vec WHERE chunk_id IN (
          SELECT id FROM memory_code_chunks WHERE workspace_path = ? AND file_path = ?
        )
      `).run(workspacePath, filePath);
    }
    // Insert new chunks
    const insertChunk = db.prepare(`
      INSERT INTO memory_code_chunks (workspace_path, file_path, file_hash, chunk_index, chunk_text)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare('INSERT INTO memory_code_fts(rowid, chunk_text) VALUES (?, ?)');
    const insertVec = db.prepare('INSERT INTO memory_code_vec (chunk_id, embedding) VALUES (?, ?)');
    const chunkIds = [];
    for (let i = 0; i < chunks.length; i++) {
      const info = insertChunk.run(workspacePath, filePath, hash, i, chunks[i]);
      const chunkId = info.lastInsertRowid;
      chunkIds.push(chunkId);
      // Always populate FTS5 — it's the universal recall path.
      insertFts.run(chunkId, chunks[i]);
      // Only populate vec when we have valid vectors.
      if (vectors && vectors[i]) {
        try { insertVec.run(chunkId, JSON.stringify(Array.from(vectors[i]))); } catch (_) {}
      }
    }
    db.prepare(`
      INSERT INTO memory_indexed_files (workspace_path, file_path, file_hash, chunk_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_path, file_path) DO UPDATE SET file_hash = excluded.file_hash, chunk_count = excluded.chunk_count, last_indexed = CURRENT_TIMESTAMP
    `).run(workspacePath, filePath, hash, chunkIds.length);
    return chunkIds;
  });
  const ids = tx();
  return { ok: true, hash, chunk_count: chunks.length, chunk_ids: ids, vec_available: vecAvailable };
}

function memoryCodeRemoveFile(workspacePath, filePath) {
  if (!db) return { ok: false };
  const tx = db.transaction(() => {
    if (vecAvailable) {
      db.prepare(`
        DELETE FROM memory_code_vec WHERE chunk_id IN (
          SELECT id FROM memory_code_chunks WHERE workspace_path = ? AND file_path = ?
        )
      `).run(workspacePath, filePath);
    }
    deleteCodeFtsRows(workspacePath, filePath);
    db.prepare('DELETE FROM memory_code_chunks WHERE workspace_path = ? AND file_path = ?').run(workspacePath, filePath);
    db.prepare('DELETE FROM memory_indexed_files WHERE workspace_path = ? AND file_path = ?').run(workspacePath, filePath);
  });
  tx();
  return { ok: true };
}

// Return index stats for a workspace — used by renderer Settings panel.
// vec_available reflects whether sqlite-vec + embeddings are usable
// (NOT whether the worker is currently spawned) — it's the source of
// truth for which recall path the renderer should show in the UI.
function memoryCodeStats(workspacePath) {
  if (!db) return { files: 0, chunks: 0, vec_available: false };
  const files = db.prepare('SELECT COUNT(*) as c FROM memory_indexed_files WHERE workspace_path = ?').get(workspacePath);
  const chunks = db.prepare('SELECT COUNT(*) as c FROM memory_code_chunks WHERE workspace_path = ?').get(workspacePath);
  return {
    files: files?.c || 0,
    chunks: chunks?.c || 0,
    vec_available: !!vecAvailable,
  };
}

// Cosine-distance vec search on code chunks, optionally filtered to one workspace.
// FALLBACK: when vecAvailable is false (sqlite-vec didn't load), use FTS5
// keyword search on chunk_text. The function still returns the same row
// shape (with distance=null for FTS5 hits) so callers don't have to branch.
function memoryCodeVecSearch(embedding, k = 8, workspacePath = null) {
  if (!db) return [];
  // FTS5 fallback path — no embedding, just text matching.
  // Callers that pass null/empty embedding get an empty array (intentional:
  // vec search requires a vector; use memoryCodeFtsSearch for text-only).
  if (!vecAvailable) {
    if (!embedding || (Array.isArray(embedding) && embedding.length === 0)) return [];
    // We have an embedding but no vec table — derive keywords from the
    // query text isn't possible here (we only have the vector). The
    // renderer should call memoryRecall which has the original query string.
    return [];
  }
  const vecJson = JSON.stringify(Array.from(embedding));
  let sql, args;
  if (workspacePath) {
    // KNN must be the inner subquery — vec0 requires MATCH + ORDER BY distance + LIMIT
    // to be the OUTERMOST reference to the vec0 table, not a JOINed one.
    sql = `
      SELECT c.id, c.workspace_path, c.file_path, c.chunk_index, c.chunk_text, knn.distance
      FROM memory_code_chunks c
      JOIN (
        SELECT chunk_id, distance FROM memory_code_vec
        WHERE embedding MATCH ?
        ORDER BY distance LIMIT ?
      ) knn ON knn.chunk_id = c.id
      WHERE c.workspace_path = ?
      ORDER BY knn.distance
    `;
    // Over-fetch when workspace-filtered (some results may get filtered post-knn).
    args = [vecJson, Math.max(k * 4, 32), workspacePath];
  } else {
    sql = `
      SELECT c.id, c.workspace_path, c.file_path, c.chunk_index, c.chunk_text, knn.distance
      FROM memory_code_chunks c
      JOIN (
        SELECT chunk_id, distance FROM memory_code_vec
        WHERE embedding MATCH ?
        ORDER BY distance LIMIT ?
      ) knn ON knn.chunk_id = c.id
      ORDER BY knn.distance
    `;
    args = [vecJson, k];
  }
  try {
    return db.prepare(sql).all(...args);
  } catch (e) {
    console.warn('[memory tier2] code vec search failed:', e.message);
    return [];
  }
}

// FTS5 keyword search on code chunks — used as the FTS5-only fallback
// for memoryRecall when sqlite-vec is unavailable. Splits the query into
// tokens, ranks by FTS5 bm25 score, optionally filters to one workspace.
function memoryCodeFtsSearch(query, k = 12, workspacePath = null) {
  if (!db || !query) return [];
  const tokens = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 12);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map(t => `"${t}"*`).join(' OR ');
  let sql, args;
  if (workspacePath) {
    sql = `
      SELECT c.id, c.workspace_path, c.file_path, c.chunk_index, c.chunk_text,
             bm25(memory_code_fts) AS score
      FROM memory_code_fts
      JOIN memory_code_chunks c ON c.id = memory_code_fts.rowid
      WHERE memory_code_fts MATCH ?
        AND c.workspace_path = ?
      ORDER BY score
      LIMIT ?
    `;
    args = [ftsQuery, workspacePath, k];
  } else {
    sql = `
      SELECT c.id, c.workspace_path, c.file_path, c.chunk_index, c.chunk_text,
             bm25(memory_code_fts) AS score
      FROM memory_code_fts
      JOIN memory_code_chunks c ON c.id = memory_code_fts.rowid
      WHERE memory_code_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `;
    args = [ftsQuery, k];
  }
  try {
    return db.prepare(sql).all(...args);
  } catch (e) {
    console.warn('[memory tier2] code fts search failed:', e.message);
    return [];
  }
}

// Cosine-distance vec search on concept embeddings.
function memoryConceptVecSearch(embedding, k = 6) {
  if (!db || !embedding) return [];
  const vecJson = JSON.stringify(Array.from(embedding));
  try {
    // KNN must be the inner subquery — vec0 requires MATCH + ORDER BY distance + LIMIT
    // to be the OUTERMOST reference to the vec0 table, not a JOINed one.
    return db.prepare(`
      SELECT c.slug, c.title, c.lead, c.body, c.tags, knn.distance
      FROM memory_concepts c
      JOIN memory_vec_map m ON m.slug = c.slug
      JOIN (
        SELECT vec_id, distance FROM memory_vec
        WHERE embedding MATCH ?
        ORDER BY distance LIMIT ?
      ) knn ON knn.vec_id = m.vec_id
      ORDER BY knn.distance
    `).all(vecJson, k);
  } catch (e) {
    console.warn('[memory tier2] concept vec search failed:', e.message);
    return [];
  }
}

// Embed-and-store for a concept (called when memoryUpsertConcept fires).
async function memoryConceptEmbed(slug) {
  if (!db) return { ok: false };
  const row = db.prepare('SELECT title, lead, body FROM memory_concepts WHERE slug = ?').get(slug);
  if (!row) return { ok: false, error: 'not_found' };
  const text = [row.title, row.lead || '', row.body || ''].filter(Boolean).join('\n\n').slice(0, 2000);
  const [vec] = await embedBatch([text]);
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT vec_id FROM memory_vec_map WHERE slug = ?').get(slug);
    if (existing) {
      db.prepare('UPDATE memory_vec SET embedding = ? WHERE vec_id = ?').run(JSON.stringify(Array.from(vec)), existing.vec_id);
    } else {
      const info = db.prepare('INSERT INTO memory_vec (embedding) VALUES (?)').run(JSON.stringify(Array.from(vec)));
      db.prepare('INSERT INTO memory_vec_map (vec_id, slug) VALUES (?, ?)').run(info.lastInsertRowid, slug);
    }
  });
  tx();
  return { ok: true };
}

// Remove a concept's embedding (called when memoryDeleteConcept fires).
function memoryConceptForget(slug) {
  if (!db) return { ok: false };
  const row = db.prepare('SELECT vec_id FROM memory_vec_map WHERE slug = ?').get(slug);
  if (!row) return { ok: true, skipped: true };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM memory_vec WHERE vec_id = ?').run(row.vec_id);
    db.prepare('DELETE FROM memory_vec_map WHERE vec_id = ?').run(row.vec_id);
  });
  tx();
  return { ok: true };
}

// Cleanup embed worker on app close.
function closeEmbedWorker() {
  if (embedWorker) {
    try { embedWorker.kill(); } catch (_) {}
    embedWorker = null;
    embedReady = false;
  }
}

// Raw better-sqlite3 handle, for standalone modules (e.g.
// src/dev-port-allocation.js) that need db.prepare()/db.exec() directly
// rather than going through a db.js wrapper function. Added Aug 3 2026
// for the port-authority integration.
function getRawDb() { return db; }

module.exports = {
  init,
  getRawDb,
  close,
  migrateLegacy,
  getSetting, setSetting, deleteSetting, getAllSettings, setAllSettings,
  getRecentFolders, addRecentFolder, clearRecentFolders,
  setAuthToken, getAuthToken, deleteAuthToken,
  getChatHistory, addChatMessage, clearChatHistory,
  listConversations, listAllConversations, getConversation, createConversation, saveConversation, deleteConversation, touchConversation,
  getTasks, addTask, updateTask, deleteTask,
  putOAuthState, consumeOAuthState, getOAuthState, cleanupOAuthState,
  getLiveTickets, saveLiveTickets, clearLiveTickets,
  getLiveGameCache, saveLiveGameCache, clearLiveGameCache,
  devvitSeedDefaults, devvitListUsers, devvitUpsertUser, devvitDeleteUser,
  devvitListSubreddits, devvitUpsertSubreddit, devvitDeleteSubreddit,
  devvitGetProjectSettings, devvitSetProjectSettings, devvitInitDefaultsForProject,
  memoryListEssentials, memoryGetEssential, memorySetEssential, memoryDeleteEssential,
  memoryListConcepts, memoryGetConcept, memoryUpsertConcept, memoryDeleteConcept,
  memoryBufferAppend, memoryBufferList, memoryBufferMarkConsolidated, memoryBackfillWorkspacePaths,
  memoryArchiveAppend, memoryArchiveList,
  memoryRecall, memoryBootstrap, memoryConsolidate,
  // v3 — section-grain concepts + stage stats
  memorySplitSections, memoryRebuildSections, memoryRebuildAllSections,
  memorySectionsForConcept, memorySectionsSearch, memoryAppendToSection,
  memoryUnconsolidatedCount, memorySectionsCount,
  memoryStageStatsGet, memoryStageStatsPatch, memoryStageStatsSetGlobal,
  // v3.1 — conversations lane + injection gate + pinned lanes
  memoryRebuildConversationFts, memoryRebuildAllConversationsFts,
  memoryConversationsSearch, memoryGateCheck,
  memoryEnsureLanes, memoryGetLanes, MEMORY_LANE_SLUGS,
  // Tier 2 — codebase indexer
  embedBatch, chunkText, hashContent,
  memoryCodeUpsertFile, memoryCodeRemoveFile, memoryCodeStats,
  memoryCodeVecSearch, memoryCodeFtsSearch, memoryConceptVecSearch,
  memoryConceptEmbed, memoryConceptForget,
  backfillConceptEmbeddings, closeEmbedWorker,
};