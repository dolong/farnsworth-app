# Farnsworth IPC Surface — Full Method Inventory

**Source:** `app/preload.js` (auto-generated 1:1 — keep in sync when methods are added/removed/renamed).
**Verified count:** 125 methods as of Jul 13, 2026.
**Historical count:** 84 (post-Tier 1, Jul 5) → 91 (post-Tier 2, Jul 6 ~20:23 ET) → 121 (Jul 12 morning) → 124 (Jul 12 Tier 3: `memoryRoute`, `memoryRunConsolidation`, `memoryStageStats`) → 125 (Jul 13 v3.1: `memoryRunRetrospective`). Earlier growth driven by Test View (5), canvas polish (3), relay (5), tab persistence (2), Devvit settings (8), chat conversations (5), Claude Code auth gate (2), and one-offs.

## Conventions

Every method on `window.farnsworth` calls into the main process via Electron's IPC. Two shapes:

| Shape | Pattern | Used by |
|---|---|---|
| **invoke (request/response)** | `ipcRenderer.invoke('channel:name', ...args)` returns a Promise | most methods |
| **subscribe (event push)** | `ipcRenderer.on('channel:name', handler)` returns an unsubscribe function | 5 methods (`on*`) — `onCanvasSetPreview`, `onFsFolderEvent`, `onMenuAction`, `onRelayMessage`, `onRelayStatus` |
| **stream (chunked response)** | `ipcRenderer.send('inference:stream', ...)` + `ipcRenderer.on('inference:chunk', ...)` — returns a Promise that resolves with the final result on `type:'done'` | `streamMessage` only |

### Parameter shapes

- **Most invoke methods** take either primitive args or an object — match the signature in the table below.
- **Tier 1 memory IPCs** (`memoryRecall`, `memoryRemember`, etc.) take an **object** (`{query, limit}`).
- **Tier 2 memory IPCs** (`memoryCodeWatch`, `memoryCodeStats`, etc.) take a **positional string** (the workspace path) — *not* an object. Calling them with `{folder: "..."}` returns `{ok: false, error: "missing_workspace_path"}`. Verified Jul 6.
- **Live panel IPCs** (`liveChat`) take the `gameId` first, then the payload.

### Channel naming

Channels in `main.js` use colon-prefixed lowercase (`memory:code-watch`, `canvas:setVisible`). Exposed renderer-side methods are **camelCase** (`memoryCodeWatch`, `canvasSetVisible`). The mapping is 1:1; preload.js is the contract.

### Categories

1. [Settings](#1-settings--4)
2. [Dev tools (farnsworth backend boot)](#2-dev-tools--3)
3. [Recent folders](#3-recent-folders--3)
4. [Canvas live preview](#4-canvas-live-preview--8)
5. [Folder picker](#5-folder-picker--1)
6. [Workspace config](#6-workspace-config--2)
7. [Devvit emulator](#7-devvit-emulator--8)
8. [File operations](#8-file-operations--8)
9. [Auth — manual API key](#9-auth--manual-api-key--3)
10. [Auth — Claude.ai OAuth (PKCE)](#10-auth--claudeai-oauth-pkce--6)
11. [Credentials (keychain-backed)](#11-credentials-keychain-backed--3)
12. [Auth — keychain import](#12-auth--keychain-import--3)
13. [Auth — Claude Code CLI detection](#13-auth--claude-code-cli-detection--1)
14. [Chat history (per-workspace)](#14-chat-history-per-workspace--3)
15. [Chat conversations (multi-chat switcher)](#15-chat-conversations-multi-chat-switcher--5)
16. [Test scripts (NLP test creator + Test View)](#16-test-scripts--5)
17. [Inference](#17-inference--4)
18. [Tasks](#18-tasks--4)
19. [Platform](#19-platform--1)
20. [Live panel — Reddit Games API](#20-live-panel--reddit-games-api--3)
21. [Live panel — cached ticket suggestions](#21-live-panel--cached-ticket-suggestions--3)
22. [Terminal panel](#22-terminal-panel--3)
23. [Claude Code panel](#23-claude-code-panel--6)
24. [Memory — Tiers 1 + 3](#24-memory--tiers-1--3--18)
25. [Memory — Tier 2 (codebase indexer)](#25-memory--tier-2-codebase-indexer--6)
26. [Folder watcher](#26-folder-watcher--3)
27. [Memory — concept operations](#27-memory--concept-operations--2)
28. [Relay (farnsworth-relay companion app)](#28-relay-farnsworth-relay-companion-app--5)

---

### 1. Settings — 4

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `getSettings` | `settings:get` | `()` | `Promise<object>` | All settings at once. **Bulk path was silently broken until Jul 12 ~00:45 ET** — see [§ known-bugs](#known-bugs) below. |
| `setSettings` | `settings:set` | `(settings: object)` | `Promise<{ok}>` | Persists the whole settings object. Fix landed: passes the object directly (was double-`Object.entries`-ing). |
| `getSetting` | `setting:get` | `(key: string)` | `Promise<any>` | Single-key getter. **The recommended path for new code.** |
| `setSetting` | `setting:set` | `(key: string, value: any)` | `Promise<{ok}>` | Single-key setter. Recommended over `setSettings` for new code. |

### 2. Dev tools — 3

Farnsworth backend dev server boot detection per app type (`devvit`, etc.).

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `devFarnsworthGet` | `dev:farnsworth:get` | `(appType: string, repoRoot?: string)` | `Promise<{available, type, url, pid}>` | Returns `{available: false, type}` when down. **`repoRoot` parameter added Jul 9 ~15:05 ET** — rejects cached dev server from a different project (orphan-cache guard). |
| `devFarnsworthBoot` | `dev:farnsworth:boot` | `(appType: string, repoRoot?: string)` | `Promise<{ok, url, pid} \| {ok:false, error, message}>` | Runs `npm run farnsworth:<appType>` in the workspace; resolves when server is up. |
| `devFarnsworthStop` | `dev:farnsworth:stop` | `(appType: string)` | `Promise<{ok}>` | Kills vite, clears meta. |

### 3. Recent folders — 3

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `getRecent` | `recent:get` | `()` | `Promise<string[]>` |
| `addRecent` | `recent:add` | `(folderPath: string)` | `Promise<{ok}>` |
| `clearRecent` | `recent:clear` | `()` | `Promise<{ok}>` |

### 4. Canvas live preview — 8

`WebContentsView`-backed since Jul 9 ~18:55 ET (replaced `<webview>`-tag approach which couldn't propagate CSS-driven height changes).

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `canvasCreateView` | `canvas:createView` | `(viewId: string, url: string, bounds: {x,y,width,height})` | `Promise<{ok}>` | `viewId` is renderer-generated string tracking the BrowserView between updates. `bounds` in window-content pixels. |
| `canvasUpdateViewBounds` | `canvas:updateViewBounds` | `(viewId: string, bounds: {x,y,width,height})` | `Promise<{ok}>` | Resize/move. **Must be clipped to containing DOM element** — placeholder `getBoundingClientRect()` returns natural size regardless of overflow (Jul 10 ~16:10 ET). |
| `canvasRemoveAllViews` | `canvas:removeAllViews` | `()` | `Promise<{ok}>` | Nuke all views. **Call from `renderCanvas()`** — `Page.reload` leaves views composited (WebContentsView orphan bug, Jul 11 ~17:14 ET). |
| `canvasRemoveView` | `canvas:removeView` | `(viewId: string)` | `Promise<{ok}>` | Remove a specific view. |
| `canvasSetPreview` | `canvas:setPreview` | `(preview: object)` | `Promise<{ok}>` | Set the current preview (the chat agent's `open_testview` tool fires this). |
| `onCanvasSetPreview` | `canvas:setPreview` (event) | `(callback: (payload) => void)` | unsubscribe fn | Subscribe to programmatic preview switches. Renderer-side handler does the same as the size-toggle click — nukes views, sets `state.preview`, re-renders. Added Jul 11 ~18:50 ET. |
| `canvasSetVisible` | `canvas:setVisible` | `(viewId: string, visible: boolean)` | `Promise<{ok}>` | Hide/show a view. **CSS `z-index` does NOT affect `WebContentsView`** — it's a separate composited layer. To make a popover appear on top, `setVisible(false)` the canvas view (Jul 10 ~11:18 ET). |
| `canvasDebugView` | `canvas:debugView` | `(viewId: string)` | `Promise<object>` | Inspect a canvas view's webContents state. |

### 5. Folder picker — 1

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `openFolderDialog` | `dialog:openFolder` | `()` | `Promise<string \| null>` |

### 6. Workspace config — 2

Reads/writes `<project>/.farnsworth/config.json`.

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `loadWorkspaceConfig` | `workspace:loadConfig` | `(folderPath: string)` | `Promise<object \| null>` |
| `saveWorkspaceConfig` | `workspace:saveConfig` | `(folderPath: string, config: object)` | `Promise<{ok}>` |

### 7. Devvit emulator — 8

User library + subreddit library are global (workspace-agnostic). The active selection is per-project (keyed by workspace_path).

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `devvitListUsers` | `devvit:list-users` | `()` | `Promise<DevvitUser[]>` |
| `devvitUpsertUser` | `devvit:upsert-user` | `(user: DevvitUser)` | `Promise<{ok}>` |
| `devvitDeleteUser` | `devvit:delete-user` | `(id: string)` | `Promise<{ok}>` |
| `devvitListSubreddits` | `devvit:list-subreddits` | `()` | `Promise<DevvitSubreddit[]>` |
| `devvitUpsertSubreddit` | `devvit:upsert-subreddit` | `(sub: DevvitSubreddit)` | `Promise<{ok}>` |
| `devvitDeleteSubreddit` | `devvit:delete-subreddit` | `(id: string)` | `Promise<{ok}>` |
| `devvitGetProjectSettings` | `devvit:get-project-settings` | `(workspacePath: string)` | `Promise<{userId, subId} \| null>` |
| `devvitSetProjectSettings` | `devvit:set-project-settings` | `(workspacePath: string, userId: string, subId: string)` | `Promise<{ok}>` |

### 8. File operations — 8

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `readDir` | `fs:readDir` | `(folderPath: string, depth?: number)` | `Promise<DirEntry[]>` | |
| `readFile` | `fs:readFile` | `(folderPath: string, filePath: string)` | `Promise<string>` | |
| `grepWorkspace` | `fs:grepWorkspace` | `(folderPath: string, query: string, opts?: object)` | `Promise<Match[]>` | |
| `listFiles` | `fs:listFiles` | `(folderPath: string, opts?: object)` | `Promise<string[]>` | |
| `writeFile` | `fs:writeFile` | `(folderPath: string, filePath: string, content: string)` | `Promise<{ok}>` | |
| `showInFinder` | `fs:showInFinder` | `(folderPath: string, filePath: string)` | `Promise<{ok}>` | TCC-safe "reveal in Finder". |
| `rename` | `fs:rename` | `(folderPath: string, oldRelPath: string, newRelPath: string)` | `Promise<{ok}>` | |
| `delete` | `fs:delete` | `(folderPath: string, relPath: string)` | `Promise<{ok}>` | |

### 9. Auth — manual API key — 3

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `setApiKey` | `auth:setApiKey` | `(key: string)` | `Promise<{ok}>` |
| `hasApiKey` | `auth:hasApiKey` | `()` | `Promise<boolean>` |
| `clearApiKey` | `auth:clearApiKey` | `()` | `Promise<{ok}>` |

### 10. Auth — Claude.ai OAuth (PKCE) — 6

Loopback flow. **The `oauthComplete` mutationFn path is broken** — see [§ known-bugs](#known-bugs).

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `oauthStart` | `auth:oauthStart` | `()` | `Promise<{authorizeUrl, state}>` |
| `oauthWaitForCallback` | `auth:oauthWaitForCallback` | `(state: string)` | `Promise<{code}>` |
| `oauthComplete` | `auth:oauthComplete` | `(code: string, state: string)` | `Promise<{ok} \| {ok:false, error}>` |
| `oauthRefresh` | `auth:oauthRefresh` | `()` | `Promise<{ok}>` |
| `oauthStatus` | `auth:oauthStatus` | `()` | `Promise<{connected, expiresAt, ...}>` |
| `oauthDisconnect` | `auth:oauthDisconnect` | `()` | `Promise<{ok}>` |

### 11. Credentials (keychain-backed) — 3

Cross-platform via keytar (Mac Keychain / Windows Credential Manager / Linux libsecret).

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `credentialPromptSecret` | `credential:promptSecret` | `(payload: {name, prompt, fields})` | `Promise<{ok, values}>` |
| `credentialReadSecret` | `credential:readSecret` | `(payload: {name})` | `Promise<{ok, values} \| null>` |
| `credentialDeleteSecret` | `credential:deleteSecret` | `(payload: {name})` | `Promise<{ok}>` |

### 12. Auth — keychain import — 3

Workaround for when the Claude.ai OAuth mutationFn is broken (Jun 25 ~22:48 ET). Reads/writes the OS credential store entry Claude Code CLI uses.

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `importFromKeychain` | `auth:importFromKeychain` | `()` | `Promise<{ok} \| {ok:false, error}>` | Imports Claude Code's credential store entry into Farnsworth's `auth_tokens` row. Mac-only `security` shell fallback if keytar isn't loaded. |
| `reStoreToKeychain` | `auth:reStoreToKeychain` | `()` | `Promise<{ok}>` | Re-stores Farnsworth's current `auth_tokens` back to the OS credential store — lets the next Farnsworth launch on Windows/Linux reuse the credential store entry Claude Code CLI already wrote. |
| `runClaudeLogin` | `auth:runClaudeLogin` | `()` | `Promise<{ok} \| {ok:false, error}>` | Spawns `claude login` as a child process — the CLI opens the browser, captures the loopback callback, exchanges the code, and writes the token to the OS credential store. After exit, main reads the freshly-written entry via the same keychain-import path. |

### 13. Auth — Claude Code CLI detection — 1

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `checkClaudeCode` | `auth:checkClaudeCode` | `()` | `Promise<{installed: boolean, path?: string, version?: string}>` |

### 14. Chat history (per-workspace) — 3

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `chatList` | `chat:list` | `(workspacePath: string)` | `Promise<ChatMessage[]>` |
| `chatAdd` | `chat:add` | `(workspacePath: string, role: string, content: string, model?: string, meta?: object)` | `Promise<{ok, id}>` |
| `chatClear` | `chat:clear` | `(workspacePath: string)` | `Promise<{ok}>` |

### 15. Chat conversations (multi-chat switcher) — 5

Persisted threads (multi-chat switcher in the UI).

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `chatConvList` | `chatConv:list` | `()` | `Promise<ChatConv[]>` |
| `chatConvLoad` | `chatConv:load` | `(id: string)` | `Promise<ChatConv \| null>` |
| `chatConvCreate` | `chatConv:create` | `(payload: {title?, workspacePath?})` | `Promise<{ok, id}>` |
| `chatConvSave` | `chatConv:save` | `(payload: ChatConv)` | `Promise<{ok}>` |
| `chatConvDelete` | `chatConv:delete` | `(id: string)` | `Promise<{ok}>` |

### 16. Test scripts — 5

NLP test creator (Jul 10 ~23:50 ET) + Test View (Jul 11). **Per-project convention**: tests live at `<project>/.farnsworth/devvit-tests/*.json` since Jul 11 ~18:38 ET.

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `testSave` | `test:save` | `({folder, name, json})` | `Promise<{ok, path}>` | |
| `testRun` | `test:run` | `({path})` | `Promise<{ok, output, exitCode}>` | |
| `testList` | `test:list` | `({folder}?)` | `Promise<TestFile[]>` | |
| `testRead` | `test:read` | `({folder, name})` | `Promise<{json, path}>` | |
| `testDelete` | `test:delete` | `({folder, name})` | `Promise<{ok}>` | |

### 17. Inference — 4

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `sendMessage` | `inference:send` | `(opts: SendOpts)` | `Promise<InferenceResult>` | Non-streaming. |
| `streamMessage` | `inference:stream` + `inference:chunk` | `(opts: SendOpts, onChunk: (payload) => void)` | `Promise<InferenceResult>` (resolves on `type:'done'`) | The streaming handler. **Tool-use blocks sanitized Jul 11 ~19:55 ET** — `src/app.js:8194` strips renderer-side accumulator fields (`inputJson`, `caller`) before pushing to API history. |
| `executeTool` | `inference:toolExecute` | `(name: string, input: object)` | `Promise<any>` | |
| `getAgentTools` | `inference:agentTools` | `()` | `Promise<Tool[]>` | Returns the 10-tool agent array. |

### 18. Tasks — 4

DB-backed Tasks panel (Jun 26 ~11:50 ET).

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `tasksList` | `tasks:list` | `(workspacePath: string)` | `Promise<Task[]>` |
| `tasksAdd` | `tasks:add` | `(workspacePath, status, title, detail, priority, source, assignee, fileLink)` | `Promise<{ok, id}>` |
| `tasksUpdate` | `tasks:update` | `(id: string, fields: object)` | `Promise<{ok}>` |
| `tasksDelete` | `tasks:delete` | `(id: string)` | `Promise<{ok}>` |

### 19. Platform — 1

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `platform` | `app:platform` | `()` | `Promise<{os, arch, electron, node, chrome}>` |

### 20. Live panel — Reddit Games API — 3

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `liveLoadGame` | `live:loadGame` | `(gameId: string)` | `Promise<LiveGame \| null>` |
| `liveRefreshGame` | `live:refreshGame` | `(gameId: string)` | `Promise<LiveGame>` |
| `liveChat` | `live:chat` | `(gameId: string, payload: {message, ...})` | `Promise<{reply}>` |

### 21. Live panel — cached ticket suggestions — 3

SQLite-backed ticket cache.

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `liveTicketsGet` | `live:ticketsGet` | `(gameId: string)` | `Promise<{tickets, rawReply} \| null>` |
| `liveTicketsSave` | `live:ticketsSave` | `(gameId, tickets, rawReply)` | `Promise<{ok}>` |
| `liveTicketsClear` | `live:ticketsClear` | `(gameId: string)` | `Promise<{ok}>` |

### 22. Terminal panel — 3

Phase 2 PTY integration.

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `getTerminalWsUrl` | `terminal:getWsUrl` | `()` | `Promise<{url}>` | |
| `terminalRunCommand` | `terminal:runCommand` | `(command: string)` | `Promise<{ok}>` | Phase 5 — agent's `run_command` pipes into the active PTY. |
| `terminalClose` | `terminal:close` | `(tabId: string)` | `Promise<{ok}>` | Kills the PTY + WS for the tab. |

### 23. Claude Code panel — 6

Spawns the `claude` binary in a PTY (not bash). Same WS protocol as terminal panel, separate port (9224).

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `getClaudeCodeWsUrl` | `claudeCode:getWsUrl` | `()` | `Promise<{url}>` | |
| `claudeCodeClose` | `claudeCode:close` | `(tabId: string)` | `Promise<{ok}>` | |
| `claudeCodeListTabs` | `claudeCode:listTabs` | `()` | `Promise<TabState[]>` | Tab persistence (Jul 9). |
| `claudeCodeSaveTabs` | `claudeCode:saveTabs` | `(state: TabState)` | `Promise<{ok}>` | Tab persistence (Jul 9). |
| `claudeCodeCheckAuth` | `claudeCode:checkAuth` | `()` | `Promise<{authenticated: boolean}>` | Renderer checks before spawning the `claude` TUI. |
| `claudeCodeRunLogin` | `claudeCode:runLogin` | `()` | `Promise<{ok} \| {ok:false, error}>` | Spawns `claude login`, waits for Keychain update. |

### 24. Memory — Tiers 1 + 3 — 18

SQLite-backed persistence (4 tables + `memory_sections`, a derived FTS5 index at section grain: `memory_essentials`, `memory_concepts`, `memory_buffer`, `memory_archive`, `memory_sections`). **Tier 1 IPCs use object args.** Tier 3 (Jul 12) added the per-stage model pipeline: extraction on remember, model consolidation, retrieval re-rank on recall, and pre-turn routing (`memoryRoute`). The concept `body` column stays canonical; `memory_sections` is rebuilt on every concept write.

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `memoryBootstrap` | `memory:bootstrap` | `()` | `Promise<{essentials, recentConcepts, today}>` | Called on app init. |
| `memoryRecall` | `memory:recall` | `(query: string, limit?: number)` | `Promise<{essentials, concepts, code, buffer, sections, conversations, reranked?}>` | **6-key shape as of Jul 13 (v3.1)** — `sections` is section-grain FTS5 hits over `memory_sections`; `conversations` is bm25 hits over `memory_conversations_fts` (`{conv_id, title, snippet}`). When the retrieval stage is enabled, concepts + sections come back model-re-ranked with `reranked: true`; on any failure the raw FTS5 order returns unchanged. |
| `memoryRemember` | `memory:remember` | `(content: string, opts?: object)` | `Promise<{ok, id?, extracted?, skipped?, noise?}>` | Archive always gets the raw content. **Tier 3:** when the extraction stage is enabled, a cheap model distills the content into `[kind] fact` buffer rows (`source='extraction'`, max 6; `keep:false` skips buffering entirely, returning `{ok, extracted: 0, skipped: true}`). **v3.1:** a zero-cost noise pre-filter (`noiseFilter`, default on) skips the model call for trivial acks ("ok", "thanks", <10 chars), returning `{skipped: true, noise: true}` and bumping `extraction.noiseSkips`. Disabled/no-auth/bad-output falls back to raw buffering. |
| `memoryGet` | `memory:get` | `(slug: string)` | `Promise<Concept \| null>` | |
| `memorySet` | `memory:set` | `(concept: Concept)` | `Promise<{ok}>` | |
| `memoryDelete` | `memory:delete` | `(slug: string)` | `Promise<{ok}>` | |
| `memoryList` | `memory:list` | `(limit?: number)` | `Promise<Concept[]>` | |
| `memoryEssentialGet` | `memory:essential-get` | `(key: string)` | `Promise<any>` | |
| `memoryEssentialSet` | `memory:essential-set` | `(key: string, value: any, source?: string, confidence?: number)` | `Promise<{ok}>` | |
| `memoryEssentialDelete` | `memory:essential-delete` | `(key: string)` | `Promise<{ok}>` | |
| `memoryEssentials` | `memory:essentials` | `()` | `Promise<EssentialsMap>` | List all essentials. |
| `memoryConsolidate` | `memory:consolidate` | `(bufferIds: number[] \| null)` | `Promise<{ok, count?} \| ConsolidationResult>` | Explicit ids: plain flag flip (per-row Settings buttons). **`null` (Tier 3): runs the full Stage-2 model pass** — merges buffer facts into concept sections via append/create/essential/drop ops. |
| `memoryArchive` | `memory:archive` | `(opts?: {since?, until?})` | `Promise<ArchiveEntry[]>` | |
| `memoryBuffer` | `memory:buffer` | `(onlyUnconsolidated?: boolean, limit?: number)` | `Promise<BufferEntry[]>` | |
| `memoryRoute` | `memory:route` | `({context: string})` | `Promise<{ok, essentials, lanes, concepts, routed, gated?} \| {ok: false, disabled?, error?}>` | **Tier 3 stages 4+5.** Router picks ≤ bucketBudget concept articles for the message; L2 selector picks sections within them (lead always included). L2 disabled → whole `body` per concept (v2-style). Router disabled → `{ok: false, disabled: true, essentials, lanes}`. **v3.1:** `lanes` = the pinned `threads` + `recent` articles (renderer injects them once per conversation, like essentials; excluded from the router index). Injection gate (`router.gate`, default on): zero keyword overlap between the message and the corpus → `{gated: true, concepts: []}` with **no model call** (bumps `router.gateSkips`). Called by the renderer on **every chat send**. |
| `memoryRunConsolidation` | `memory:run-consolidation` | `()` | `Promise<ConsolidationResult>` | Manual "Run now" from Settings → Memory. `{ok, processed, total, applied: {append, create, essential, drop, lane}, reason}`. v3.1: consolidation also maintains the `threads`/`recent` lanes (`lane` ops replace a lane body; ids:[]). |
| `memoryRunRetrospective` | `memory:run-retrospective` | `(convId?: string)` | `Promise<{ok, items?, title?, skipped?, reason?} \| {ok: false, error}>` | **v3.1 Stage 6.** Without `convId`: sweeps the most recent conversation regardless of quiet time (Settings "Run now"). With `convId`: sweeps that conversation. Model output lands as `[kind] fact` buffer rows (`source='retrospective'`). The scheduler (30-min tick + 150s post-boot) auto-sweeps conversations that have gone quiet ≥ `quietMinutes` with new activity since the last sweep (state: `memoryRetroState` settings row; first run seeds all but the 3 newest as swept). |
| `memoryStageStats` | `memory:stage-stats` | `()` | `Promise<{ok, stats, bufferCount, sectionsCount}>` | Per-stage `{lastRun, ms, model, runs, lastError}` + global `lastConsolidationAt` from the `memoryStageStats` settings row. |

### 25. Memory — Tier 2 (codebase indexer) — 6

FTS5-only path (Jul 7 ~02:11 ET, pivoted from sqlite-vec after onnxruntime allocator bug). **Tier 2 IPCs take a positional STRING (workspace path), NOT an object.**

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `memoryCodeStats` | `memory:code-stats` | `(workspacePath: string)` | `Promise<{chunks, files}>` | Verified: 2100 chunks / 51 files (Jul 7 ~16:15 ET). |
| `memoryCodeIndexFile` | `memory:code-index-file` | `(workspacePath: string, filePath: string, content: string)` | `Promise<{ok}>` | |
| `memoryCodeRemoveFile` | `memory:code-remove-file` | `(workspacePath: string, filePath: string)` | `Promise<{ok}>` | |
| `memoryCodeWatch` | `memory:code-watch` | `(workspacePath: string)` | `Promise<{ok, watching}>` | Calling with `{folder: "..."}` returns `{ok: false, error: "missing_workspace_path"}`. |
| `memoryCodeUnwatch` | `memory:code-unwatch` | `()` | `Promise<{ok}>` | |
| `memoryCodeSearch` | `memory:code-search` | `(workspacePath: string, query: string, k?: number)` | `Promise<SearchHit[]>` | Returns hits with `source='fts'` on code matches. |

### 26. Folder watcher — 3

Pushes `fs:folderEvent` messages when files change on disk outside the editor (agent writes, external edits).

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `fsWatchFolder` | `fs:watchFolder` | `(folderPath: string)` | `Promise<{ok, watching}>` | |
| `fsUnwatchFolder` | `fs:unwatchFolder` | `()` | `Promise<{ok}>` | |
| `onFsFolderEvent` | `fs:folderEvent` (event) | `(callback: (payload) => void)` | unsubscribe fn | Renderer-side debounce + `readFolder()`. |

### 27. Memory — concept operations — 2

| Renderer method | Channel | Signature | Returns |
|---|---|---|---|
| `memoryConceptEmbed` | `memory:concept-embed` | `(slug: string)` | `Promise<{ok}>` |
| `memoryConceptForget` | `memory:concept-forget` | `(slug: string)` | `Promise<{ok}>` |

### 28. Relay (farnsworth-relay companion app) — 5

Outbound WS to `farnsworth-relay` for companion app connectivity (Jul 8 thin slice).

| Renderer method | Channel | Signature | Returns | Notes |
|---|---|---|---|---|
| `relaySend` | `relay:send` | `(msg: RelayMsg)` | `Promise<{ok}>` | |
| `relayStatus` | `relay:status` | `()` | `Promise<{status, ...}>` | |
| `onRelayMessage` | `relay:message` (event) | `(handler: (data) => void)` | unsubscribe fn | |
| `onRelayStatus` | `relay:status` (event) | `(handler: (data) => void)` | unsubscribe fn | |
| (paired: `onMenuAction`) | `menu:action` (event) | `(callback: (payload) => void)` | unsubscribe fn | Native macOS menu bar sends `menu:action` events to the focused window. |

---

## Known bugs (current)

### `setSettings` bulk path was silently broken (fixed Jul 12 ~00:45 ET)

`main.js`'s `settings:set` handler passed `Object.entries(settings)` into `db.setAllSettings()` which runs `Object.entries` *again* internally — writing junk rows with numeric keys `'0'..'15'` containing `["key", value]` pair arrays. **Every call to `persistSettings()` (which calls `setSettings`) wrote corrupted data.** No bulk-persisted setting ever survived a restart (`defaultModel` included). Only single-key `setting:get`/`setting:set` (the newer IPCs) worked correctly.

**Fix:** `main.js` `settings:set` handler now passes the object directly. Junk rows purged. New code should prefer single-key `setSetting(key, value)` over bulk `setSettings(obj)`.

### `wire()` direct listeners on settings-pane elements are dead (fixed Jul 12 ~00:45 ET)

`wire()` runs once at boot, but `renderSettings()` rebuilds `#settings-pane.innerHTML` from scratch every render. Any `addEventListener` on settings-pane elements attached inside `wire()` is dead — the elements don't exist at boot. Fix pattern: document-level click delegation with `e.target.closest('#element-id')`.

### `oauthComplete` mutationFn path is broken (Jun 25 ~22:48 ET, known)

The Claude.ai PKCE OAuth mutationFn endpoint is broken. **Workaround:** use `importFromKeychain` to read Claude Code CLI's credential store entry, or `runClaudeLogin` to spawn `claude login` as a child process.

### `Page.reload` leaves `WebContentsView` composited (Jul 11 ~17:14 ET, fixed)

Renderer-side `teardownCanvasBrowserViews()` is a no-op when DOM is wiped. **Fix:** call `window.farnsworth.canvasRemoveAllViews()` from `renderCanvas()` and every other canvas-region entry point.

### Tool-use block sanitization (fixed Jul 11 ~19:55 ET)

Any `tool_use` block sent to the Anthropic API must contain ONLY `{type, id, name, input}` — strip everything else. Fix at `src/app.js:8194`.

## Adding a new method

1. Register the channel in `main.js` with `ipcMain.handle('namespace:action', ...)` (or `ipcMain.on` for fire-and-forget).
2. Expose it in `preload.js` under the `contextBridge.exposeInMainWorld('farnsworth', {...})` object, calling `ipcRenderer.invoke` (or `ipcRenderer.on` + unsubscribe wrapper for subscriptions).
3. Update this doc — keep the table row in the right category section.
4. If the renderer needs it, add to `src/app.js` state or wherever the call site is.
5. main.js changes require **full app restart** (`pkill -9 -f Farnsworth.app && open /Applications/Farnsworth.app`); renderer-only changes can be CDP `Page.reload`-ed.

## Cross-references

- `tests.md` — the test system wiki (covers the 5 test IPCs in depth)
- `DEVVIT-TESTS.md` — the JSON test format spec the chat agent reads
- `farnsworth-electron-app` concept (memory) — the build + IPC surface evolution
- `farnsworth-chat-surfaces` concept — the 13 chat surfaceTypes
- `farnsworth-memory` concept — Tier 1 + Tier 2 architecture
- `farnsworth-automation-suite` concept — test runner + chat agent tools
- `farnsworth-chat-agent` concept — the 10 tool agents