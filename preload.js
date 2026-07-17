// Farnsworth — preload
// Narrow IPC surface exposed to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farnsworth', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  getSetting: (key) => ipcRenderer.invoke('setting:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('setting:set', key, value),

  // Dev tools (farnsworth backend boot detection, per app type)
  // Returns {available, type, url, pid} when `npm run farnsworth:<appType>`
  // is running, or {available: false, type} when the dev server is down.
  // repoRoot (optional): the active workspace path — main.js uses this to
  // reject a cached dev server that belongs to a different project
  // (Long Jul 9 ~15:05 ET — orphan cache from a previous session).
  devFarnsworthGet: (appType, repoRoot) => ipcRenderer.invoke('dev:farnsworth:get', appType, repoRoot),
  // Boot the farnsworth dev server for a workspace by running its
  // `npm run farnsworth:<appType>` script. Resolves when the server is up
  // (or fails). Returns {ok, url, pid} on success, {ok:false, error, message}
  // on failure.
  devFarnsworthBoot: (appType, repoRoot) => ipcRenderer.invoke('dev:farnsworth:boot', appType, repoRoot),
  // Stop the farnsworth dev server for an app type (kills vite, clears meta).
  devFarnsworthStop: (appType) => ipcRenderer.invoke('dev:farnsworth:stop', appType),

  // Recent folders
  getRecent: () => ipcRenderer.invoke('recent:get'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // Canvas live preview — BrowserView-backed (Jul 9 ~18:20 ET).
  // Replaces the <webview>-tag approach which couldn't propagate CSS-driven
  // height changes to the inner viewport (the squished-150px bug).
  // viewId is a renderer-generated string used to track the BrowserView
  // between updates. bounds = {x, y, width, height} in window-content pixels.
  canvasCreateView: (viewId, url, bounds, opts) =>
    ipcRenderer.invoke('canvas:createView', { viewId, url, bounds, opts }),
  canvasOpenDevTools: (viewId) => ipcRenderer.invoke('canvas:openDevTools', { viewId }),
  canvasSetNetworkAccess: (allowed) => ipcRenderer.invoke('canvas:setNetworkAccess', { allowed }),
  canvasUpdateViewBounds: (viewId, bounds) =>
    ipcRenderer.invoke('canvas:updateViewBounds', { viewId, bounds }),
  canvasRemoveAllViews: () => ipcRenderer.invoke('canvas:removeAllViews'),
  canvasRemoveView: (viewId) =>
    ipcRenderer.invoke('canvas:removeView', { viewId }),
  canvasSetPreview: (preview) => ipcRenderer.invoke('canvas:setPreview', { preview }),
  // Subscribe to programmatic preview switches (chat agent's open_testview
  // tool, Jul 11 ~18:50 ET). Renderer-side handler does the same thing as
  // the size-toggle click — nukes views, sets state.preview, re-renders.
  onCanvasSetPreview: (callback) => {
    const handler = (_e, payload) => {
      try { callback(payload); } catch (err) { console.error('[canvas:setPreview] handler error:', err); }
    };
    ipcRenderer.on('canvas:setPreview', handler);
    return () => ipcRenderer.removeListener('canvas:setPreview', handler);
  },
  canvasSetVisible: (viewId, visible) =>
    ipcRenderer.invoke('canvas:setVisible', { viewId, visible }),
  canvasSetZoomFactor: (viewId, factor) =>
    ipcRenderer.invoke('canvas:setZoomFactor', { viewId, factor }),
  // Debug: inspect a canvas BrowserView's webContents state.
  canvasDebugView: (viewId) =>
    ipcRenderer.invoke('canvas:debugView', { viewId }),
  addRecent: (p) => ipcRenderer.invoke('recent:add', p),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),

  // Folder picker
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // Workspace config
  loadWorkspaceConfig: (folderPath) => ipcRenderer.invoke('workspace:loadConfig', folderPath),
  saveWorkspaceConfig: (folderPath, config) => ipcRenderer.invoke('workspace:saveConfig', folderPath, config),

  // Devvit emulator — user library + per-project settings.
  // The user/subreddit library is global (workspace-agnostic). The
  // active selection is per-project (workspace_path key).
  devvitListUsers: () => ipcRenderer.invoke('devvit:list-users'),
  devvitUpsertUser: (user) => ipcRenderer.invoke('devvit:upsert-user', user),
  devvitDeleteUser: (id) => ipcRenderer.invoke('devvit:delete-user', id),
  devvitListSubreddits: () => ipcRenderer.invoke('devvit:list-subreddits'),
  devvitUpsertSubreddit: (sub) => ipcRenderer.invoke('devvit:upsert-subreddit', sub),
  devvitDeleteSubreddit: (id) => ipcRenderer.invoke('devvit:delete-subreddit', id),
  devvitGetProjectSettings: (workspacePath) => ipcRenderer.invoke('devvit:get-project-settings', workspacePath),
  devvitSetProjectSettings: (workspacePath, userId, subId) => ipcRenderer.invoke('devvit:set-project-settings', workspacePath, userId, subId),
  // Companion v0.4 IPCs (Jul 13) — set project user/subreddit from the
  // companion's Preview sheet cogwheel.
  setDevvitProjectUser: (folder, userId) => ipcRenderer.invoke('devvit:setProjectUser', { folder, userId }),
  setDevvitProjectSubreddit: (folder, subredditId) => ipcRenderer.invoke('devvit:setProjectSubreddit', { folder, subredditId }),
  // Companion v0.4 IPCs (Jul 13) — canvas reload + chat stop/model.
  canvasReloadPreview: () => ipcRenderer.invoke('canvas:reloadPreview'),
  chatSetModel: (alias) => ipcRenderer.invoke('chat:setModel', { alias }),
  chatStopInference: () => ipcRenderer.invoke('chat:stopInference'),
  // Companion v0.4 IPC (Jul 13) — run a test by absolute path.
  runTest: (testPath) => ipcRenderer.invoke('test:run', { path: testPath }),

  // File operations
  readDir: (folderPath, depth) => ipcRenderer.invoke('fs:readDir', folderPath, depth),
  readFile: (folderPath, filePath) => ipcRenderer.invoke('fs:readFile', folderPath, filePath),
  grepWorkspace: (folderPath, query, opts) => ipcRenderer.invoke('fs:grepWorkspace', folderPath, query, opts),
  listFiles: (folderPath, opts) => ipcRenderer.invoke('fs:listFiles', folderPath, opts),
  writeFile: (folderPath, filePath, content) => ipcRenderer.invoke('fs:writeFile', folderPath, filePath, content),
  showInFinder: (folderPath, filePath) => ipcRenderer.invoke('fs:showInFinder', folderPath, filePath),
  rename: (folderPath, oldRelPath, newRelPath) => ipcRenderer.invoke('fs:rename', folderPath, oldRelPath, newRelPath),
  delete: (folderPath, relPath) => ipcRenderer.invoke('fs:delete', folderPath, relPath),

  // Auth — manual API key
  setApiKey: (key, provider) => ipcRenderer.invoke('auth:setApiKey', key, provider),
  hasApiKey: (provider) => ipcRenderer.invoke('auth:hasApiKey', provider),
  clearApiKey: (provider) => ipcRenderer.invoke('auth:clearApiKey', provider),
  codexStatus: () => ipcRenderer.invoke('auth:codexStatus'),

  // Auth — Claude.ai OAuth (PKCE) — loopback flow
  oauthStart: () => ipcRenderer.invoke('auth:oauthStart'),
  oauthWaitForCallback: (state) => ipcRenderer.invoke('auth:oauthWaitForCallback', state),
  oauthComplete: (code, state) => ipcRenderer.invoke('auth:oauthComplete', code, state),
  oauthRefresh: () => ipcRenderer.invoke('auth:oauthRefresh'),
  oauthStatus: () => ipcRenderer.invoke('auth:oauthStatus'),
  oauthDisconnect: () => ipcRenderer.invoke('auth:oauthDisconnect'),

  // Credential surfaces — secure secret storage (keychain-backed)
  credentialPromptSecret: (payload) => ipcRenderer.invoke('credential:promptSecret', payload || {}),
  credentialReadSecret: (payload) => ipcRenderer.invoke('credential:readSecret', payload || {}),
  credentialDeleteSecret: (payload) => ipcRenderer.invoke('credential:deleteSecret', payload || {}),

  // Auth — Import OAuth tokens from Claude Code CLI's credential store entry.
  // Cross-platform via keytar (Mac Keychain / Windows Credential Manager /
  // Linux libsecret); Mac-only `security` shell fallback if keytar isn't loaded.
  // Workaround for when claude.ai/v1/oauth/{org}/authorize mutationFn is broken.
  importFromKeychain: () => ipcRenderer.invoke('auth:importFromKeychain'),

  // Auth — Re-store Farnsworth's current auth_tokens row back to the OS
  // credential store. Cross-platform via keytar; Mac shell fallback. After
  // running importFromKeychain once, this lets the next Farnsworth launch
  // on Windows/Linux reuse the credential store entry Claude Code CLI
  // already wrote — no fresh `claude auth login` needed.
  reStoreToKeychain: () => ipcRenderer.invoke('auth:reStoreToKeychain'),

  // Auth — Spawn `claude login` as a child process. The CLI opens the
  // browser, captures the local-loopback callback, exchanges the code,
  // and writes the token to the OS credential store. After exit, main
  // reads the freshly-written entry via the same keychain-import path.
  // Use this when the manual Import button fails with no_credentials —
  // Farnsworth drives the full auth flow autonomously.
  runClaudeLogin: () => ipcRenderer.invoke('auth:runClaudeLogin'),

  // Auth — Claude Code CLI detection
  checkClaudeCode: () => ipcRenderer.invoke('auth:checkClaudeCode'),

  // Chat history
  chatList: (workspacePath) => ipcRenderer.invoke('chat:list', workspacePath),
  chatAdd: (workspacePath, role, content, model, meta) => ipcRenderer.invoke('chat:add', workspacePath, role, content, model, meta),
  chatClear: (workspacePath) => ipcRenderer.invoke('chat:clear', workspacePath),

  // Chat conversations — persisted threads (multi-chat switcher in the UI)
  chatConvList: () => ipcRenderer.invoke('chatConv:list'),
  chatConvLoad: (id) => ipcRenderer.invoke('chatConv:load', id),
  chatConvCreate: (payload) => ipcRenderer.invoke('chatConv:create', payload || {}),
  chatConvSave: (payload) => ipcRenderer.invoke('chatConv:save', payload || {}),
  chatConvDelete: (id) => ipcRenderer.invoke('chatConv:delete', id),

  // Test scripts (NLP test creator, Jul 10 ~23:50 ET)
  testSave: ({ folder, name, json }) => ipcRenderer.invoke('test:save', { folder, name, json }),
  testRun: ({ path }) => ipcRenderer.invoke('test:run', { path }),
  testList: ({ folder } = {}) => ipcRenderer.invoke('test:list', { folder }),
  testRead: ({ folder, name }) => ipcRenderer.invoke('test:read', { folder, name }),
  testDelete: ({ folder, name }) => ipcRenderer.invoke('test:delete', { folder, name }),
  // Inference — call Claude API with saved OAuth token or manual API key
  sendMessage: (opts) => ipcRenderer.invoke('inference:send', opts),
  // Git primitives for per-call-site AI commands (AI Commit / AI Review)
  gitBranch: (opts) => ipcRenderer.invoke('git:branch', opts || {}),
  gitDiff: (opts) => ipcRenderer.invoke('git:diff', opts || {}),
  gitCommit: (opts) => ipcRenderer.invoke('git:commit', opts || {}),
  // Streaming — returns a Promise that resolves with the final result.
  // onChunk is called for each SSE event: { type: 'text_delta'|'tool_use_delta'|'block_stop'|..., ... }
  streamMessage: (opts, onChunk) => {
    const requestId = 'stream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    ipcRenderer.send('inference:stream', { ...opts, requestId });
    return new Promise((resolve, reject) => {
      const handler = (_e, payload) => {
        if (payload.requestId !== requestId) return;
        if (payload.type === 'done') {
          ipcRenderer.removeListener('inference:chunk', handler);
          resolve(payload.result);
        } else if (payload.type === 'error') {
          ipcRenderer.removeListener('inference:chunk', handler);
          reject({ ok: false, error: payload.error, message: payload.message, status: payload.status });
        } else {
          try { onChunk && onChunk(payload); } catch {}
        }
      };
      ipcRenderer.on('inference:chunk', handler);
    });
  },
  executeTool: (name, input) => ipcRenderer.invoke('inference:toolExecute', name, input),
  getAgentTools: () => ipcRenderer.invoke('inference:agentTools'),

  // Tasks
  tasksList: (workspacePath) => ipcRenderer.invoke('tasks:list', workspacePath),
  tasksAdd: (workspacePath, status, title, detail, priority, source, assignee, fileLink) => ipcRenderer.invoke('tasks:add', workspacePath, status, title, detail, priority, source, assignee, fileLink),
  tasksUpdate: (id, fields) => ipcRenderer.invoke('tasks:update', id, fields),
  tasksDelete: (id) => ipcRenderer.invoke('tasks:delete', id),

  // Platform
  platform: () => ipcRenderer.invoke('app:platform'),

  // Live panel — Anomaly Intelligence Reddit Games API
  liveLoadGame: (gameId) => ipcRenderer.invoke('live:loadGame', gameId),
  // Force a fresh fetch + write to the live_game_cache table.
  liveRefreshGame: (gameId) => ipcRenderer.invoke('live:refreshGame', gameId),
  liveChat: (gameId, payload) => ipcRenderer.invoke('live:chat', gameId, payload),

  // Live panel — cached ticket suggestions (SQLite-backed)
  liveTicketsGet: (gameId) => ipcRenderer.invoke('live:ticketsGet', gameId),
  liveTicketsSave: (gameId, tickets, rawReply) => ipcRenderer.invoke('live:ticketsSave', gameId, tickets, rawReply),
  liveTicketsClear: (gameId) => ipcRenderer.invoke('live:ticketsClear', gameId),

  // Terminal panel (Phase 2)
  getTerminalWsUrl: () => ipcRenderer.invoke('terminal:getWsUrl'),
  // Terminal command pipe-in (Phase 5) — agent's run_command pipes into the active PTY
  terminalRunCommand: (command) => ipcRenderer.invoke('terminal:runCommand', command),
  // Close a specific terminal tab by id (killed its PTY + WS)
  terminalClose: (tabId) => ipcRenderer.invoke('terminal:close', tabId),

  // Claude Code panel — spawns the `claude` binary in a PTY (not bash).
  // Same protocol as the terminal panel (WebSocket bridge), separate port
  // (9224) so the two panels run independently. CWD = workspace folder.
  // This is the "official Claude Code embedded in Farnsworth" path — the
  // chat panel remains a custom API client; this panel is Anthropic's
  // Claude Code binary running as a child process.
  getClaudeCodeWsUrl: () => ipcRenderer.invoke('claudeCode:getWsUrl'),
  claudeCodeClose: (tabId) => ipcRenderer.invoke('claudeCode:close', tabId),
  // Tab persistence — restore the panel's open tabs across restarts.
  claudeCodeListTabs: () => ipcRenderer.invoke('claudeCode:listTabs'),
  claudeCodeSaveTabs: (state) => ipcRenderer.invoke('claudeCode:saveTabs', state),

  // Claude Code panel auth gate — the renderer checks auth before spawning
  // the `claude` TUI. If unauthenticated, it shows a sign-in card with a
  // button that calls claudeCodeRunLogin (spawns `claude login`, waits for
  // Keychain to update, returns the result).
  claudeCodeCheckAuth: () => ipcRenderer.invoke('claudeCode:checkAuth'),
  claudeCodeRunLogin: () => ipcRenderer.invoke('claudeCode:runLogin'),

  // Codex panel (mirrors the Claude Code panel IPC surface, Jul 14).
  // codexStatus (Settings → AI detection) already exists above; these are
  // the panel's own lifecycle calls.
  getCodexWsUrl: () => ipcRenderer.invoke('codex:getWsUrl'),
  codexClose: (tabId) => ipcRenderer.invoke('codex:close', tabId),
  codexListTabs: () => ipcRenderer.invoke('codex:listTabs'),
  codexSaveTabs: (state) => ipcRenderer.invoke('codex:saveTabs', state),
  codexCheckAuth: () => ipcRenderer.invoke('codex:checkAuth'),
  codexRunLogin: () => ipcRenderer.invoke('codex:runLogin'),

  // Native menu bridge — the macOS menu bar sends 'menu:action' events to
  // the focused window. The renderer subscribes via onMenuAction(callback)
  // and reacts (openFolder, openFile, newWindow, etc.). Returns an
  // unsubscribe function.
  onMenuAction: (callback) => {
    const handler = (_e, payload) => {
      try { callback(payload); } catch (err) { console.error('[menu] handler error:', err); }
    };
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },

  // Memory system (Tier 1, Jul 5 2026) — always-loaded essentials + concepts
  // + buffer + archive. Tier 1 uses LIKE-based recall; Tier 2 swaps in
  // sqlite-vec. The IPC surface is shaped so the swap is renderer-invisible.
  //
  // bootstrap  → { essentials, recentConcepts, today }    (load at convo start)
  // recall     → { essentials, concepts, buffer }         (semantic search)
  // remember   → appends to buffer + archive (immutable log)
  // get/set/delete/list → CRUD on concept files
  // essential-get/set/delete/essentials → CRUD on essentials
  // consolidate → flip buffer rows to consolidated
  // archive/buffer → read daily log + buffer (debugging + future community)
  memoryBootstrap: () => ipcRenderer.invoke('memory:bootstrap'),
  memoryRecall: (query, limit) => ipcRenderer.invoke('memory:recall', query, limit),
  memoryRemember: (content, opts) => ipcRenderer.invoke('memory:remember', content, opts),
  memoryGet: (slug) => ipcRenderer.invoke('memory:get', slug),
  memorySet: (concept) => ipcRenderer.invoke('memory:set', concept),
  memoryDelete: (slug) => ipcRenderer.invoke('memory:delete', slug),
  memoryList: (limit) => ipcRenderer.invoke('memory:list', limit),
  memoryEssentialGet: (key) => ipcRenderer.invoke('memory:essential-get', key),
  memoryEssentialSet: (key, value, source, confidence) => ipcRenderer.invoke('memory:essential-set', key, value, source, confidence),
  memoryEssentialDelete: (key) => ipcRenderer.invoke('memory:essential-delete', key),
  memoryEssentials: () => ipcRenderer.invoke('memory:essentials'),
  memoryConsolidate: (bufferIds) => ipcRenderer.invoke('memory:consolidate', bufferIds),
  memoryArchive: (opts) => ipcRenderer.invoke('memory:archive', opts),
  memoryBuffer: (onlyUnconsolidated, limit) => ipcRenderer.invoke('memory:buffer', onlyUnconsolidated, limit),
  // Tier 3 (Jul 12 2026) — routing + consolidation + stage stats
  memoryRoute: (opts) => ipcRenderer.invoke('memory:route', opts),
  memoryRunConsolidation: () => ipcRenderer.invoke('memory:run-consolidation'),
  memoryRunRetrospective: (convId) => ipcRenderer.invoke('memory:run-retrospective', convId),
  memoryStageStats: () => ipcRenderer.invoke('memory:stage-stats'),
  // Tier 2 — codebase indexer (sqlite-vec)
  memoryCodeStats: (workspacePath) => ipcRenderer.invoke('memory:code-stats', workspacePath),
  memoryCodeIndexFile: (workspacePath, filePath, content) => ipcRenderer.invoke('memory:code-index-file', workspacePath, filePath, content),
  memoryCodeRemoveFile: (workspacePath, filePath) => ipcRenderer.invoke('memory:code-remove-file', workspacePath, filePath),
  memoryCodeWatch: (workspacePath) => ipcRenderer.invoke('memory:code-watch', workspacePath),
  memoryCodeUnwatch: () => ipcRenderer.invoke('memory:code-unwatch'),
  memoryCodeSearch: (workspacePath, query, k) => ipcRenderer.invoke('memory:code-search', workspacePath, query, k),

  // Folder watcher — pushes fs:folderEvent messages when files
  // change on disk outside the editor (agent writes, external
  // edits, etc.). Renderer-side debounce + readFolder().
  fsWatchFolder: (folderPath) => ipcRenderer.invoke('fs:watchFolder', folderPath),
  fsUnwatchFolder: () => ipcRenderer.invoke('fs:unwatchFolder'),
  onFsFolderEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('fs:folderEvent', handler);
    return () => ipcRenderer.removeListener('fs:folderEvent', handler);
  },

  // Unsaved-changes prompt — Save / Don't Save / Cancel.
  // 0 = Save, 1 = Don't Save, 2 = Cancel (or error).
  dialogConfirmDiscard: (opts) => ipcRenderer.invoke('dialog:confirmDiscard', opts || {}),
  memoryConceptEmbed: (slug) => ipcRenderer.invoke('memory:concept-embed', slug),
  memoryConceptForget: (slug) => ipcRenderer.invoke('memory:concept-forget', slug),

  // Relay — outbound WS to farnsworth-relay for companion app connectivity
  relaySend: (msg) => ipcRenderer.invoke('relay:send', msg),
  relayStatus: () => ipcRenderer.invoke('relay:status'),
  onRelayMessage: (handler) => {
    ipcRenderer.on('relay:message', (_e, data) => handler(data));
    return () => ipcRenderer.removeListener('relay:message', handler);
  },
  onRelayStatus: (handler) => {
    ipcRenderer.on('relay:status', (_e, data) => handler(data));
    return () => ipcRenderer.removeListener('relay:status', handler);
  },

  // Clipboard image paste — read from main-process clipboard (more
  // reliable than the renderer's dataTransfer for native macOS sources
  // like Lightshot, Preview, Finder) and save to disk for the Claude
  // Code panel's file-reference path. Jul 16 ~23:30 ET.
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),
  clipboardSaveImage: (opts) => ipcRenderer.invoke('clipboard:saveImage', opts),

  // File attachments — paperclip button / drag-drop / Finder paste
  // (Jul 16 ~23:55 ET). openFiles is the native macOS picker
  // (multi-select); fileRead inlines small text file content for the
  // message body, with a hard cap (100KB) so the API call stays sane.
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  fileRead: (opts) => ipcRenderer.invoke('file:read', opts),
});