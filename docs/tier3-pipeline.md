# Tier 3 — Memory pipeline (v3: section-grain + per-stage models)

**Status:** SHIPPED + verified Jul 12, 2026 (~17:10 ET). Built in one pass after Long's call to migrate straight to the v3-equivalent architecture ("migrate to the best version, and make sure settings reflect how it actually works").

## What it is

Farnsworth's memory is a five-stage model pipeline over the SQLite store. Each stage has its own model, enabled toggle, and settings, configured in **Settings → Memory** (which now describes exactly what runs — no mock chrome).

| # | Stage | Default model | Runs | Fallback when disabled/unavailable |
|---|---|---|---|---|
| 1 | Extraction | Haiku 4.5 | after each chat turn (`memory:remember`) | raw text buffered unfiltered |
| 2 | Consolidation | Sonnet 5 | scheduled (Hourly/Daily/Weekly) + buffer threshold + manual Run now | consolidate = flag flip only |
| 3 | Retrieval | Sonnet 5 | on `memory:recall` | raw FTS5 order |
| 4 | Memory Router | Haiku 4.5 | **every chat send** (`memory:route`) | Tier-1 bootstrap dump, first message only |
| 5 | Section Selector (L2) | Haiku 4.5 | with the router, when routed articles have >1 section | whole article injected (v2-style) |

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
- Pill: `TIER 3 · LIVE`. Five stages, honest descriptions including each stage's fallback.
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
