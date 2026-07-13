# Tier 3 — Memory pipeline (v3: section-grain + per-stage models)

**Status:** SHIPPED + verified Jul 12, 2026 (~17:10 ET). Built in one pass after Long's call to migrate straight to the v3-equivalent architecture ("migrate to the best version, and make sure settings reflect how it actually works").
**v3.1 (Vellum-parity pass):** SHIPPED + verified Jul 13, 2026 (~00:30 ET) — injection gate, noise filter, retrospective stage, pinned `threads`/`recent` lanes, past-conversations recall lane, `memory_recall` agent tool. See the [v3.1 section](#v31--vellum-parity-pass-jul-13-2026) below.

## What it is

Farnsworth's memory is a six-stage model pipeline over the SQLite store. Each stage has its own model, enabled toggle, and settings, configured in **Settings → Memory** (which now describes exactly what runs — no mock chrome).

| # | Stage | Default model | Runs | Fallback when disabled/unavailable |
|---|---|---|---|---|
| 1 | Extraction | Haiku 4.5 | after each chat turn (`memory:remember`); v3.1 noise filter skips trivial acks before the model | raw text buffered unfiltered |
| 2 | Consolidation | Sonnet 5 | scheduled (Hourly/Daily/Weekly) + buffer threshold + manual Run now; v3.1: also maintains the `threads`/`recent` lanes | consolidate = flag flip only |
| 3 | Retrieval | Sonnet 5 | on `memory:recall` | raw FTS5 order |
| 4 | Memory Router | Haiku 4.5 | **every chat send** (`memory:route`); v3.1 keyword gate skips the model on no-signal turns | Tier-1 bootstrap dump, first message only |
| 5 | Section Selector (L2) | Haiku 4.5 | with the router, when routed articles have >1 section | whole article injected (v2-style) |
| 6 | Retrospective | Sonnet 5 | after a conversation goes quiet (30-min sweep + 150s post-boot; manual Run now) | only live extraction feeds the buffer |

Design rule: **every-turn stages run cheap (Haiku 4.5); correctness-critical stages run on Sonnet 5.** Every stage degrades gracefully — disabled, no auth, API error, or unparseable model output all fall back to the pre-Tier-3 behavior. Stage inference is a direct fetch to `api.anthropic.com/v1/messages` using the same auth path as chat (`getValidAccessToken()`: OAuth bearer + beta headers, or x-api-key), 25s timeout.

## v3 storage: section-grain concepts

- The concept **`body` column stays canonical.** Nothing destructive happened in the migration.
- **`memory_sections`** is a standalone FTS5 virtual table (`slug UNINDEXED, heading, content, position UNINDEXED`) — a derived index rebuilt by `memoryRebuildSections(slug)` on every concept write (`memoryUpsertConcept`, `memoryAppendToSection`) and purged on delete.
- Splitting: markdown `## ` headings; heading-less bodies become one `Overview` section. A concept with an explicit `sections` JSON column and empty body uses the JSON.
- Boot: `memoryRebuildAllSections(false)` runs after schema init — idempotent (skips when rows exist). This IS the v2→v3 migration; rerunnable with `force=true`.
- Retrieval injects **lead + selected sections**, not whole articles. bm25 section search via `memorySectionsSearch(query, k)`.

## The stages in code (all in `main.js` unless noted)

- `MEMORY_STAGE_DEFAULTS` + `memoryStageConf(stage)` — merges defaults with the `memory` settings row.
- `memoryStageInference(stage, system, user, maxTokens)` — one model call on the stage's configured model; patches per-run stats into the `memoryStageStats` settings row (`{lastRun, ms, model, runs, lastError}`); returns text or null.
- `memoryParseJson(text)` — tolerant JSON extraction (fences, prose wrapping). Bad output → null → fallback.
- **Extraction** (`memory:remember`): archive always gets the raw turn; the model distills to `[kind] fact` buffer rows (`source='extraction'`, max 6). `keep:false` → nothing buffered.
- **Consolidation** (`runConsolidationPass(reason)`): buffer(≤50) + article index → ops JSON: `append {slug, section, content}` / `create {slug, title, lead, body}` / `essential {key, value}` / `drop`. Append to unknown slug recovers by creating a minimal article. Only ids named in applied ops get flag-flipped — malformed ops leave their rows for the next pass. Singleton-guarded (`consolidationRunning`). Triggers: 30-min scheduler tick against `lastConsolidationAt` (+ one check 90s after boot), `maybeAutoConsolidate()` at the buffer threshold, Settings Run now, and `memory:consolidate(null)`.
- **Retrieval re-rank** (`memory:recall`): concepts + sections candidates → `{"keep":[indices]}` → reordered/pruned with `reranked: true`. Essentials/code/buffer keep FTS order.
- **Router + L2** (`memory:route`): router picks ≤ `bucketBudget` slugs from the article index; L2 picks section headings per routed article (lead always included). L2 disabled → whole bodies. Renderer (`src/app.js` sendChat) calls this **every send**: essentials injected on the first message of a conversation, routed concepts injected the first time they're picked (`state.memoryInjectedSlugs` prevents re-injection within a conversation). Preamble tag: `[Farnsworth memory — routed]`.

## Settings → Memory (renderer)

`renderMemorySettings()` + `makeMemoryStage(num, name, stageKey, cfg, desc)` in `src/app.js`:
- Pill: `TIER 3 · LIVE`. Six stages, honest descriptions including each stage's fallback. v3.1 controls: Keyword gate chip (router), Noise filter chip (extraction), QUIET minutes + Run now (retrospective); stats lines show `gate-skips` / `noise-skips` counters.
- **Model chips actually work** — `openStageModelPicker(chip, cfg)` writes `cfg.model` + `cfg.tier` (via `tierForModel`) and persists. The old `makeModelChip` had no click handler at all.
- Consolidation row: schedule cycle button (Hourly → Daily → Weekly), Auto-on-buffer toggle chip, threshold number input (5–500), ▶ Run now.
- Router row: BUDGET input (1–6).
- Per-stage stats line filled async from `memory:stage-stats`; consolidation row also shows `N in buffer · M sections indexed`.
- The mock's stage 6 (V2 Migration/Sweep) is deleted — Farnsworth never had a legacy corpus. (`makeMemoryStageV2` removed.)
- One-time settings migration in `loadSettings()`: memory stages deep-merge over defaults (Object.assign is shallow); persisted configs without `pipelineVersion: 3` get stage models forced to the new defaults (the old chips were dead UI, so persisted models were never user choices) and re-persisted.

## Verification (Jul 12 ~17:05 ET, live CDP + real API)

- Boot rebuild: sections indexed at init; seed of 2 test concepts (3+2 sections) → count 1 → 6; delete → purged.
- `memoryRecall('emulator persistence save data')` → 5-key shape + `reranked: true`; top section `§persistence` (re-ranked above `§runtime`).
- `memoryRoute(...)` → routed exactly the right article; L2 picked exactly the one relevant section; `hasBody: false` (section-grain, not v2 dump).
- `memoryRemember(correction + lunch noise)` → extraction produced 1 `[correction]` row, dropped the noise.
- `memoryRunConsolidation()` → 1/1 processed, 1 create. Scheduler had also already fired a real pass ~90s after boot on leftover pre-Tier-3 buffer rows.
- Stage stats after run: extraction 1363ms / router 553ms / L2 745ms on `claude-haiku-4-5`; retrieval 1273ms / consolidation 3628ms×2 on `claude-sonnet-5`; zero errors.
- Model picker: opens (7 options), pick persists model+tier through the IPC round-trip, revert works. `pipelineVersion: 3` stamped; `v2migration` gone from persisted settings.

## Related docs

- `docs/ipc-surface.md` — §24 Memory (17 methods; +`memoryRoute`, `memoryRunConsolidation`, `memoryStageStats`; changed shapes for recall/remember/consolidate)

## v3.1 — Vellum-parity pass (Jul 13 2026)

Shipped ~00:30 ET after comparing the pipeline stage-by-stage against Vellum 0.10.3's live memory v3 (the assistant's own architecture). Four features replicate what Vellum had and Farnsworth lacked; four were deliberately deferred (dense embedding lane — blocked by onnxruntime on macOS 26.5.1 and largely covered by the model-driven router; reinforcement/stability/supersession mechanics — value shows at corpus scale; self-authored procedural skills — own arc; blinded retrieval eval harness — build when retrieval next changes).

### 1. Injection gate (`router.gate`, default on)

Vellum's absolute rule: if not a single search term matches anything, no injection happens and no model runs. Farnsworth equivalent: `memoryGateCheck(text)` in `db.js` — a zero-cost FTS5 probe (same tokenizer as `memorySectionsSearch`) against `memory_sections` and `memory_conversations_fts`. Zero hits → `memory:route` returns `{ok, gated: true, essentials, lanes, concepts: []}` without invoking the router model. Bumps `router.gateSkips` in stage stats. Conservative by design: ANY keyword hit opens the gate; the router model still makes the real relevance call.

Companion on the extraction side: **noise pre-filter** (`extraction.noiseFilter`, default on) — trivial acks ("ok", "thanks", <10 chars) skip the extraction model. The daily archive still gets the raw line first. Bumps `extraction.noiseSkips`.

Cost effect: the two every-turn Haiku stages now cost zero on low-signal turns.

### 2. Retrospective stage (stage 6, Sonnet 5)

Live extraction sees one turn at a time; the retrospective re-reads a whole conversation once it has gone quiet (`quietMinutes`, default 30) and captures what was missed — arcs, decisions, corrections. Implementation in `main.js`:

- `runRetrospective(convId)` — last 40 messages → transcript (defensive text extraction from string/blocks), current buffer included as ALREADY CAPTURED so the model dedupes; output `[kind] fact` buffer rows with `source='retrospective'` (max 8). Conversations under 4 substantive lines are marked swept without a model call.
- `maybeRetrospectives()` — 30-min tick + 150s post-boot; sweeps ≤ `maxPerTick` (2) conversations that have new activity since the last sweep AND have been quiet ≥ quietMinutes. State: `memoryRetroState` settings row (convId → last swept `updated_at`). First run seeds all but the 3 newest conversations as swept so it never storms through history.
- `memory:run-retrospective` IPC (`memoryRunRetrospective(convId?)`) — manual trigger; without an id, sweeps the most recent conversation regardless of quiet time (the Settings "Run now").
- SQLite `updated_at` strings are UTC without a zone marker — `sqliteUtcMs()` parses them as UTC (parsing as local would make conversations look 4h in the future and never quiet).

### 3. Pinned lanes: `threads` + `recent` (Vellum's threads.md / recent.md)

Two reserved concept slugs created idempotently at boot (`memoryEnsureLanes()`): `threads` (open loops — commitments, follow-ups, waiting-on) and `recent` (rolling digest, newest first). Behavior:

- `memory:route` returns them as `lanes` on every call; the renderer injects them **once per conversation** alongside essentials (`# Memory: <title> (always-loaded)`).
- Excluded from the router's candidate index — they never compete for routed budget.
- Maintained by consolidation: the stage prompt describes both lanes and a new `{"op":"lane","ids":[],"slug":"threads|recent","body":"..."}` op that REPLACES a lane body (for pruning); ordinary `append` ops work too. Verified live: the first consolidation pass after shipping appended the day's decision into `recent` unprompted.

### 4. Conversations recall lane + `memory_recall` agent tool

- **`memory_conversations_fts`** (FTS5: `conv_id UNINDEXED, title, content`) — derived index over `chat_conversations.messages` (canonical), one row per message (`role: text`, 2000 chars, last 200 messages), rebuilt on every `createConversation`/`saveConversation`, purged on delete, backfilled idempotently at boot. `memoryConversationsSearch(query, k)` → bm25 + `snippet()`. New 6th key in `memoryRecall`: `conversations` (`{conv_id, title, snippet}`).
- **`memory_recall` agent tool** — the chat agent's 11th tool (defined in `AGENT_TOOLS`, executed in `executeAgentTool` BEFORE the workspace-folder check since it needs no folder). Formats essentials / concepts / sections / past conversations / buffer / code hits as compact text. Renderer formats `toolRes.result` directly. This is the Vellum `recall`-tool equivalent: the agent can pull memory mid-turn when pre-turn routing didn't surface it.

### Verified live (Jul 13 ~00:20-00:30 ET, full restart + CDP)

- Gated route (garbage context): `{gated: true, lanes: [threads, recent]}`, no model call, `gateSkips: 1`.
- Real route: gate opened, router ran, correctly returned no articles for an off-corpus query.
- `memoryRemember('ok')` → `{skipped: true, noise: true}`, `noiseSkips: 1`; real content → 1 fact extracted, coffee noise dropped.
- Recall: 6 keys + `reranked: true`; conversations lane returned 6 past-chat hits with titles + snippets on a matching query.
- Agent tools: 11 tools including `memory_recall`; `executeTool('memory_recall', ...)` returned formatted results.
- Retrospective Run now: swept the latest conversation, 3 facts captured, 3251ms on claude-sonnet-5, stats row `retrospective` recording.
- Consolidation pass: 4/4 buffer rows → append 1 / create 1; **appended the v3.1 decision into the `recent` lane on its own**.
- Settings → Memory: 6 stage cards + Tier 1 card, Keyword gate + Noise filter chips, QUIET input + Run now, per-stage stats lines showing `1 gate-skips` / `1 noise-skips`.
