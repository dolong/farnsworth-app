# Farnsworth Memory System — Tier 1

**Shipped: Jul 5 ~20:45 ET**

## What it does

A working 4-table memory system backing Farnsworth's chat panel:
- **Essentials** — always-loaded key→value pairs (preferences, corrections, identity)
- **Concepts** — long-form wiki-style articles (one per topic, with lead + body + sections)
- **Buffer** — raw facts learned this session, awaits consolidation
- **Archive** — immutable daily log of every chat turn (user msg + agent reply)

The chat panel injects essentials + recent concept leads as a `[Farnsworth memory]` preamble on the FIRST message of each conversation. Every completed chat turn writes user msg + agent reply to the archive (immutable log). Tier 1 uses LIKE-based recall; Tier 2 will swap in sqlite-vec embeddings.

## What's in the code

| File | Change |
| --- | --- |
| `db.js` | Added 4 tables (`memory_essentials`, `memory_concepts`, `memory_buffer`, `memory_archive`) + 11 CRUD/recall functions + exports |
| `main.js` | Added 14 IPC handlers (`memory:bootstrap`, `memory:recall`, `memory:remember`, `memory:get/set/delete/list`, `memory:essential-get/set/delete/essentials`, `memory:consolidate`, `memory:archive`, `memory:buffer`) |
| `preload.js` | Exposed the 14 IPCs as `window.farnsworth.memory*` methods |
| `src/app.js` | Extended `renderMemorySettings()` with a "Farnsworth Memory (Tier 1)" section showing essentials + concepts + buffer with add/edit/delete. Added memory preamble injection on first send of each conversation. Added memory archive capture on every chat turn completion via `finally` block. |

## Endpoints

```
memory:bootstrap                 → { essentials, recentConcepts, today }
memory:recall(query, limit?)     → { essentials, concepts, buffer }
memory:remember(content, opts?)  → appends to buffer + archive
memory:get(slug)                 → full concept body
memory:set(concept)              → upsert concept
memory:delete(slug)              → delete concept
memory:list(limit?)              → recent concepts
memory:essential-get(key)
memory:essential-set(key, val, src?, conf?)
memory:essential-delete(key)
memory:essentials                → list all
memory:consolidate(bufferIds?)   → flip buffer rows to consolidated
memory:archive(opts?)            → read daily log
memory:buffer(onlyUnconsolidated?, limit?)
```

## Verified via CDP (Jul 5 ~20:40 ET)

```
memoryEssentials() → 2 entries (long_prefers_pithy, no_permission_prompts)
memoryBootstrap() → { essentials: [...], recentConcepts: [long-profile], today: "2026-07-06" }
memoryRecall("long prefers pithy") → matches both essentials AND long-profile concept
memorySet(long-profile) → {ok: true}
memoryRecall("migrated Claude") → finds long-profile via title/lead/body LIKE match
```

## Chat-side wiring

**Memory preamble** (`sendChatMessage`):
- On first send of each conversation: `await memoryBootstrap()`, build `[Farnsworth memory]\n# Memory essentials\n- key: value\n# Recent concepts\n- slug: lead\n[/Farnsworth memory]` preamble, prepend to user message.
- Subsequent messages in the same conversation: no preamble (already in LLM working memory).
- `state.memoryLoadedForConv = state.chatActiveId` tracks per-conversation.

**Turn archive** (`finally` block after the tool-use for loop):
- `memoryRemember(userText, { kind: 'fact', source: 'chat.user', context: 'conv=...' })`
- `memoryRemember(agentText, { kind: 'fact', source: 'chat.agent', context: 'conv=...' })` (skip on error)
- Truncates to 800 chars per message to keep archive reasonable.

## Settings UI

Open Settings (cogwheel) → Memory. The bottom of the panel shows:

**Farnsworth Memory (Tier 1)** section:
- **Essentials (always-loaded)** — list of key→value rows with delete buttons, add form (key + value)
- **Concepts (long-form articles)** — list of slug + title rows with view (alert with full body) + delete + add form (slug + title + lead)
- **Buffer (raw facts awaiting consolidation)** — list of recent facts with per-row consolidate button + "Consolidate all buffer" button

## Schema

```sql
CREATE TABLE memory_essentials (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memory_concepts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lead TEXT,
  body TEXT,
  sections TEXT,        -- JSON
  tags TEXT,             -- JSON
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memory_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  context TEXT,
  source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  consolidated INTEGER DEFAULT 0
);

CREATE TABLE memory_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,    -- 'fact' | 'correction' | 'commitment' | 'plan' | 'note'
  content TEXT NOT NULL,
  metadata TEXT,         -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## What ships NOT in Tier 1

- ❌ **sqlite-vec embeddings** — currently LIKE-based. Tier 2 swap is renderer-invisible (the IPC surface is shaped for it).
- ❌ **Codebase indexer** — Tier 2. Embeds project files for semantic search across code.
- ❌ **Consolidation cron** — Tier 2. Merges buffer into concepts on a schedule.
- ❌ **Live community memory** — Tier 3. Scrape GitHub issues, Reddit threads.
- ❌ **User-tunable pipeline** — Tier 3. Settings UI for the 6 pipeline stages with model selector.
- ❌ **Concept browser/editor UI** — Tier 1 uses `alert()` for concept view; Tier 2 gets a proper editor pane.
- ❌ **Memory router** — Tier 3. Pick which concept pages to inject next turn based on conversation context.

## How to test

```bash
# Open Settings → Memory in Farnsworth
# Add an essential: key="long_prefers_pithy", value="true"
# Add a concept: slug="test-concept", title="Test", lead="A test concept"
# Send a chat message — should see memory preamble on first send
# Check archive: sqlite3 ~/Library/Application\ Support/Farnsworth/farnsworth/farnsworth.db "SELECT * FROM memory_archive;"
```

## Files

- `~/Documents/Farnsworth/app/db.js` — schema + functions
- `~/Documents/Farnsworth/app/main.js` — IPC handlers
- `~/Documents/Farnsworth/app/preload.js` — contextBridge exposure
- `~/Documents/Farnsworth/app/src/app.js` — Settings UI + chat preamble + turn archive