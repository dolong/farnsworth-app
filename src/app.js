// Farnsworth — renderer
// State + rendering for chat, canvas, right panel, settings overlay.
// All panes are state-driven — change state, re-render.

'use strict';

// ============================================================================
// LIVE PANEL CONFIG
//
// The Live tab pulls from the deployed Anomaly Intelligence API at
// https://anomalyint.vercel.app. To point it at a different game,
// swap LIVE_DEFAULT_GAME_ID below for another UUID from
// GET /api/reddit-games. The API is proxied through main.js IPC
// (live:loadGame + live:chat) so the renderer doesn't fetch cross-origin.
// ============================================================================
const LIVE_DEFAULT_GAME_ID = 'e6cf6a58-966e-4ae9-b3dd-cfa4a8a9c372'; // Sword & Supper
// Resolves the active game id — DB override (set via the Live cogwheel
// popover) wins over the constant. Falls back to the default if the
// setting hasn't been written or the renderer hasn't loaded it yet.
function getLiveGameId() {
  return state.liveGameId || LIVE_DEFAULT_GAME_ID;
}

// ============================================================================
// STATE
// ============================================================================
// Per-call-site model routing (Jul 13 ~23:05 ET) — the cost-control surface.
// Every row maps to a REAL call site in this file; decorative rows were
// removed in the honest-wiring pass. Model choices persist per-row via
// state.settings.perCallSiteRouting; routedModelApiId(id) resolves the
// API model for a call site (falls back to defaultModel).
//   titles → maybeGenerateConvTitle()  (fires after the first exchange)
//   commit → aiCommitCommand()         (⌘K → AI: Commit Changes)
//   review → aiReviewCommand()         (⌘K → AI: Review Changes)
// Memory pipeline stage models are NOT here — they have their own pickers
// on the Settings → Memory page (one source of truth per knob).
const ROUTING_CALL_SITES = [
  { id: 'titles', name: 'Conversation titles', model: 'Haiku 4.5', savings: 'saves ~50× vs Opus', desc: 'Auto-named after the first exchange' },
  { id: 'commit', name: 'AI Commit message', model: 'Haiku 4.5', savings: 'saves ~50× vs Opus', desc: '⌘K → AI: Commit Changes', confirm: true },
  { id: 'review', name: 'AI Code review', model: 'Sonnet 5', desc: '⌘K → AI: Review Changes' },
];

const state = {
  rightTab: 'files',          // files | tasks | live
  leftPanel: 'claudecode',    // chat | terminal | claudecode
  settingsOpen: false,
  settingsPage: 'ai',         // ai | memory | canvas | workspace | appearance | account
  vm: { markup: false, comments: false, edit: false, tweaks: true },
  vmMarkupStrokes: [],        // [{ points: [{x,y}], color, width }] in 0-1 coords
  vmComments: [],             // [{ id, x, y, text, createdAt }] in 0-1 coords
  vmCommentsDisplay: false,   // expand comment text inline (for screenshots / chat capture)
  preview: 'post',            // post | mobile | desktop | fullscreen | testview
  canvasMode: 'live',         // live | storybook | code
  codeFile: '',

  // Farnsworth backend dev server (set by `npm run farnsworth` in
  // vibe-farnsworth-template). When available, canvas preview iframes
  // point at the dev server URL. { available: false } when the meta
  // file is missing or the PID is dead.
  farnsworthDev: { available: false },
  farnsworthBooting: false,
  zoom: 100,

  // Persisted artboard widths per preview mode (height derives from aspect ratio)
  // Mobile aspect = 360/692, Desktop aspect = 720/460, Post aspect captured at drag start
  previewWidths: { post: 700, mobile: 390, desktop: 724, fullscreen: 1120, testview: 900 },

  // Left panel width (in-memory; resets on reload). Drag handle lets the user
  // grow it up to 66% of the viewport so Claude Code / Terminal can use more room.
  leftPanelWidth: 384,

  // Left panel collapsed (in-memory). True = 36px icon strip; False = full width.
  leftPanelCollapsed: false,

  // Right panel width (in-memory; resets on reload). Drag handle on the left edge.
  rightPanelWidth: 352,

  // Right panel collapsed (in-memory). True = 36px icon strip on right edge.
  rightPanelCollapsed: false,

  // Folder-based workspace (Phase 1)
  folder: null,
  appType: null,              // 'threejs' | 'blockchain' | 'devvit' | null
  welcomeOpen: true,
  appTypeOpen: false,
  auth: {
    apiKeySet: false,
    oauthConnected: false,
    oauthExpiresAt: null,
    oauthExpiresInSec: null,
    oauthAccountInfo: null,
    oauthInProgress: false,
    claudeCodeAvailable: false,
    openaiKeySet: false,
    codexAvailable: false,
    codexMethod: null,
  },

  // Live status-bar sources (Jul 14 — the bar was static mock text before).
  git: { branch: null, dirty: false },
  session: {
    routedCalls: 0,       // routedModelApiId() invocations this session
    lastUsage: null,      // { input_tokens, output_tokens } from the last chat turn
    memStats: null,       // { bufferCount, sectionsCount } from memory:stage-stats
  },

  // Settings — persisted via IPC
  settings: {
    defaultModel: 'Opus 4.8 High',
    // Model for test-runner llm-steps (Settings → AI → Testing model).
    // Injected into farnsworth-test.py as FARNSWORTH_TEST_MODEL by the
    // test:run spawns; a per-step "model" field still overrides. Jul 12.
    testingModel: 'Sonnet 5',
    // Honest rows only — see ROUTING_CALL_SITES above for the id → call
    // site mapping. behavior/verification/streaming were removed Jul 13
    // (persisted with zero consumers since day 1 — dead-controls audit).
    // routingV 2 = the honest-wiring migration; older persisted rows were
    // decorative seeds, not user choices, so they don't carry over.
    routingV: 2,
    perCallSiteRouting: ROUTING_CALL_SITES.map(r => ({ ...r })),
    memory: {
      extraction: { enabled: true, model: 'Haiku 4.5', tier: 'speed', extract: ['Corrections', 'Preferences', 'Decisions'], noiseFilter: true },
      consolidation: { enabled: true, model: 'Sonnet 5', tier: 'balanced', schedule: 'Daily', autoOnBuffer: true, bufferThreshold: 50 },
      retrieval: { enabled: true, model: 'Sonnet 5', tier: 'balanced', depth: 'Standard', summariesFirst: true, graphSpread: true },
      router: { enabled: true, model: 'Haiku 4.5', tier: 'speed', bucketBudget: 3, gate: true },
      l2selector: { enabled: true, model: 'Haiku 4.5', tier: 'speed' },
      retrospective: { enabled: true, model: 'Sonnet 5', tier: 'balanced', quietMinutes: 30 },
      pipelineVersion: 3,
    },
    canvas: {
      defaultZoom: 100, fitOnOpen: false,
      defaults: { markup: false, comments: false, tweaks: true },
      engine: { devtools: true, cookieIsolation: false, network: true },
    },
    // canvasV/appearanceV 2 = honest-wiring migration (Jul 13). Pre-wiring
    // persisted values were decorative seeds, not user choices, so they
    // don't carry over (same rule as routingV). The old workspace/account
    // seeds (fake storage path, sharing defaults, "Mara Blake") are gone --
    // Workspace renders live folder/recents state, About renders app:info.
    canvasV: 2,
    appearanceV: 2,
    appearance: { theme: 'dark', density: 'Comfortable', accent: 'blurple', font: 'Hanken Grotesk' },
  },

  chatMessages: [
    { id: 'welcome', role: 'agent', text: 'Hey Long — ready to ship. Try asking me to add a feature, refactor a file, or run a command. I can read, edit, and write files in your open folder.', verified: true },
  ],

  // Chat conversations — persisted threads. The active conversation's id is
  // stored here; switching the dropdown loads its messages into chatMessages
  // (and auto-saves push the latest snapshot back to DB).
  chatActiveId: null,
  chatHistoryOpen: false,
  chatHistory: [], // [{ id, title, updated_at, preview }]
  chatGeneratedTitles: {}, // convId → LLM-generated title (routing call site: 'titles')
  // NOTE: modelToApiId / CHAT_MODEL_OPTIONS / openModelPicker are declared
  // as standalone top-level functions BELOW (after the state object closes
  // at line ~262). They live outside the state object so they don't pollute
  // state serialization. They were originally placed here, but the closing
  // brace above was closing the state object too early — moved them out
  // (Jul 6 ~08:42 ET fix).


  files: { entries: [], current: null, loading: false },

  tasks: [],                   // loaded from DB on every Tasks tab mount; empty array means no tasks yet
  tasksLoadedForWs: null,       // last workspace_path we loaded tasks for; re-load when state.folder changes
  tasksLoading: false,          // true while a DB read is in flight (prevents double-loads)
  tasksFilter: 'all',           // all | todo | in-progress | done
  tasksComposing: false,        // inline new-task form open?

  // Live panel — subreddit/community analytics for the deployed game.
  // Was instance-based infra metrics; reoriented Jun 25 ~11:50 ET to match
  // the analytics dashboard at anomalyint.vercel.app. The data is now
  // fetched live from GET /api/reddit-games/:id (Jun 26 ~03:30 ET) — see
  // the LIVE_DEFAULT_GAME_ID constant near the top of this file. Mapping
  // lives in mapApiToLive(); the render functions consume the same shape
  // the old mock used, so the panel UI barely changed.
  liveGame: null,             // mapped subreddit-shaped object, or null while loading
  liveGameLoading: false,
  liveGameRefreshing: false,   // background refresh in flight (cache already on screen)
  liveGameFromCache: false,    // last load was served from the SQLite cache
  liveGameFetchedAt: null,     // ISO timestamp of when the current data was fetched
  liveGameError: null,
  liveGameId: null,            // override for LIVE_DEFAULT_GAME_ID; loaded from settings on init, updated via the cogwheel popover
  liveConfigOpen: false,       // true while the subreddit-config popover is mounted
  liveChatHistory: [],        // [{ role, content }, ...]
  liveChatPending: false,
  // AI-suggested JIRA-style tickets for the live game. Filled lazily
  // via the chat endpoint with a structured prompt; the renderer
  // parses the JSON reply into these shapes. Expand state is a Set
  // of ticket IDs currently shown in full. null = not yet attempted
  // (will trigger cache-load + auto-generate on first Live tab mount);
  // [] = attempted but cache miss + auto-generate kicked off.
  liveTickets: null,
  liveTicketsLoading: false,
  liveTicketsError: null,
  liveTimeoutSeconds: 15,   // configurable via Live cogwheel; backed by live.timeout_seconds SQLite setting
  files: { loading: false, entries: [], loadedForFolder: null, collapsed: new Set(), filter: '', selected: null }, // loadedForFolder gates the tab-switch lazy walk (Jul 3 ~15:11 ET boot lag fix); collapsed tracks manually-toggled folder paths; filter is the live keyword; selected is the relPath of the focused row for F2 rename / context menu
  liveConfig: {              // per-project Live panel config, backed by .farnsworth/config.json's `live` subkey
    projectName: '',         // display name for the project (e.g. "Froggy Auto-RPG")
    subredditName: '',       // human-readable subreddit name (e.g. "SwordAndSupperGame")
    url: '',                 // full Reddit URL for the subreddit
    postName: '',            // post to focus on in the Live panel post view
  },
  livePostEdits: {},         // in-memory edits by post id: { [postId]: { title, body, editedAt } }
  liveTicketsExpanded: new Set(),
  liveTicketsRawReply: null,  // last raw AI reply if JSON parse failed
  liveExpandedSections: { description: false, insights: true, changeLog: true },
};

  // chat panel reads state.settings.defaultModel ('Opus 4.8 High', etc.)
// and passes the translated id to window.farnsworth.streamMessage.
// Mapping source: platform.claude.com/docs/en/about-claude/models/overview
// (Jul 6 2026 model table). 'effort' on Opus 4.8 defaults to 'high' so
// we don't need to pass it explicitly.
function modelToApiId(displayName) {
  if (!displayName) return 'claude-opus-4-8'; // safe default if settings haven't loaded yet
  const map = {
    'Opus 4.8': 'claude-opus-4-8',
    'Opus 4.8 High': 'claude-opus-4-8',
    'Opus 4.7': 'claude-opus-4-7',
    'Opus 4.6': 'claude-opus-4-6',
    'Opus 4.5': 'claude-opus-4-5-20251101',
    'Sonnet 5': 'claude-sonnet-5',
    'Sonnet 4.6': 'claude-sonnet-4-6',
    'Sonnet 4.5': 'claude-sonnet-4-5',
    'Haiku 4.5': 'claude-haiku-4-5',
    'Fable 5': 'claude-fable-5',
  };
  return map[displayName] || displayName; // pass through if already an API id
}

// Per-call-site routing lookups (Jul 13 ~23:05 ET). See ROUTING_CALL_SITES
// at the top of the file for the id → call site mapping.
function routingRow(id) {
  return (state.settings?.perCallSiteRouting || []).find(r => r && r.id === id) || null;
}
function routedModelApiId(id) {
  const row = routingRow(id);
  // Status-bar counter: this function is only invoked at real call time
  // (titles/commit/review call sites), never during render, so counting
  // here counts actual routed model calls.
  if (state?.session) { state.session.routedCalls++; queueMicrotask(() => { try { updateStatusBar(); } catch {} }); }
  return modelToApiId(row?.model || state.settings?.defaultModel);
}

// The list of models Farnsworth's chat can pick. Used by the model picker
// popover below. API ids come from modelToApiId() so the picker can stay in
// display-name space.
const CHAT_MODEL_OPTIONS = [
  { display: 'Opus 4.8 High', effort: 'high', desc: '1M context · most capable · adaptive thinking' },
  { display: 'Opus 4.8',      effort: 'medium', desc: '1M context · most capable' },
  { display: 'Sonnet 5',      effort: 'high', desc: '1M context · fast · new' },
  { display: 'Sonnet 4.6',    effort: 'high', desc: '1M context · balanced' },
  { display: 'Sonnet 4.5',    effort: 'high', desc: '200k context · balanced' },
  { display: 'Haiku 4.5',     effort: null,   desc: '200k context · fastest' },
  { display: 'Fable 5',       effort: 'high', desc: 'Vellum default (Jul 2 ~16:00 ET)' },
];

// Model picker popover — anchored under a dropdown button in Settings → AI.
// Generic over the settings key it edits: 'defaultModel' (main chat thread)
// or 'testingModel' (test-runner llm-steps). Picking an option updates
// state.settings[settingsKey] and persists via persistSettings().
function openModelPicker(anchorBtn, settingsKey = 'defaultModel', onPick = null, currentDisplay = null) {
  // Close any existing picker first.
  const existing = document.querySelector('.model-picker');
  if (existing) existing.remove();

  const pop = el('div', { class: 'model-picker' });
  pop.style.cssText = `
    position: fixed; z-index: 9999;
    background: #1f2024; border: 1px solid #2a2c32;
    border-radius: 11px; padding: 6px;
    min-width: 320px; max-width: 380px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55);
    font-size: 13px;
  `;
  const r = anchorBtn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = r.left + 'px';

  for (const opt of CHAT_MODEL_OPTIONS) {
    const isCurrent = (currentDisplay ?? state.settings?.[settingsKey]) === opt.display;
    const row = el('button', {
      class: 'model-picker__row' + (isCurrent ? ' is-current' : ''),
      style: `
        display: flex; flex-direction: column; align-items: flex-start;
        width: 100%; padding: 9px 13px; border: none; border-radius: 7px;
        background: ${isCurrent ? 'rgba(168,85,247,.18)' : 'transparent'};
        color: ${isCurrent ? '#c8a6ff' : '#e6e9ef'};
        cursor: pointer; text-align: left;
      `,
    });
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        <span style="font-weight:600;font-size:13px;">${opt.display}</span>
        ${opt.effort ? `<span style="font-size:10px;color:#949ba4;background:#2a2c32;border-radius:4px;padding:2px 6px;font-weight:600;">${opt.effort.toUpperCase()}</span>` : ''}
        ${isCurrent ? '<span style="margin-left:auto;font-size:10px;color:#a855f7;">✓ current</span>' : ''}
      </div>
      <div style="font-size:11.5px;color:#949ba4;margin-top:2px;">${opt.desc}</div>
    `;
    row.addEventListener('click', () => {
      pop.remove();
      // Callback mode (per-call-site routing rows): the caller owns the
      // write + persist + re-render. Key mode (defaultModel/testingModel):
      // write the flat settings key directly.
      if (typeof onPick === 'function') { onPick(opt.display); return; }
      state.settings[settingsKey] = opt.display;
      persistSettings();
      renderSettings(); // re-render so the dropdown button shows the new value
      // Jul 14 ~09:20 ET: keep the chat input chip in sync when the
      // settings default changes (the settings dropdown lives in the
      // overlay; the chat input chip is in the main UI).
      if (settingsKey === 'defaultModel') updateChatInputModelButton();
    });
    pop.appendChild(row);
  }
  document.body.appendChild(pop);

  // Close on outside click or Escape
  const close = () => { pop.remove(); document.removeEventListener('click', onOutside); };
  const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorBtn) close(); };
  setTimeout(() => document.addEventListener('click', onOutside), 0);
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ============================================================================
// UTILITIES
// ============================================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      // Event names are case-insensitive in HTML but case-sensitive
      // in addEventListener — normalize to lowercase so onClick /
      // onChange / onInput etc. all resolve to the right DOM event.
      node.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => node.dataset[dk] = dv);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  children.flat().forEach(child => {
    if (child == null) return;
    if (typeof child === 'string' || typeof child === 'number') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  });
  return node;
}
function svg(viewBox, paths) {
  const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrap.setAttribute('viewBox', viewBox);
  wrap.setAttribute('width', '24');
  wrap.setAttribute('height', '24');
  wrap.setAttribute('fill', 'none');
  wrap.setAttribute('stroke', 'currentColor');
  wrap.setAttribute('stroke-width', '2');
  wrap.setAttribute('stroke-linecap', 'round');
  wrap.setAttribute('stroke-linejoin', 'round');
  paths.forEach(p => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (typeof p === 'string') path.setAttribute('d', p);
    else Object.entries(p).forEach(([k, v]) => path.setAttribute(k, v));
    wrap.appendChild(path);
  });
  return wrap;
}

// Simple markdown-ish renderer for the chat agent's response text.
// Jul 13 ~18:50 ET: used by renderMessage() to format the bottom-of-message
// response with bold/italic/inline code/code blocks/lists. Newlines in the
// input string are preserved by the parent .msg__text--response CSS
// (white-space: pre-wrap), so we don't convert \n to <br>. The el() helper
// uses textContent for strings, so this function returns HTML for innerHTML.
function renderText(text) {
  if (!text) return '';
  // Escape HTML first so user content can't inject markup.
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Process line-by-line for unordered lists. We do this BEFORE the other
  // markdown passes because the inline patterns (bold, code, etc.) can
  // appear inside list items and should be processed normally.
  const lines = s.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const liMatch = line.match(/^[\-\*] (.+)$/);
    if (liMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + liMatch[1] + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(line);
    }
  }
  if (inList) out.push('</ul>');
  s = out.join('\n');

  // Fenced code blocks (```lang\ncode\n```). Process before inline code
  // so the block's content isn't touched by inline rules.
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    return '<pre><code>' + code + '</code></pre>';
  });

  // Inline code (`foo`)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold (**text**). Non-greedy, single-line.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // Italic (*text*). Non-greedy, single-line, bounded by non-word chars
  // so we don't match across ** boundaries (already consumed by bold).
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>');

  // Headers (## h2, ### h3). Process line-by-line again because the
  // heading regex anchors on the start of a line.
  const headingLines = s.split('\n');
  for (let i = 0; i < headingLines.length; i++) {
    const h = headingLines[i].match(/^(#{1,3}) (.+)$/);
    if (h) {
      const level = h[1].length;
      const tag = 'h' + level;
      headingLines[i] = '<' + tag + '>' + h[2] + '</' + tag + '>';
    }
  }
  s = headingLines.join('\n');

  // Links ([text](url))
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Newlines are preserved by the parent's white-space: pre-wrap CSS,
  // so we don't convert \n to <br> here. The result is a string with
  // inline markup + raw newlines, rendered as innerHTML.
  return s;
}
function fileIcon(type) {
  // returns SVG string for file-type icon
  const stroke = type === 'jsx' ? '#3ab7f0' : type === 'json' ? '#a855f7' : '#f0883e';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`;
}

// ============================================================================
// CHAT THREAD
// ============================================================================
function renderChat() {
  const thread = $('#chat-thread');
  thread.innerHTML = '';
  state.chatMessages.forEach(m => thread.appendChild(renderMessage(m)));
  // Auto-scroll to bottom
  thread.scrollTop = thread.scrollHeight;
  // Persist the active conversation (debounced) so the dropdown always reflects
  // the current state and a hard refresh doesn't lose work-in-progress.
  scheduleChatHistorySave();
}

// ============================================================================
// CHAT HISTORY — multi-conversation switcher in the chat header
// ============================================================================
//
// Each conversation is a row in `chat_conversations` (SQLite) keyed by id,
// with the message list stored as a JSON blob. The renderer auto-saves on
// every renderChat() (debounced 500ms), lists conversations in the dropdown
// panel, and switches between them by loading the JSON. "New chat" creates
// a fresh row and resets the message list to a single welcome message.

const CHAT_HISTORY_PREVIEW_LIMIT = 80;
let _chatHistorySaveTimer = null;

function buildConversationTitle(messages) {
  // First user message, trimmed. Falls back to "New chat" if no user text.
  const firstUser = messages.find(m => m.role === 'user' && m.text && !m.working);
  if (firstUser) return firstUser.text.slice(0, 60) + (firstUser.text.length > 60 ? '…' : '');
  return 'New chat';
}

// Title of the currently active conversation, for the chat header subline.
// Looks up the cached conversation row in state.chatHistory; falls back to
// deriving from the live messages; falls back again to a welcome/default.
// Used by updateWindowTitle() to render "devvit · <conv title>" in the
// chat header (Jul 6 ~09:00 ET).
function currentConvTitle() {
  if (!state.chatActiveId) return '';
  const row = (state.chatHistory || []).find(c => c.id === state.chatActiveId);
  if (row && row.title) return row.title;
  if (Array.isArray(state.chatMessages) && state.chatMessages.length) {
    return buildConversationTitle(state.chatMessages);
  }
  return '';
}

function buildConversationPreview(messages) {
  // Last meaningful message (skip in-progress placeholders), short snippet.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.text && !m.working) {
      const role = m.role === 'user' ? 'You: ' : m.role === 'agent' ? 'Claude: ' : '';
      const t = m.text.replace(/\s+/g, ' ').trim();
      return role + t.slice(0, CHAT_HISTORY_PREVIEW_LIMIT);
    }
  }
  return 'No messages yet';
}

function scheduleChatHistorySave() {
  if (!state.chatActiveId) return; // no active conversation to save into
  if (_chatHistorySaveTimer) clearTimeout(_chatHistorySaveTimer);
  _chatHistorySaveTimer = setTimeout(saveActiveConversation, 500);
}

async function saveActiveConversation() {
  if (!state.chatActiveId) return;
  // Title preference (Jul 13, per-call-site 'titles'): LLM-generated title
  // (this session) > preserved non-heuristic title from the DB row (survives
  // restarts — if the stored title differs from the heuristic, it was
  // generated) > heuristic first-user-message slice.
  const heuristic = buildConversationTitle(state.chatMessages);
  const generated = state.chatGeneratedTitles?.[state.chatActiveId];
  const existing = (state.chatHistory || []).find(c => c.id === state.chatActiveId)?.title;
  const title = generated
    || ((existing && existing !== 'New chat' && existing !== heuristic) ? existing : heuristic);
  try {
    await window.farnsworth.chatConvSave({
      id: state.chatActiveId,
      title,
      messages: state.chatMessages,
    });
    // Refresh the dropdown list so titles/previews update in place.
    refreshChatHistoryList();
  } catch (e) {
    console.warn('[chat] save failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Per-call-site 'titles' (Jul 13 ~23:05 ET): LLM-generated conversation
// titles. Fires once per conversation after the first successful exchange,
// on the routed model (Haiku by default — ~50× cheaper than Opus for a
// 10-token title). Falls back silently to the heuristic title on any error.
// ---------------------------------------------------------------------------
const _titleGenAttempted = new Set();

function sanitizeGeneratedTitle(raw) {
  if (!raw) return '';
  let t = String(raw).split('\n')[0].trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 60);
}

async function maybeGenerateConvTitle() {
  try {
    const convId = state.chatActiveId;
    if (!convId || _titleGenAttempted.has(convId)) return;
    if (!window.farnsworth?.sendMessage) return;
    if (state.chatGeneratedTitles[convId]) return;
    const firstUser = state.chatMessages.find(m => m.role === 'user' && m.text);
    const firstAgent = state.chatMessages.find(m =>
      m.role === 'agent' && m.text && !m.error && !m.working && !String(m.id).startsWith('welcome'));
    if (!firstUser || !firstAgent) return;
    // Only generate when the stored title is still the heuristic/default —
    // never clobber a title the user (or a previous generation) set.
    const heuristic = buildConversationTitle(state.chatMessages);
    const existing = (state.chatHistory || []).find(c => c.id === convId)?.title;
    if (existing && existing !== 'New chat' && existing !== heuristic) return;
    _titleGenAttempted.add(convId);
    const res = await window.farnsworth.sendMessage({
      model: routedModelApiId('titles'),
      maxTokens: 50,
      system: 'You name conversations. Given the first exchange, reply with ONLY a concise 3-6 word title. No quotes, no trailing punctuation, no commentary.',
      messages: [{
        role: 'user',
        content: `User: ${String(firstUser.text).slice(0, 500)}\n\nAssistant: ${String(firstAgent.text).slice(0, 500)}`,
      }],
    });
    const title = sanitizeGeneratedTitle(res?.ok ? res.text : '');
    if (!title) return; // heuristic stands
    state.chatGeneratedTitles[convId] = title;
    await saveActiveConversation();
    updateWindowTitle();
  } catch (e) {
    console.warn('[titles] generation failed (heuristic stands):', e.message);
  }
}

async function refreshChatHistoryList() {
  try {
    state.chatHistory = await window.farnsworth.chatConvList();
  } catch (e) {
    state.chatHistory = [];
  }
  renderChatHistoryList();
}

function renderChatHistoryList() {
  const list = $('#chat-history-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.chatHistory.length) {
    const empty = el('div', { class: 'chathistory__empty' }, 'No conversations yet. Send a message to start one.');
    list.appendChild(empty);
    return;
  }
  for (const conv of state.chatHistory) {
    // Build preview by loading the full conversation if not cached.
    // We only have { id, title, updated_at } from chatConvList; if the user
    // hovers, we'll lazy-load the messages. For now, derive preview from title.
    const item = el('div', {
      class: 'chathistory__item' + (conv.id === state.chatActiveId ? ' is-active' : ''),
      'data-conv-id': conv.id,
    });
    item.appendChild(el('div', { class: 'chathistory__item-body' },
      el('div', { class: 'chathistory__item-title' }, conv.title || 'Untitled'),
      el('div', { class: 'chathistory__item-meta' }, formatRelativeTime(conv.updated_at)),
    ));
    const delBtn = el('div', {
      class: 'chathistory__item-del',
      title: 'Delete conversation',
      'data-del-conv': conv.id,
    }, '×');
    item.appendChild(delBtn);
    list.appendChild(item);
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(t.getTime())) return iso;
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return t.toLocaleDateString();
}

function toggleChatHistory(force) {
  const panel = $('#chat-history-panel');
  const trigger = $('#chat-history-toggle');
  if (!panel || !trigger) return;
  const next = (typeof force === 'boolean') ? force : panel.hidden;
  panel.hidden = !next;
  trigger.setAttribute('aria-expanded', String(next));
  state.chatHistoryOpen = next;
  if (next) refreshChatHistoryList();
}

async function startNewConversation() {
  // Persist the outgoing conversation first so its title/preview reflect reality.
  if (state.chatActiveId && state.chatMessages.length) {
    await saveActiveConversation();
  }
  const res = await window.farnsworth.chatConvCreate({ messages: [] });
  state.chatActiveId = res.id;
  await persistChatActiveId(res.id);
  state.chatMessages = [
    { id: 'welcome-' + Date.now(), role: 'agent', text: 'New chat — what do you want to build?', verified: true },
  ];
  renderChat();
  await refreshChatHistoryList();
  toggleChatHistory(false);
  // Jul 6 ~09:00 ET — refresh the chat header so the new conv title appears.
  updateWindowTitle();
  const input = $('#chat-input');
  if (input) input.focus();
}

async function switchConversation(id) {
  if (id === state.chatActiveId) {
    toggleChatHistory(false);
    return;
  }
  // Save outgoing first
  if (state.chatActiveId && state.chatMessages.length) {
    await saveActiveConversation();
  }
  const conv = await window.farnsworth.chatConvLoad(id);
  if (!conv) return;
  state.chatActiveId = conv.id;
  await persistChatActiveId(conv.id);
  state.chatMessages = Array.isArray(conv.messages) ? conv.messages : [];
  renderChat();
  await refreshChatHistoryList();
  toggleChatHistory(false);
  // Jul 6 ~09:00 ET — refresh the chat header subline so the new conv title appears.
  updateWindowTitle();
}

async function deleteConversation(id) {
  if (id === state.chatActiveId) {
    // Active conversation: clear it locally + delete the DB row.
    state.chatMessages = [];
    renderChat();
    state.chatActiveId = null;
    await persistChatActiveId(null);
  }
  try { await window.farnsworth.chatConvDelete(id); } catch {}
  await refreshChatHistoryList();
}

// Persist the active conversation ID to the settings table so a fresh
// launch (or a close-then-reopen cycle) lands on the same conversation.
// Fires on every chatActiveId change; the single-key IPC keeps this
// cheap and avoids the bulk settings contamination bug (Jun 26).
// Cleared to null when the active conversation is deleted (deleteConversation
// sets a fresh active or null if no conversations remain).
async function persistChatActiveId(id) {
  try {
    if (window.farnsworth?.setSetting) {
      await window.farnsworth.setSetting('chat.activeId', id || null);
    }
  } catch {}
}

// Jul 13 ~22:40 ET: per-message copy-to-clipboard buttons (Long's request).
// Ghost icon button, revealed on message hover, swaps to a green checkmark
// for 1.2s after a successful copy. getText is lazy so the button copies
// whatever the message holds at click time. Paired with the user-select
// opt-in on .msg__body/.msg__bubble in styles.css (body has user-select:
// none, which silently blocked drag-select + Cmd+C in chat).
const MSG_COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const MSG_COPIED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
function makeMsgCopyBtn(getText, cls) {
  const btn = el('button', { class: cls || 'msg__copy' });
  btn.type = 'button';
  btn.title = 'Copy to clipboard';
  btn.innerHTML = MSG_COPY_ICON;
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText() || '');
      btn.innerHTML = MSG_COPIED_ICON;
      btn.classList.add('is-copied');
      setTimeout(() => { btn.innerHTML = MSG_COPY_ICON; btn.classList.remove('is-copied'); }, 1200);
    } catch (e) {
      console.warn('[chat] copy failed:', e);
    }
  });
  return btn;
}

// Pin a hover copy button to each fenced code block inside a rendered
// message text container. Reads the code text from the DOM at click time.
function attachCodeCopyButtons(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    pre.appendChild(makeMsgCopyBtn(() => (pre.querySelector('code') || pre).innerText, 'code-copy'));
  });
}

function renderMessage(m) {
  if (m.role === 'user') {
    const row = el('div', { class: 'msg msg--user' });
    if ((m.text || '').trim()) row.appendChild(makeMsgCopyBtn(() => m.text, 'msg__copy msg__copy--user'));
    row.appendChild(el('div', { class: 'msg__bubble' }, m.text));
    return row;
  }
  if (m.role === 'context') {
    return el('div', { class: 'context-card' },
      el('div', { class: 'context-card__head' },
        el('span', { class: 'context-card__type' }, 'SECTION'),
        el('span', { class: 'context-card__title' }, m.title),
      ),
      el('div', { class: 'context-card__body' }, m.description),
    );
  }
  if (m.role === 'agent') {
    const avatar = el('div', { class: 'msg__avatar' + (m.working ? ' msg__avatar--working' : '') });
    avatar.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12 2l2.2 6.3L20.5 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z"/></svg>';

    const head = el('div', { class: 'msg__head' },
      el('span', { class: 'msg__name' }, 'Claude'),
      // Jul 14 ~09:20 ET: was hardcoded "Opus 4.8" — chat bubbles always
      // showed Opus even when the actual model was Fable 5 or whatever
      // default the user picked. Each agent message stores its model on
      // creation (see sendChatMessage ~line 9247); fall back to the
      // current default for legacy bubbles from before this fix.
      el('span', { class: 'msg__model' }, m.model || state.settings?.defaultModel || 'Opus 4.8'),
    );
    // Copy the whole message (m.text is the preamble+response concatenation
    // kept for history compat). Hidden while streaming — partial text.
    if (!m.working && (m.text || '').trim()) {
      head.appendChild(makeMsgCopyBtn(() => m.text));
    }
    const body = el('div', { class: 'msg__body' }, head);

    if (m.working) {
      const working = el('div', { class: 'msg__working' });
      working.appendChild(el('span', {}, m.workingLabel || 'Editing'));
      const dots = el('span', { class: 'working-dots' });
      for (let i = 0; i < 3; i++) dots.appendChild(el('span'));
      working.appendChild(dots);
      body.appendChild(working);
    }
    // Jul 13 ~18:50 ET: render preamble (text before any tool_use) as a
    // small italic "thinking" indicator at the TOP. Render response (text
    // after all tool_uses complete) as formatted markdown at the BOTTOM
    // (after chips). Vellum-style chat layout -- no plain text at the
    // top above the code executions. white-space: pre-wrap preserves
    // newlines (the prior plain text rendering collapsed them).
    if (!m.working && m.preambleText && m.preambleText.trim()) {
      const thinking = el('div', { class: 'msg__text msg__text--thinking' });
      thinking.innerHTML = renderText(m.preambleText);
      attachCodeCopyButtons(thinking);
      body.appendChild(thinking);
    }

    // Render any inline UI surfaces (task_progress, choice, copy_block, etc.)
    // Surfaces are appended to the message as Claude emits ui_show tool calls.
    // For Phase 1, all surfaces render at the end of the body (after text +
    // working indicator). Phase 4 will add proper interleaving if needed.
    if (Array.isArray(m.surfaces) && m.surfaces.length && window.FarnsworthSurfaces) {
      const surfacesWrap = el('div', { class: 'msg__surfaces' });
      for (const surface of m.surfaces) {
        try {
          const node = window.FarnsworthSurfaces.render(surface, {});
          if (node) surfacesWrap.appendChild(node);
        } catch (e) {
          console.error('[surface] render failed for type=' + surface.surfaceType, e);
        }
      }
      body.appendChild(surfacesWrap);
    }

    if (m.chips && m.chips.length) {
      const chips = el('div', { class: 'msg__chips' });
      m.chips.forEach(c => {
        const chip = el(c.action ? 'button' : 'span', { class: 'chip chip--' + c.kind + (c.action ? ' chip--action' : '') });
        if (c.action) chip.type = 'button';
        // chip icon
        const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        iconSvg.setAttribute('class', 'chip__icon');
        iconSvg.setAttribute('viewBox', '0 0 24 24');
        iconSvg.setAttribute('fill', 'none');
        iconSvg.setAttribute('stroke', c.kind === 'read' ? '#3ab7f0' : c.kind === 'search' ? '#f0b232' : c.kind === 'edit' ? '#eb459e' : c.kind === 'terminal' ? '#7e6bff' : c.kind === 'settings' ? '#fbbf24' : '#3ba55c');
        iconSvg.setAttribute('stroke-width', '2');
        iconSvg.setAttribute('stroke-linecap', 'round');
        iconSvg.setAttribute('stroke-linejoin', 'round');
        if (c.kind === 'read') iconSvg.innerHTML = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
        else if (c.kind === 'search') iconSvg.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>';
        else if (c.kind === 'edit') iconSvg.innerHTML = '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>';
        else if (c.kind === 'check') {
          iconSvg.innerHTML = '<circle cx="12" cy="12" r="9" fill="none"/><path d="M21 12a9 9 0 1 1-3-6.7" stroke-width="2.4" fill="none"/>';
        } else if (c.kind === 'terminal') {
          iconSvg.innerHTML = '<path d="M4 17l6-6-6-6M12 19h8"/>';
        } else if (c.kind === 'settings') {
          // Cogwheel — matches the Farnsworth settings cog in the Live cogwheel popover
          iconSvg.innerHTML = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
        }
        chip.appendChild(iconSvg);
        chip.appendChild(document.createTextNode(' ' + c.label));
        if (c.action === 'open-ai') {
          chip.addEventListener('click', () => {
            try { openSettings('ai'); } catch (e) { console.warn('[chat] openSettings(ai) failed:', e); }
          });
        } else if (c.action === 'git-commit-run') {
          // AI Commit confirm flow (per-call-site 'commit' row, confirm ON):
          // the chip carries the model-written message as payload.
          chip.addEventListener('click', () => runPendingGitCommit(m));
        } else if (c.action === 'git-commit-cancel') {
          chip.addEventListener('click', () => cancelPendingGitCommit(m));
        }
        chips.appendChild(chip);

        // For terminal chips, append a body with the run output
        if (c.kind === 'terminal' && m.runOutputs && m.runOutputs[c.runIndex]) {
          const run = m.runOutputs[c.runIndex];
          const body = el('div', { class: 'chip__term-body' });
          const cmd = el('div', { class: 'chip__term-cmd' });
          cmd.textContent = '$ ' + (run.command || '');
          body.appendChild(cmd);
          if (run.stdout) {
            const out = el('div', {});
            out.textContent = run.stdout;
            body.appendChild(out);
          }
          if (run.stderr) {
            const errDiv = el('div', { class: 'chip__term-stderr' });
            errDiv.textContent = run.stderr;
            body.appendChild(errDiv);
          }
          const meta = el('div', { class: 'chip__term-meta' });
          meta.textContent = 'exit ' + (run.exitCode ?? '?');
          body.appendChild(meta);
          // Replace the inner span with a div so the body can be a block element
          chip.style.display = 'block';
          chip.appendChild(body);
        }
      });
      body.appendChild(chips);
    }

    if (m.verified) {
      const check = el('div', { class: 'chip chip--check' });
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span>Verified against check — all confirmed working.</span>';
      body.appendChild(check);
    }

    // Jul 13 ~18:50 ET: render the response text (text after all tool_uses
    // completed) at the BOTTOM as formatted markdown. Uses renderText()
    // for basic bold/italic/code/lists + white-space: pre-wrap preserves
    // newlines. Vellum-style chat layout -- the model's answer appears
    // after the code executions, not before them.
    if (!m.working && m.responseText && m.responseText.trim()) {
      const response = el('div', { class: 'msg__text msg__text--response' });
      response.innerHTML = renderText(m.responseText);
      attachCodeCopyButtons(response);
      body.appendChild(response);
    }

    return el('div', { class: 'msg' }, avatar, body);
  }
  return null;
}

// ============================================================================
// CANVAS BROWSERVIEW WIRING (Jul 9 ~18:20 ET)
// ============================================================================
// Each [data-canvas-view] placeholder div in the live preview is the
// layout slot for a BrowserView rendered by main.js. BrowserView is the
// proper Electron API for this -- <webview> locks the inner viewport at
// first-load size (~300x150 HTML default) and never propagates CSS-driven
// height changes (verified end-to-end Jul 9 ~17:35 ET: webview element
// was 390x844 at reload time but inner viewport stayed 390x150, console
// log proved the reload fired). BrowserView.setBounds() is called in the
// main process so the inner viewport's dimensions match the bounds
// directly -- no CSS race, no reload-after-layout, no 150px squish.
//
// The placeholder stores its BrowserView's viewId on a data attribute
// so ResizeObserver callbacks can look it up. Bounds are queried via
// getBoundingClientRect() which returns window-content pixel
// coordinates (same coordinate system as BrowserView.setBounds).

function teardownCanvasBrowserViews() {
  // Find every placeholder that still has a viewId, send canvas:removeView
  // for it, disconnect its ResizeObserver, and clear the data attribute.
  // Called from renderCanvas() BEFORE stage.innerHTML = '' so we can
  // still query the old DOM by selector.
  document.querySelectorAll('[data-canvas-view-id]').forEach(el => {
    const viewId = el.dataset.canvasViewId;
    if (viewId && window.farnsworth?.canvasRemoveView) {
      window.farnsworth.canvasRemoveView(viewId).catch(() => {});
    }
    if (el._browserViewRo) { el._browserViewRo.disconnect(); el._browserViewRo = null; }
    delete el.dataset.canvasViewId;
  });
}

// Recompute every WebContentsView's bounds from its placeholder rect,
// clipped to the canvas-viewport so views never overflow onto adjacent UI.
// Single source of truth for the two ResizeObservers, the stage scroll
// listener, and updateZoom(). getBoundingClientRect reflects CSS transforms,
// so zoomed placeholders produce correctly scaled bounds.
function syncCanvasViewBounds() {
  if (!window.farnsworth?.canvasUpdateViewBounds) return;
  const vpEl = document.getElementById('canvas-viewport');
  const vpR = vpEl?.getBoundingClientRect();
  document.querySelectorAll('[data-canvas-view-id]').forEach(el => {
    const viewId = el.dataset.canvasViewId;
    if (!viewId) return;
    const r = el.getBoundingClientRect();
    let x = Math.round(r.left), y = Math.round(r.top);
    let right = Math.round(r.right), bottom = Math.round(r.bottom);
    if (vpR) {
      x = Math.max(x, Math.round(vpR.left));
      y = Math.max(y, Math.round(vpR.top));
      right = Math.min(right, Math.round(vpR.right));
      bottom = Math.min(bottom, Math.round(vpR.bottom));
    }
    window.farnsworth.canvasUpdateViewBounds(viewId, {
      x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y),
    });
  });
}

// Fit-to-view for Test View: pick the largest zoom (≤100%) where the whole
// artboard — phone canvas + test panel + header with + New — fits inside the
// stage. Runs on render + viewport resize unless the user has manually
// zoomed while in this preview (state._zoomManualFor). offsetWidth/Height
// are layout sizes, unaffected by the current transform.
function autoFitZoomToStage() {
  const art = document.getElementById('canvas-artboard');
  const stage = document.getElementById('canvas-stage');
  if (!art || !stage) return;
  const aw = art.offsetWidth, ah = art.offsetHeight;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (aw <= 0 || ah <= 0 || availW <= 0 || availH <= 0) return;
  const fit = Math.min(availW / aw, availH / ah, 1);
  state.zoom = Math.max(25, Math.min(100, Math.floor(fit * 100)));
  updateZoom();
}

function setupCanvasBrowserViews() {
  // Find every [data-canvas-view] placeholder in the freshly-rendered
  // canvas (skipped ones that already have a viewId -- defensive against
  // double-setup). For each, generate a viewId, send canvas:createView
  // with the placeholder's current pixel rect, then attach a
  // ResizeObserver that keeps the BrowserView bounds in sync on resize /
  // zoom / resolution changes.
  if (!window.farnsworth?.canvasCreateView) return;

  // Viewport-level observer — fires when the IDE window resizes or the
  // left/right panel collapses/expands (the canvas-viewport changes
  // width). The artboard re-centers in the wider canvas-stage, but the
  // placeholder inside doesn't resize, only repositions. ResizeObserver
  // on the placeholder itself doesn't fire for position-only changes,
  // so the WebContentsView's bounds would stay locked at the original
  // position while the artboard drifts — leaving dead space on the
  // trailing side of the canvas (verified Jul 10: viewport 1318 wide,
  // placeholder centered at x=848 but WebContentsView stuck at x=577).
  // Observing the viewport catches this case; the per-placeholder
  // observer below still handles resolution preset changes (where the
  // placeholder itself resizes).
  const viewport = document.getElementById('canvas-viewport');
  if (viewport && !viewport._canvasViewportRo) {
    const viewportRo = new ResizeObserver(() => {
      // Clip placeholder bounds to the viewport rect (shared helper) so the
      // WebContentsView doesn't overflow when the IDE window shrinks below
      // the placeholder's natural size. On Test View, re-fit the zoom too —
      // the window resize changes how much artboard fits (skipped when the
      // user has manually zoomed in this preview). autoFit → updateZoom →
      // syncCanvasViewBounds, so bounds stay correct either way. No RO loop:
      // the zoom transform never resizes the viewport itself.
      if (state.preview === 'testview' && state.canvasMode === 'live' && state._zoomManualFor !== 'testview') {
        autoFitZoomToStage();
      } else {
        syncCanvasViewBounds();
      }
    });
    viewportRo.observe(viewport);
    viewport._canvasViewportRo = viewportRo;
  }

  // Stage scroll — the stage is overflow:auto (Jul 13) so oversized
  // artboards can be scrolled. Scrolling moves placeholder rects without
  // firing any ResizeObserver; keep view bounds in lock-step (rAF-throttled).
  const stageEl = document.getElementById('canvas-stage');
  if (stageEl && !stageEl._canvasScrollSync) {
    stageEl.addEventListener('scroll', () => {
      if (stageEl._scrollRaf) return;
      stageEl._scrollRaf = requestAnimationFrame(() => {
        stageEl._scrollRaf = null;
        syncCanvasViewBounds();
      });
    }, { passive: true });
    stageEl._canvasScrollSync = true;
  }

  document.querySelectorAll('[data-canvas-view]').forEach(el => {
    if (el.dataset.canvasViewId) return;
    const viewId = `canvas-${el.dataset.canvasView}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = el.dataset.canvasUrl;
    const rect = el.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    // Don't assign the viewId until the IPC succeeds -- otherwise the
    // teardown logic in renderCanvas() can't tell which placeholders
    // actually have a BrowserView and which have a pending IPC.
    (async () => {
      try {
        // Engine settings -> view options (Settings -> Canvas, Jul 13).
        // Computed at creation time; toggles apply on next preview load.
        const eng = state.settings.canvas?.engine || {};
        const viewOpts = {
          devTools: eng.devtools !== false,
          partitionKey: (eng.cookieIsolation && state.folder)
            ? state.folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48)
            : null,
        };
        const result = await window.farnsworth.canvasCreateView(viewId, url, bounds, viewOpts);
        if (!result?.ok) {
          console.error('[canvas:setup] createView failed for viewId=' + viewId + ':', result?.error);
          return;
        }
        el.dataset.canvasViewId = viewId;
        // ALWAYS pin the content zoom factor on fresh views — including at
        // 100%. Electron restores the partition's persisted per-origin zoom
        // on navigation, so a view left unpinned comes up at whatever factor
        // the origin last had (e.g. yesterday's 0.99), not 1.0. Main.js
        // records the desired factor and re-applies it on load-commit.
        if (window.farnsworth.canvasSetZoomFactor) {
          window.farnsworth.canvasSetZoomFactor(viewId, state.zoom / 100);
        }
        syncCanvasViewBounds();
        const ro = new ResizeObserver(() => {
          // Placeholder resize (resolution preset change) — same shared
          // viewport-clipped sync as everywhere else.
          syncCanvasViewBounds();
        });
        ro.observe(el);
        el._browserViewRo = ro;
      } catch (e) {
        console.error('[canvas:setup] IPC exception for viewId=' + viewId + ':', e);
      }
    })();
  });
}

// ============================================================================
// TEST CREATOR (NLP-driven test script authoring, Jul 10 ~23:50 ET)
//
// In-canvas panel that lets the user type plain English and get a JSON test
// script. Flow:
//   1. User types English ("click PLAY, dismiss the welcome dialog")
//   2. Generate button → renderer calls window.farnsworth.sendMessage
//      with a system prompt that converts English to JSON test steps
//   3. JSON preview is shown (editable) + Save button writes to
//      ~/Documents/farnsworth-tests/tests/<name>.json
//   4. Save & run button spawns the Python CDP test runner and shows output
//
// If the LLM call fails (no auth, network error, etc.) we fall back to
// keyword matching using the same parser as farnsworth-test.py's `new` cmd.
// ============================================================================
const TEST_CREATOR_SYSTEM_PROMPT = `You are a test script generator for Farnsworth's canvas preview.
Convert a plain-English test description into a JSON test script.

Available actions (each step is one of these):
  - reload:          Page.reload + sleep, resets state for idempotent runs
  - waitFor:         poll document.querySelector until found or timeout
  - click:           click center of element matching selector
  - clickIfPresent:  click only if selector exists (no exception if absent)
  - screenshot:      save PNG to given path
  - eval:            run JS in the page, print return value

Common CSS selectors for the Farnsworth canvas (the game inside the preview):
  - Canvas stage (desktop):   .fw-stage--desktop
  - Canvas stage (mobile):    .fw-stage--mobile
  - Canvas stage (fullscreen): .fw-stage--fullscreen
  - Welcome modal:            .fw-stage--desktop .lobby2-ftue svg
  - PLAY tab:                 .bnav-play
  - ROSTER/DRAFT/BP/OPTIONS:  .bnav-item (text identifies which)
  - RANKED button:            .lb2-qbtn (text "RANKED")
  - TRAINING button:          .lb2-qbtn (text "TRAINING")
  - DAILY/WEEKLY tabs:        .lb2-mission-tab

Output rules:
  - Reply with ONLY valid JSON (no markdown, no explanation)
  - Format: {"name": "<short test name>", "steps": [{"action": "...", ...}, ...]}
  - First step should usually be "reload" for idempotent runs
  - Use real CSS selectors from the list above, not made-up ones
  - For "dismiss welcome" / "close dialog", use clickIfPresent on .fw-stage--desktop .lobby2-ftue svg
  - For "click PLAY", use .bnav-play (not text "PLAY")
  - Always start with {"name": and end with }`;

function keywordFallbackParse(text) {
  // Same logic as farnsworth-test.py's parse_english_steps — used when LLM fails
  const parts = text.split(/[,;\n]|then|and then/).map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const p of parts) {
    const pl = p.toLowerCase();
    if (pl === 'reload') {
      steps.push({ action: 'reload', waitMs: 2000 });
    } else if (pl.startsWith('wait for ') || pl.startsWith('wait until ')) {
      steps.push({ action: 'waitFor', selector: p.split(' ', 2).slice(-1)[0], timeout: 5000 });
    } else if (pl.startsWith('click ') || pl.startsWith('tap ') || pl.startsWith('press ')) {
      steps.push({ action: 'click', selector: p.split(' ', 1)[1] || p });
    } else if (pl.startsWith('dismiss') || pl.startsWith('close modal') || pl.startsWith('close dialogue') || pl.startsWith('close dialog')) {
      steps.push({ action: 'clickIfPresent', selector: '.fw-stage--desktop .lobby2-ftue svg, [role=dialog] button' });
    } else if (pl.startsWith('screenshot') || pl.startsWith('snap') || pl.startsWith('shot')) {
      steps.push({ action: 'screenshot', path: '/tmp/' + pl.replace(/[^a-z0-9]+/g, '-') + '.png' });
    } else if (pl.startsWith('eval ') || pl.startsWith('inspect ') || pl.startsWith('check ')) {
      steps.push({ action: 'eval', expression: p.split(' ', 1)[1] || p });
    } else {
      steps.push({ action: 'eval', expression: p });
    }
  }
  return steps;
}

function deriveTestName(text) {
  // Auto-derive a kebab-case name from the first ~40 chars of the prompt
  const t = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (t || 'test').slice(0, 40);
}

function setTestCreatorStatus(text, kind = '') {
  const el = document.getElementById('test-creator-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'test-creator__status' + (kind ? ' is-' + kind : '');
}

function setTestCreatorButtonsEnabled(enabled) {
  const save = document.getElementById('test-creator-save');
  const run = document.getElementById('test-creator-run');
  if (save) save.disabled = !enabled;
  if (run) run.disabled = !enabled;
}

async function generateTestFromNLP(description) {
  // Try LLM first; fall back to keyword matching if anything fails
  if (window.farnsworth?.sendMessage) {
    try {
      const res = await window.farnsworth.sendMessage({
        model: 'claude-fable-5',
        maxTokens: 1500,
        system: TEST_CREATOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: description }],
      });
      if (res?.ok && res.text) {
        // Strip markdown fences if Claude added them
        let text = res.text.trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.steps)) {
          return { ok: true, json: parsed, source: 'llm' };
        }
      }
    } catch (e) {
      console.warn('[test-creator] LLM failed, falling back to keyword matching:', e?.message);
    }
  }
  // Fallback: keyword matching (less capable but always works)
  const steps = keywordFallbackParse(description);
  const json = { name: deriveTestName(description), steps };
  return { ok: true, json, source: 'fallback' };
}

async function onTestCreatorGenerate() {
  const promptEl = document.getElementById('test-creator-prompt');
  const jsonEl = document.getElementById('test-creator-json');
  const nameEl = document.getElementById('test-creator-name');
  const description = promptEl.value.trim();
  if (!description) {
    setTestCreatorStatus('Type a description first.', 'error');
    return;
  }
  setTestCreatorStatus('Generating...');
  const result = await generateTestFromNLP(description);
  if (!result.ok) {
    setTestCreatorStatus('Generation failed: ' + (result.error || 'unknown'), 'error');
    return;
  }
  jsonEl.value = JSON.stringify(result.json, null, 2);
  if (!nameEl.value.trim()) nameEl.value = result.json.name || deriveTestName(description);
  setTestCreatorStatus(
    result.source === 'llm' ? 'Generated via LLM (editable).' : 'Generated via keyword fallback (LLM unavailable).',
    'success'
  );
  setTestCreatorButtonsEnabled(true);
}

async function onTestCreatorSave() {
  const jsonEl = document.getElementById('test-creator-json');
  const nameEl = document.getElementById('test-creator-name');
  const json = jsonEl.value.trim();
  const name = nameEl.value.trim() || deriveTestName(nameEl.value || jsonEl.value);
  if (!json) { setTestCreatorStatus('Nothing to save.', 'error'); return; }
  // Validate JSON locally before sending to main
  try { JSON.parse(json); } catch (e) {
    setTestCreatorStatus('Invalid JSON: ' + e.message, 'error');
    return;
  }
  setTestCreatorStatus('Saving...');
  const res = await window.farnsworth.testSave({ name, json });
  if (!res?.ok) {
    setTestCreatorStatus('Save failed: ' + (res?.error || 'unknown'), 'error');
    return;
  }
  setTestCreatorStatus('Saved to ' + res.path, 'success');
}

async function onTestCreatorSaveAndRun() {
  await onTestCreatorSave();
  const status = document.getElementById('test-creator-status');
  if (status.className.includes('is-error')) return; // save failed
  // Extract the path from the status text
  const m = status.textContent.match(/Saved to (.+)$/);
  if (!m) { setTestCreatorStatus('Save status missing path — run manually.', 'error'); return; }
  const testPath = m[1];
  const outputEl = document.getElementById('test-creator-output');
  outputEl.textContent = 'Running...';
  setTestCreatorStatus('Running...');
  const res = await window.farnsworth.testRun({ path: testPath });
  if (!res) {
    outputEl.textContent = 'No response from test runner.';
    return;
  }
  const out = (res.stdout || '') + (res.stderr ? '\n--- stderr ---\n' + res.stderr : '');
  outputEl.textContent = out || '(no output)';
  if (res.ok) {
    setTestCreatorStatus('Test passed.', 'success');
  } else if (res.failed > 0) {
    setTestCreatorStatus('Test ran with ' + res.failed + ' failed step(s).', 'error');
  } else {
    setTestCreatorStatus('Test exited with code ' + res.code + '.', 'error');
  }
}

function onTestCreatorOpenFolder() {
  // Reveal the tests folder in Finder via shell.openPath. Farnsworth's main
  // process has shell; we route through a tiny IPC since the renderer doesn't.
  // For now, just copy the path so the user can paste into Finder.
  const path = '~/Documents/farnsworth-tests/tests/';
  navigator.clipboard?.writeText(path);
  setTestCreatorStatus('Path copied to clipboard: ' + path, 'success');
}

function openTestCreator() {
  const panel = document.getElementById('test-creator');
  if (!panel) return;
  panel.hidden = false;
  // Hide canvas views while the panel is open so the backdrop is clean
  // (canvas views are separate composited layers and would show through).
  // The optional chaining is defensive in case hideAllCanvasViews isn't
  // defined yet at first paint (it normally is, hoisted function decl).
  hideAllCanvasViews?.();
  // Defensive: any canvas re-render while the panel is open will tear
  // down + re-create the WebContentsViews (stripping data-canvas-view-id
  // then setting it again on a fresh placeholder). Watch for those new
  // viewIds and hide them so the panel backdrop stays clean. Disconnect
  // on close.
  if (window.MutationObserver && !state.testCreatorCanvasObserver) {
    const vp = document.getElementById('canvas-viewport');
    if (vp) {
      const observer = new MutationObserver(() => {
        if (state.testCreatorOpen) hideAllCanvasViews?.();
      });
      observer.observe(vp, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-canvas-view-id'],
      });
      state.testCreatorCanvasObserver = observer;
    }
  }
  state.testCreatorOpen = true;
  const input = document.getElementById('test-creator-prompt');
  if (input) setTimeout(() => input.focus(), 50);
}

function closeTestCreator() {
  const panel = document.getElementById('test-creator');
  if (!panel) return;
  panel.hidden = true;
  state.testCreatorOpen = false;
  // Restore canvas views
  showAllCanvasViews?.();
  if (state.testCreatorCanvasObserver) {
    state.testCreatorCanvasObserver.disconnect();
    state.testCreatorCanvasObserver = null;
  }
}

// Wire up once on initial load
function setupTestCreator() {
  const openBtn = document.getElementById('open-test-creator');
  const closeBtn = document.getElementById('test-creator-close');
  const genBtn = document.getElementById('test-creator-generate');
  const saveBtn = document.getElementById('test-creator-save');
  const runBtn = document.getElementById('test-creator-run');
  const openFolderBtn = document.getElementById('test-creator-open-folder');
  const backdrop = document.querySelector('.test-creator__backdrop');
  if (openBtn) openBtn.addEventListener('click', openTestCreator);
  if (closeBtn) closeBtn.addEventListener('click', closeTestCreator);
  if (backdrop) backdrop.addEventListener('click', closeTestCreator);
  if (genBtn) genBtn.addEventListener('click', onTestCreatorGenerate);
  if (saveBtn) saveBtn.addEventListener('click', onTestCreatorSave);
  if (runBtn) runBtn.addEventListener('click', onTestCreatorSaveAndRun);
  if (openFolderBtn) openFolderBtn.addEventListener('click', onTestCreatorOpenFolder);
  // Allow Enter in the prompt textarea to trigger generate (with Cmd/Ctrl)
  const promptEl = document.getElementById('test-creator-prompt');
  if (promptEl) {
    promptEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onTestCreatorGenerate();
      }
    });
  }
}

// CANVAS STAGE
// ============================================================================
function renderCanvas() {
  // renderCanvas() destroys + recreates the artboard, so the zoom
  // transform applied via updateZoom() is lost. The artboard is
  // re-mounted with id="canvas-artboard"; re-apply zoom on the next
  // animation frame so the scale picks up before paint.
  // Nuke every canvas WebContentsView in main.js before doing anything
  // else. This catches two orphan scenarios:
  //   1. Page.reload via CDP: renderer JS wipes the DOM but main.js's
  //      canvasWebContentsViews map keeps the old views alive. The next
  //      renderCanvas() has no DOM placeholders to find, so the per-view
  //      teardown below is a no-op and the orphan WebContentsView keeps
  //      compositing on top of whatever the new preview renders.
  //      Long reported this Jul 11 ~17:09 ET — the Test View's 390x844
  //      game canvas persisted across reload and overlapped Post View.
  //   2. Async setup race: a view created via canvasCreateView resolves
  //      AFTER teardown already ran, leaving an orphan view in the map
  //      with no DOM placeholder referencing it. The previous setPreview
  //      + preview-tab handlers call this for their own paths; centralizing
  //      it here means every renderCanvas() catches it regardless of trigger.
  // After this, teardownCanvasBrowserViews() is redundant (the IPC
  // already destroyed every view) but harmless — it just disconnects
  // per-placeholder ResizeObservers on the old DOM elements.
  window.farnsworth?.canvasRemoveAllViews?.();
  // Teardown any existing canvas BrowserViews BEFORE wiping the DOM —
  // each placeholder stores its viewId on a data attribute so this is
  // a single querySelectorAll + IPC round-trip. (Replaces the <webview>
  // approach which couldn't propagate CSS-driven height changes to the
  // inner viewport -- see teardownCanvasBrowserViews for the squish-bug
  // history.)
  teardownCanvasBrowserViews();
  const stage = $('#canvas-stage');
  const viewport = $('#canvas-viewport');
  stage.innerHTML = '';
  if (viewport) {
    viewport.classList.toggle('canvas__viewport--code', state.canvasMode === 'code');
  }

  // Post View is a DOM-only mock — the WebContentsView layers must be hidden
  // so the iframe doesn't render on top of the Reddit post UI. This is the
  // initial-load path: setPreview() only fires on user clicks, so without
  // this branch renderCanvas() leaves the WebContentsView visible on first
  // paint. Same compositing-layer fix as the cogwheel popover (Jul 10 ~11:52).
  // Test View is the opposite: the game WebContentsView IS the canvas, so
  // we must show it (not hide).
  if (state.canvasMode === 'live' && state.preview === 'post') {
    hideAllCanvasViews?.();
  } else if (state.canvasMode === 'live') {
    showAllCanvasViews?.();
  }

  if (state.canvasMode === 'live') {
    stage.appendChild(renderLivePreview());
  } else if (state.canvasMode === 'storybook') {
    stage.appendChild(renderStorybook());
  } else if (state.canvasMode === 'code') {
    stage.appendChild(renderCodeView());
    // The renderCodeView path re-uses Monaco's container when possible, but
    // on first render (or after a reload) the editor may not exist yet.
    // Mount Monaco into the fresh container if needed.
    if (!monacoEditor || !document.contains(monacoEditor.getContainerDomNode())) {
      initMonacoEditor();
      if (activeFileIdx >= 0) focusActiveFile();
    }
  }

  // update overlay bar visibility
  const sizeToggles = $('#canvas-size-toggles');
  if (sizeToggles) sizeToggles.style.display = state.canvasMode === 'live' ? 'flex' : 'none';
  // Mark up / Comments / Edit / Tweaks chips are for marking/story/preview
  // modes only — hide them in code view (the editor doesn't need them).
  const vmToggles = $('#vm-toggles');
  if (vmToggles) vmToggles.style.display = state.canvasMode === 'code' ? 'none' : '';
  // Re-sync the mode-toggle active states and the Live pulse — renderCanvas()
  // runs after the dev server boots/stops, so this is when the pulse state
  // needs to flip.
  updateModeToggles();
  renderLiveStatus();

  // VM overlays (mark up pen + comment pins) sit on top of the preview.
  // Appended to #canvas-viewport so the overlay-bar (z-index 7) stays above.
  const viewportEl = document.getElementById('canvas-viewport');
  if (viewportEl) {
    // Remove any stale overlays from a previous render
    viewportEl.querySelectorAll('.vm-overlay').forEach(n => {
      if (n._ro) n._ro.disconnect();
      n.remove();
    });
    // Disconnect any ResizeObservers left behind on previous canvases
    document.querySelectorAll('#vm-strokes-canvas').forEach(oldCanvas => {
      if (oldCanvas._ro) oldCanvas._ro.disconnect();
    });
    viewportEl.appendChild(renderVmOverlay());
  }
  // Keep the resolution dropdown in sync with the current preview
  // category's default width — important on first render and after
  // switching categories so the dropdown doesn't show a stale value.
  if (typeof syncResolutionDropdownToCategory === 'function') {
    syncResolutionDropdownToCategory();
  }
  // renderCanvas() destroys + recreates the artboard, so re-apply the
  // current zoom transform on the next paint. Without this, switching
  // preview modes or resolution presets snaps back to 100%.
  // Test View auto-fits instead (unless the user manually zoomed while in
  // it — _zoomManualFor stops matching as soon as the preview switches, so
  // auto-fit re-engages on the next visit). Runs after the calibrate rAF
  // registered during artboard render, so it measures final layout sizes.
  requestAnimationFrame(() => {
    if (state.preview === 'testview' && state.canvasMode === 'live' && state._zoomManualFor !== 'testview') {
      autoFitZoomToStage();
    } else {
      // Settings -> Canvas preview defaults (Jul 13): when the user hasn't
      // manually zoomed in this preview, apply the configured default --
      // fit-to-view when fitOnOpen is ON, else defaultZoom%. Manual zoom
      // (zoom buttons set _zoomManualFor = state.preview) always wins.
      const cs = state.settings?.canvas || {};
      if (state._zoomManualFor !== state.preview && state.canvasMode === 'live') {
        if (cs.fitOnOpen) { autoFitZoomToStage(); return; }
        const dz = parseInt(cs.defaultZoom, 10);
        if (Number.isFinite(dz) && dz >= 25 && dz <= 200) state.zoom = dz;
      }
      updateZoom();
    }
  });

  // Set up canvas BrowserViews for any [data-canvas-view] placeholders
  // in the freshly-rendered artboard. BrowserView.setBounds() is set in
  // the main process, so the inner viewport's dimensions match the
  // placeholder's pixel rect from first paint -- no squish bug. The
  // ResizeObserver inside setupCanvasBrowserViews() keeps bounds in
  // sync on window resize / zoom / resolution preset changes.
  requestAnimationFrame(() => setupCanvasBrowserViews());

  // Push canvas state to companion apps via the relay. The companion's
  // canvas viewer subscribes once on WS open; we re-push on every render
  // so the iframe in the companion stays in sync with Farnsworth's view.
  // No-op if the relay isn't connected (window.farnsworth.relaySend
  // returns false and logs a warning).
  sendCanvasStateToCompanions();
}

// ----- Canvas state forwarding (Farnsworth -> companion canvas viewer) -----
// Captures a snapshot of the current canvas (mode + preview + file + html)
// and pushes it to companion apps over the relay. Companions subscribed via
// canvas:subscribe will receive the snapshot and render it in an iframe.
function captureCanvasState() {
  let html = null;
  let url = null;
  try {
    if (state.canvasMode === 'code') {
      // Code mode — no iframe preview; send the file name + Monaco text instead
      const activeFile = state.openFiles && state.openFiles[state.activeFileIdx];
      if (activeFile) {
        html = `<pre style="font-family:monospace;padding:20px;color:#ddd;background:#1e1e1e;">${escapeHtml(activeFile.content || '')}</pre>`;
      }
    } else if (state.preview === 'mobile' || state.preview === 'desktop' || state.preview === 'fullscreen' || state.preview === 'testview') {
      // Live game preview — since the Jul 9 WebContentsView swap there is
      // no DOM iframe; the placeholder div carries the exact URL the view
      // loads in data-canvas-url (incl. ?view= param). Companion's iframe
      // src points to this. Fall back to a real iframe (pre-swap DOM),
      // then to the dev server root.
      const holder = document.querySelector('[data-canvas-url]');
      if (holder) url = holder.getAttribute('data-canvas-url') || null;
      if (!url) {
        const iframe = document.querySelector('#canvas-artboard iframe');
        if (iframe && iframe.src) url = iframe.src;
      }
      if (!url && state.farnsworthDev?.available) url = state.farnsworthDev.url;
    } else if (state.canvasMode === 'storybook') {
      // Storybook — serialize the artboard's DOM (no nested game iframe)
      const artboard = document.getElementById('canvas-artboard');
      if (artboard) html = artboard.outerHTML;
    } else {
      // Post View — serialize the artboard and KEEP the nested game
      // iframe (it loads from the dev server, runs in its own origin).
      // The outer srcdoc iframe in the companion has
      // allow-scripts allow-same-origin, so the nested iframe can
      // execute scripts and render the actual game.
      const artboard = document.getElementById('canvas-artboard');
      if (artboard) html = artboard.outerHTML;
    }
  } catch (e) {
    console.warn('[canvas-state] capture failed:', e.message);
  }
  return {
    type: 'canvas:state',
    mode: state.canvasMode || 'live',
    preview: state.preview || 'post',
    file: state.openFiles?.[state.activeFileIdx]?.name || null,
    html,
    url,
    ts: Date.now(),
  };
}

// Cached companion CSS — the standalone srcdoc iframe in the companion
// can't inherit our parent stylesheet, so we inline only the artboard +
// post-view rules (~12KB) on every canvas:state push. Cached on first load.
let companionCssCache = null;
async function getCompanionCss() {
  if (companionCssCache) return companionCssCache;
  try {
    const resp = await fetch('./src/canvas-styles.css');
    if (resp.ok) companionCssCache = await resp.text();
  } catch (e) {
    console.warn('[canvas-state] failed to load canvas-styles.css:', e.message);
  }
  return companionCssCache || '';
}

async function sendCanvasStateToCompanions() {
  if (!window.farnsworth?.relaySend) return;
  const snap = captureCanvasState();
  if (!snap.html && !snap.url && !snap.file) return;
  // Inline the companion-only CSS so the srcdoc iframe renders styled
  if (snap.html && state.canvasMode !== 'code') {
    const css = await getCompanionCss();
    if (css) snap.html = `<style>${css}</style>${snap.html}`;
  }
  try {
    window.farnsworth.relaySend(snap);
  } catch (e) {
    console.warn('[canvas-state] relaySend failed:', e.message);
  }
}

// ----- Chat event forwarding (Farnsworth -> companion chat stream) -----
// Mirrors the canvas-state forwarding pattern. Companion v0.4 listens for
// chat:start / chat:delta / chat:done on its WS connection and renders
// the stream incrementally in its chat panel (instead of waiting for a
// single 'chat' event at the end).
//
// chat:start - fires once per user message when the agent begins processing
// chat:delta - fires on each text_delta chunk from streamMessage
// chat:done  - fires once per user message when the agent loop finishes
//               (success OR error path; outer try/finally covers errors)
//
// Pure renderer-side: no main.js changes needed. The relay is dumb (JSON
// pass-through), so this just becomes more message types on the wire.
function sendChatEventToCompanions(eventType, payload) {
  if (!window.farnsworth?.relaySend) return;
  try {
    window.farnsworth.relaySend({
      type: eventType,
      conversationId: state.chatActiveId || null,
      ts: Date.now(),
      ...payload,
    });
  } catch (e) {
    console.warn('[chat-stream] relaySend failed:', e.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function wireRelay() {
  if (!window.farnsworth?.onRelayMessage) return;
  window.farnsworth.onRelayMessage((data) => {
    if (!data || typeof data !== 'object') return;
    const t = data.type;
    const payload = data.payload || data;
    if (t === 'chat') {
      // Companion sent a chat message — append to active conversation
      const text = payload.text || '';
      if (text && state.chatActiveId && window.farnsworth.chatMessageAppend) {
        window.farnsworth.chatMessageAppend(state.chatActiveId, {
          role: 'user', text, ts: payload.ts || Date.now(),
        }).then(() => refreshChatHistoryList());
      }
    } else if (t === 'command') {
      // Companion ran a Farnsworth command
      const name = payload.name;
      const args = payload.args || {};
      if (name === 'openFile' && args.path) {
        handleFolderPicked(args.path);
      } else if (name === 'setCanvasMode' && args.mode) {
        state.canvasMode = args.mode;
        renderCanvas();
      } else if (name === 'setPreview' && args.preview) {
        // Switch between post | mobile | desktop | fullscreen | testview
        // within live mode
        // Nuke every canvas WebContentsView before changing preview --
        // catches the async setup race (Jul 11 ~16:30 ET) where a view
        // created via canvasCreateView resolves after teardown already
        // ran, leaving an orphan view visible in the new preview.
        window.farnsworth?.canvasRemoveAllViews?.();
        state.preview = args.preview;
        // Post View is a DOM-only mock -- hide the WebContentsView layers so
        // the iframe doesn't render on top of the Reddit post UI. Same pattern
        // as the cogwheel popover fix (Jul 10 ~11:52 ET) and the test creator
        // panel (Jul 11 04:22 ET) -- both call hideAllCanvasViews on open and
        // showAllCanvasViews on close to keep WebContentsView behind any DOM
        // overlay that overlaps the canvas region. Test View keeps the game
        // canvas visible (the game IS the canvas surface for testing).
        if (state.preview === 'post') {
          hideAllCanvasViews?.();
        } else {
          showAllCanvasViews?.();
        }
        renderCanvas();
      } else if (name === 'reloadPreview') {
        // Companion v0.4 reload button (Jul 13). Same as Cmd+R but
        // dispatched from the mobile preview sheet.
        window.farnsworth?.canvasRemoveAllViews?.();
        renderCanvas();
      } else if (name === 'setModel' && args.alias) {
        // Companion v0.4 Settings sheet model picker (Jul 13).
        state.model = args.alias;
        // Persist via the single-key setting:set IPC.
        window.farnsworth?.setSetting?.('model', args.alias);
        renderSettings?.();
      } else if (name === 'stopInference') {
        // Companion v0.4 Stop button (Jul 13). The chat panel listens for
        // 'chat:stopInference' IPC events; this is the in-renderer path
        // for the same intent (when no companion is connected).
        const stopBtn = document.querySelector('[data-action="stop-inference"]');
        if (stopBtn) stopBtn.click();
      } else if (name === 'setEmulatorUser' && args.user) {
        // Companion v0.4 Preview sheet cogwheel user picker (Jul 13).
        // Resolves the username to an ID via the devvit:list-users IPC,
        // then calls devvit:setProjectUser. Fire-and-forget — the IPC
        // broadcasts emulator:config back over the relay when it lands.
        (async () => {
          try {
            const users = await window.farnsworth?.listDevvitUsers?.();
            const user = (users || []).find(u => u.username === args.user);
            if (user && state.folder) {
              await window.farnsworth?.setDevvitProjectUser?.(state.folder, user.id);
            }
          } catch (e) { console.warn('[relay:command] setEmulatorUser failed:', e.message); }
        })();
      } else if (name === 'setEmulatorSubreddit' && args.subreddit) {
        // Companion v0.4 Preview sheet cogwheel subreddit picker (Jul 13).
        (async () => {
          try {
            const subs = await window.farnsworth?.listDevvitSubreddits?.();
            const sub = (subs || []).find(s => s.name === args.subreddit);
            if (sub && state.folder) {
              await window.farnsworth?.setDevvitProjectSubreddit?.(state.folder, sub.id);
            }
          } catch (e) { console.warn('[relay:command] setEmulatorSubreddit failed:', e.message); }
        })();
      } else if (name === 'runTest' && args.testId) {
        // Companion v0.4 Test sheet Run button (Jul 13).
        window.farnsworth?.runTest?.(args.testId).catch((e) =>
          console.warn('[relay:command] runTest failed:', e.message)
        );
      }
    } else if (t === 'canvas:subscribe') {
      // Companion wants to receive canvas:state — push current snapshot
      sendCanvasStateToCompanions();
    } else if (t === 'canvas:state') {
      // Companion pushed canvas state (e.g. cursor position) — accept
      // silently for now (future: sync markups / selection cursor)
    }
  });
}

// ----- VM overlay layers (mark up + comments) -----
// Two stacked absolute layers over the preview content. Switched on by
// state.vm.markup / state.vm.comments. CSS-target highlighting (click a
// component, see its CSS selector + blue outline) is deferred until we
// can introspect iframe DOM (cross-origin blocker today).
function renderVmOverlay() {
  const frag = document.createDocumentFragment();
  if (state.vm.markup) frag.appendChild(renderMarkupOverlay());
  if (state.vm.comments) frag.appendChild(renderCommentsOverlay());
  return frag;
}

function renderMarkupOverlay() {
  const overlay = el('div', { class: 'vm-overlay vm-overlay--markup is-active' });
  const canvas = el('canvas', { class: 'vm-strokes-canvas', id: 'vm-strokes-canvas' });
  overlay.appendChild(canvas);

  const toolbar = el('div', { class: 'vm-overlay__toolbar' });
  toolbar.appendChild(el('span', { class: 'vm-overlay__toolbar-label', style: 'color:var(--text-muted);font-size:11.5px;font-weight:600;' }, 'Mark up — draw to annotate'));
  toolbar.appendChild(el('div', { class: 'vm-overlay__toolbar-divider' }));
  const undoBtn = el('button', { class: 'vm-overlay__toolbar-btn', title: 'Undo last stroke (⌘Z)' }, 'Undo');
  undoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.vmMarkupStrokes?.length) {
      state.vmMarkupStrokes.pop();
      drawMarkupStrokes();
    }
  });
  toolbar.appendChild(undoBtn);
  const clearBtn = el('button', { class: 'vm-overlay__toolbar-btn vm-overlay__toolbar-btn--clear' }, 'Clear');
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.vmMarkupStrokes = [];
    drawMarkupStrokes();
  });
  toolbar.appendChild(clearBtn);
  overlay.appendChild(toolbar);

  // Defer canvas sizing + first draw until it's in the DOM
  requestAnimationFrame(() => {
    sizeMarkupCanvas();
    drawMarkupStrokes();
  });
  const ro = new ResizeObserver(() => {
    sizeMarkupCanvas();
    drawMarkupStrokes();
  });
  ro.observe(canvas);
  // Stash the observer on the canvas element so renderCanvas() can disconnect
  canvas._ro = ro;

  setupMarkupPen(canvas);
  return overlay;
}

function sizeMarkupCanvas() {
  const canvas = document.getElementById('vm-strokes-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  // Preserve existing strokes by scaling the bitmap up by the resize ratio
  const oldW = canvas.width, oldH = canvas.height;
  canvas.width = Math.floor(rect.width);
  canvas.height = Math.floor(rect.height);
  if (oldW && oldH) {
    // Re-draw on the new canvas size
    drawMarkupStrokes();
  }
}

function setupMarkupPen(canvas) {
  let drawing = false;
  let currentStroke = null;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX || 0) - rect.left;
    const cy = (e.clientY || 0) - rect.top;
    return { x: rect.width > 0 ? cx / rect.width : 0, y: rect.height > 0 ? cy / rect.height : 0 };
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawing = true;
    currentStroke = { points: [getPos(e)], color: '#ffa500', width: 3 };
    state.vmMarkupStrokes = state.vmMarkupStrokes || [];
    state.vmMarkupStrokes.push(currentStroke);
    drawMarkupStrokes();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    currentStroke.points.push(getPos(e));
    drawMarkupStrokes();
  });
  const end = () => { drawing = false; currentStroke = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);
}

function drawMarkupStrokes() {
  const canvas = document.getElementById('vm-strokes-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const strokes = state.vmMarkupStrokes || [];
  for (const stroke of strokes) {
    ctx.strokeStyle = stroke.color || '#ffa500';
    ctx.lineWidth = stroke.width || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = stroke.points;
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x * w, py = pts[i].y * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function renderCommentsOverlay() {
  const overlay = el('div', { class: 'vm-overlay vm-overlay--comments is-active' });
  const surface = el('div', { class: 'vm-comments-surface' });
  overlay.appendChild(surface);

  const displayMode = !!state.vmCommentsDisplay;

  // Toolbar: Display text toggle (for screenshots / chat capture)
  const toolbar = el('div', { class: 'vm-overlay__toolbar' });
  const displayBtn = el('button', {
    class: 'vm-overlay__toolbar-btn' + (displayMode ? ' is-active' : ''),
    title: 'Expand comment text inline — use this before capturing the preview for chat'
  }, displayMode ? 'Display text: on' : 'Display text');
  displayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.vmCommentsDisplay = !state.vmCommentsDisplay;
    renderCanvas();
  });
  toolbar.appendChild(displayBtn);
  overlay.appendChild(toolbar);

  // Render existing comments — pins (interactive) or cards (display mode)
  const comments = state.vmComments || [];

  if (displayMode) {
    for (const c of comments) {
      surface.appendChild(renderCommentCard(c));
    }
    // Click empty area → add new card with empty text, auto-focus
    surface.addEventListener('click', (e) => {
      if (e.target.closest('.vm-comment-card')) return;
      const rect = surface.getBoundingClientRect();
      const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
      state.vmComments = state.vmComments || [];
      const newComment = { id: 'c' + Date.now(), x, y, text: '', createdAt: Date.now() };
      state.vmComments.push(newComment);
      renderCanvas();
      // Focus the new card's text
      setTimeout(() => {
        const cards = document.querySelectorAll('.vm-comment-card');
        const lastCard = cards[cards.length - 1];
        const text = lastCard?.querySelector('.vm-comment-card__text');
        if (text) text.focus();
      }, 30);
    });
  } else {
    for (const c of comments) {
      surface.appendChild(renderCommentPin(c));
    }
    // Click empty area → drop new pin at click position
    surface.addEventListener('click', (e) => {
      if (e.target.closest('.vm-comment-pin') || e.target.closest('.vm-comment-box')) return;
      const rect = surface.getBoundingClientRect();
      const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
      state.vmComments = state.vmComments || [];
      const newComment = { id: 'c' + Date.now(), x, y, text: '', createdAt: Date.now() };
      state.vmComments.push(newComment);
      renderCanvas();
    });
  }

  return overlay;
}

function renderCommentCard(comment) {
  const card = el('div', { class: 'vm-comment-card' });
  card.style.left = (comment.x * 100) + '%';
  card.style.top = (comment.y * 100) + '%';

  const num = (state.vmComments || []).indexOf(comment) + 1;
  card.appendChild(el('span', { class: 'vm-comment-card__label' }, '#' + num));

  const text = el('div', {
    class: 'vm-comment-card__text',
    contenteditable: 'true',
    'data-placeholder': 'Click to add a comment…'
  });
  text.textContent = comment.text || '';
  text.addEventListener('blur', () => {
    comment.text = text.textContent.trim();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      text.blur();
    }
  });
  // Stop clicks inside the card from triggering the surface empty-click handler
  text.addEventListener('click', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => e.stopPropagation());

  card.appendChild(text);
  return card;
}

function renderCommentPin(comment) {
  const pin = el('button', { class: 'vm-comment-pin', type: 'button' });
  pin.style.left = (comment.x * 100) + '%';
  pin.style.top = (comment.y * 100) + '%';
  pin.textContent = String((state.vmComments || []).indexOf(comment) + 1);
  pin.title = comment.text || 'New comment';
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    openCommentBox(comment.id);
  });
  return pin;
}

function openCommentBox(commentId) {
  // Remove existing box if open
  const existing = document.querySelector('.vm-comment-box');
  if (existing) existing.remove();

  const comments = state.vmComments || [];
  const comment = comments.find(c => c.id === commentId);
  if (!comment) return;
  const surface = document.querySelector('.vm-comments-surface');
  if (!surface) return;

  const box = el('div', { class: 'vm-comment-box' });
  // Position below the pin
  const pinTopPx = comment.y * surface.getBoundingClientRect().height + 8;
  const pinLeftPx = Math.max(0, comment.x * surface.getBoundingClientRect().width - 110);
  box.style.left = pinLeftPx + 'px';
  box.style.top = pinTopPx + 'px';

  const textarea = el('textarea', { class: 'vm-comment-box__textarea', placeholder: 'Add a comment...' });
  textarea.value = comment.text || '';
  box.appendChild(textarea);

  const actions = el('div', { class: 'vm-comment-box__actions' });

  const deleteBtn = el('button', { class: 'vm-comment-box__btn vm-comment-box__btn--delete', type: 'button' }, 'Delete');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.vmComments = state.vmComments.filter(c => c.id !== commentId);
    renderCanvas();
  });

  const cancelBtn = el('button', { class: 'vm-comment-box__btn', type: 'button' }, 'Cancel');
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    box.remove();
  });

  const saveBtn = el('button', { class: 'vm-comment-box__btn vm-comment-box__btn--save', type: 'button' }, 'Save');
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    comment.text = textarea.value;
    renderCanvas();
  });

  actions.appendChild(deleteBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);

  surface.appendChild(box);
  setTimeout(() => { textarea.focus(); }, 0);
}

// Lightweight transient toast, bottom-center. Auto-dismisses after ~3.2s.
// Declared as a function so it's hoisted for all call sites above.
function showToast(msg) {
  if (!msg) return;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  setTimeout(() => {
    t.classList.remove('toast--in');
    setTimeout(() => t.remove(), 250);
  }, 3200);
}

// Renders the dev-server status/run control in the canvas overlay bar.
// - Live mode + server up   → green "Live" pill (click to stop)
// - Live mode + server down → "Go Live" run button (boots the dev server)
// - Booting                 → disabled "Starting…" state
// - Not live mode           → hidden
function renderLiveStatus() {
  const host = $('#canvas-live-status');
  if (!host) return;
  host.innerHTML = '';
  if (state.canvasMode !== 'live') { host.style.display = 'none'; return; }
  host.style.display = 'flex';

  const type = state.appType || 'devvit';

  if (state.farnsworthBooting) {
    const b = el('button', { class: 'live-status-btn live-status-btn--booting', disabled: true });
    b.innerHTML = '<span class="live-status-spinner"></span>Starting…';
    host.appendChild(b);
    return;
  }

  if (state.farnsworthDev?.available) {
    const pill = el('button', {
      class: 'live-status-btn live-status-btn--live',
      title: `Live dev server: ${state.farnsworthDev.url} (pid ${state.farnsworthDev.pid}). Click to stop.`,
      onClick: () => stopFarnsworthDev(),
    });
    pill.innerHTML = '<span class="live-status-dot"></span>Live';
    host.appendChild(pill);
    // Devvit emulator: user dropdown + cogwheel for switching/configuring.
    // The cogwheel opens the popover; the dropdown is a quick switch that
    // writes to SQLite + signals the subprocess to re-seed.
    if (type === 'devvit') {
      const userPill = el('button', {
        class: 'live-status-btn live-status-btn--user',
        id: 'devvit-user-pill',
        title: 'Current devvit user — click to switch',
        onClick: (e) => { e.stopPropagation(); openDevvitUserMenu(); },
      });
      userPill.innerHTML = '<span class="live-status-user-dot">👤</span><span id="devvit-user-pill-name">…</span>';
      host.appendChild(userPill);
      // Refresh the user pill label now that the dev server is live.
      refreshDevvitUserPill();

      const cogBtn = el('button', {
        class: 'live-status-btn live-status-btn--cog',
        id: 'devvit-cog-btn',
        title: 'Configure devvit emulator (users, subreddits, active selection)',
        onClick: (e) => { e.stopPropagation(); openDevvitConfig(); },
      });
      cogBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      host.appendChild(cogBtn);
    }
    return;
  }

  // Server down → run button
  const runBtn = el('button', {
    class: 'live-status-btn live-status-btn--run',
    title: `Boot the ${type} dev server (npm run farnsworth:${type}) so the preview renders live.`,
    onClick: () => bootFarnsworthDev(),
  });
  runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Go Live';
  host.appendChild(runBtn);
}

// Refreshes the user pill label from the devvit:get-project-settings IPC.
// Called when the dev server boots + after switching users.
async function refreshDevvitUserPill() {
  if (!state.folder || !window.farnsworth?.devvitGetProjectSettings) return;
  try {
    const settings = await window.farnsworth.devvitGetProjectSettings(state.folder);
    const label = document.getElementById('devvit-user-pill-name');
    if (label) label.textContent = settings?.current_username || '(no user)';
  } catch (e) {
    console.warn('[devvit] refreshDevvitUserPill failed:', e);
  }
}

// Quick-switch user dropdown. Lists all users from devvit:list-users,
// picks one → devvit:set-project-settings → reloads the dev server so
// the loader picks up the new currentUsername.
async function openDevvitUserMenu() {
  // Toggle closed if already open.
  const existing = document.querySelector('.devvit-user-menu');
  if (existing) { existing.remove(); return; }

  if (!window.farnsworth?.devvitListUsers || !state.folder) {
    showToast?.('Devvit emulator not available.');
    return;
  }
  let users, settings;
  try {
    users = await window.farnsworth.devvitListUsers();
    settings = await window.farnsworth.devvitGetProjectSettings(state.folder);
  } catch (e) {
    showToast?.('Failed to load devvit users.');
    return;
  }
  const activeId = settings?.current_user_id || null;

  const menu = el('div', { class: 'devvit-user-menu' });
  menu.innerHTML = `
    <div class="devvit-user-menu-title">Switch devvit user</div>
    ${users.map((u) => `
      <button class="devvit-user-menu-item ${u.id === activeId ? 'is-active' : ''}" data-user-id="${u.id}">
        <span class="devvit-user-menu-username">${escapeHtml(u.username)}</span>
        <span class="devvit-user-menu-karma">${(u.link_karma || 0) + (u.comment_karma || 0)} karma</span>
      </button>
    `).join('')}
    <div class="devvit-user-menu-foot">
      <button class="devvit-user-menu-configure" id="devvit-user-menu-configure">Manage users…</button>
    </div>
  `;
  document.body.appendChild(menu);
  // Anchor under the user pill.
  const anchor = document.getElementById('devvit-user-pill');
  const rect = anchor?.getBoundingClientRect();
  if (rect) {
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 8) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  }
  // Click handler — switch + reload dev server.
  menu.querySelectorAll('.devvit-user-menu-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = Number(btn.getAttribute('data-user-id'));
      menu.remove();
      try {
        await window.farnsworth.devvitSetProjectSettings(state.folder, userId, settings?.current_subreddit_id || null);
        showToast?.(`Switched to ${btn.querySelector('.devvit-user-menu-username')?.textContent}. Restarting dev server…`);
        await stopFarnsworthDev();
        await bootFarnsworthDev();
        await refreshDevvitUserPill();
      } catch (e) {
        showToast?.('Failed to switch user.');
      }
    });
  });
  menu.querySelector('#devvit-user-menu-configure')?.addEventListener('click', () => {
    menu.remove();
    openDevvitConfig();
  });
  // Click-outside closes.
  setTimeout(() => {
    const onClick = (e) => {
      if (!menu.contains(e.target) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('click', onClick);
      }
    };
    document.addEventListener('click', onClick);
  }, 0);
}

// Cogwheel popover — full configuration UI for the devvit emulator.
// Lists users + subreddits, lets you add/edit/remove, and sets the
// active selection. Persists via devvit:set-project-settings +
// devvit:upsert-user / devvit:upsert-subreddit.
async function openDevvitConfig() {
  const existing = document.querySelector('.devvit-config-popover');
  if (existing) {
    existing.remove();
    showAllCanvasViews();
    return;
  }

  if (!state.folder || !window.farnsworth?.devvitListUsers) {
    showToast?.('Open a devvit workspace first.');
    return;
  }
  let users, subreddits, settings;
  try {
    users = await window.farnsworth.devvitListUsers();
    subreddits = await window.farnsworth.devvitListSubreddits();
    settings = await window.farnsworth.devvitGetProjectSettings(state.folder);
  } catch (e) {
    showToast?.('Failed to load devvit config.');
    return;
  }

  const pop = el('div', { class: 'devvit-config-popover' });
  pop.innerHTML = `
    <div class="devvit-config-title">Devvit emulator — users &amp; subreddit</div>
    <div class="devvit-config-sub">Pick the active user + subreddit for this project. Click any user or subreddit to make it active. Use + to add new ones.</div>

    <div class="devvit-config-section">
      <div class="devvit-config-section-label">Active user</div>
      <select class="devvit-config-select" id="devvit-config-active-user">
        ${users.map((u) => `<option value="${u.id}" ${u.id === settings?.current_user_id ? 'selected' : ''}>${escapeHtml(u.username)} (${(u.link_karma || 0) + (u.comment_karma || 0)} karma)</option>`).join('')}
      </select>
    </div>

    <div class="devvit-config-section">
      <div class="devvit-config-section-label">Active subreddit</div>
      <select class="devvit-config-select" id="devvit-config-active-subreddit">
        ${subreddits.map((s) => `<option value="${s.id}" ${s.id === settings?.current_subreddit_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>
    </div>

    <div class="devvit-config-section">
      <div class="devvit-config-section-label">User library (${users.length})</div>
      <div class="devvit-config-list" id="devvit-config-users-list">
        ${users.map((u) => `
          <div class="devvit-config-list-item" data-user-id="${u.id}">
            <span class="devvit-config-list-name">${escapeHtml(u.username)}</span>
            <span class="devvit-config-list-meta">${(u.link_karma || 0) + (u.comment_karma || 0)} karma${u.is_employee ? ' · employee' : ''}</span>
            <button class="devvit-config-list-del" data-del-user="${u.id}" title="Remove user">×</button>
          </div>
        `).join('')}
      </div>
      <button class="devvit-config-add-btn" id="devvit-config-add-user">+ Add user</button>
    </div>

    <div class="devvit-config-section">
      <div class="devvit-config-section-label">Subreddit library (${subreddits.length})</div>
      <div class="devvit-config-list" id="devvit-config-subs-list">
        ${subreddits.map((s) => `
          <div class="devvit-config-list-item" data-sub-id="${s.id}">
            <span class="devvit-config-list-name">${escapeHtml(s.name)}</span>
            <span class="devvit-config-list-meta">${s.type} · ${s.member_count} members</span>
            <button class="devvit-config-list-del" data-del-sub="${s.id}" title="Remove subreddit">×</button>
          </div>
        `).join('')}
      </div>
      <button class="devvit-config-add-btn" id="devvit-config-add-sub">+ Add subreddit</button>
    </div>

    <div class="devvit-config-row">
      <button class="devvit-config-cancel" id="devvit-config-cancel">Cancel</button>
      <button class="devvit-config-save" id="devvit-config-save">Save &amp; reload</button>
    </div>
    <div class="devvit-config-err" id="devvit-config-err"></div>
  `;
  document.body.appendChild(pop);
  const anchor = document.getElementById('devvit-cog-btn');
  const rect = anchor?.getBoundingClientRect();
  if (rect) {
    pop.style.position = 'fixed';
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  }

  // Hide canvas WebContentsViews so the iframe doesn't cover the popover.
  // CSS z-index doesn't apply to WebContentsViews — they're a separate
  // composited layer rendered above the DOM. Hide them while the popover
  // is open; restore on every close path below.
  hideAllCanvasViews();
  const closeAndRestore = () => {
    pop.remove();
    showAllCanvasViews();
  };

  // Wire delete buttons.
  pop.querySelectorAll('[data-del-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-del-user'));
      await window.farnsworth.devvitDeleteUser(id);
      // Re-open shows views first then re-hides — flicker is imperceptible
      // but cleaner to keep them visible through the swap.
      showAllCanvasViews();
      pop.remove();
      openDevvitConfig(); // re-render
    });
  });
  pop.querySelectorAll('[data-del-sub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.getAttribute('data-del-sub'));
      await window.farnsworth.devvitDeleteSubreddit(id);
      showAllCanvasViews();
      pop.remove();
      openDevvitConfig(); // re-render
    });
  });

  // Add user / subreddit buttons — open small inline forms.
  pop.querySelector('#devvit-config-add-user')?.addEventListener('click', () => {
    const username = prompt('New username (e.g. u/alice):');
    if (!username) return;
    const reddit_id = prompt('Reddit id (e.g. t2_alice99):') || `t2_${username.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Date.now().toString(36).slice(-4)}`;
    window.farnsworth.devvitUpsertUser({ reddit_id, username, link_karma: 0, comment_karma: 0, is_employee: 0 })
      .then(() => { showAllCanvasViews(); pop.remove(); openDevvitConfig(); });
  });
  pop.querySelector('#devvit-config-add-sub')?.addEventListener('click', () => {
    const name = prompt('New subreddit name (e.g. r/foo):');
    if (!name) return;
    const reddit_id = prompt('Reddit id (e.g. t5_foo01):') || `t5_${name.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Date.now().toString(36).slice(-4)}`;
    window.farnsworth.devvitUpsertSubreddit({ reddit_id, name, type: 'public', member_count: 0 })
      .then(() => { showAllCanvasViews(); pop.remove(); openDevvitConfig(); });
  });

  // Cancel closes.
  pop.querySelector('#devvit-config-cancel')?.addEventListener('click', closeAndRestore);

  // Save & reload — writes active selection, restarts dev server.
  pop.querySelector('#devvit-config-save')?.addEventListener('click', async () => {
    const userId = Number(pop.querySelector('#devvit-config-active-user')?.value);
    const subId = Number(pop.querySelector('#devvit-config-active-subreddit')?.value);
    const errEl = pop.querySelector('#devvit-config-err');
    try {
      await window.farnsworth.devvitSetProjectSettings(state.folder, userId, subId);
      pop.remove();
      showAllCanvasViews();
      showToast?.('Devvit config saved. Restarting dev server…');
      await stopFarnsworthDev();
      await bootFarnsworthDev();
      await refreshDevvitUserPill();
    } catch (e) {
      if (errEl) errEl.textContent = e.message || 'Save failed.';
    }
  });
  // Click-outside closes.
  setTimeout(() => {
    const onClick = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) {
        pop.remove();
        showAllCanvasViews();
        document.removeEventListener('click', onClick);
      }
    };
    document.addEventListener('click', onClick);
  }, 0);
}

// Hide every canvas WebContentsView so overlays (cogwheel popover, modals)
// don't get visually covered by the iframe behind them.
function hideAllCanvasViews() {
  document.querySelectorAll('[data-canvas-view-id]').forEach((el) => {
    const viewId = el.dataset.canvasViewId;
    if (viewId && window.farnsworth?.canvasSetVisible) {
      window.farnsworth.canvasSetVisible(viewId, false);
    }
  });
}

// Restore visibility of every canvas WebContentsView (called from every
// close path of openDevvitConfig).
function showAllCanvasViews() {
  document.querySelectorAll('[data-canvas-view-id]').forEach((el) => {
    const viewId = el.dataset.canvasViewId;
    if (viewId && window.farnsworth?.canvasSetVisible) {
      window.farnsworth.canvasSetVisible(viewId, true);
    }
  });
}

// Boots the dev server for the open workspace's app type, then re-detects and
// re-renders so the preview swaps from static images to live iframes.
async function bootFarnsworthDev() {
  if (!window.farnsworth?.devFarnsworthBoot) {
    showToast?.('Reload Farnsworth — dev bridge unavailable.');
    return;
  }
  if (!state.folder) {
    showToast?.('Open a workspace folder first.');
    return;
  }
  const type = state.appType || 'devvit';
  state.farnsworthBooting = true;
  renderLiveStatus();
  try {
    const res = await window.farnsworth.devFarnsworthBoot(type, state.folder);
    if (res?.ok) {
      state.farnsworthDev = { available: true, type: res.type, url: res.url, pid: res.pid, startedAt: res.startedAt };
      showToast?.(`${type} dev server live at ${res.url}`);
    } else {
      state.farnsworthDev = { available: false };
      showToast?.(res?.message || 'Failed to start dev server.');
      console.warn('[Farnsworth] boot failed:', res);
    }
  } catch (e) {
    state.farnsworthDev = { available: false };
    showToast?.('Failed to start dev server.');
    console.warn('[Farnsworth] boot error:', e);
  } finally {
    state.farnsworthBooting = false;
    renderCanvas();
  }
}

// Stops the running dev server (kills the vite process) and re-renders so the
// preview falls back to the static images.
async function stopFarnsworthDev() {
  if (!window.farnsworth?.devFarnsworthStop) {
    showToast?.('Stop from a terminal: pkill -f vite.devtools.config.ts');
    return;
  }
  try {
    await window.farnsworth.devFarnsworthStop(state.appType || 'devvit');
  } catch (e) {
    console.warn('[Farnsworth] stop error:', e);
  }
  state.farnsworthDev = { available: false };
  renderCanvas();
}

function renderLivePreview() {
  // New: dispatch on state.preview — 'post' | 'mobile' | 'desktop'.
  // Post = Reddit dark-mode feed with the Sword & Supper game embed.
  // Mobile / Desktop = app launch views (still generic shapes, will be
  // replaced with real Sword & Supper app screens in subsequent passes).
  const cls = state.preview === 'post'
    ? 'artboard--post'
    : (state.preview === 'mobile' ? 'artboard--mobile'
      : (state.preview === 'fullscreen' ? 'artboard--fullscreen'
        : (state.preview === 'testview' ? 'artboard--testview' : 'artboard--desktop')));
  const wrap = el('div', { class: 'artboard ' + cls, id: 'canvas-artboard' });

  // Apply persisted width; height is derived from aspect ratio on mobile/desktop
  // (Post height is content-driven initially; captured at first resize)
  const initialW = state.previewWidths[state.preview];
  // Custom height override (set by the resolution dropdown's Custom input).
  // When set, takes precedence over the category's aspect ratio so the
  // artboard can be any W × H regardless of whether it's mobile/desktop.
  // Aspect ratios track the per-category defaults (mobile 390×844 ≈ 2.16,
  // desktop 724×596 ≈ 0.823, fullscreen 16:9).
  const customH = state.previewCustomHeight?.[state.preview] || null;
  // For mobile/desktop the width/height + these aspect ratios describe the
  // INNER render area (the game iframe / device viewport), NOT the outer frame.
  // We seed the artboard at the inner target here, then calibrateArtboardToInner()
  // (scheduled after mount) measures the real chrome — phone bezel + status /
  // app / action bars, desktop title / action bar — and grows the outer frame so
  // the iframe lands exactly on the target dims. This matches how real device
  // preview tools work: "390 × 844" means the game gets a 390 × 844 canvas.
  wrap.style.width = initialW + 'px';
  if (state.preview === 'mobile') wrap.style.height = (customH || (initialW * 844 / 390)) + 'px';
  else if (state.preview === 'desktop') wrap.style.height = (customH || (initialW * 596 / 724)) + 'px';
  // Fullscreen — larger, immersive 16:9 game canvas with no action bar.
  else if (state.preview === 'fullscreen') wrap.style.height = (customH || (initialW * 9 / 16)) + 'px';
  // Test View — split layout with phone game canvas on the left + test
  // runner panel on the right. Height derives from width via the default
  // 900:876 outer aspect (876 = 844 phone + 2×16 padding) so a corner-drag
  // size survives re-renders; the phone lands exactly 390×844 at default.
  else if (state.preview === 'testview') wrap.style.height = (customH || (initialW * 876 / 900)) + 'px';

  // Artboard frame
  const frame = el('div', { class: 'artboard__frame' });
  ['tl', 'tr', 'bl', 'br'].forEach(pos => {
    const c = el('span', { class: 'artboard__corner artboard__corner--' + pos });
    frame.appendChild(c);
  });
  wrap.appendChild(frame);

  // Label
  const label = el('div', { class: 'artboard__label' });
  if (state.preview === 'post') {
    label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Frame · Post View';
  } else if (state.preview === 'fullscreen') {
    label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>Frame · Fullscreen';
  } else if (state.preview === 'testview') {
    label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6L4 18a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L15 8V2M9 2h6M9 14h6"/></svg>Frame · Test View';
  } else {
    label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>Frame · Matchmaking';
  }
  wrap.appendChild(label);

  // Size label — shows the subreddit for Post View, otherwise the actual
  // current W × H (using the derived height from the category aspect
  // ratio, or the custom-height override if set).
  const size = el('div', { class: 'artboard__size' });
  if (state.preview === 'post') {
    size.textContent = 'Reddit · r/SwordAndSupperGame';
  } else {
    const w = initialW;
    let h = customH;
    if (!h) {
      // Re-derive from the category aspect ratio (matches the height
      // assignment above).
      if (state.preview === 'mobile') h = w * 844 / 390;
      else if (state.preview === 'desktop') h = w * 596 / 724;
      else if (state.preview === 'fullscreen') h = w * 9 / 16;
      else if (state.preview === 'testview') h = w * 876 / 900;
      else h = w;
    }
    size.textContent = Math.round(w) + ' × ' + Math.round(h);
  }
  wrap.appendChild(size);

  // Body
  if (state.preview === 'post') wrap.appendChild(renderPostView());
  else if (state.preview === 'mobile') wrap.appendChild(renderPhone());
  else if (state.preview === 'fullscreen') wrap.appendChild(renderFullscreen());
  else if (state.preview === 'testview') wrap.appendChild(renderTestView());
  else wrap.appendChild(renderDesktop());

  // Wire up corner drag (after body so getBoundingClientRect reflects final layout)
  // For Post View: capture initial height after render so aspect reflects current content
  if (state.preview === 'post') {
    const h = wrap.getBoundingClientRect().height;
    if (h > 10) wrap.dataset.postAspect = (initialW / h).toString();
  }
  ['tl', 'tr', 'bl', 'br'].forEach(pos => {
    const corner = frame.querySelector('.artboard__corner--' + pos);
    corner.addEventListener('mousedown', (e) => startArtboardResize(e, wrap, pos, size));
  });

  // Inner-frame calibration (mobile/desktop): after the artboard is mounted,
  // size the outer frame so the game iframe matches the selected device
  // dimensions, with the chrome added on top. rAF ensures the element is in
  // the document and laid out before we measure.
  if (state.preview === 'mobile' || state.preview === 'desktop') {
    const mode = state.preview;
    const targetInnerW = initialW;
    const targetInnerH = customH || (mode === 'mobile'
      ? initialW * 844 / 390
      : initialW * 596 / 724);
    requestAnimationFrame(() => calibrateArtboardToInner(wrap, mode, targetInnerW, targetInnerH));
  }
  // Test View needs no calibration (Jul 13): the phone's geometry is fully
  // CSS-derived (height:100% + aspect-ratio), so the 390×844 default falls
  // out of the 900×876 artboard. The old calibrate call assumed inner width
  // follows outer width 1:1, which is false for the split layout — it
  // drifted the artboard width on every render once the phone became fluid.

  return wrap;
}

// Size the artboard so its INNER render area (the game iframe) equals
// targetInnerW × targetInnerH, adding the measured frame chrome on top. Used
// for mobile/desktop so preset dimensions describe the game viewport, the way
// real device-preview tools work. Must run after the artboard is in the DOM.
function calibrateArtboardToInner(wrap, mode, targetInnerW, targetInnerH) {
  if (!wrap || !wrap.isConnected) return;
  const sel = mode === 'mobile' ? '.phone__screen'
    : mode === 'desktop' ? '.desktop__stage'
    : mode === 'fullscreen' ? '.fullscreen__stage'
    : null;
  if (!sel) return;
  const renderEl = wrap.querySelector(sel);
  if (!renderEl) return;
  const outer = wrap.getBoundingClientRect();
  const inner = renderEl.getBoundingClientRect();
  if (inner.width < 10 || inner.height < 10) return; // not laid out yet
  // Chrome is the fixed delta between the outer frame and the render area; it
  // doesn't change as the frame resizes (bezel/bars are fixed px).
  const chromeW = outer.width - inner.width;
  const chromeH = outer.height - inner.height;
  wrap.style.width = Math.round(targetInnerW + chromeW) + 'px';
  wrap.style.height = Math.round(targetInnerH + chromeH) + 'px';
}

// Drag-to-resize with locked aspect ratio. Called by mousedown on an artboard corner.
function startArtboardResize(e, wrap, corner, sizeLabel) {
  e.preventDefault();
  e.stopPropagation();

  // Layout sizes, NOT getBoundingClientRect — the artboard may be under a
  // zoom scale() transform (auto-fit / manual zoom, Jul 13). The transformed
  // rect is the visual size; writing mouse deltas against it would snap the
  // layout width from e.g. 900 to 486 on the first drag at 54% zoom.
  const initialW = wrap.offsetWidth;
  const initialH = wrap.offsetHeight;
  const zoomScale = (state.zoom || 100) / 100;
  if (initialW < 50 || initialH < 50) return; // not yet measurable

  // Aspect = width / height. For Post View, use the captured aspect if available
  // (so the first drag locks to the rendered content shape, not 480/undefined).
  const aspect = (state.preview === 'post' && wrap.dataset.postAspect)
    ? parseFloat(wrap.dataset.postAspect)
    : initialW / initialH;

  const initialMouseX = e.clientX;
  const initialMouseY = e.clientY;

  // Per-corner sign for horizontal drag: TL/BL = -1 (drag right shrinks),
  // TR/BR = +1 (drag right grows).
  const cornerSign = { tl: -1, tr: 1, bl: -1, br: 1 };
  const sign = cornerSign[corner];

  const onMove = (ev) => {
    // Mouse deltas are in screen px; divide by the zoom scale so the edge
    // tracks the cursor when the artboard is visually scaled.
    const dx = (ev.clientX - initialMouseX) / zoomScale;
    const dy = (ev.clientY - initialMouseY) / zoomScale;
    // Width change due to vertical drag (aspect-locked): dy contributes (dy * aspect)
    const dwFromDx = dx * sign;
    const dwFromDy = dy * sign * aspect;
    // Use whichever magnitude dominates — feels natural regardless of drag direction
    const dw = Math.abs(dwFromDx) > Math.abs(dwFromDy) ? dwFromDx : dwFromDy;
    const newW = Math.max(200, Math.min(1600, initialW + dw));
    const newH = newW / aspect;
    wrap.style.width = newW + 'px';
    wrap.style.height = newH + 'px';
    // Keep the zoom margin compensation in step with the new layout size
    // (updateZoom() computes it from offsetWidth/Height at zoom time; a drag
    // afterwards would leave stale margins and mis-center the artboard).
    if (zoomScale !== 1) {
      wrap.style.marginRight = (-(newW * (1 - zoomScale))) + 'px';
      wrap.style.marginBottom = (-(newH * (1 - zoomScale))) + 'px';
    }
    if (sizeLabel) sizeLabel.textContent = Math.round(newW) + ' × ' + Math.round(newH);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    let finalW = parseFloat(wrap.style.width) || initialW;
    // Mobile/desktop store the INNER render width (not the outer frame), so
    // previewWidths stays in inner-space and the next render re-calibrates
    // cleanly. Measure the actual iframe/render area on release.
    if (state.preview === 'mobile' || state.preview === 'desktop') {
      const sel = state.preview === 'mobile' ? '.phone__screen' : '.desktop__stage';
      const renderEl = wrap.querySelector(sel);
      if (renderEl) {
        const ir = renderEl.getBoundingClientRect();
        if (ir.width > 10) finalW = ir.width;
        // Keep a custom height in inner-space too, if one is active.
        if (state.previewCustomHeight?.[state.preview] && ir.height > 10) {
          state.previewCustomHeight[state.preview] = ir.height;
        }
      }
    }
    state.previewWidths[state.preview] = finalW;
    // Test View with a Custom height override active: keep it tracking the
    // dragged height, otherwise the next render snaps back to the stale one.
    if (state.preview === 'testview' && state.previewCustomHeight?.testview) {
      const fh = parseFloat(wrap.style.height);
      if (fh > 10) state.previewCustomHeight.testview = fh;
    }
    // Lock Post aspect going forward so future renders don't fall back to content height
    if (state.preview === 'post') {
      const finalH = parseFloat(wrap.style.height) || initialH;
      if (finalH > 10) wrap.dataset.postAspect = (finalW / finalH).toString();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function renderPostView() {
  // Live Post View needs both a subreddit name and a post name to be
  // meaningfully populated. Folders without a `.farnsworth/config.json`
  // `live` block (e.g. Farnsworth itself — it's the IDE, not a Devvit
  // project) end up with `state.liveConfig` = {projectName:'', sub:'', url:'', postName:''}.
  // The previous code fell back to hardcoded thelastdraft mock content
  // ("Strange Mild Japanese Katsu Curry", "r/SwordAndSupperGame", "u/MaccaoTooth")
  // — which is misleading when the open folder is unrelated. Show an
  // empty placeholder + Live cogwheel prompt instead. Jul 8 ~10:50 ET.
  const lc = state.liveConfig || {};
  const hasLiveConfig = (lc.subredditName && lc.subredditName.trim()) || (lc.postName && lc.postName.trim());
  if (!hasLiveConfig) {
    const wrap = el('div', { class: 'post-view post-view--empty' });
    wrap.innerHTML = `
      <div class="post-view__nav">
        <div class="post-view__nav-icon"><svg viewBox="0 0 20 20" fill="currentColor"><path d="M17.1 4.801H2.9a.9.9 0 010-1.8h14.199a.9.9 0 01.001 1.8zM18 10a.9.9 0 00-.9-.9H2.9a.9.9 0 000 1.8h14.199A.9.9 0 0018 10zm0 6.1a.9.9 0 00-.9-.9H2.9a.9.9 0 000 1.8h14.199a.9.9 0 00.901-.9z"/></svg></div>
        <div class="post-view__nav-logo">reddit</div>
        <div class="post-view__nav-search"><svg viewBox="0 0 20 20" fill="currentColor"><path d="M14.386 14.386L19.738 19.737M17 9.5a7.5 7.5 0 11-15 0 7.5 7.5 0 0115 0z" stroke="currentColor" stroke-width="1.8" fill="none"/></svg><span class="post-view__nav-search-input">Find anything</span></div>
      </div>
      <div class="post-view__empty">
        <div class="post-view__empty-icon">
          <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        </div>
        <div class="post-view__empty-title">No Live config for this folder</div>
        <div class="post-view__empty-text">This workspace doesn't have a Reddit post configured. Open the Live panel's settings to add your subreddit + post name.</div>
        <button class="post-view__empty-btn" id="post-view-empty-config-btn">Open Live settings</button>
      </div>
    `;
    setTimeout(() => {
      const btn = wrap.querySelector('#post-view-empty-config-btn');
      if (btn) btn.onclick = () => openLiveConfigPopover();
    }, 0);
    return wrap;
  }
  const root = el('div', { class: 'post-view' });

  // Top nav bar — Reddit header (hamburger + reddit wordmark + search)
  // Hamburger has a small red notification dot in its top-right corner
  // (the original Snoo circle was removed — Long said it looked like a
  // stray red dot beside the wordmark, and wanted the badge moved inside
  // the hamburger where it actually belongs.)
  const nav = el('div', { class: 'post-view__nav' });
  nav.innerHTML = `
    <div class="post-view__nav-icon">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M17.1 4.801H2.9a.9.9 0 010-1.8h14.199a.9.9 0 01.001 1.8zM18 10a.9.9 0 00-.9-.9H2.9a.9.9 0 000 1.8h14.199A.9.9 0 0018 10zm0 6.1a.9.9 0 00-.9-.9H2.9a.9.9 0 000 1.8h14.199a.9.9 0 00.901-.9z"/></svg>
      <span class="post-view__nav-badge"></span>
    </div>
    <div class="post-view__nav-logo">reddit</div>
    <div class="post-view__nav-search">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M14.386 14.386L19.738 19.737M17 9.5a7.5 7.5 0 11-15 0 7.5 7.5 0 0115 0z" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
      <span class="post-view__nav-search-input">Find anything</span>
    </div>
  `;
  root.appendChild(nav);

  // Feed (scrollable)
  const feed = el('div', { class: 'post-view__feed' });

  // First post — the MaccaoTooth "Strange Mild Japanese Katsu Curry" embed
  const post = el('div', { class: 'post-view__post' });

  // Content (full-width, no separate vote column — Reddit's PDP uses pill vote)
  const content = el('div', { class: 'post-view__content' });

  // Credit bar — two-line: subreddit + author (Reddit's PDP layout)
  const credit = el('div', { class: 'post-view__credit' });
  credit.innerHTML = `
    <div class="post-view__credit-back"><svg viewBox="0 0 20 20" fill="currentColor"><path d="M12.7 4.3a1 1 0 00-1.4 0l-6 6a1 1 0 000 1.4l6 6a1 1 0 001.4-1.4L7.4 11H17a1 1 0 100-2H7.4l5.3-5.3a1 1 0 000-1.4z"/></svg></div>
    <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
      <div class="post-view__credit-sub">
        <span class="post-view__credit-avatar"><img src="assets/reddit/community-icon.png" alt="r/SwordAndSupperGame"/></span>
        <span class="post-view__credit-sub-name">${(state.liveConfig?.subredditName && ('r/' + state.liveConfig.subredditName)) || 'r/SwordAndSupperGame'}</span>
        <span class="post-view__credit-sub-dot">·</span>
        <span class="post-view__credit-sub-time">19m ago</span>
      </div>
      <div style="font-size:11px;color:#818384;display:flex;align-items:center;gap:4px;">
        <span style="color:#d7dadc;font-weight:500;">u/MaccaoTooth</span>
      </div>
    </div>
    <div class="post-view__credit-more"><svg viewBox="0 0 20 20" fill="currentColor"><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg></div>
  `;
  content.appendChild(credit);

  // Title — driven by state.liveConfig.postName when set, falls through
  // to the hardcoded mock post. (Long Jul 3 ~13:19 ET — "the post name
  // from the config should replace the hardcoded title here.")
  const title = el('h1', { class: 'post-view__title' });
  title.textContent = (state.liveConfig?.postName && state.liveConfig.postName.trim())
    || 'Strange Mild Japanese Katsu Curry';
  content.appendChild(title);

  

  // Game embed — real Sword & Supper Devvit iframe screenshot (732×512)
  // captured from the live Reddit post on Jun 26 ~12:24 ET.
  // Replaces the earlier CSS-art mock with the actual game scene.
  // Jul 2: when `npm run farnsworth` is running (state.farnsworthDev.available),
  // the static background-image was overlaid with a live iframe pointing at
  // the dev server's splash.tsx render (?view=post). Background-image stays
  // as the fallback when farnsworth isn't available.
  // Jul 11 ~14:42 ET: the-last-draft doesn't have a splash.tsx — loading
  // ?view=post renders the full game UI which overflows the 732×512 embed
  // area and visually overlays the Reddit post. Skip the iframe for
  // lastdraft (or any project without a compact splash view); the static
  // background-image still shows the embed look.
  const embed = el('div', { class: 'post-view__embed' });
  if (state.farnsworthDev?.available) {
    embed.appendChild(el('iframe', {
      class: 'post-view__embed-iframe',
      src: state.farnsworthDev.url + '/?view=post',
      title: 'Live Reddit post preview',
    }));
  }
  content.appendChild(embed);

  // Action bar — Reddit pill style: vote pill (up + count + down), comments pill, award icon, share pill
  const actions = el('div', { class: 'post-view__actions' });
  actions.innerHTML = `
    <button class="post-view__pill post-view__pill--vote">
      <span class="vote-arrow is-up is-active"><svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 4l-6 6h4v6h4v-6h4z"/></svg></span>
      <span class="vote-count">1</span>
      <span class="vote-arrow is-down"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 16l-6-6h4V4h4v6h4z"/></svg></span>
    </button>
    <button class="post-view__pill">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 00-7.9 9.3L1 19l7.7-1.1A8 8 0 1010 2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
      0
    </button>
    <button class="post-view__pill">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2L11.5 7L17 8L13 12L14 17L10 14.5L6 17L7 12L3 8L8.5 7Z"/></svg>
      Award
    </button>
    <button class="post-view__pill">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="14" height="14">
        <path d="M0 0h256v256H0z" fill="none"/>
        <path fill="currentColor" d="m237.66 106.35l-80-80A8 8 0 0 0 144 32v40.35c-25.94 2.22-54.59 14.92-78.16 34.91c-28.38 24.08-46.05 55.11-49.76 87.37a12 12 0 0 0 20.68 9.58c11-11.71 50.14-48.74 107.24-52V192a8 8 0 0 0 13.66 5.65l80-80a8 8 0 0 0 0-11.3M160 172.69V144a8 8 0 0 0-8-8c-28.08 0-55.43 7.33-81.29 21.8a196.2 196.2 0 0 0-36.57 26.52c5.8-23.84 20.42-46.51 42.05-64.86C99.41 99.77 127.75 88 152 88a8 8 0 0 0 8-8V51.32L220.69 112Z"/>
      </svg>
      Share
    </button>
    <div class="post-view__privacy">
      <svg viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4M10 13h.01" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>
      Privacy
    </div>
  `;
  content.appendChild(actions);

  post.appendChild(content);
  feed.appendChild(post);

  // Comments section
  const comments = el('div', { class: 'post-view__comments' });
  comments.innerHTML = `
    <div class="post-view__comments-header">Join the conversation</div>
    <div class="post-view__comments-empty">
      <div class="post-view__comments-snoo"><img src="src/assets/reddit/snoo-wave.png" alt="Snoo"/></div>
      <div class="post-view__comments-empty-title">Be the first to comment</div>
      <div class="post-view__comments-empty-text">Nobody's responded to this post yet. Add your thoughts and start the conversation.</div>
    </div>
  `;
  feed.appendChild(comments);

  // Second post teaser (ShrekisSexy)
  const teaser = el('div', { class: 'post-view__post-teaser' });
  teaser.innerHTML = `
    <div class="post-view__post-teaser-avatar"></div>
    <div class="post-view__post-teaser-body">
      <div class="post-view__post-teaser-meta">
        <span class="post-view__author" style="color:#d7dadc;font-weight:500">u/ShrekisSexy</span>
        <span>· 5 hr. ago</span>
      </div>
      <div class="post-view__post-teaser-title">Here are 5 end-game builds without legacy items</div>
      <div class="post-view__post-teaser-snippet">I just beat two level 1000+ boss rushes as a level 169. These are my 5</div>
    </div>
  `;
  feed.appendChild(teaser);

  root.appendChild(feed);

  return root;
}

function renderPhone() {
  // Phone mockup for the "App Launch View - Mobile" preview.
  // Phone bezel + custom chrome (status bar + app bar with X/title/3-dots +
  // game content + bottom upvote/comment/share action bar). Sword & Supper
  // game scene fills the screen area.
  const phone = el('div', { class: 'phone' });
  phone.innerHTML = `
    <div class="phone__statusbar">
      <div class="phone__statusbar-time">12:24</div>
      <div class="phone__statusbar-right">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 18a2 2 0 002-2H10a2 2 0 002 2zm6-6V9a6 6 0 10-12 0v3H4v8h16v-8h-2z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M2 18h2v-6H2v6zm4 0h2V8H6v10zm4 0h2v-4h-2v4zm4 0h2V4h-2v14zm4 0h2v-2h-2v2z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4zM13 21h-2v-1h2v1zm0-3h-2V6h2v12z"/></svg>
      </div>
    </div>
    <div class="phone__appbar">
      <div class="phone__appbar-close">
        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M14.7 5.3a1 1 0 010 1.4L11.4 10l3.3 3.3a1 1 0 11-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 11-1.4-1.4L8.6 10 5.3 6.7a1 1 0 011.4-1.4L10 8.6l3.3-3.3a1 1 0 011.4 0z"/></svg>
      </div>
      <div class="phone__appbar-title">${(state.liveConfig?.projectName && state.liveConfig.projectName.trim()) || ''}</div>
      <div class="phone__appbar-more">
        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
      </div>
    </div>
    <div class="phone__screen">
      ${state.farnsworthDev?.available
        ? `<div class="phone__screen-iframe phone__screen-browser-view" data-canvas-view="mobile" data-canvas-url="${state.farnsworthDev.url}/?view=mobile" style="width:100%;height:100%;display:block;background:#000"></div>`
        : `<img src="src/assets/reddit/swordandsuppermobile.png" alt="Sword & Supper game" />`}
    </div>
    <div class="phone__actions">
      <button class="post-view__pill post-view__pill--vote">
        <span class="vote-arrow is-up is-active"><svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 4l-6 6h4v6h4v-6h4z"/></svg></span>
        <span class="vote-count">83</span>
        <span class="vote-arrow is-down"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10 16l-6-6h4V4h4v6h4z"/></svg></span>
      </button>
      <button class="post-view__pill">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 2a8 8 0 00-7.9 9.3L1 19l7.7-1.1A8 8 0 1010 2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        28
      </button>
      <button class="post-view__pill">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 2L11.5 7L17 8L13 12L14 17L10 14.5L6 17L7 12L3 8L8.5 7Z"/></svg>
        Award
      </button>
      <button class="post-view__pill post-view__pill--icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="18" height="18">
          <path d="M0 0h256v256H0z" fill="none"/>
          <path fill="currentColor" d="m237.66 106.35l-80-80A8 8 0 0 0 144 32v40.35c-25.94 2.22-54.59 14.92-78.16 34.91c-28.38 24.08-46.05 55.11-49.76 87.37a12 12 0 0 0 20.68 9.58c11-11.71 50.14-48.74 107.24-52V192a8 8 0 0 0 13.66 5.65l80-80a8 8 0 0 0 0-11.3M160 172.69V144a8 8 0 0 0-8-8c-28.08 0-55.43 7.33-81.29 21.8a196.2 196.2 0 0 0-36.57 26.52c5.8-23.84 20.42-46.51 42.05-64.86C99.41 99.77 127.75 88 152 88a8 8 0 0 0 8-8V51.32L220.69 112Z"/>
        </svg>
      </button>
    </div>
  `;
  return phone;
}

function renderDesktop() {
  // Desktop mockup for "App Launch View - Desktop".
  // Devvit is a web app — render the Sword & Supper game inside a
  // desktop-sized window with a title bar (Daily Dungeon + 3 dots + X).
  // Rounded corners on the container, game content fills the body.
  const d = el('div', { class: 'desktop' });
  d.innerHTML = `
    <div class="desktop__titlebar">
      <div class="desktop__title">${(state.liveConfig?.projectName && state.liveConfig.projectName.trim()) || ''}</div>
      <div class="desktop__controls">
        <button class="desktop__control desktop__control--dots"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg></button>
        <button class="desktop__control desktop__control--fs"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><path d="M3 8V4h4M17 8V4h-4M3 12v4h4M17 12v4h-4"/></svg></button>
        <button class="desktop__control desktop__control--close"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M14.7 5.3a1 1 0 010 1.4L11.4 10l3.3 3.3a1 1 0 11-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 11-1.4-1.4L8.6 10 5.3 6.7a1 1 0 011.4-1.4L10 8.6l3.3-3.3a1 1 0 011.4 0z"/></svg></button>
      </div>
    </div>
    <div class="desktop__stage">
      ${state.farnsworthDev?.available
        ? `<div class="desktop__stage-iframe desktop__stage-browser-view" data-canvas-view="desktop" data-canvas-url="${state.farnsworthDev.url}/?view=desktop" style="width:100%;height:100%;display:block;background:#000"></div>`
        : `<img src="src/assets/reddit/swordandsuppermobile.png" alt="Sword & Supper game" />`}
    </div>
    <div class="desktop__actions">
      <button class="post-view__pill post-view__pill--vote">
        <span class="vote-arrow is-up is-active"><svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 4l-6 6h4v6h4v-6h4z"/></svg></span>
        <span class="vote-count">83</span>
        <span class="vote-arrow is-down"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10 16l-6-6h4V4h4v6h4z"/></svg></span>
      </button>
      <button class="post-view__pill">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 2a8 8 0 00-7.9 9.3L1 19l7.7-1.1A8 8 0 1010 2z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        28
      </button>
      <button class="post-view__pill">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 2L11.5 7L17 8L13 12L14 17L10 14.5L6 17L7 12L3 8L8.5 7Z"/></svg>
        Award
      </button>
      <button class="post-view__pill post-view__pill--icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="18" height="18">
          <path d="M0 0h256v256H0z" fill="none"/>
          <path fill="currentColor" d="m237.66 106.35l-80-80A8 8 0 0 0 144 32v40.35c-25.94 2.22-54.59 14.92-78.16 34.91c-28.38 24.08-46.05 55.11-49.76 87.37a12 12 0 0 0 20.68 9.58c11-11.71 50.14-48.74 107.24-52V192a8 8 0 0 0 13.66 5.65l80-80a8 8 0 0 0 0-11.3M160 172.69V144a8 8 0 0 0-8-8c-28.08 0-55.43 7.33-81.29 21.8a196.2 196.2 0 0 0-36.57 26.52c5.8-23.84 20.42-46.51 42.05-64.86C99.41 99.77 127.75 88 152 88a8 8 0 0 0 8-8V51.32L220.69 112Z"/>
        </svg>
      </button>
    </div>
  `;
  return d;
}

// Fullscreen — an immersive, larger-than-desktop game canvas. Same expanded
// game render as App Desktop (?view=desktop) but chromeless: a slim title bar
// only, NO upvote / comment / award / share action bar. Used to preview the
// game at a big 16:9 size the way it'd look played full-window.
function renderFullscreen() {
  const f = el('div', { class: 'fullscreen' });
  f.innerHTML = `
    <div class="fullscreen__titlebar">
      <div class="fullscreen__title">${(state.liveConfig?.projectName && state.liveConfig.projectName.trim()) || ''}</div>
      <div class="fullscreen__controls">
        <button class="fullscreen__control fullscreen__control--min"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><path d="M4 10h12"/></svg></button>
        <button class="fullscreen__control fullscreen__control--exit"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><path d="M8 3H5a2 2 0 0 0-2 2v3M15 3h2a2 2 0 0 1 2 2v3M8 17H5a2 2 0 0 1-2-2v-3M15 17h2a2 2 0 0 0 2-2v-3"/></svg></button>
        <button class="fullscreen__control fullscreen__control--close"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M14.7 5.3a1 1 0 010 1.4L11.4 10l3.3 3.3a1 1 0 11-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 11-1.4-1.4L8.6 10 5.3 6.7a1 1 0 011.4-1.4L10 8.6l3.3-3.3a1 1 0 011.4 0z"/></svg></button>
      </div>
    </div>
    <div class="fullscreen__stage">
      ${state.farnsworthDev?.available
        ? `<div class="fullscreen__stage-iframe fullscreen__stage-browser-view" data-canvas-view="fullscreen" data-canvas-url="${state.farnsworthDev.url}/?view=desktop" style="width:100%;height:100%;display:block;background:#000"></div>`
        : `<img src="src/assets/reddit/swordandsuppermobile.png" alt="Sword & Supper game" />`}
    </div>
  `;
  return f;
}

// Test View — split layout with phone-sized game canvas on the left and a
// test runner panel on the right. The game canvas is a WebContentsView
// pointing at the dev server (?view=mobile); the test runner lists all
// JSON tests in ~/Documents/farnsworth-tests/tests/, has per-test Run
// buttons, an output panel showing stdout/stderr from the last run, and a
// Reset Game button that reloads the WebContentsView to a fresh game
// instance. Tests target the WebContentsView's CDP target directly via
// python3 farnsworth-test.py.
function renderTestView() {
  const wrap = el('div', { class: 'testview' });

  // Left: phone-frame game canvas (390x844) hosting the live game.
  const game = el('div', { class: 'testview__game' });
  const phone = el('div', { class: 'phone testview__phone' });
  phone.innerHTML = `
    <div class="phone__statusbar">
      <div class="phone__statusbar-time">12:24</div>
      <div class="phone__statusbar-right">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 18a2 2 0 002-2H10a2 2 0 002 2zm6-6V9a6 6 0 10-12 0v3H4v8h16v-8h-2z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M2 18h2v-6H2v6zm4 0h2V8H6v10zm4 0h2v-4h-2v4zm4 0h2V4h-2v14zm4 0h2v-2h-2v2z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4zM13 21h-2v-1h2v1zm0-3h-2V6h2v12z"/></svg>
      </div>
    </div>
    <div class="phone__appbar">
      <div class="phone__appbar-close">
        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M14.7 5.3a1 1 0 010 1.4L11.4 10l3.3 3.3a1 1 0 11-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 11-1.4-1.4L8.6 10 5.3 6.7a1 1 0 011.4-1.4L10 8.6l3.3-3.3a1 1 0 011.4 0z"/></svg>
      </div>
      <div class="phone__appbar-title">${(state.liveConfig?.projectName && state.liveConfig.projectName.trim()) || ''}</div>
      <div class="phone__appbar-more">
        <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><circle cx="5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15" cy="10" r="1.4"/></svg>
      </div>
    </div>
    <div class="phone__screen">
      ${state.farnsworthDev?.available
        ? `<div class="phone__screen-iframe phone__screen-browser-view" data-canvas-view="mobile" data-canvas-url="${state.farnsworthDev.url}/?view=mobile" style="width:100%;height:100%;display:block;background:#000"></div>`
        : `<div class="testview__no-dev">Start \`npm run farnsworth\` in the project to load a game.</div>`}
    </div>
  `;
  game.appendChild(phone);
  wrap.appendChild(game);

  // Right: test runner panel.
  const panel = el('div', { class: 'testview__panel' });

  // Header with title + actions (+ New, Refresh, Reset Game).
  // + New opens the editor in 'new' mode; the standalone NLP test creator
  // modal that used to live in the canvas overlay bar (Jul 10 ~23:50 ET)
  // was removed when Long asked to combine test building features into
  // Test View (Jul 11 ~16:42 ET).
  const head = el('div', { class: 'testview__panel-head' });
  head.innerHTML = `
    <div class="testview__panel-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6L4 18a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L15 8V2M9 2h6M9 14h6"/></svg>
      Tests
    </div>
    <div class="testview__panel-actions">
      <button class="testview__btn testview__btn--accent" id="testview-new" title="Create a new test (or generate from description)">+ New</button>
      <button class="testview__btn testview__btn--ghost" id="testview-refresh" title="Re-list tests from ~/Documents/farnsworth-tests/tests/">Refresh</button>
      <button class="testview__btn testview__btn--primary" id="testview-reset-game" title="Reload the game WebContentsView to a fresh instance">Reset Game</button>
    </div>
  `;
  panel.appendChild(head);

  // Test list — populated by loadTestViewTests() (async). Each row has
  // Run / Edit / × buttons. Edit opens the editor in 'edit' mode; ×
  // confirms and calls test:delete.
  const list = el('div', { class: 'testview__list' });
  list.id = 'testview-list';
  list.innerHTML = '<div class="testview__list-empty">Loading tests…</div>';
  panel.appendChild(list);

  // Editor section — toggles open when + New or Edit is clicked. Hidden
  // by default. Holds: name input + description (optional, for NLP
  // generate) + JSON textarea + Save / Save & Run / Cancel buttons. Replaces
  // the standalone NLP test creator modal (deprecated Jul 11 ~16:42 ET).
  const editor = el('div', { class: 'testview__editor', id: 'testview-editor', hidden: true });
  editor.innerHTML = `
    <div class="testview__editor-head">
      <span class="testview__editor-title" id="testview-editor-title">Edit test</span>
      <button class="testview__editor-close" id="testview-editor-close" aria-label="Close editor" title="Close editor">×</button>
    </div>
    <div class="testview__editor-body">
      <label class="testview__editor-label">Test name</label>
      <input type="text" class="testview__editor-input" id="testview-editor-name" placeholder="my-test-name" spellcheck="false" />

      <details class="testview__editor-generate-section">
        <summary class="testview__editor-generate-toggle">Generate from description (optional, uses LLM)</summary>
        <textarea class="testview__editor-desc" id="testview-editor-desc" rows="2" placeholder="e.g. Click PLAY, dismiss welcome, screenshot lobby"></textarea>
        <button class="testview__btn testview__btn--ghost" id="testview-editor-generate">Generate</button>
      </details>

      <label class="testview__editor-label">JSON</label>
      <textarea class="testview__editor-json" id="testview-editor-json" rows="14" spellcheck="false" placeholder='{"name": "my-test", "steps": [{"action": "reload"}]}'></textarea>

      <div class="testview__editor-status" id="testview-editor-status"></div>

      <div class="testview__editor-actions">
        <button class="testview__btn testview__btn--primary" id="testview-editor-save">Save</button>
        <button class="testview__btn testview__btn--accent" id="testview-editor-save-run">Save & Run</button>
        <button class="testview__btn testview__btn--ghost" id="testview-editor-cancel">Cancel</button>
      </div>
    </div>
  `;
  panel.appendChild(editor);

  // Output panel — populated by runTestViewTest() (async).
  const output = el('div', { class: 'testview__output' });
  output.id = 'testview-output';
  output.innerHTML = '<div class="testview__output-empty">Select a test above and click Run. Output appears here.</div>';
  panel.appendChild(output);

  wrap.appendChild(panel);

  // Wire up the buttons + populate the test list. Defer to next frame so
  // the DOM is in place before handlers attach.
  requestAnimationFrame(() => {
    const refreshBtn = panel.querySelector('#testview-refresh');
    const resetBtn = panel.querySelector('#testview-reset-game');
    const newBtn = panel.querySelector('#testview-new');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      closeTestViewEditor(panel);
      loadTestViewTests(panel);
    });
    if (resetBtn) resetBtn.addEventListener('click', () => resetTestViewGame(wrap));
    if (newBtn) newBtn.addEventListener('click', () => openTestViewEditor(panel, 'new'));

    // Editor button handlers
    const editorCloseBtn = panel.querySelector('#testview-editor-close');
    const editorCancelBtn = panel.querySelector('#testview-editor-cancel');
    const editorSaveBtn = panel.querySelector('#testview-editor-save');
    const editorSaveRunBtn = panel.querySelector('#testview-editor-save-run');
    const editorGenerateBtn = panel.querySelector('#testview-editor-generate');
    if (editorCloseBtn) editorCloseBtn.addEventListener('click', () => closeTestViewEditor(panel));
    if (editorCancelBtn) editorCancelBtn.addEventListener('click', () => closeTestViewEditor(panel));
    if (editorSaveBtn) editorSaveBtn.addEventListener('click', () => saveTestViewEditor(panel));
    if (editorSaveRunBtn) editorSaveRunBtn.addEventListener('click', () => saveAndRunTestViewEditor(panel));
    if (editorGenerateBtn) editorGenerateBtn.addEventListener('click', () => generateTestViewEditor(panel));

    loadTestViewTests(panel);
  });

  return wrap;
}

// Populate the test list by calling window.farnsworth.testList() (test:list IPC).
// Re-renders the list rows on every call. Each row has Run / Edit / × buttons.
// Pass state.folder so the IPC resolves to <folder>/.farnsworth/devvit-tests/
// (per-project test location, Jul 11 ~18:38 ET).
async function loadTestViewTests(panel) {
  const list = panel.querySelector('#testview-list');
  if (!list) return;
  const result = await window.farnsworth?.testList?.({ folder: state.folder });
  if (!result || !result.ok) {
    // Surface a hint when there's no active folder — Test View needs
    // a project root to resolve the per-project tests dir
    // (<folder>/.farnsworth/devvit-tests/). Jul 11 ~18:38 ET.
    if (result.error === 'no_folder') {
      list.innerHTML = '<div class="testview__list-empty">Pick a folder first. Tests live at <code>&lt;project&gt;/.farnsworth/devvit-tests/</code>.</div>';
      return;
    }
    list.innerHTML = `<div class="testview__list-empty">Failed to list tests: ${result?.error || 'unknown'}</div>`;
    return;
  }
  if (!result.tests || result.tests.length === 0) {
    const dir = result.dir || `${state.folder || '<folder>'}/.farnsworth/devvit-tests/`;
    list.innerHTML = `<div class="testview__list-empty">No tests found in <code>${dir}</code>. Click + New to create one.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const t of result.tests) {
    const row = el('div', { class: 'testview__test-row', 'data-test-path': t.path });
    row.innerHTML = `
      <div class="testview__test-info">
        <div class="testview__test-name">${t.name}.json</div>
        <div class="testview__test-meta">${t.size} bytes · ${new Date(t.modified).toLocaleString()}</div>
      </div>
      <div class="testview__test-actions">
        <button class="testview__btn testview__btn--primary testview__test-run" data-test-path="${t.path}" title="Run this test">Run</button>
        <button class="testview__btn testview__btn--ghost testview__test-edit" data-test-name="${t.name}" title="Edit JSON in the inline editor">Edit</button>
        <button class="testview__btn testview__btn--danger testview__test-delete" data-test-name="${t.name}" title="Delete this test">×</button>
      </div>
    `;
    row.querySelector('.testview__test-run').addEventListener('click', () => runTestViewTest(panel, t));
    row.querySelector('.testview__test-edit').addEventListener('click', () => openTestViewEditor(panel, 'edit', t.name));
    row.querySelector('.testview__test-delete').addEventListener('click', () => deleteTestViewTest(panel, t.name));
    list.appendChild(row);
  }
}

// Open the inline editor in 'new' or 'edit' mode. In 'edit' mode, reads
// the JSON from disk via test:read and populates the fields. In 'new'
// mode, leaves them empty for the user to fill in.
async function openTestViewEditor(panel, mode, testName) {
  const editor = panel.querySelector('#testview-editor');
  if (!editor) return;
  const titleEl = editor.querySelector('#testview-editor-title');
  const nameEl = editor.querySelector('#testview-editor-name');
  const jsonEl = editor.querySelector('#testview-editor-json');
  const descEl = editor.querySelector('#testview-editor-desc');
  const statusEl = editor.querySelector('#testview-editor-status');

  editor.dataset.mode = mode;
  editor.dataset.originalName = testName || '';

  if (mode === 'edit') {
    titleEl.textContent = `Edit: ${testName}.json`;
    statusEl.textContent = 'Loading...';
    statusEl.className = 'testview__editor-status';
    editor.hidden = false;

    const res = await window.farnsworth?.testRead?.({ folder: state.folder, name: testName });
    if (!res?.ok) {
      statusEl.textContent = `Failed to read: ${res?.error || 'unknown'}`;
      statusEl.className = 'testview__editor-status is-error';
      return;
    }
    nameEl.value = res.name;
    jsonEl.value = res.json;
    descEl.value = '';
    statusEl.textContent = '';
    statusEl.className = 'testview__editor-status';
  } else {
    titleEl.textContent = 'New test';
    nameEl.value = '';
    jsonEl.value = '';
    descEl.value = '';
    statusEl.textContent = 'Type a description and click Generate, or write JSON directly.';
    statusEl.className = 'testview__editor-status is-hint';
    editor.hidden = false;
    setTimeout(() => nameEl.focus(), 50);
  }
}

function closeTestViewEditor(panel) {
  const editor = panel.querySelector('#testview-editor');
  if (editor) editor.hidden = true;
}

// Validate + save the editor's JSON via test:save. On success, refreshes
// the list and returns {name, path}. On failure, shows the error in the
// status line and returns null.
async function saveTestViewEditor(panel) {
  const editor = panel.querySelector('#testview-editor');
  const nameEl = editor.querySelector('#testview-editor-name');
  const jsonEl = editor.querySelector('#testview-editor-json');
  const statusEl = editor.querySelector('#testview-editor-status');

  const name = nameEl.value.trim();
  const json = jsonEl.value.trim();

  if (!name) {
    statusEl.textContent = 'Name required.';
    statusEl.className = 'testview__editor-status is-error';
    return null;
  }
  if (!json) {
    statusEl.textContent = 'JSON required.';
    statusEl.className = 'testview__editor-status is-error';
    return null;
  }
  try { JSON.parse(json); } catch (e) {
    statusEl.textContent = 'Invalid JSON: ' + e.message;
    statusEl.className = 'testview__editor-status is-error';
    return null;
  }

  statusEl.textContent = 'Saving...';
  statusEl.className = 'testview__editor-status';

  const res = await window.farnsworth?.testSave?.({ folder: state.folder, name, json });
  if (!res?.ok) {
    statusEl.textContent = 'Save failed: ' + (res?.error || 'unknown');
    statusEl.className = 'testview__editor-status is-error';
    return null;
  }

  statusEl.textContent = `Saved to ${res.path}`;
  statusEl.className = 'testview__editor-status is-success';

  await loadTestViewTests(panel);

  return { ok: true, name: res.name, path: res.path };
}

// Save + run in one flow. The 'Save & Run' button. After a successful
// save, runs the test and streams output into the output panel, then
// closes the editor.
async function saveAndRunTestViewEditor(panel) {
  const result = await saveTestViewEditor(panel);
  if (!result) return;
  await runTestViewTest(panel, { name: result.name, path: result.path });
  closeTestViewEditor(panel);
}

// Delete a test via test:delete IPC. Confirms first via browser confirm.
// If the deleted test was being edited, closes the editor too.
async function deleteTestViewTest(panel, testName) {
  if (!confirm(`Delete ${testName}.json? This cannot be undone.`)) return;
  const res = await window.farnsworth?.testDelete?.({ folder: state.folder, name: testName });
  if (!res?.ok) {
    alert(`Delete failed: ${res?.error || 'unknown'}`);
    return;
  }
  await loadTestViewTests(panel);
  const editor = panel.querySelector('#testview-editor');
  if (editor && !editor.hidden && editor.dataset.originalName === testName) {
    closeTestViewEditor(panel);
  }
}

// Generate JSON from a plain-English description via the NLP helper
// (TEST_CREATOR_SYSTEM_PROMPT + generateTestFromNLP). Reuses the LLM
// + keyword-fallback path from the now-deprecated standalone test
// creator modal — the description input + Generate button inside the
// inline editor preserve the ability to bootstrap new tests from
// English without needing to leave Test View.
async function generateTestViewEditor(panel) {
  const editor = panel.querySelector('#testview-editor');
  const descEl = editor.querySelector('#testview-editor-desc');
  const jsonEl = editor.querySelector('#testview-editor-json');
  const nameEl = editor.querySelector('#testview-editor-name');
  const statusEl = editor.querySelector('#testview-editor-status');

  const description = descEl.value.trim();
  if (!description) {
    statusEl.textContent = 'Type a description first.';
    statusEl.className = 'testview__editor-status is-error';
    return;
  }

  statusEl.textContent = 'Generating...';
  statusEl.className = 'testview__editor-status';

  const result = await generateTestFromNLP(description);
  if (!result.ok) {
    statusEl.textContent = 'Generation failed.';
    statusEl.className = 'testview__editor-status is-error';
    return;
  }

  jsonEl.value = JSON.stringify(result.json, null, 2);
  if (!nameEl.value.trim()) nameEl.value = result.json.name || deriveTestName(description);
  statusEl.textContent = result.source === 'llm' ? 'Generated via LLM (editable).' : 'Generated via keyword fallback (LLM unavailable).';
  statusEl.className = 'testview__editor-status is-success';
}

// Run a single test, stream output into the output panel.
async function runTestViewTest(panel, t) {
  const output = panel.querySelector('#testview-output');
  if (!output) return;
  output.innerHTML = `<div class="testview__output-header">▶ Running ${t.name}.json…</div><pre class="testview__output-pre"></pre>`;
  const pre = output.querySelector('.testview__output-pre');
  const result = await window.farnsworth?.testRun?.({ path: t.path });
  if (!result) {
    pre.textContent = 'Test runner IPC failed (no response from main).';
    return;
  }
  const status = result.ok ? 'PASS' : (result.failed > 0 ? `FAIL (${result.failed} failed)` : 'ERROR');
  pre.textContent = `Exit ${result.code ?? '?'} · ${status}\n\n--- stdout ---\n${result.stdout || '(empty)'}\n\n--- stderr ---\n${result.stderr || '(empty)'}`;
  output.querySelector('.testview__output-header').innerHTML = `▶ ${t.name}.json · ${status}`;
}

// Reset the game WebContentsView by re-calling canvasCreateView with the same
// viewId (main.js handler reloads the URL in place, which resets the game's
// React state to initial). Triggered by the Reset Game button.
function resetTestViewGame(wrap) {
  const placeholder = wrap.querySelector('[data-canvas-view="mobile"]');
  if (!placeholder || !placeholder.dataset.canvasViewId) {
    // View not yet created (farnsworth dev not available, or createView in flight).
    return;
  }
  const viewId = placeholder.dataset.canvasViewId;
  const url = placeholder.dataset.canvasUrl;
  const rect = placeholder.getBoundingClientRect();
  // call canvasCreateView with same viewId — main.js will reload the URL in place.
  window.farnsworth?.canvasCreateView?.(viewId, url, {
    x: rect.left, y: rect.top, width: rect.width, height: rect.height,
  });
  // Visual feedback in the output panel.
  const panel = wrap.querySelector('.testview__panel');
  const output = panel?.querySelector('#testview-output');
  if (output) {
    output.innerHTML = `<div class="testview__output-header">⟳ Game reset</div><div class="testview__output-empty">Game WebContentsView reloaded. Previous test state cleared.</div>`;
  }
}

function renderStorybook() {
  const sb = el('div', { class: 'storybook' });

  // Head
  const head = el('div', { class: 'storybook__head' });
  const titleGroup = el('div', { class: 'storybook__title-group' });
  const titleIcon = el('div', { class: 'storybook__title-icon' });
  titleIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  titleGroup.appendChild(titleIcon);
  titleGroup.appendChild(el('div', {}, el('div', { class: 'storybook__title' }, 'Storybook'), el('div', { class: 'storybook__sub' }, '7 pages · page-by-page access')));
  head.appendChild(titleGroup);
  const search = el('div', { class: 'storybook__search' });
  search.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>Find a page…';
  head.appendChild(search);
  sb.appendChild(head);

  // Screens section
  const screensLabel = el('div', { class: 'storybook__section-label' }, 'SCREENS', el('span', { class: 'storybook__section-count' }, '4'));
  sb.appendChild(screensLabel);
  const screensGrid = el('div', { class: 'storybook__grid' });
  state.files.filter(f => f.folder === 'screens').forEach(f => {
    screensGrid.appendChild(makeStorybookCard(f));
  });
  sb.appendChild(screensGrid);

  // Components section
  const compsLabel = el('div', { class: 'storybook__section-label' }, 'COMPONENTS', el('span', { class: 'storybook__section-count' }, '3'));
  sb.appendChild(compsLabel);
  const compsGrid = el('div', { class: 'storybook__grid' });
  state.files.filter(f => f.component).forEach(f => {
    compsGrid.appendChild(makeStorybookCard(f));
  });
  sb.appendChild(compsGrid);

  return sb;
}

function makeStorybookCard(f) {
  const card = el('div', { class: 'storybook__card' + (f.current ? ' is-current' : '') });
  card.innerHTML = `
    <div class="storybook__thumb"><div class="storybook__thumb-inner">
      <div class="storybook__thumb-bar"></div>
      <div class="storybook__thumb-hero"><div class="storybook__thumb-hero-c"></div><span class="storybook__thumb-hero-vs">VS</span><div class="storybook__thumb-hero-c"></div></div>
      <div class="storybook__thumb-foot"></div>
    </div></div>
    <div class="storybook__card-foot">
      <div><div class="storybook__card-name">${f.path.split('/').pop().replace(/\.(html|jsx)$/, '')}</div><div class="storybook__card-file">${f.path}</div></div>
      ${f.current ? '<span class="storybook__card-badge storybook__card-badge--current">CURRENT</span>' : '<span class="storybook__card-badge">' + (Math.floor(Math.random() * 5) + 1) + '</span>'}
    </div>
  `;
  return card;
}

function renderCodeView() {
  const view = el('div', { class: 'code-view' });

  // Find bar at the top (Jul 6 ~21:40 ET per Long). Live filter that
  // shows match count + prev/next nav. Hidden by default; toggle with
  // Cmd+F or by clicking the search icon. When active, it stays at the
  // top of the code view even when Monaco re-renders.
  const findbar = el('div', { class: 'code-view__findbar' + (state.codeFindOpen ? ' is-open' : '') });
  if (state.codeFindOpen) {
    const fbInput = el('input', {
      class: 'code-view__findbar-input',
      type: 'text',
      placeholder: 'Find in file…',
      value: state.codeFindTerm || '',
    });
    const fbCount = el('span', { class: 'code-view__findbar-count', id: 'findbar-count' });
    const fbPrev = el('button', { class: 'code-view__findbar-btn', title: 'Previous match (Shift+Enter)' });
    fbPrev.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
    const fbNext = el('button', { class: 'code-view__findbar-btn', title: 'Next match (Enter)' });
    fbNext.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    const fbClose = el('button', { class: 'code-view__findbar-btn', title: 'Close (Escape)' });
    fbClose.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    findbar.appendChild(fbInput);
    findbar.appendChild(fbCount);
    findbar.appendChild(fbPrev);
    findbar.appendChild(fbNext);
    findbar.appendChild(fbClose);

    // State for the active match index (per-findbar-session)
    const find = {
      matches: [],
      cursor: 0,
      lastTerm: '',
    };
    const recompute = () => {
      const model = monacoEditor && monacoEditor.getModel();
      if (!model || !state.codeFindTerm) {
        fbCount.textContent = '';
        find.matches = [];
        return;
      }
      const matches = model.findMatches(state.codeFindTerm, true, false, false, null, true);
      find.matches = matches;
      find.cursor = 0;
      fbCount.textContent = matches.length ? `1 of ${matches.length}` : 'No results';
      if (matches.length) {
        const m = matches[0];
        monacoEditor.setSelection(m.range);
        monacoEditor.revealRangeInCenter(m.range);
      }
    };
    const gotoCursor = (delta) => {
      if (!find.matches.length) return;
      find.cursor = (find.cursor + delta + find.matches.length) % find.matches.length;
      const m = find.matches[find.cursor];
      monacoEditor.setSelection(m.range);
      monacoEditor.revealRangeInCenter(m.range);
      fbCount.textContent = `${find.cursor + 1} of ${find.matches.length}`;
    };

    fbInput.addEventListener('input', (e) => {
      state.codeFindTerm = e.target.value;
      recompute();
    });
    fbInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        gotoCursor(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.codeFindOpen = false;
        renderCanvas();
      }
    });
    fbPrev.addEventListener('click', () => gotoCursor(-1));
    fbNext.addEventListener('click', () => gotoCursor(1));
    fbClose.addEventListener('click', () => {
      state.codeFindOpen = false;
      renderCanvas();
    });

    // After the DOM is mounted, focus the input and recompute matches.
    setTimeout(() => {
      fbInput.focus();
      // Place caret at end so user can extend their existing search
      fbInput.setSelectionRange(state.codeFindTerm.length, state.codeFindTerm.length);
      recompute();
    }, 0);
  } else {
    // Compact bar — just a search icon button to open the find bar
    const openBtn = el('button', { class: 'code-view__findbar-toggle', title: 'Find in file (Cmd+F)' });
    openBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>';
    openBtn.addEventListener('click', () => {
      // Seed with the current selection if there is one
      const sel = monacoEditor && monacoEditor.getSelection();
      if (sel && !sel.isEmpty()) {
        const model = monacoEditor.getModel();
        state.codeFindTerm = model.getValueInRange(sel);
      }
      state.codeFindOpen = true;
      renderCanvas();
    });
    findbar.appendChild(openBtn);
  }
  view.appendChild(findbar);

  // Layout (Jun 26 ~10:30 ET per Long's call — tabs + breadcrumbs moved
  // from top to bottom of the canvas pane so they don't crowd the file
  // info header in the toolbar above). Order in DOM is body → breadcrumbs
  // → tabs; CSS uses border-top now that these elements sit at the
  // bottom of the column.

  // Code body first — Monaco fills the top of the column.
  // Keep Monaco attached to the SAME element across renders. Monaco's
  // editor instance holds a reference to the container we passed it; if
  // we create a fresh div on every render and try to attach Monaco to it,
  // Monaco stays bound to the previous (now-detached) container. Using
  // monacoEditor.getContainerDomNode() returns Monaco's actual container
  // so we can re-parent it into the new code-view body without touching
  // the editor instance. On the first render (no editor yet), create a
  // fresh container and let initMonacoEditor() claim it later.
  const activeFile = openFiles[activeFileIdx] || null;
  const externalChange = activeFile && externalChanges.has(activeFile.path.startsWith(state.folder + '/') ? activeFile.path.slice(state.folder.length + 1) : activeFile.path);
  if (externalChange) {
    const relPath = activeFile.path.startsWith(state.folder + '/') ? activeFile.path.slice(state.folder.length + 1) : activeFile.path;
    const banner = el('div', { class: 'code-view__extbanner' });
    banner.innerHTML = `
      <div class="code-view__extbanner-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
      </div>
      <div class="code-view__extbanner-text">
        <strong>File modified on disk</strong>
        <span class="code-view__extbanner-path">${escapeHtml(relPath)}</span>
      </div>
      <div class="code-view__extbanner-actions">
        <button class="code-view__extbanner-btn code-view__extbanner-btn--diff" id="extbanner-diff">Show diff</button>
        <button class="code-view__extbanner-btn code-view__extbanner-btn--reload" id="extbanner-reload">Reload from disk</button>
        <button class="code-view__extbanner-btn code-view__extbanner-btn--discard" id="extbanner-discard">Keep my changes</button>
      </div>
    `;
    view.appendChild(banner);
    // Wire buttons after the element is appended to the DOM
    setTimeout(() => {
      const diffBtn = document.getElementById('extbanner-diff');
      const reloadBtn = document.getElementById('extbanner-reload');
      const discardBtn = document.getElementById('extbanner-discard');
      if (diffBtn) diffBtn.onclick = () => showExternalDiff(relPath);
      if (reloadBtn) reloadBtn.onclick = () => reloadFileFromDisk(relPath);
      if (discardBtn) discardBtn.onclick = () => discardExternalChange(relPath);
    }, 0);
  }

  const body = el('div', { class: 'code-view__body' });
  let monacoEl;
  if (monacoEditor && monacoEditor.getContainerDomNode()) {
    monacoEl = monacoEditor.getContainerDomNode();
  } else {
    monacoEl = document.getElementById('monaco-container');
    if (!monacoEl) {
      monacoEl = el('div', { class: 'code-view__monaco', id: 'monaco-container' });
    }
  }
  body.appendChild(monacoEl);
  view.appendChild(body);

  // Breadcrumbs — derive from the active file's parent dir. The hardcoded
  // 'screens' was wrong for any file outside the screens/ subfolder.
  const filePath = activeFile ? activeFile.path : (state.files.current || '');
  const dirPath = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';
  const displayDir = dirPath || (state.folder ? state.folder.split('/').slice(-2).join('/') : '');
  const bc = el('div', { class: 'code-view__breadcrumbs' });
  bc.innerHTML = escapeHtml(displayDir) + ' <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg> <span style="color:#9aa0a8">' + escapeHtml(state.codeFile || (activeFile ? activeFile.name : '')) + '</span>';
  view.appendChild(bc);

  // Tabs — render from openFiles[] so every open file has a pill (matches
  // updateTabUI()'s data). The previous version hardcoded a single tab named
  // after state.codeFile, which lost the open-files history every re-render.
  const tabs = el('div', { class: 'code-view__tabs' });
  openFiles.forEach((f, i) => {
    const tab = el('div', { class: 'code-view__tab' + (i === activeFileIdx ? ' is-active' : '') });
    tab.dataset.fileIdx = i;
    tab.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f0883e" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span>' + escapeHtml(f.name) + '</span><span class="code-view__tab--dot' + (f.dirty ? ' is-dirty' : '') + '"></span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    tab.addEventListener('click', () => { activeFileIdx = i; focusActiveFile(); });
    tabs.appendChild(tab);
  });
  tabs.appendChild(el('div', { style: 'flex:1' }));
  const actions = el('div', { class: 'code-view__tab-actions' });
  actions.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h16M4 18h7"/></svg><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  tabs.appendChild(actions);
  view.appendChild(tabs);

  return view;
}

// ============================================================================
// RIGHT PANEL
// ============================================================================
function renderRightPanel() {
  $$('.righttab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === state.rightTab));
  const content = $('#rightpanel-content');
  content.innerHTML = '';

  if (state.rightTab === 'files') content.appendChild(renderFiles());
  else if (state.rightTab === 'tasks') content.appendChild(renderTasks());
  else if (state.rightTab === 'live') content.appendChild(renderLive());
}

function renderFiles() {
  const wrap = el('div');
  const folderName = state.folder ? state.folder.split('/').pop() : 'No folder open';
  wrap.innerHTML = `
    <div class="files__head">
      <div class="files__head-row">
        <div>
          <div class="files__head-label">PROJECT FILES</div>
          <div class="files__head-name">${folderName}</div>
          ${state.folder ? `<div class="files__head-path">${state.folder}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="files__add-btn" title="Refresh" id="files-refresh-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
          <button class="files__add-btn" title="Change folder" id="files-change-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
        </div>
      </div>
      <div class="files__filter">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="files-filter-input" class="files__filter-input" type="text" placeholder="Filter files…" value="${escapeHtml(state.files.filter || '')}" />
      </div>
    </div>
    <div class="files__tree" id="files-tree-body"></div>
  `;

  const tree = wrap.querySelector('#files-tree-body');

  if (!state.folder) {
    tree.innerHTML = '<div class="files__empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#3a3c42" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><div class="files__empty-text">No folder open</div><button class="files__empty-btn" id="files-open-btn">Open Folder…</button></div>';
    const btn = tree.querySelector('#files-open-btn');
    if (btn) btn.addEventListener('click', openFolderPicker);
    return wrap;
  }

  if (state.files.loading) {
    tree.innerHTML = '<div class="files__loading"><div class="files__loading-pulse"></div>Loading files…</div>';
    return wrap;
  }

  if (!state.files.entries.length) {
    tree.innerHTML = '<div class="files__empty"><div class="files__empty-text">Empty folder</div></div>';
    return wrap;
  }

  // Render tree from disk entries (preserving directory grouping).
  // When the filter is active, we render a flat list of matching files
  // (no folder grouping — the filter is for finding one file quickly).
  const filterTerm = (state.files.filter || '').toLowerCase().trim();
  const entries = filterTerm
    ? state.files.entries.filter(e => e.name.toLowerCase().includes(filterTerm) || e.path.toLowerCase().includes(filterTerm))
    : state.files.entries;
  const topLevel = entries.filter(e => !e.path.includes('/'));
  const collapsed = state.files.collapsed || new Set();
  topLevel.forEach(entry => {
    if (entry.type === 'dir') {
      const children = state.files.entries.filter(e => e.path.startsWith(entry.path + '/') && e.path.split('/').length === entry.path.split('/').length + 1);
      const isCollapsed = collapsed.has(entry.path);
      const folderEl = el('div', { class: 'files__folder' + (isCollapsed ? ' is-collapsed' : '') + ((state.files.selected === entry.path) ? ' is-selected' : '') });
      folderEl.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="#8b9099"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span class="files__folder-name">${entry.name}</span>
        <span class="files__folder-count">${children.length}</span>
      `;
      folderEl.dataset.relPath = entry.path;
      folderEl.dataset.role = 'folder';
      // Header is the click target — chevron + icon + name + count.
      folderEl.addEventListener('click', () => {
        state.files.selected = entry.path;
        if (collapsed.has(entry.path)) collapsed.delete(entry.path);
        else collapsed.add(entry.path);
        renderRightPanel();
      });
      folderEl.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        state.files.selected = entry.path;
        showFileContextMenu(entry, true, ev.clientX, ev.clientY);
      });
      tree.appendChild(folderEl);
      // Children always rendered; CSS hides them when parent is collapsed.
      const childrenWrap = el('div', { class: 'files__children' });
      children.forEach(child => {
        if (child.type === 'dir') {
          const subChildren = state.files.entries.filter(e => e.path.startsWith(child.path + '/') && e.path.split('/').length === child.path.split('/').length + 1);
          const subCollapsed = collapsed.has(child.path);
          const sub = el('div', { class: 'files__folder files__folder--nested' + (subCollapsed ? ' is-collapsed' : '') + ((state.files.selected === child.path) ? ' is-selected' : '') });
          sub.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#8b9099"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span class="files__folder-name">${child.name}</span>
            <span class="files__folder-count">${subChildren.length}</span>
          `;
          sub.dataset.relPath = child.path;
          sub.dataset.role = 'folder';
          sub.addEventListener('click', () => {
            state.files.selected = child.path;
            if (collapsed.has(child.path)) collapsed.delete(child.path);
            else collapsed.add(child.path);
            renderRightPanel();
          });
          sub.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            state.files.selected = child.path;
            showFileContextMenu(child, true, ev.clientX, ev.clientY);
          });
          childrenWrap.appendChild(sub);
          const subFilesWrap = el('div', { class: 'files__children' });
          subChildren.forEach(c => c.type === 'file' && subFilesWrap.appendChild(makeFileEl(c)));
          childrenWrap.appendChild(subFilesWrap);
        } else {
          childrenWrap.appendChild(makeFileEl(child));
        }
      });
      tree.appendChild(childrenWrap);
    } else {
      tree.appendChild(makeFileEl(entry));
    }
  });

  // Wire refresh + change folder buttons
  const refreshBtn = wrap.querySelector('#files-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadFolderFiles(state.folder));
  const changeBtn = wrap.querySelector('#files-change-btn');
  if (changeBtn) changeBtn.addEventListener('click', openFolderPicker);

  // Wire filter input — updates state.files.filter on every keystroke and
  // re-renders. The filter narrows the tree to matching names/paths.
  const filterInput = wrap.querySelector('#files-filter-input');
  if (filterInput) {
    filterInput.addEventListener('input', (e) => {
      state.files.filter = e.target.value;
      // Re-render only the tree (cheap), not the whole panel
      const newWrap = renderFiles();
      const oldTree = wrap.querySelector('#files-tree-body');
      const newTree = newWrap.querySelector('#files-tree-body');
      if (oldTree && newTree) oldTree.replaceWith(newTree);
      // Re-focus the input so typing doesn't break the cursor
      const fresh = wrap.querySelector('#files-filter-input');
      if (fresh) {
        fresh.focus();
        // Move caret to end
        const v = fresh.value;
        fresh.setSelectionRange(v.length, v.length);
      }
    });
    // Keep focus after every render so the user can keep typing
    filterInput.addEventListener('focus', () => { state.files.filterFocused = true; });
  }

  return wrap;
}

function makeFileEl(f) {
  const fileEl = el('div', {
    class: 'files__file' + (f.current ? ' is-current' : '') + (isFileDirty(f) ? ' is-dirty' : '') + ((state.files.selected === f.path) ? ' is-selected' : ''),
    onClick: () => {
      // Clear is-selected on siblings without full re-render
      const tree = fileEl.parentElement;
      if (tree) {
        tree.querySelectorAll('.files__file.is-selected, .files__folder.is-selected').forEach(r => r.classList.remove('is-selected'));
      }
      fileEl.classList.add('is-selected');
      state.files.selected = f.path;
      openFile(f);
    },
  });
  fileEl.dataset.relPath = f.path;
  const icon = document.createElement('span');
  icon.className = 'files__file-icon-wrap';
  icon.innerHTML = fileIcon(f.ext);
  fileEl.appendChild(icon);
  const nameSpan = el('span', { class: 'files__file-name' }, f.name);
  nameSpan.dataset.role = 'name';
  fileEl.appendChild(nameSpan);
  if (f.current) fileEl.appendChild(el('span', { class: 'files__file-status' }));
  // Right-click → context menu with Rename / Delete / Reveal in Finder / Copy Path.
  fileEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    // Mirror the click selection behavior so the row gets the class
    const tree = fileEl.parentElement;
    if (tree) {
      tree.querySelectorAll('.files__file.is-selected, .files__folder.is-selected').forEach(r => r.classList.remove('is-selected'));
    }
    fileEl.classList.add('is-selected');
    state.files.selected = f.path;
    showFileContextMenu(f, false, ev.clientX, ev.clientY);
  });
  return fileEl;
}

// Check if a Files-tree entry has an open + dirty buffer.
// `f.path` is the relative path within state.folder; openFiles[] stores
// absolute paths so we reconstruct via path.join.
function isFileDirty(f) {
  if (!state.folder || !openFiles?.length) return false;
  const abs = state.ffolder ? state.folder + '/' + f.path : f.path;
  const open = openFiles.find(o => o.path === abs);
  return !!(open && open.dirty);
}

// Refresh dirty dots across the Files tree without re-rendering the
// whole panel (avoids filter input focus loss). Called from the
// Monaco onDidChangeModelContent callback.
function updateFilesDirtyDots() {
  const rows = document.querySelectorAll('.files__file[data-rel-path]');
  rows.forEach(row => {
    const rel = row.dataset.relPath;
    const entry = state.files.entries.find(e => e.path === rel);
    if (!entry) return;
    const dirty = isFileDirty(entry);
    row.classList.toggle('is-dirty', dirty);
  });
}

// ============================================================================
// FILES PANEL — rename + delete + context menu
// ============================================================================

// Show a context menu anchored to (clientX, clientY) for a file or folder
// entry. Menu items: Rename, Delete, Reveal in Finder, Copy Path.
// `entry` is {name, path, type, ext?}; `isDir` distinguishes folder vs file.
function showFileContextMenu(entry, isDir, clientX, clientY) {
  // Dismiss any existing menu
  const existing = document.querySelector('.files__ctxmenu');
  if (existing) existing.remove();
  const menu = el('div', { class: 'files__ctxmenu' });
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  const items = [
    { label: 'Rename', kbd: 'F2', action: () => startInlineRenameForEntry(entry) },
    { label: 'Delete…', kbd: '⌫', action: () => deleteEntry(entry, isDir) },
    { sep: true },
    { label: 'Reveal in Finder', kbd: '', action: () => revealEntryInFinder(entry) },
    { label: 'Copy Path', kbd: '', action: () => copyEntryPath(entry) },
  ];
  items.forEach(item => {
    if (item.sep) {
      menu.appendChild(el('div', { class: 'files__ctxmenu-sep' }));
    } else {
      const btn = el('button', { class: 'files__ctxmenu-item', onClick: () => { menu.remove(); item.action(); } });
      btn.appendChild(el('span', { class: 'files__ctxmenu-label' }, item.label));
      if (item.kbd) btn.appendChild(el('span', { class: 'files__ctxmenu-kbd' }, item.kbd));
      menu.appendChild(btn);
    }
  });
  document.body.appendChild(menu);
  // Adjust if menu would overflow viewport
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 4) + 'px';
  // Click outside dismisses
  setTimeout(() => {
    const onClick = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', onClick); }
    };
    document.addEventListener('click', onClick);
  }, 0);
}

// Find the DOM row for a relPath and start an inline rename. Used by both
// F2 keybinding and the context-menu action.
function startInlineRenameForEntry(entry) {
  if (!state.folder || !entry || !entry.path) return;
  // Selector: file rows by data-rel-path, folders by data-rel-path+role=folder
  const sel = `.files__file[data-rel-path="${entry.path}"], .files__folder[data-rel-path="${entry.path}"]`;
  const row = document.querySelector(sel);
  if (!row) return;
  // Find the name span — either .files__file-name or .files__folder-name
  const nameSpan = row.querySelector('.files__file-name') || row.querySelector('.files__folder-name');
  if (!nameSpan) return;
  const original = nameSpan.textContent;
  const isDir = entry.type === 'dir' || row.dataset.role === 'folder';
  // Replace the span with an input
  const input = el('input', {
    class: 'files__rename-input',
    type: 'text',
    value: original,
    spellcheck: 'false',
  });
  input.style.width = Math.max(80, nameSpan.offsetWidth + 20) + 'px';
  nameSpan.replaceWith(input);
  input.focus();
  // Select basename (everything before the dot for files, no extension for dirs)
  if (isDir) {
    input.setSelectionRange(0, original.length);
  } else {
    const dot = original.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : original.length);
  }
  const finish = async (commit) => {
    input.removeEventListener('keydown', onKey);
    const next = input.value.trim();
    // Restore the name span
    const restored = el(isDir ? 'span' : 'span', { class: isDir ? 'files__folder-name' : 'files__file-name' }, original);
    input.replaceWith(restored);
    if (!commit) return;
    if (!next || next === original) return;
    // Compute the new relPath (replace last segment of entry.path)
    const sep = entry.path.includes('/') ? '/' : '';
    const parts = entry.path.split('/');
    parts[parts.length - 1] = next;
    const newRel = parts.join('/');
    const res = await window.farnsworth.rename(state.folder, entry.path, newRel);
    if (!res.ok) {
      alert('Rename failed: ' + (res.error || 'unknown'));
      return;
    }
    // If the renamed file is open, update its path
    const absOld = state.folder + '/' + entry.path;
    const absNew = state.folder + '/' + newRel;
    const open = openFiles.find(o => o.path === absOld);
    if (open) {
      open.path = absNew;
      open.name = next;
      renderTabs();
    }
    await loadFolderFiles(state.folder, true);
  };
  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  };
  input.addEventListener('keydown', onKey);
  // Click outside cancels (does NOT commit — Enter is the explicit
  // commit gesture; Monaco's focus-steal after openFile() would
  // otherwise trigger an unintentional blur).
  setTimeout(() => {
    const onDocClick = (ev) => {
      if (input.contains(ev.target)) return;
      document.removeEventListener('click', onDocClick);
      finish(false);
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

async function deleteEntry(entry, isDir) {
  if (!state.folder || !entry || !entry.path) return;
  const label = isDir ? `folder "${entry.name}"` : `file "${entry.name}"`;
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  const res = await window.farnsworth.delete(state.folder, entry.path);
  if (!res.ok) {
    alert('Delete failed: ' + (res.error || 'unknown'));
    return;
  }
  // Close the file in the editor if it was open + dirty
  const abs = state.folder + '/' + entry.path;
  const idx = openFiles.findIndex(o => o.path === abs);
  if (idx >= 0) actuallyCloseFile(idx);
  state.files.selected = null;
  await loadFolderFiles(state.folder, true);
}

async function revealEntryInFinder(entry) {
  if (!state.folder || !entry || !entry.path) return;
  await window.farnsworth.showInFinder(state.folder, entry.path);
}

async function copyEntryPath(entry) {
  if (!state.folder || !entry || !entry.path) return;
  const abs = state.folder + '/' + entry.path;
  try {
    await navigator.clipboard.writeText(abs);
  } catch {
    // Fallback: temporary textarea
    const ta = document.createElement('textarea');
    ta.value = abs;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

// F2 — rename the selected file/folder. Selection persists in
// state.files.selected, so this works regardless of whether the
// Files tab is currently visible. If the user is in the code
// editor and there's a selected file from a recent Files click,
// F2 still renames that file.
function renameSelectedFile() {
  const rel = state.files.selected;
  if (!rel) return;
  const entry = state.files.entries.find(e => e.path === rel);
  if (!entry) return;
  startInlineRenameForEntry(entry);
}

// Delete the selected file/folder.
function deleteSelectedFile() {
  const rel = state.files.selected;
  if (!rel) return;
  const entry = state.files.entries.find(e => e.path === rel);
  if (!entry) return;
  deleteEntry(entry, entry.type === 'dir');
}

function renderTasks() {
  // Always DB-backed. Fire a load on every mount — SQLite is local
  // and fast, and the in-flight guard inside loadTasksFromDb()
  // prevents the double-load cost when the user clicks the tab
  // rapidly. The tasksLoadedForWs stamp inside the helper detects
  // workspace changes so we reload when the scope shifts.
  loadTasksFromDb();

  const wrap = el('div');
  const filter = state.tasksFilter || 'all';
  const filtered = filter === 'all'
    ? state.tasks
    : state.tasks.filter(t => (t.status || 'todo') === filter);

  wrap.innerHTML = `
    <div class="tasks__head">
      <div class="tasks__head-row">
        <div>
          <div class="files__head-label">TASKS</div>
          <div class="files__head-name">${state.tasks.length} tasks · ${state.tasks.filter(t => t.status === 'done').length} done${state.folder ? ' · this workspace' : ' · global'}</div>
        </div>
        <button class="tasks__new-btn" data-tasks-new><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>New</button>
      </div>
      <div class="tasks__filters">
        <span class="tasks__filter${filter === 'all' ? ' is-active' : ''}" data-tasks-filter="all">All</span>
        <span class="tasks__filter${filter === 'todo' ? ' is-active' : ''}" data-tasks-filter="todo">Todo</span>
        <span class="tasks__filter${filter === 'in-progress' ? ' is-active' : ''}" data-tasks-filter="in-progress">Doing</span>
        <span class="tasks__filter${filter === 'done' ? ' is-active' : ''}" data-tasks-filter="done">Done</span>
      </div>
    </div>
    ${state.tasksComposing ? `
      <form class="tasks__compose" data-tasks-compose>
        <input type="text" class="tasks__compose-input" placeholder="What needs to be done?" data-tasks-compose-title autofocus />
        <textarea class="tasks__compose-detail" placeholder="Optional details (context, acceptance criteria…)" data-tasks-compose-detail rows="2"></textarea>
        <div class="tasks__compose-row">
          <select class="tasks__compose-priority" data-tasks-compose-priority>
            <option value="low">Low priority</option>
            <option value="med" selected>Medium priority</option>
            <option value="high">High priority</option>
          </select>
          <div class="tasks__compose-actions">
            <button type="button" class="tasks__compose-cancel" data-tasks-compose-cancel>Cancel</button>
            <button type="submit" class="tasks__compose-submit" data-tasks-compose-submit>＋ Add task</button>
          </div>
        </div>
      </form>
    ` : ''}
    <div class="tasks__list"></div>
  `;

  // Wire header buttons
  wrap.querySelector('[data-tasks-new]')?.addEventListener('click', () => {
    state.tasksComposing = !state.tasksComposing;
    renderRightPanel();
  });
  wrap.querySelectorAll('[data-tasks-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tasksFilter = btn.dataset.tasksFilter;
      renderRightPanel();
    });
  });

  // Wire compose form
  const compose = wrap.querySelector('[data-tasks-compose]');
  if (compose) {
    const cancel = () => { state.tasksComposing = false; renderRightPanel(); };
    compose.querySelector('[data-tasks-compose-cancel]').addEventListener('click', cancel);
    compose.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = compose.querySelector('[data-tasks-compose-title]').value.trim();
      if (!title) return;
      const detail = compose.querySelector('[data-tasks-compose-detail]').value.trim();
      const priority = compose.querySelector('[data-tasks-compose-priority]').value;
      persistNewTask({ title, detail, priority });
      state.tasksComposing = false;
      renderRightPanel();
    });
  }

  // Render task sections
  const list = wrap.querySelector('.tasks__list');
  const sections = [
    { label: 'IN PROGRESS', color: 'yellow', status: 'in-progress' },
    { label: 'TODO', color: 'muted', status: 'todo' },
    { label: 'DONE', color: 'green', status: 'done' },
  ];
  sections.forEach(s => {
    const matching = filtered.filter(t => (t.status || 'todo') === s.status);
    if (!matching.length) return;
    list.appendChild(el('div', { class: 'tasks__section' },
      el('span', { class: 'tasks__section-label', style: 'color:' + (s.color === 'green' ? '#3ba55c' : s.color === 'yellow' ? '#f0b232' : '#80848e') }, s.label),
      el('span', { class: 'tasks__section-count' }, String(matching.length))
    ));
    matching.forEach(t => list.appendChild(makeTask(t)));
  });

  if (!filtered.length) {
    list.appendChild(el('div', { class: 'tasks__empty' },
      filter === 'all'
        ? 'No tasks yet — click + New to add one.'
        : `No ${filter} tasks.`
    ));
  }

  return wrap;
}

// Load tasks from SQLite. DB rows replace the seed/mocked entries
// when there's anything in the DB; if the DB is empty we keep the
// seed tasks visible so the panel isn't blank.
async function loadTasksFromDb() {
  // Always read from DB. The Tasks panel is fully DB-backed — no seed
  // data. Three guards:
  //   1. In-flight guard — prevent concurrent loads when the user
  //      clicks the tab rapidly.
  //   2. Same-workspace short-circuit — if we just loaded for this
  //      workspace and nothing changed, skip the round trip.
  //   3. Mid-flight workspace check — if the workspace changed while
  //      we were awaiting, drop the stale result so a fresh load wins.
  if (state.tasksLoading) return;
  if (!window.farnsworth || !window.farnsworth.tasksList) return;
  const ws = state.folder || null;
  if (state.tasksLoadedForWs === ws && state.tasks.length > 0) return;
  state.tasksLoading = true;
  state.tasksLoadedForWs = ws;
  try {
    const rows = await window.farnsworth.tasksList(ws);
    if (!Array.isArray(rows)) return;
    if (state.tasksLoadedForWs !== ws) return;
    state.tasks = rows.map(r => ({
      id: r.id,
      dbId: r.id,
      title: r.title,
      status: r.status || 'todo',
      priority: priorityIntToString(r.priority),
      detail: r.detail || '',
      source: r.source || null,
      assignee: r.assignee || 'blue',
      file: r.file_link || null,
      live: r.source && r.source.startsWith('live-') ? true : undefined,
    }));
    renderRightPanel();
  } finally {
    state.tasksLoading = false;
  }
}

function priorityIntToString(p) {
  if (p == null) return null;
  if (typeof p === 'string') return p;
  // DB stores as 0/1/2 — map back to label
  if (p >= 2) return 'high';
  if (p >= 1) return 'med';
  return 'low';
}

function priorityStringToInt(p) {
  if (p === 'high') return 2;
  if (p === 'med') return 1;
  if (p === 'low') return 0;
  return 0;
}

// Persist a brand-new task. Creates in DB first, then inserts the row
// into state.tasks with the returned dbId. Always resets the
// tasksLoadedForWs stamp so the next loadTasksFromDb() re-fetches from
// DB (in case the write path diverged from the load path).
async function persistNewTask({ title, detail, priority, source, assignee, fileLink }) {
  // Always show the task optimistically in the UI while we wait for DB.
  const optimisticId = 'pending-' + Date.now();
  const optimisticTask = { id: optimisticId, dbId: null, title, status: 'todo', priority, detail: detail || '', source: source || null, assignee: assignee || 'blue', file: fileLink || null };
  state.tasks.unshift(optimisticTask);
  renderRightPanel();

  if (!window.farnsworth || !window.farnsworth.tasksAdd) {
    // No IPC available — fall back to local-only id.
    optimisticTask.id = 'local-' + Date.now();
    renderRightPanel();
    return;
  }
  const ws = state.folder || '';
  try {
    const res = await window.farnsworth.tasksAdd(ws, 'todo', title, detail || '', priorityStringToInt(priority), source || null, assignee || 'blue', fileLink || null);
    if (!res || !res.ok) {
      // DB write failed — leave the optimistic row visible (local-only).
      optimisticTask.id = 'local-' + Date.now();
      renderRightPanel();
      return;
    }
    // DB write succeeded — replace the optimistic row with the canonical DB row.
    const dbTask = (res.task && normalizeDbTask(res.task)) || { id: res.id, dbId: res.id, title, status: 'todo', priority, detail, source, assignee, file: fileLink };
    const idx = state.tasks.findIndex(t => t === optimisticTask);
    if (idx >= 0) state.tasks[idx] = dbTask;
    else state.tasks.unshift(dbTask);
    // Reset stamp so next load re-fetches from DB (covers reload + workspace shift).
    state.tasksLoadedForWs = null;
    renderRightPanel();
  } catch (err) {
    console.error('[tasks] persistNewTask DB write failed:', err);
    optimisticTask.id = 'local-' + Date.now();
    renderRightPanel();
  }
}

// Update an existing task in DB + state.
async function persistTaskUpdate(task, fields) {
  // Optimistic UI: apply to state first.
  Object.assign(task, fields);
  renderRightPanel();
  if (!task.dbId || !window.farnsworth || !window.farnsworth.tasksUpdate) return;
  await window.farnsworth.tasksUpdate(task.dbId, dbFieldsForUpdate(fields));
}

// Delete a task from DB + state.
async function persistTaskDelete(task) {
  state.tasks = state.tasks.filter(t => t !== task);
  renderRightPanel();
  if (task.dbId && window.farnsworth && window.farnsworth.tasksDelete) {
    await window.farnsworth.tasksDelete(task.dbId);
  }
}

function dbFieldsForUpdate(fields) {
  const out = {};
  if ('status' in fields) out.status = fields.status;
  if ('title' in fields) out.title = fields.title;
  if ('detail' in fields) out.detail = fields.detail;
  if ('priority' in fields) out.priority = priorityStringToInt(fields.priority);
  if ('assignee' in fields) out.assignee = fields.assignee;
  if ('file' in fields) out.file_link = fields.file;
  return out;
}

function normalizeDbTask(r) {
  return {
    id: r.id,
    dbId: r.id,
    title: r.title,
    status: r.status || 'todo',
    priority: priorityIntToString(r.priority),
    detail: r.detail || '',
    source: r.source || null,
    assignee: r.assignee || 'blue',
    file: r.file_link || null,
    live: r.source && r.source.startsWith('live-') ? true : undefined,
  };
}

// Cycle a task through statuses: todo → in-progress → done → todo.
// Also opens the chat input pre-filled with the task as a prompt for
// the AI agent (the "Send" affordance — clicking the body dispatches).
function taskCycleStatus(task) {
  const next = task.status === 'todo' ? 'in-progress'
             : task.status === 'in-progress' ? 'done'
             : 'todo';
  persistTaskUpdate(task, { status: next });
}

// "Send to AI" — pre-fill the chat input with a prompt about this task
// and focus it. The user hits Enter (or clicks Send) to dispatch.
function taskSendToAi(task) {
  const prompt = buildTaskPrompt(task);
  const input = $('#chat-input');
  if (!input) return;
  input.value = prompt;
  input.focus();
  // Move cursor to end so the user can edit/append easily.
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function buildTaskPrompt(task) {
  const lines = [
    `Help me work on this task: ${task.title}.`,
  ];
  if (task.detail) lines.push(task.detail);
  if (task.file) lines.push(`Related file: ${task.file}`);
  if (task.source && task.source.startsWith('live-')) {
    lines.push('Source: AI ticket suggestion from the Sword & Supper live panel.');
  }
  lines.push('Start by reading any related files and outlining an approach.');
  return lines.join('\n\n');
}

function makeTask(t) {
  const task = el('div', { class: 'task' + (t.status === 'done' ? ' is-done' : '') + (t.status === 'in-progress' ? ' is-in-progress' : '') });

  // Check circle (click cycles status)
  const check = el('div', { class: 'task__check' });
  if (t.status === 'done') {
    check.innerHTML = '<svg class="task__check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3ba55c"/><path d="M8 12.5l2.5 2.5 5-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else if (t.status === 'in-progress') {
    check.innerHTML = '<svg class="task__check-circle" viewBox="0 0 24 24" fill="none" stroke="#f0b232" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="#f0b232" stroke="none"/></svg>';
  } else {
    check.innerHTML = '<svg class="task__check-circle" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
  }
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    taskCycleStatus(t);
  });
  task.appendChild(check);

  // Body
  const body = el('div', { class: 'task__body' });
  body.appendChild(el('div', { class: 'task__title' }, t.title));
  if (t.detail) {
    body.appendChild(el('div', { class: 'task__detail' }, t.detail));
  }
  if (t.status !== 'done') {
    const meta = el('div', { class: 'task__meta' });
    if (t.priority) {
      meta.appendChild(el('span', { class: 'task__meta-item' },
        el('span', { class: 'task__priority-dot task__priority--' + t.priority }),
        t.priority.charAt(0).toUpperCase() + t.priority.slice(1)
      ));
    }
    if (t.file) {
      meta.appendChild(el('span', { class: 'task__link' },
        el('span', { html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>' }),
        t.file
      ));
    }
    if (t.live || (t.source && t.source.startsWith('live-'))) {
      meta.appendChild(el('span', { class: 'task__live-badge' },
        el('span', { html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>' }),
        'Live · prod'
      ));
    }
    if (t.due) {
      meta.appendChild(el('span', { class: 'task__due' },
        el('span', { html: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' }),
        t.due
      ));
    }
    body.appendChild(meta);
  }

  // Per-task action buttons — show on hover. Send dispatches to AI,
  // Delete removes from DB + state.
  const actions = el('div', { class: 'task__actions' });
  const sendBtn = el('button', {
    class: 'task__action task__action--send',
    title: 'Send to AI — pre-fill the chat with this task',
    onClick: (e) => { e.stopPropagation(); taskSendToAi(t); },
  });
  sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  actions.appendChild(sendBtn);

  const delBtn = el('button', {
    class: 'task__action task__action--delete',
    title: 'Delete task',
    onClick: (e) => { e.stopPropagation(); persistTaskDelete(t); },
  });
  delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  actions.appendChild(delBtn);

  body.appendChild(actions);
  task.appendChild(body);

  // Assignee
  task.appendChild(el('div', { class: 'task__assignee task__assignee--' + (t.assignee || 'blue') }, assigneeInitials(t.assignee)));

  return task;
}

function assigneeInitials(kind) {
  if (kind === 'blue') return 'JL';
  if (kind === 'pink') return 'AK';
  if (kind === 'green') return 'MR';
  return '?';
}

function renderLive() {
  const wrap = el('div', { class: 'live' });

  // Lazy-fetch on first render. loadLiveGame() now goes through the
  // live_game_cache SQLite table — cache hits return instantly, misses
  // hit the API and persist. No auto-refresh on subsequent mounts; the
  // cache is the source of truth until the user clicks the refresh icon.
  // deferRender: renderLive() is already on the stack and will render
  // with the new state (liveGameLoading=true) once loadLiveGame's
  // synchronous setup returns — no need for a recursive renderRightPanel
  // that would double the .live wrapper.
  //
  // Refresh state.liveGameId from the active workspace's config on
  // every mount — recovers from a stale in-memory id left over from a
  // cogwheel config change or a session where the renderer hasn't been
  // reloaded since disk changed. Per-project (Jul 2): liveGameId lives
  // in .farnsworth/config.json, not the global settings table. When
  // no folder is open, getLiveGameId() falls back to the default.
  if (state.folder && window.farnsworth?.loadWorkspaceConfig) {
    window.farnsworth.loadWorkspaceConfig(state.folder).then(res => {
      const id = res?.ok && res.config?.liveGameId;
      if (typeof id === 'string' && id.length > 0 && id !== state.liveGameId) {
        state.liveGameId = id;
        // New id — invalidate the cached game and retry.
        state.liveGame = null;
        state.liveGameError = null;
        loadLiveGame(getLiveGameId(), { deferRender: true });
      }
    });
  }

  // On every mount: if the last fetch errored, retry. This handles
  // transient API errors, the cogwheel 404, and the user coming back
  // to the tab after fixing whatever caused the failure.
  if (state.liveGameError) {
    state.liveGameError = null;
    state.liveGame = null;
    loadLiveGame(getLiveGameId(), { deferRender: true });
  } else if (!state.liveGame && !state.liveGameLoading) {
    loadLiveGame(getLiveGameId(), { deferRender: true });
  }

  // Tasks: load from DB so the "In your tasks list" badges on tickets
  // can mark already-added ones. loadTasksFromDb has its own in-flight
  // + same-workspace guards, so calling it from renderLive is safe
  // even when the Tasks tab has never been opened. Without this, the
  // Live panel can't see which tickets are already in tasks unless the
  // user happens to have visited Tasks first.
  loadTasksFromDb();

  // Tickets: try cache first, then auto-generate if empty. Both
  // calls are idempotent — refresh button forces a regenerate.
  if (!state.liveTickets && !state.liveTicketsLoading) {
    state.liveTickets = []; // mark as "we've tried"
    loadCachedLiveTickets().then(hit => {
      if (!hit) loadLiveTickets();
      renderRightPanel();
    });
  }

  // Header is always rendered so the cogwheel + cancel button stay
  // accessible during loading and error states (Long Jul 3 ~11:55 ET —
  // "cogwheel should stay there even during loading. No reason why you
  // cant interrupt it"). renderLiveHeader handles the null `s` case by
  // showing placeholders + a Cancel button.
  wrap.appendChild(renderLiveHeader(state.liveGame));

  // Loading state — spinner inline below header. Header above gives the
  // user a way to interrupt (cogwheel to change config, Cancel to stop).
  if (state.liveGameLoading && !state.liveGame) {
    wrap.appendChild(renderLiveLoading());
    return wrap;
  }

  // Error state — message + retry inline below header.
  if (state.liveGameError && !state.liveGame) {
    wrap.appendChild(renderLiveError(state.liveGameError));
    return wrap;
  }

  const s = state.liveGame;
  if (!s) {
    wrap.appendChild(renderLiveLoading());
    return wrap;
  }

  // Background refresh: data is already on-screen, but a small "Refreshing…"
  // chip floats over the right edge so the user knows new data is in flight.
  if (state.liveGameRefreshing) {
    wrap.appendChild(renderLiveRefreshing());
  }

  // Header carries the title + Reddit branding + actions; the old
  // renderLiveHead() (LIVE · COMMUNITY label + duplicate "Sword & Supper")
  // was stacked above renderLiveHeader() and removed Jun 25 ~13:16 ET per
  // Long's "top section is too cluttered" call.
  // (Header already appended above — don't double-append here.)
  wrap.appendChild(renderLiveStats(s));
  wrap.appendChild(renderLiveActivity(s));
  wrap.appendChild(renderLiveInsights(s));
  wrap.appendChild(renderLiveTickets(s));
  wrap.appendChild(renderLiveAskAI(s));
  wrap.appendChild(renderLiveScreenshots(s));
  wrap.appendChild(renderLiveChangeLog(s));
  return wrap;
}

function renderLiveHeader(s) {
  // Same layout as before (Jun 26 ~09:00 ET), but the "Updated" pill is
  // now interactive: it shows when the data was last fetched relative to
  // now ("just now", "5m ago") and exposes a small refresh icon that
  // forces a fresh API fetch + writes back to the live_game_cache table.
  // No auto-refresh on tab mount — cache is shown instantly and only
  // updates when the user clicks the icon.
  // The cogwheel (added Jun 26 ~16:00 ET) opens a popover where the user
  // can change which subreddit the Live panel fetches data from.
  //
  // Null-safe: when `s` is null (loading or error), render the header
  // anyway so the cogwheel stays accessible. Show a "Loading…" or
  // "Error" title + a Cancel button when loading (Long Jul 3 ~11:55 ET
  // — "cogwheel should stay there even during loading").
  const isPlaceholder = !s;
  const isLoading = isPlaceholder && !!state.liveGameLoading;
  const isError = isPlaceholder && !!state.liveGameError;
  const currentId = state.liveGameId || LIVE_DEFAULT_GAME_ID;
  // Per-project config wins when set — lets the user edit the hardcoded
  // "SwordAndSupperGame" path / name / URL via the cogwheel. Falls
  // through to the API-derived values when the config is empty.
  // (Long Jul 3 ~12:42 ET — "Theres text thats hardcoded that says
  // swordandsupper i just want to edit that right now with the config.")
  const cfg = state.liveConfig || {};
  const subPath = cfg.subredditName
    ? `r/${cfg.subredditName}`
    : (isPlaceholder
      ? (() => { try { return new URL(`https://www.reddit.com/r/${currentId}`).pathname.replace(/^\/+/, '') || `r/${currentId}`; } catch (_) { return `r/${currentId}`; } })()
      : (() => { try { return new URL(s.subredditUrl).pathname.replace(/^\/+/, '') || 'r/swordnsupper'; } catch (_) { return 'r/' + (s.name || '').toLowerCase().replace(/\s+/g, ''); } })());
  const relativeAge = formatRelativeTime(state.liveGameFetchedAt);
  const isRefreshing = !!state.liveGameRefreshing;
  const fromCache = !!state.liveGameFromCache;
  // Project name from config wins over the API's `s.name` — same shape
  // as the subredditName override above. Empty config falls through.
  const name = cfg.projectName
    ? cfg.projectName
    : (isPlaceholder ? (isError ? 'Load failed' : 'Loading…') : s.name);
  const popularity = isPlaceholder ? 'unknown' : s.popularity;
  const genre = isPlaceholder ? '' : s.genre;
  // URL from config wins — gives the user an explicit "Open subreddit"
  // target even when the API-derived one is empty/wrong.
  const subHref = cfg.url
    || (isPlaceholder ? `https://www.reddit.com/r/${currentId}` : s.subredditUrl);
  const head = el('div', { class: 'live__subhead' });
  head.innerHTML = `
    <div class="live__subhead-top">
      <div class="live__subhead-eyebrow">
        <span class="live__reddit-chip">REDDIT APP</span>
        <span class="live__subreddit-path">${escapeHtml(subPath)}</span>
      </div>
      <div class="live__subhead-actions">
        ${isLoading ? `
          <button class="live__cancel-btn" id="live-cancel-btn" title="Cancel the in-flight request" aria-label="Cancel loading">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            Cancel
          </button>
        ` : ''}
        <a class="live__open-sub" href="${escapeHtml(subHref)}" target="_blank" rel="noopener">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
          Open subreddit
        </a>
        <button class="live__config-btn" id="live-config-btn" title="Configure live subreddit" aria-label="Configure live subreddit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>
    <div class="live__subhead-row">
      <div class="live__snoo-wrap">
        <img class="live__snoo" src="assets/reddit-logo.webp" alt="Reddit" />
      </div>
      <div class="live__subhead-text">
        <h2 class="live__game-name">${escapeHtml(name)}</h2>
        <div class="live__subhead-tags">
          <span class="live__popularity live__popularity--${escapeHtml(popularity)}">${escapeHtml(popularity)}</span>
          ${genre ? `<span class="live__genre">${escapeHtml(genre)}</span>` : ''}
          ${isPlaceholder ? '' : `
          <span class="live__last-update ${fromCache ? 'is-cached' : 'is-fresh'}" title="Last update">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            <span class="live__last-update-label">Updated</span>
            <span class="live__last-update-date">${relativeAge}</span>
            <button class="live__refresh-btn ${isRefreshing ? 'is-spinning' : ''}" id="live-refresh-btn" title="Refresh from API" aria-label="Refresh from API">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>
            </button>
          </span>
          `}
        </div>
      </div>
    </div>
  `;
  // Wire refresh click — single-shot, disabled while in flight. Skipped
  // when the header is a placeholder (no real data yet).
  if (!isPlaceholder) {
    const refreshBtn = head.querySelector('#live-refresh-btn');
    if (refreshBtn && !isRefreshing) {
      refreshBtn.addEventListener('click', () => refreshLiveGame());
    }
  }
  // Wire cogwheel click — opens the subreddit-config popover. Always
  // available, even during loading/error (Long Jul 3 ~11:55 ET).
  const configBtn = head.querySelector('#live-config-btn');
  if (configBtn) {
    configBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLiveConfig();
    });
  }
  // Wire cancel click — clears the loading state and surfaces a "cancelled"
  // error. The IPC fetch continues in the background but its result is
  // ignored. User can click Retry or change config to start fresh.
  const cancelBtn = head.querySelector('#live-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      state.liveGameLoading = false;
      state.liveGameError = { error: 'cancelled', message: 'Load cancelled.' };
      renderRightPanel();
    });
  }
  return head;
}

// Settings popover for the Live panel — user can swap the subreddit
// URL the panel fetches data from. Persists to the SQLite settings
// table (key: live.subreddit) so it survives reloads. The cogwheel
// next to "Open subreddit" opens this; clicking outside or pressing
// Escape closes it.
function openLiveConfig() {
  // If already open, toggle closed.
  const existing = document.querySelector('.live__config-popover');
  if (existing) { existing.remove(); state.liveConfigOpen = false; return; }
  state.liveConfigOpen = true;

  const currentUrl = state.liveConfig?.url || state.liveGame?.subredditUrl || `https://www.reddit.com/r/${LIVE_DEFAULT_GAME_ID}`;
  const pop = el('div', { class: 'live__config-popover' });
  pop.innerHTML = `
    <div class="live__config-title">Live panel</div>
    <div class="live__config-sub">Point the Live panel at a different subreddit and pin the post you want to edit. Saved to this project's <code>.farnsworth/config.json</code>.</div>
    <label class="live__config-label" for="live-config-project">Project name</label>
    <input type="text" class="live__config-input" id="live-config-project" value="${escapeHtml(state.liveConfig?.projectName || '')}" placeholder="e.g. Froggy Auto-RPG" />
    <label class="live__config-label" for="live-config-subname">Subreddit name</label>
    <input type="text" class="live__config-input" id="live-config-subname" value="${escapeHtml(state.liveConfig?.subredditName || '')}" placeholder="e.g. SwordAndSupperGame" />
    <label class="live__config-label" for="live-config-input">Reddit URL</label>
    <input type="text" class="live__config-input" id="live-config-input" value="${escapeHtml(currentUrl)}" placeholder="https://www.reddit.com/r/…" autofocus />
    <label class="live__config-label" for="live-config-post">Post name</label>
    <input type="text" class="live__config-input" id="live-config-post" value="${escapeHtml(state.liveConfig?.postName || '')}" placeholder="e.g. Welcome Thread" />
    <div class="live__config-timeout-row">
      <label class="live__config-timeout-label" for="live-config-timeout">Request timeout (seconds)</label>
      <input type="number" class="live__config-input live__config-input--num" id="live-config-timeout" value="${state.liveTimeoutSeconds}" min="1" max="600" step="1" />
      <div class="live__config-timeout-hint">Default 15s. Increase if the API is slow; decrease if you want failures to surface faster.</div>
    </div>
    <div class="live__config-row">
      <button class="live__config-cancel" id="live-config-cancel">Cancel</button>
      <button class="live__config-save" id="live-config-save">Save & reload</button>
    </div>
    <div class="live__config-err" id="live-config-err"></div>
  `;
  // Anchor it just below the cogwheel button.
  const anchor = document.querySelector('#live-config-btn');
  const rect = anchor?.getBoundingClientRect();
  document.body.appendChild(pop);
  if (rect) {
    pop.style.position = 'fixed';
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  }
  // Wire handlers
  const input = pop.querySelector('#live-config-input');
  const projectInput = pop.querySelector('#live-config-project');
  const subnameInput = pop.querySelector('#live-config-subname');
  const postInput = pop.querySelector('#live-config-post');
  input.focus();
  input.select();
  const collect = () => ({
    projectName: projectInput?.value || '',
    subredditName: subnameInput?.value || '',
    url: input?.value || '',
    postName: postInput?.value || '',
  });
  pop.querySelector('#live-config-cancel').addEventListener('click', () => {
    pop.remove();
    state.liveConfigOpen = false;
  });
  pop.querySelector('#live-config-save').addEventListener('click', () => saveLiveConfig(collect(), pop));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLiveConfig(collect(), pop); }
    if (e.key === 'Escape') { e.preventDefault(); pop.remove(); state.liveConfigOpen = false; }
  });
  // Click outside to close
  setTimeout(() => {
    document.addEventListener('click', function onOutside(e) {
      if (!pop.contains(e.target) && e.target !== anchor) {
        pop.remove();
        state.liveConfigOpen = false;
        document.removeEventListener('click', onOutside);
      }
    });
  }, 0);
}

async function saveLiveConfig(values, pop) {
  // `values` is { projectName, subredditName, url, postName } from the
  // 4 cogwheel inputs. `pop` is the popover element so we can show the
  // error inline.
  const rawUrl = (values?.url || '').trim();
  const projectName = (values?.projectName || '').trim();
  const subredditName = (values?.subredditName || '').trim();
  const postName = (values?.postName || '').trim();
  // Parse the URL — accept either a full Reddit URL or a bare slug/UUID.
  // The /api/reddit-games/<id> route resolves both. We normalize to the
  // bare id (last path segment, stripping query/hash) and persist it.
  let id = rawUrl;
  if (!id) {
    pop.querySelector('#live-config-err').textContent = 'Enter a subreddit URL or slug.';
    return;
  }
  // If it looks like a URL, pull the last path segment.
  if (/^https?:\/\//i.test(id)) {
    try {
      const u = new URL(id);
      const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      // r/<slug> → ["r", "slug"]; bare /<slug> → ["slug"]
      const last = parts.filter(p => p && p !== 'r').pop();
      if (!last) throw new Error('no slug in URL');
      id = last;
    } catch (e) {
      pop.querySelector('#live-config-err').textContent = `Couldn't parse URL: ${e.message}`;
      return;
    }
  }
  // Validate — only alnum, dash, underscore (matches main.js IPC validator).
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 128) {
    pop.querySelector('#live-config-err').textContent = 'Subreddit id has invalid characters.';
    return;
  }
  // Parse the timeout input — must be a positive integer in [1, 600].
  const timeoutInput = pop.querySelector('#live-config-timeout');
  const timeoutVal = Number(timeoutInput?.value);
  if (!Number.isFinite(timeoutVal) || timeoutVal < 1 || timeoutVal > 600) {
    pop.querySelector('#live-config-err').textContent = 'Timeout must be 1–600 seconds.';
    return;
  }
  state.liveTimeoutSeconds = timeoutVal;
  // Persist timeout to the global settings table (it's not per-project —
  // every Live panel uses the same timeout).
  if (window.farnsworth?.setSetting) {
    try {
      await window.farnsworth.setSetting('live.timeout_seconds', timeoutVal);
    } catch (e) {
      console.error('[live-config] timeout save failed:', e);
    }
  }
  // Persist to the per-project .farnsworth/config.json (each workspace
  // has its own subreddit now — see handleFolderPicked for the load
  // path). We merge with any existing config so we don't drop the
  // appType when the user updates only the subreddit. The new `live`
  // subkey carries the 4 panel-config fields (projectName, subredditName,
  // url, postName) — keeps the URL authoritative while letting the
  // human-readable subreddit name live alongside.
  if (state.folder && window.farnsworth?.loadWorkspaceConfig && window.farnsworth?.saveWorkspaceConfig) {
    try {
      const existing = await window.farnsworth.loadWorkspaceConfig(state.folder);
      const base = (existing.ok && existing.config) || {};
      await window.farnsworth.saveWorkspaceConfig(state.folder, {
        ...base,
        liveGameId: id,
        live: {
          projectName,
          subredditName,
          url: rawUrl,
          postName,
        },
      });
    } catch (e) {
      console.error('[live-config] workspace save failed:', e);
    }
  }
  // Update in-memory id + liveConfig so getLiveGameId() and the header
  // render return the new values immediately for any concurrent render path.
  state.liveGameId = id;
  state.liveConfig = { projectName, subredditName, url: rawUrl, postName };
  // Reset Live state + reload. Force flag bypasses the idempotency guard
  // so even if state.liveGame still references the previous game id,
  // the new id wins.
  state.liveGame = null;
  state.liveGameLoading = false;
  state.liveGameRefreshing = false;
  state.liveGameFromCache = false;
  state.liveGameFetchedAt = null;
  state.liveGameError = null;
  // Trigger render + load with the new id.
  pop.remove();
  state.liveConfigOpen = false;
  renderRightPanel();
  loadLiveGame(id, { deferRender: true, force: true });
}

function renderLiveStats(s) {
  const grid = el('div', { class: 'live__stats' });
  // Description / Moderators / Created date / Last Update removed per Long's
  // calls (Jun 25 ~12:14–12:22 ET). Last Update moved to the header aside.
  // Stats grid is now 2 tiles — just the active community metrics.
  const tiles = [
    { label: 'WEEKLY USERS',  value: s.stats.weeklyUsers,   icon: 'users' },
    { label: 'CONTRIBUTIONS', value: s.stats.contributions, icon: 'edit' },
  ];
  tiles.forEach(t => {
    const tile = el('div', { class: 'live__stat' });
    tile.innerHTML = `
      <div class="live__stat-icon">${liveStatIcon(t.icon)}</div>
      <div class="live__stat-label">${t.label}</div>
      <div class="live__stat-value">${t.value}</div>
    `;
    grid.appendChild(tile);
  });
  return grid;
}

function liveStatIcon(name) {
  const icons = {
    users: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };
  return icons[name] || '';
}

function renderLiveDescription(s) {
  const wrap = el('div', { class: 'live__section live__description' });
  const expanded = !!state.liveExpandedSections.description;
  wrap.innerHTML = `
    <div class="live__section-head" data-toggle="description">
      <h4 class="live__section-title">Description</h4>
    </div>
    <p class="live__desc-text">${s.description}</p>
    <h4 class="live__section-title live__section-title--sub">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.5 8.5 2 9.5l5.5 5L6 22l6-3 6 3-1.5-7.5L22 9.5 14.5 8.5 12 2z"/></svg>
      AI Visual Description
    </h4>
    <p class="live__desc-caption">Generated from screenshots of pinned & popular posts</p>
    <p class="live__desc-ai ${expanded ? 'is-expanded' : ''}">${s.aiVisualDescription}</p>
    <button class="live__desc-toggle" data-toggle="description">${expanded ? 'Show less' : 'Show more'}</button>
  `;
  wrap.querySelectorAll('[data-toggle="description"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.liveExpandedSections.description = !state.liveExpandedSections.description;
      renderRightPanel();
    });
  });
  return wrap;
}

function renderLiveModerators(s) {
  const wrap = el('div', { class: 'live__section' });
  wrap.innerHTML = `<h4 class="live__section-title">Moderators</h4>`;
  const list = el('div', { class: 'live__mods' });
  s.moderators.forEach(m => {
    const initial = m.name.replace(/^u\//, '').slice(0, 2).toUpperCase();
    const chip = el('div', { class: 'live__mod' });
    chip.innerHTML = `
      <div class="live__mod-avatar" style="background:${m.color}">${initial}</div>
      <div class="live__mod-name">u/${m.name}</div>
    `;
    list.appendChild(chip);
  });
  wrap.appendChild(list);
  return wrap;
}

function renderLiveScreenshots(s) {
  const wrap = el('div', { class: 'live__section' });
  wrap.innerHTML = `
    <h4 class="live__section-title">Screenshots</h4>
    <p class="live__desc-caption">${s.screenshots.length} image stored in R2.</p>
  `;
  const strip = el('div', { class: 'live__shots' });
  s.screenshots.forEach(shot => {
    const tile = el('div', { class: 'live__shot' });
    tile.innerHTML = `
      <div class="live__shot-thumb">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      </div>
      <div class="live__shot-caption">${shot.caption}</div>
    `;
    strip.appendChild(tile);
  });
  wrap.appendChild(strip);
  return wrap;
}

function renderLiveActivity(s) {
  const wrap = el('div', { class: 'live__section live__activity' });
  wrap.innerHTML = `
    <h4 class="live__section-title">Activity Over Time</h4>
    <p class="live__desc-caption">Rolling 7-day users and contributions per measurement.</p>
  `;
  wrap.appendChild(buildActivityChart(s.activity));
  return wrap;
}

function buildActivityChart(points) {
  const W = 320, H = 110, PAD = 24;
  const maxY = Math.max(...points.map(p => p.u)) * 1.05;
  const stepX = (W - PAD * 2) / Math.max(1, points.length - 1);
  const yOf = v => PAD + (1 - v / maxY) * (H - PAD * 2);
  const xOf = i => PAD + i * stepX;

  const usersPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(p.u)}`).join(' ');
  const contribPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(p.c)}`).join(' ');
  const usersArea = `${usersPath} L${xOf(points.length - 1)},${H - PAD} L${PAD},${H - PAD} Z`;
  const contribArea = `${contribPath} L${xOf(points.length - 1)},${H - PAD} L${PAD},${H - PAD} Z`;

  // Y-axis ticks at 0, maxY/2, maxY
  const yTicks = [0, maxY / 2, maxY].map(v => ({
    v,
    y: yOf(v),
    label: v >= 1000 ? `${Math.round(v / 1000)}K` : Math.round(v).toString(),
  }));

  // X-axis: 4 evenly-spaced date labels
  const xTickIdxs = points.length > 1
    ? [0, Math.floor((points.length - 1) / 3), Math.floor(2 * (points.length - 1) / 3), points.length - 1]
    : [0];
  const xTicks = xTickIdxs.map(i => ({ i, label: points[i].d, x: xOf(i) }));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'live__chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  // Defs for the two area gradients
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="live-chart-users" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5865f2" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#5865f2" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="live-chart-contrib" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3ba55c" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#3ba55c" stop-opacity="0"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  // Y grid lines + labels
  yTicks.forEach(t => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', PAD); line.setAttribute('x2', W - PAD);
    line.setAttribute('y1', t.y); line.setAttribute('y2', t.y);
    line.setAttribute('stroke', '#2a2b2f'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', W - PAD + 2); lbl.setAttribute('y', t.y + 3);
    lbl.setAttribute('fill', '#80848e'); lbl.setAttribute('font-size', '9');
    lbl.textContent = t.label;
    svg.appendChild(lbl);
  });

  // X labels
  xTicks.forEach(t => {
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', t.x); lbl.setAttribute('y', H - 6);
    lbl.setAttribute('fill', '#80848e'); lbl.setAttribute('font-size', '9');
    lbl.setAttribute('text-anchor', 'middle');
    lbl.textContent = t.label;
    svg.appendChild(lbl);
  });

  // Areas
  const areaUsers = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  areaUsers.setAttribute('d', usersArea); areaUsers.setAttribute('fill', 'url(#live-chart-users)');
  svg.appendChild(areaUsers);

  const areaContrib = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  areaContrib.setAttribute('d', contribArea); areaContrib.setAttribute('fill', 'url(#live-chart-contrib)');
  svg.appendChild(areaContrib);

  // Lines
  const lineUsers = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lineUsers.setAttribute('d', usersPath); lineUsers.setAttribute('fill', 'none');
  lineUsers.setAttribute('stroke', '#5865f2'); lineUsers.setAttribute('stroke-width', '1.6');
  svg.appendChild(lineUsers);

  const lineContrib = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lineContrib.setAttribute('d', contribPath); lineContrib.setAttribute('fill', 'none');
  lineContrib.setAttribute('stroke', '#3ba55c'); lineContrib.setAttribute('stroke-width', '1.6');
  svg.appendChild(lineContrib);

  const chart = el('div', { class: 'live__chart-wrap' });
  chart.appendChild(svg);

  // Legend
  const legend = el('div', { class: 'live__chart-legend' });
  legend.innerHTML = `
    <span class="live__legend-item"><span class="live__legend-swatch" style="background:#5865f2"></span>users</span>
    <span class="live__legend-item"><span class="live__legend-swatch" style="background:#3ba55c"></span>contributions</span>
  `;
  chart.appendChild(legend);
  return chart;
}

function renderLiveInsights(s) {
  const i = s.insights;
  const wrap = el('div', { class: 'live__section live__insights' });
  const hasSentiment = i.hasSentiment !== false && typeof i.sentiment === 'number';
  const sentimentPct = hasSentiment
    ? Math.max(0, Math.min(100, ((i.sentiment + i.sentimentMax) / (i.sentimentMax * 2)) * 100))
    : 50;
  const sentimentColor = hasSentiment ? (i.sentiment >= 1 ? '#3ba55c' : i.sentiment <= -1 ? '#f23f43' : '#f0b232') : '#80848e';
  const analyzedAt = i.analyzedAt ? new Date(i.analyzedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

  wrap.innerHTML = `
    <h4 class="live__section-title">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.5 8.5 2 9.5l5.5 5L6 22l6-3 6 3-1.5-7.5L22 9.5 14.5 8.5 12 2z"/></svg>
      Community Insights
    </h4>
    <p class="live__desc-caption">AI sentiment analysis from ${i.analyzedPosts} posts and ${i.analyzedComments} comments · ${analyzedAt}</p>

    <div class="live__sentiment">
      <div class="live__sentiment-label">Overall Sentiment</div>
      <div class="live__sentiment-value">
        <span class="live__sentiment-score" style="color:${sentimentColor}">${hasSentiment ? (i.sentiment > 0 ? '+' : '') + i.sentiment.toFixed(1) : '—'}</span>
        <span class="live__sentiment-max"> / ${i.sentimentMax}</span>
      </div>
      <div class="live__sentiment-bar">
        <div class="live__sentiment-bar-track">
          <div class="live__sentiment-bar-fill" style="left:${sentimentPct}%;background:${sentimentColor}"></div>
        </div>
        <div class="live__sentiment-bar-mid"></div>
      </div>
      <p class="live__sentiment-summary">${i.summary || (hasSentiment ? '' : 'No sentiment analysis yet — the AI hasn\'t crunched this community\'s recent posts.')}</p>
    </div>

    <div class="live__themes-label">THEMES</div>
    <div class="live__themes">
      ${i.themes.map(t => `<span class="live__theme">${t}</span>`).join('')}
    </div>

    <div class="live__themes-label live__themes-label--love">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#3ba55c" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      WHAT PEOPLE LOVE
    </div>
    <ul class="live__loves">
      ${i.loves.map(t => `<li><span class="live__bullet live__bullet--plus">+</span>${t}</li>`).join('')}
    </ul>

    <div class="live__themes-label live__themes-label--pain">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f23f43" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
      PAIN POINTS
    </div>
    <ul class="live__pains">
      ${i.painPoints.map(t => `<li><span class="live__bullet live__bullet--minus">–</span>${t}</li>`).join('')}
    </ul>

    <div class="live__themes-label">ANALYZED POSTS</div>
    <ul class="live__posts">
      ${i.posts.map(p => `
        <li class="live__post">
          <div class="live__post-title">${p.title}</div>
          <div class="live__post-tags">
            ${p.pinned ? '<span class="live__post-tag live__post-tag--pinned">pinned</span>' : ''}
            <span class="live__post-tag">${p.tag}</span>
          </div>
          <div class="live__post-stats">
            <span><strong>${p.votes}</strong> votes</span>
            <span><strong>${p.comments}</strong> comments</span>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
  return wrap;
}

function renderLiveAskAI(s) {
  const wrap = el('div', { class: 'live__section live__ask' });
  const i = s.insights;
  const history = state.liveChatHistory || [];
  const pending = !!state.liveChatPending;

  // The chat endpoint is a server-side proxy through anomalyint.vercel.app
  // (Vercel holds the OpenAI key), so no Claude OAuth is needed — anyone
  // with the game loaded can ask questions immediately.
  wrap.innerHTML = `
    <h4 class="live__section-title">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.5 8.5 2 9.5l5.5 5L6 22l6-3 6 3-1.5-7.5L22 9.5 14.5 8.5 12 2z"/></svg>
      Ask AI about this community
    </h4>
    <p class="live__desc-caption">Chatting with context from ${i.analyzedPosts} posts and ${i.analyzedComments} comments — proxied through the Anomaly Intelligence API.</p>
    <div class="live__chat-history" data-live-chat-history>
      ${history.map(m => `
        <div class="live__chat-msg live__chat-msg--${m.role}">
          <div class="live__chat-role">${m.role === 'user' ? 'You' : 'Analyst'}</div>
          <div class="live__chat-text">${escapeHtml(m.content)}</div>
        </div>
      `).join('')}
      ${pending ? `<div class="live__chat-msg live__chat-msg--assistant live__chat-msg--pending"><div class="live__chat-role">Analyst</div><div class="live__chat-text"><span class="live__chat-dots"><span></span><span></span><span></span></span> thinking…</div></div>` : ''}
    </div>
    <div class="live__ask-row">
      <input type="text" class="live__ask-input" placeholder="Ask about player sentiment, pain points, trends…" ${pending ? 'disabled' : ''} />
      <button class="live__ask-btn" ${pending ? 'disabled' : ''}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  `;

  const input = wrap.querySelector('.live__ask-input');
  const btn = wrap.querySelector('.live__ask-btn');

  const submit = () => {
    const text = (input.value || '').trim();
    if (!text || pending) return;
    input.value = '';
    sendLiveChat(text);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  btn.addEventListener('click', submit);

  // Auto-scroll the chat history to the latest message.
  const historyEl = wrap.querySelector('[data-live-chat-history]');
  if (historyEl) historyEl.scrollTop = historyEl.scrollHeight;

  return wrap;
}

function renderLiveChangeLog(s) {
  const wrap = el('div', { class: 'live__section' });
  wrap.innerHTML = `<h4 class="live__section-title">Change Log</h4>`;
  const intro = el('p', { class: 'live__desc-caption' });
  intro.textContent = 'Listing, genre, and metadata changes over time.';
  wrap.appendChild(intro);

  const list = el('ul', { class: 'live__changelog' });
  s.changeLog.forEach(entry => {
    const li = el('li', { class: 'live__changelog-item' });
    const at = new Date(entry.at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    li.innerHTML = `
      <span class="live__changelog-type">${entry.type}</span>
      <span class="live__changelog-change">${entry.change}</span>
      <span class="live__changelog-at">${at}</span>
    `;
    list.appendChild(li);
  });
  wrap.appendChild(list);
  return wrap;
}

// ============================================================================
// LIVE PANEL — data layer
//
// loadLiveGame() / mapApiToLive() / sendLiveChat() handle the API side of
// the Live tab. The render functions above stay shape-compatible with the
// old mock data — mapApiToLive() returns the same fields (renamed to match
// what the API returns where helpful, kept as-is where it doesn't).
// ============================================================================

function renderLiveLoading() {
  // Full-panel loading state shown on first load when there's no cache.
  // Big centered spinner with a multi-ring pulse + brand context line.
  const wrap = el('div', { class: 'live__loading' });
  wrap.innerHTML = `
    <div class="live__loading-spinner" aria-hidden="true">
      <div class="live__loading-ring live__loading-ring--1"></div>
      <div class="live__loading-ring live__loading-ring--2"></div>
      <div class="live__loading-ring live__loading-ring--3"></div>
      <div class="live__loading-dot"></div>
    </div>
    <div class="live__loading-title">Loading community analytics</div>
    <div class="live__loading-sub">Fetching game detail from anomalyint.vercel.app</div>
    <div class="live__loading-progress" aria-hidden="true">
      <div class="live__loading-progress-bar"></div>
    </div>
  `;
  return wrap;
}

function renderLiveRefreshing() {
  // Compact spinner shown inline when the cache is already on-screen and
  // we're doing a background refresh. Hovers over the right edge of the
  // header so the user knows new data is on the way without covering the
  // entire panel.
  const wrap = el('div', { class: 'live__refreshing' });
  wrap.innerHTML = `
    <div class="live__refreshing-spinner" aria-hidden="true"></div>
    <span>Refreshing…</span>
  `;
  return wrap;
}

function renderLiveError(err) {
  const wrap = el('div', { class: 'live__error' });
  const status = err.status ? ` (HTTP ${err.status})` : '';
  wrap.innerHTML = `
    <div class="live__error-title">Couldn't load the game</div>
    <div class="live__error-msg">${escapeHtml(err.message || err.error || 'Unknown error')}${status}</div>
    <button class="live__error-retry">Retry</button>
  `;
  wrap.querySelector('.live__error-retry').addEventListener('click', () => {
    state.liveGameError = null;
    loadLiveGame(getLiveGameId());
    renderRightPanel();
  });
  return wrap;
}

async function loadLiveGame(gameId, opts = {}) {
  // opts.silent — true means this is a background refresh; don't blow away
  //                the existing data with a loading spinner.
  // opts.deferRender — true means the caller is already inside renderLive
  //                    and will render with the new state on its own.
  //                    Avoids a recursive renderRightPanel() that doubles
  //                    the .live wrapper during the synchronous setup
  //                    (the calling renderLive sees the new state when
  //                    control returns past our first await).
  if (!window.farnsworth || !window.farnsworth.liveLoadGame) {
    state.liveGameError = { error: 'no_bridge', message: 'IPC bridge unavailable — reload Farnsworth' };
    if (!opts.silent && !opts.deferRender) renderRightPanel();
    return;
  }
  // Idempotency for the same game id (unless force-refresh).
  if (!opts.force && state.liveGame && state.liveGame.id === gameId && !state.liveGameError) return;

  if (!opts.silent) {
    state.liveGameLoading = true;
    state.liveGameError = null;
    if (!opts.deferRender) renderRightPanel();
  } else {
    // Background refresh: keep existing data on-screen, set a small
    // "refreshing" flag so the header can show a spinner.
    state.liveGameRefreshing = true;
    if (!opts.deferRender) renderRightPanel();
  }

  const res = await Promise.race([
    window.farnsworth.liveLoadGame(gameId),
    new Promise((resolve) => setTimeout(() => resolve({
      ok: false, error: 'timeout',
      message: `Loading timed out after ${state.liveTimeoutSeconds}s. Increase the timeout in Live settings or check the API URL.`,
    }), state.liveTimeoutSeconds * 1000)),
  ]);

  if (!opts.silent) {
    state.liveGameLoading = false;
  } else {
    state.liveGameRefreshing = false;
  }

  if (!res.ok) {
    state.liveGameError = res;
    renderRightPanel();
    return;
  }
  state.liveGame = mapApiToLive(res.data, gameId);
  // Track the cache fetch time so the Updated label shows "just now" / "5m ago".
  state.liveGameFetchedAt = res.fetched_at || new Date().toISOString();
  state.liveGameFromCache = !!res.cached;
  renderRightPanel();
}

// Manual refresh triggered by the icon next to the Updated date. Always
// forces a fresh API fetch (bypasses the read-through cache) and writes
// the result back to SQLite. Shows an inline spinner while the request
// is in flight; renders the new data when it arrives.
async function refreshLiveGame() {
  const gameId = getLiveGameId();
  if (!window.farnsworth || !window.farnsworth.liveRefreshGame) {
    state.liveGameError = { error: 'no_bridge', message: 'IPC bridge unavailable — reload Farnsworth' };
    renderRightPanel();
    return;
  }
  state.liveGameRefreshing = true;
  renderRightPanel();
  const res = await Promise.race([
    window.farnsworth.liveRefreshGame(gameId),
    new Promise((resolve) => setTimeout(() => resolve({
      ok: false, error: 'timeout',
      message: `Refresh timed out after ${state.liveTimeoutSeconds}s. The API may be slow or unreachable.`,
    }), state.liveTimeoutSeconds * 1000)),
  ]);
  state.liveGameRefreshing = false;
  if (!res.ok) {
    state.liveGameError = res;
    renderRightPanel();
    return;
  }
  state.liveGame = mapApiToLive(res.data, gameId);
  state.liveGameFetchedAt = new Date().toISOString();
  state.liveGameFromCache = false;
  state.liveGameError = null;
  renderRightPanel();
}

// Map the API response ({ game, events, sentiment, posts }) into the
// subreddit-shaped object the render functions already consume. Keeping
// the consumer shape stable means the panel UI barely changed.
function mapApiToLive(api, gameId) {
  const game = api.game || {};
  const events = Array.isArray(api.events) ? api.events : [];
  const sentiment = api.sentiment || null;
  const posts = Array.isArray(api.posts) ? api.posts : [];

  // Stats — derive from the latest weekly_metrics row. The API stores
  // weekly snapshots, not rolling 7-day totals; the labels match what
  // the dashboard shows.
  const metrics = Array.isArray(game.tracked_game_weekly_metrics)
    ? [...game.tracked_game_weekly_metrics].sort((a, b) => String(a.measured_on).localeCompare(String(b.measured_on)))
    : [];
  const latest = metrics[metrics.length - 1] || {};
  const firstMetric = metrics[0] || {};
  const weeklyUsers = latest.users != null ? Number(latest.users) : null;
  const contributions = latest.contributions != null ? Number(latest.contributions) : null;

  // Sentiment — API gives overall_score, but the scale is -1..+1 in
  // practice (the API MD example showed 0.82 but live data on
  // SwordAndSupperGame returned -0.2). Clamp to [-1, 1] then scale to
  // the UI's +/-10 range so the bar position math stays sane.
  const sentimentScore = sentiment && typeof sentiment.overall_score === 'number'
    ? Math.max(-1, Math.min(1, sentiment.overall_score)) * 10
    : null;

  // Change log — events come in as {field, old_value, new_value, changed_at}.
  // Render as "{field}: {old_value} → {new_value}".
  const changeLog = events.slice(0, 50).map(e => ({
    type: humanizeField(e.field),
    change: `${e.old_value || '∅'} → ${e.new_value || '∅'}`,
    at: e.changed_at,
  }));

  // Posts — top 25 from API. The "tag" column maps to post_type;
  // votes/comments get formatted.
  const insightsPosts = posts.slice(0, 10).map(p => ({
    title: p.title || '(untitled)',
    tag: p.post_type || 'discussion',
    pinned: !!p.is_pinned,
    votes: formatCount(p.upvotes),
    comments: formatCount(p.comment_count),
  }));

  // Subreddit path — derive from sub_address URL.
  const subPath = (() => {
    try {
      const u = new URL(game.sub_address || '');
      return u.pathname.replace(/^\/+/, '') || '';
    } catch (_) { return ''; }
  })();

  // Popularity chip — pick the first listing if any. The mock used a
  // single string; the API returns an array.
  const popularity = (Array.isArray(game.listings) && game.listings[0])
    ? String(game.listings[0]).toLowerCase()
    : '';

  // Genre — prefer singular field, fall back to first of genres[].
  const genre = game.genre || (Array.isArray(game.genres) && game.genres[0]) || '';

  // Screenshots — placeholder tiles, same shape as the mock.
  const screenshots = Array.isArray(game.screenshots)
    ? game.screenshots.map((url, i) => ({ id: url || `shot-${i}`, caption: 'screenshot' }))
    : [];

  return {
    id: gameId,
    name: game.game_name || '(unknown game)',
    popularity,
    genre,
    subredditUrl: game.sub_address || '',
    subPath,
    stats: {
      weeklyUsers: weeklyUsers != null ? formatCount(weeklyUsers) : '—',
      contributions: contributions != null ? formatCount(contributions) : '—',
      lastUpdate: formatShortDate(game.last_update) || '—',
      createdAt: game.created_date || '',
      firstMeasuredOn: firstMetric.measured_on || '',
    },
    description: game.description || '',
    aiVisualDescription: game.ai_visual_description || '',
    screenshots,
    // Activity chart points — sparse weekly snapshots, sorted asc.
    activity: metrics.map(m => ({
      d: formatShortDate(m.measured_on, /* mmDD */ true),
      u: Number(m.users) || 0,
      c: Number(m.contributions) || 0,
    })),
    insights: {
      analyzedPosts: sentiment?.post_count ?? posts.length,
      analyzedComments: sentiment?.comment_count ?? 0,
      analyzedAt: sentiment?.analyzed_at || '',
      sentiment: sentimentScore,
      sentimentMax: 10,
      hasSentiment: !!sentiment,
      summary: sentiment?.raw_analysis?.summary || '',
      themes: Array.isArray(sentiment?.themes) ? sentiment.themes : [],
      loves: Array.isArray(sentiment?.positive_highlights) ? sentiment.positive_highlights : [],
      painPoints: Array.isArray(sentiment?.pain_points) ? sentiment.pain_points : [],
      posts: insightsPosts,
    },
    changeLog,
  };
}

async function sendLiveChat(message) {
  if (!window.farnsworth || !window.farnsworth.liveChat) return;
  const trimmed = String(message || '').trim();
  if (!trimmed) return;

  // Build the conversation history. Send the full history so the server
  // can keep multi-turn context (it ignores system roles and prepends
  // its own system prompt).
  const history = state.liveChatHistory.map(m => ({ role: m.role, content: m.content }));
  state.liveChatHistory.push({ role: 'user', content: trimmed });
  state.liveChatPending = true;
  renderRightPanel();

  const res = await window.farnsworth.liveChat(getLiveGameId(), {
    messages: [...history, { role: 'user', content: trimmed }],
  });
  state.liveChatPending = false;

  if (!res.ok) {
    state.liveChatHistory.push({
      role: 'assistant',
      content: `⚠️ ${res.message || res.error || 'Chat failed'}${res.status ? ` (HTTP ${res.status})` : ''}`,
    });
    renderRightPanel();
    return;
  }
  const reply = res.data && res.data.reply ? res.data.reply : '(no reply)';
  state.liveChatHistory.push({ role: 'assistant', content: reply });
  renderRightPanel();
}

// ----- helpers used by the mapper -----

function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`;
  return String(v);
}

function formatShortDate(iso, mmDD = false) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  if (mmDD) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}`;
  }
  // "Jun 27, 2026"
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function humanizeField(field) {
  if (!field) return 'change';
  // snake_case → Title Case
  return String(field)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// LIVE PANEL — AI-suggested tickets
//
// Calls the same chat endpoint as Ask AI but with a structured prompt
// asking for JIRA-style tickets. The reply is JSON (with some flexibility
// for markdown-wrapped responses); tickets render as pillboxes, click to
// expand a description + "Add to Tasks" action.
// ============================================================================

const TICKETS_PROMPT = `Based on this community's pain points and recent feedback, suggest 6 JIRA-style tickets a developer should work on next to improve this game.

For each ticket provide:
- title: a short, action-oriented name (50 chars max)
- description: 1-3 sentences explaining what to build or fix and why it matters to the community
- type: one of "bug", "feature", or "improvement"
- priority: one of "high", "medium", or "low"

Respond ONLY with JSON in this exact shape, no prose before or after:
{"tickets": [{"title": "...", "description": "...", "type": "bug", "priority": "high"}]}`;

async function loadLiveTickets() {
  if (!window.farnsworth || !window.farnsworth.liveChat) return;
  state.liveTicketsLoading = true;
  state.liveTicketsError = null;
  state.liveTicketsRawReply = null;
  renderRightPanel();

  // Send as a single user message. The server prepends its own system
  // prompt built from the game/sentiment/posts context, so we just ask
  // for structured output.
  const res = await Promise.race([
    window.farnsworth.liveChat(getLiveGameId(), {
      message: TICKETS_PROMPT,
    }),
    new Promise((resolve) => setTimeout(() => resolve({
      ok: false, error: 'timeout',
      message: `Tickets request timed out after ${state.liveTimeoutSeconds}s. The AI analyst may be slow.`,
    }), state.liveTimeoutSeconds * 1000)),
  ]);
  state.liveTicketsLoading = false;

  if (!res.ok) {
    state.liveTicketsError = {
      message: res.message || res.error || 'Chat failed',
      status: res.status,
    };
    renderRightPanel();
    return;
  }

  const reply = (res.data && res.data.reply) || '';
  const parsed = parseTicketsFromReply(reply);
  if (parsed.ok) {
    state.liveTickets = parsed.tickets;
    state.liveTicketsRawReply = null;
    // Persist to SQLite so the next mount doesn't need to re-prompt.
    window.farnsworth.liveTicketsSave(getLiveGameId(), parsed.tickets, null);
  } else {
    // JSON parse failed — keep the raw reply so we can show it as a
    // fallback so Long isn't left staring at an empty section.
    state.liveTickets = [];
    state.liveTicketsRawReply = reply || '(empty reply)';
    window.farnsworth.liveTicketsSave(getLiveGameId(), [], reply);
  }
  renderRightPanel();
}

// Load cached tickets from SQLite. Returns true if a cache hit was
// applied (so the caller can skip the auto-generate step).
async function loadCachedLiveTickets() {
  if (!window.farnsworth || !window.farnsworth.liveTicketsGet) return false;
  const res = await window.farnsworth.liveTicketsGet(getLiveGameId());
  if (!res || !res.ok || !res.cached) return false;
  const { tickets, rawReply } = res.cached;
  state.liveTickets = Array.isArray(tickets) ? tickets : [];
  state.liveTicketsRawReply = rawReply || null;
  state.liveTicketsError = null;
  return state.liveTickets.length > 0 || state.liveTicketsRawReply;
}

// Refresh button — wipe cache, force regenerate.
async function refreshLiveTickets() {
  if (!window.farnsworth || !window.farnsworth.liveTicketsClear) return;
  await window.farnsworth.liveTicketsClear(getLiveGameId());
  loadLiveTickets();
}

// Pull a {tickets: [...]} JSON object out of an AI reply. Tolerates
// ```json fences, leading prose, and trailing commentary. Returns
// {ok: true, tickets} or {ok: false} — caller decides the fallback.
function parseTicketsFromReply(text) {
  if (!text) return { ok: false };
  // Try the whole string first.
  const direct = tryParseJson(text);
  if (direct && Array.isArray(direct.tickets)) {
    return { ok: true, tickets: normalizeTickets(direct.tickets) };
  }
  // Otherwise look for a JSON object inside ```json ... ``` or anywhere.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inside = tryParseJson(fence[1]);
    if (inside && Array.isArray(inside.tickets)) {
      return { ok: true, tickets: normalizeTickets(inside.tickets) };
    }
  }
  // Last attempt: find the first balanced {...} block.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    const obj = tryParseJson(slice);
    if (obj && Array.isArray(obj.tickets)) {
      return { ok: true, tickets: normalizeTickets(obj.tickets) };
    }
  }
  return { ok: false };
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function normalizeTickets(raw) {
  const validTypes = new Set(['bug', 'feature', 'improvement']);
  // Accept both 'med' and 'medium' from the AI — CSS uses task__priority--med.
  const validPriorities = new Set(['high', 'med', 'medium', 'low']);
  return raw.slice(0, 12).map((t, i) => {
    const pri = t.priority === 'medium' ? 'med' : t.priority;
    return {
      id: `t-${Date.now()}-${i}`,
      title: String(t.title || 'Untitled ticket').slice(0, 100),
      description: String(t.description || '').slice(0, 600),
      type: validTypes.has(t.type) ? t.type : 'improvement',
      priority: validPriorities.has(pri) ? pri : 'med',
    };
  });
}

function ticketTypeIcon(type) {
  if (type === 'bug') return '🐛';
  if (type === 'feature') return '✨';
  return '🔧';
}

function ticketPriorityColor(p) {
  if (p === 'high') return '#f23f43';
  if (p === 'medium' || p === 'med') return '#f0b232';
  return '#3ba55c';
}

function ticketToTask(t, gameId) {
  // Push into the workspace tasks list. No workspace path means the
  // task won't be persisted to SQLite, but it will render in the UI.
  // We attach the game id in the detail field so Long can trace it back.
  return {
    id: `live-${t.id}`,
    title: `[${t.type}] ${t.title}`,
    status: 'todo',
    priority: t.priority,
    file: null,
    assignee: 'blue',
    live: true,
    detail: t.description + (gameId ? `\n\nSource: anomalyint.vercel.app game ${gameId}` : ''),
  };
}

function renderLiveTickets(s) {
  const wrap = el('div', { class: 'live__section live__tickets' });
  const hasTickets = state.liveTickets && state.liveTickets.length > 0;
  const loading = state.liveTicketsLoading;
  const err = state.liveTicketsError;
  const rawReply = state.liveTicketsRawReply;

  // Pre-compute which tickets are already in state.tasks so we can show
  // them as "added" with a filled check-circle (mirrors the tasks panel
  // visual language). DB-backed tasks have INTEGER ids from SQLite
  // auto-increment — the old `live-` prefix pattern on task.id no longer
  // applies. Linkage now lives on task.source (`live-<gameId>`) and
  // task.title (`[<type>] <ticket.title>`). Defensive typeof guards so a
  // bad row can't blank the whole panel again.
  const liveTaskTitles = new Set(
    (Array.isArray(state.tasks) ? state.tasks : [])
      .filter(t => t && typeof t.source === 'string' && t.source.startsWith('live-') && typeof t.title === 'string')
      .map(t => t.title)
  );

  wrap.innerHTML = `
    <div class="live__tickets-head">
      <div class="live__section-title">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
        Suggested Tickets
      </div>
      <button class="live__tickets-refresh" title="Regenerate from latest community data">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>
      </button>
    </div>
    <p class="live__desc-caption">AI-generated JIRA-style tickets from the community's pain points and feedback. Click to expand; ＋ to add to your tasks.</p>
    ${loading ? `
      <div class="live__tickets-loading">
        <div class="live__loading-spinner" aria-hidden="true"></div>
        <span>Asking the analyst to suggest tickets…</span>
      </div>
    ` : ''}
    ${err ? `
      <div class="live__tickets-error">
        <div class="live__tickets-error-msg">⚠️ ${escapeHtml(err.message)}${err.status ? ` (HTTP ${err.status})` : ''}</div>
        <button class="live__tickets-retry">Retry</button>
      </div>
    ` : ''}
    ${rawReply && !loading ? `
      <div class="live__tickets-raw">
        <div class="live__tickets-raw-label">Couldn't parse JSON — showing raw reply:</div>
        <pre class="live__tickets-raw-text">${escapeHtml(rawReply)}</pre>
        <button class="live__tickets-retry">Retry</button>
      </div>
    ` : ''}
    ${hasTickets ? `
      <div class="live__tickets-list">
        ${state.liveTickets.map(t => {
          const expanded = state.liveTicketsExpanded.has(t.id);
          const ticketSig = `[${t.type}] ${t.title}`;
          const added = liveTaskTitles.has(ticketSig);
          return `
            <div class="task live__ticket live__ticket--${t.type}${expanded ? ' is-expanded' : ''}${added ? ' is-added' : ''}" data-ticket-id="${escapeHtml(t.id)}">
              <div class="task__check" data-ticket-toggle>
                ${added ? '<svg class="task__check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3ba55c"/><path d="M8 12.5l2.5 2.5 5-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg class="task__check-circle" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>'}
              </div>
              <div class="task__body">
                <div class="task__title">${ticketTypeIcon(t.type)} ${escapeHtml(t.title)}</div>
                <div class="task__meta">
                  <span class="task__meta-item">
                    <span class="task__priority-dot task__priority--${escapeHtml(t.priority)}"></span>
                    ${escapeHtml((t.priority === 'med' ? 'Medium' : t.priority.charAt(0).toUpperCase() + t.priority.slice(1)))} priority
                  </span>
                  <span class="task__meta-item live__ticket-type-label">${escapeHtml(t.type)}</span>
                  <span class="live__ticket-expand-hint">${expanded ? '▾ hide details' : '▸ show details'}</span>
                </div>
                ${expanded ? `
                  <div class="live__ticket-body">
                    <p class="live__ticket-desc">${escapeHtml(t.description)}</p>
                    <div class="live__ticket-actions">
                      ${added
                        ? '<span class="live__ticket-added-flag">✓ In your tasks list</span>'
                        : '<button class="tasks__new-btn live__ticket-add" data-ticket-add>＋ Add to Tasks</button>'}
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
    ${!hasTickets && !loading && !err && !rawReply ? `
      <div class="live__tickets-empty">
        <div class="live__tickets-empty-text">No ticket suggestions yet.</div>
        <button class="tasks__new-btn live__tickets-generate">Generate suggestions</button>
      </div>
    ` : ''}
  `;

  // Wire up section-level buttons
  wrap.querySelector('.live__tickets-refresh')?.addEventListener('click', refreshLiveTickets);
  wrap.querySelector('.live__tickets-retry')?.addEventListener('click', loadLiveTickets);
  wrap.querySelector('.live__tickets-generate')?.addEventListener('click', loadLiveTickets);

  // Toggle expand on the check circle or anywhere in the row (not on
  // the Add-to-Tasks button — that's its own click target).
  wrap.querySelectorAll('[data-ticket-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const li = btn.closest('.live__ticket');
      const id = li?.dataset.ticketId;
      if (!id) return;
      if (state.liveTicketsExpanded.has(id)) state.liveTicketsExpanded.delete(id);
      else state.liveTicketsExpanded.add(id);
      renderRightPanel();
    });
  });
  // Click anywhere else in the row to toggle too (except buttons).
  wrap.querySelectorAll('.live__ticket').forEach(li => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-ticket-add]')) return;
      if (e.target.closest('[data-ticket-toggle]')) return;
      const id = li.dataset.ticketId;
      if (!id) return;
      if (state.liveTicketsExpanded.has(id)) state.liveTicketsExpanded.delete(id);
      else state.liveTicketsExpanded.add(id);
      renderRightPanel();
    });
  });
  // Add-to-Tasks: write to DB via persistNewTask (was only unshifting to
  // in-memory state, which lost the row on reload). Use the ticket id as
  // the task id so duplicate-adds are no-ops.
  wrap.querySelectorAll('[data-ticket-add]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const li = btn.closest('.live__ticket');
      const id = li?.dataset.ticketId;
      const ticket = state.liveTickets.find(x => x.id === id);
      if (!ticket) return;
      const gameId = state.liveGame?.id || '';
      const task = ticketToTask(ticket, gameId);
      // Dedup by title signature (DB-backed tasks have integer ids —
      // comparing task.id as a string to integer ids always failed).
      const ticketSig = `[${ticket.type}] ${ticket.title}`;
      if (!state.tasks.find(t => t.title === ticketSig)) {
        persistNewTask({
          title: task.title,
          detail: task.detail,
          priority: ticket.priority,
          source: `live-${gameId}`,
          assignee: 'blue',
          fileLink: null,
        });
      }
      // Don't toggle expand on this click.
      renderRightPanel();
    });
  });

  return wrap;
}

// ============================================================
// STATUS BAR (Jul 14) — was static mock HTML; now every chip is live.
// Sources: state.auth (connection) · git:branch IPC (branch) ·
// state.files.current (path) · settings.memory (stages) · state.session
// (router count, last-turn usage, memory stats) · settings.defaultModel.
// ============================================================
function modelContextWindow(display) {
  const opt = CHAT_MODEL_OPTIONS.find(o => o.display === display);
  return opt && /1M/i.test(opt.desc || '') ? 1000000 : 200000;
}

function updateStatusBar() {
  const $id = (i) => document.getElementById(i);
  if (!$id('sb-conn')) return;

  // Connection = whether Farnsworth can call Claude right now.
  const a = state.auth || {};
  const src = a.oauthConnected ? 'Claude.ai sign-in'
    : (a.claudeCodeAvailable ? 'Claude Code CLI' : (a.apiKeySet ? 'API key' : null));
  $id('sb-conn').classList.toggle('is-off', !src);
  $id('sb-conn-label').textContent = src ? 'Connected' : 'No auth';
  $id('sb-conn').title = src ? `Claude auth: ${src}` : 'No Claude credentials — open Settings → AI';

  // Git branch (hidden when the open folder isn't a repo).
  const g = state.git || {};
  $id('sb-branch').hidden = !g.branch;
  $id('sb-branch-sep').hidden = !g.branch;
  if (g.branch) {
    $id('sb-branch-name').textContent = g.branch + (g.dirty ? '*' : '');
    $id('sb-branch').title = g.dirty ? `On ${g.branch} — uncommitted changes` : `On ${g.branch} — working tree clean`;
  }

  // Active file (hidden until a file is open).
  const p = state.files?.current || '';
  $id('status-path').textContent = p;
  $id('sb-path-sep').hidden = !p;

  // Memory pipeline: enabled stages / total.
  const mem = state.settings?.memory || {};
  const stages = Object.values(mem).filter(v => v && typeof v === 'object' && 'enabled' in v);
  const on = stages.filter(v => v.enabled).length;
  const ms = state.session.memStats;
  $id('sb-mem').textContent = `mem: ${on}/${stages.length} stages`;
  $id('sb-mem').title = `Memory pipeline: ${on} of ${stages.length} stages enabled`
    + (ms ? ` · ${ms.sectionsCount} sections in store` : '') + ' — click for Memory settings';

  // Routed model calls this session (titles/commit/review call sites).
  $id('sb-router').textContent = `router: ${state.session.routedCalls} routed`;
  $id('sb-router').title = 'Per-call-site routed model calls this session — click for AI settings';

  // Context gauge: last chat turn vs the default model's window.
  const u = state.session.lastUsage;
  if (u) {
    const win = modelContextWindow(state.settings?.defaultModel);
    const used = (u.input_tokens || 0) + (u.output_tokens || 0);
    const pct = Math.min(99, Math.max(1, Math.round(used / win * 100)));
    $id('sb-ctx').textContent = `ctx ${pct}%`;
    $id('sb-ctx').title = `Last chat turn: ${(u.input_tokens || 0).toLocaleString()} in + ${(u.output_tokens || 0).toLocaleString()} out · ${win.toLocaleString()}-token window`;
  } else {
    $id('sb-ctx').textContent = 'ctx —';
    $id('sb-ctx').title = 'No chat turns yet this session';
  }

  // Extraction buffer: facts captured, awaiting consolidation.
  $id('sb-extracted-label').textContent = ms ? `${ms.bufferCount} in buffer` : '…';
  $id('sb-extracted').title = ms
    ? `${ms.bufferCount} extracted memory items awaiting consolidation · ${ms.sectionsCount} consolidated sections — click for Memory settings`
    : 'Memory stats loading…';

  // Default chat model.
  $id('sb-model').textContent = state.settings?.defaultModel || '—';
  $id('sb-model').title = 'Default chat model — click for AI settings';

  // Chat input model picker (Jul 14 ~09:20 ET) — the HTML is hardcoded
  // with named spans .chat__model-name / .chat__model-tier, so we just
  // rewrite their text. Runs on every updateStatusBar() so the chip
  // stays synced with the settings default.
  updateChatInputModelButton();
}

async function refreshGitBranch() {
  if (!window.farnsworth?.gitBranch) return;
  try {
    const res = state.folder ? await window.farnsworth.gitBranch({ cwd: state.folder }) : { ok: false };
    state.git = res.ok ? { branch: res.branch, dirty: res.dirty } : { branch: null, dirty: false };
  } catch { state.git = { branch: null, dirty: false }; }
  updateStatusBar();
}

async function refreshMemStats() {
  if (!window.farnsworth?.memoryStageStats) return;
  try {
    const res = await window.farnsworth.memoryStageStats();
    if (res?.ok) state.session.memStats = { bufferCount: res.bufferCount ?? 0, sectionsCount: res.sectionsCount ?? 0 };
  } catch {}
  updateStatusBar();
}

function wireStatusBar() {
  const map = { 'sb-mem': 'memory', 'sb-extracted': 'memory', 'sb-router': 'ai', 'sb-model': 'ai' };
  document.querySelector('.statusbar')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.statusbar__chip');
    if (chip && map[chip.id]) openSettings(map[chip.id]);
  });
  // Cheap polls for the two sources that change outside renderer events.
  setInterval(() => { refreshGitBranch(); refreshMemStats(); }, 60000);
  window.addEventListener('focus', refreshGitBranch);
}

function openFile(f) {
  // Update current file marker
  state.files.entries.forEach(x => { if (x.type === 'file') x.current = false; });
  f.current = true;
  state.files.current = f.path;
  state.codeFile = f.name;
  $('#canvas-file-name').textContent = f.name.replace(/\.(html|jsx|css|json|js|ts|tsx)$/, '');
  updateStatusBar(); // status bar reads state.files.current (set above)
  // Switch to code mode and open the file in Monaco
  if (['html','htm','jsx','tsx','js','mjs','cjs','ts','css','scss','less','json','jsonc','md','mdx','py','go','rs','rb','java','c','cpp','cc','h','hpp','sh','bash','zsh','yaml','yml','toml','ini','xml','svg','sql','txt'].includes(f.ext)) {
    state.canvasMode = 'code';
    renderCanvas();
    updateModeToggles();
    // Construct absolute path from workspace folder + relative path
    const absPath = state.folder ? state.folder + '/' + f.path : f.path;
    openFileByPath(absPath);
  } else {
    // Unknown ext: just switch to code mode without reading
    state.canvasMode = 'code';
    renderCanvas();
    updateModeToggles();
  }
  renderRightPanel();
}

// ============================================================================
// SETTINGS OVERLAY
// ============================================================================
function openSettings(page) {
  if (page && typeof page === 'string') state.settingsPage = page;
  state.settingsOpen = true;
  $('#settings-overlay').hidden = false;
  // WebContentsView composites ABOVE the DOM — z-index can't put the
  // settings overlay on top of the canvas preview (same layer bug as the
  // Devvit config popover, Jul 10). Hide views while settings is open.
  hideAllCanvasViews();
  renderSettings();
}
function closeSettings() {
  state.settingsOpen = false;
  $('#settings-overlay').hidden = true;
  showAllCanvasViews();
}

function renderSettings() {
  $$('.settings__rail-item').forEach(item => item.classList.toggle('is-active', item.dataset.page === state.settingsPage));
  const pane = $('#settings-pane');
  pane.innerHTML = '';

  if (state.settingsPage === 'ai') pane.appendChild(renderAISettings());
  else if (state.settingsPage === 'memory') pane.appendChild(renderMemorySettings());
  else if (state.settingsPage === 'canvas') pane.appendChild(renderCanvasSettings());
  else if (state.settingsPage === 'workspace') pane.appendChild(renderWorkspaceSettings());
  else if (state.settingsPage === 'appearance') pane.appendChild(renderAppearanceSettings());
  else if (state.settingsPage === 'account') pane.appendChild(renderAboutSettings());
}

function renderAISettings() {
  const s = state.settings;
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:24px;"><div class="settings-page__title">AI</div><div class="settings-page__sub">Authentication, the chat model, and per-call-site cost routing.</div></div>

    <div class="settings-section" id="ai-auth-section">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:13px;">
        <div class="settings-section__title" style="margin-bottom:0;">Anthropic</div>
        <span class="settings-info-wrap">
          <button class="settings-info-btn" data-info="How Farnsworth calls Claude. Credentials stay encrypted in the macOS Keychain and never leave this machine." title="About">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
          </button>
        </span>
      </div>
    </div>

    <div class="settings-section" id="ai-openai-section">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:13px;">
        <div class="settings-section__title" style="margin-bottom:0;">OpenAI</div>
        <span class="settings-info-wrap">
          <button class="settings-info-btn" data-info="Credentials for ChatGPT/Codex integrations. Stored encrypted in the macOS Keychain. Chat inference currently runs on Claude — this key is picked up by OpenAI-powered features as they land." title="About">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
          </button>
        </span>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section__title">Default model</div>
      <div class="settings-section__desc">Used for the main chat thread unless a call-site overrides it below.</div>
      <button class="model-dropdown" id="ai-model-picker-btn">
        <span class="model-dropdown__dot"></span>
        ${s.defaultModel.replace(' High', '')}
        ${s.defaultModel.includes('High') ? '<span class="model-dropdown__tier">High</span>' : ''}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#80848e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:14px;"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>

    <div class="settings-section">
      <div class="settings-section__title">Testing model</div>
      <div class="settings-section__desc">Used by test-runner <code>llm-step</code> visual checks unless a step's <code>model</code> field overrides it. Smaller = faster steps; Haiku is usually enough for YES/NO screenshot judgments.</div>
      <button class="model-dropdown" id="ai-testing-model-btn">
        <span class="model-dropdown__dot"></span>
        ${(s.testingModel || 'Sonnet 5').replace(' High', '')}
        ${(s.testingModel || '').includes('High') ? '<span class="model-dropdown__tier">High</span>' : ''}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#80848e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:14px;"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>

    <div class="settings-section">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:13px;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="settings-section__title">Per-call-site model routing</div>
            <span class="settings-pill settings-pill--cost">COST CONTROL</span>
          </div>
          <div class="settings-section__desc">Route small tasks to small models. ~50× cost difference vs Opus, negligible quality loss. Every row below is a real call site — memory pipeline stages have their own model pickers on the Memory page.</div>
        </div>
        <button id="routing-reset-btn" style="font-size:11.5px;font-weight:600;color:#3ab7f0;background:none;border:none;cursor:pointer;white-space:nowrap;">Reset defaults</button>
      </div>
      <div class="routing-table"></div>
    </div>
  `;

  // Build the Claude auth section content
  const authSection = wrap.querySelector('#ai-auth-section');
  if (authSection) {
    // Section 1: Claude.ai OAuth (preferred — uses subscription)
    const oauthRow = el('div', { class: 'apikey-row' });
    const oauthConnected = state.auth.oauthConnected;
    const oauthExpiresIn = state.auth.oauthExpiresInSec;
    // Three connected states: OAuth (claude.ai flow), Claude Code CLI
    // (Keychain), or disconnected. Both connected states give Farnsworth a
    // valid Claude token; the difference is just where it lives.
    const claudeCodeAuthed = state.auth.claudeCodeAvailable && !oauthConnected;
    oauthRow.innerHTML = `
      <div class="apikey-row__label">
        <div class="apikey-row__label-main">
          Claude subscription
          <span class="settings-pill settings-pill--v23">RECOMMENDED</span>
        </div>
        <div class="apikey-row__label-sub">Use your Claude Pro/Max subscription. Tokens auto-refresh.</div>
      </div>
      <div class="apikey-row__field" id="oauth-field">
        ${state.auth.oauthInProgress
          ? oauthInProgressHTML()
          : (oauthConnected
            ? oauthConnectedHTML(oauthExpiresIn)
            : (claudeCodeAuthed
              ? claudeCodeConnectedHTML(state.auth.claudeCodeSubscriptionType, state.auth.claudeCodeExpiresAt)
              : oauthDisconnectedHTML()))}
      </div>
    `;
    authSection.appendChild(oauthRow);

    // Section 2: Manual API key (fallback for power users)
    const apiKeyRow = el('div', { class: 'apikey-row' });
    apiKeyRow.innerHTML = `
      <div class="apikey-row__label">
        <div class="apikey-row__label-main">Anthropic API key</div>
        <div class="apikey-row__label-sub">Paid console.anthropic.com key. Use this if you don't have a Claude.ai subscription.</div>
      </div>
      <div class="apikey-row__field">
        <input type="password" id="ai-apikey-input" class="apikey-input" placeholder="sk-ant-api03-…" autocomplete="off" />
        <button class="btn btn--primary btn--sm" id="ai-apikey-save">Save</button>
        ${state.auth.apiKeySet ? '<button class="btn btn--ghost btn--sm" id="ai-apikey-clear">Remove</button>' : ''}
      </div>
      ${state.auth.apiKeySet ? '<div class="apikey-row__status is-set"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>API key saved</div>' : '<div class="apikey-row__status is-missing"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>No API key · optional — only needed if not using subscription</div>'}
    `;
    authSection.appendChild(apiKeyRow);

    // Section 3: Claude Code CLI detection — only rendered when it adds
    // information. When signed in VIA the CLI (claudeCodeAuthed), row 1's
    // status already says "Signed in via Claude Code CLI"; repeating it
    // here was pure duplication (Jul 14 copy-bloat trim).
    if (!claudeCodeAuthed) {
      const ccRow = el('div', { class: 'apikey-row' });
      ccRow.innerHTML = `
        <div class="apikey-row__label">
          <div class="apikey-row__label-main">Claude Code CLI auth</div>
          <div class="apikey-row__label-sub">Detects an existing CLI login in the OS credential store.</div>
        </div>
        <div class="apikey-row__field">
          ${state.auth.claudeCodeAvailable
            ? '<div class="apikey-row__status is-set"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Claude Code CLI logged in</div>'
            : '<div class="apikey-row__status is-missing"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>No Claude Code CLI login found</div>'}
        </div>
      `;
      authSection.appendChild(ccRow);
    }
  }

  // Build the OpenAI section content (Jul 14). Same honest rules as the
  // Anthropic section: the key row stores a real encrypted credential
  // (provider 'openai-api'), the Codex row reports a real ~/.codex/auth.json
  // read — nothing decorative.
  const openaiSection = wrap.querySelector('#ai-openai-section');
  if (openaiSection) {
    const oaKeyRow = el('div', { class: 'apikey-row' });
    oaKeyRow.innerHTML = `
      <div class="apikey-row__label">
        <div class="apikey-row__label-main">OpenAI API key</div>
        <div class="apikey-row__label-sub">platform.openai.com key for ChatGPT/Codex features.</div>
      </div>
      <div class="apikey-row__field">
        <input type="password" id="ai-openai-key-input" class="apikey-input" placeholder="sk-…" autocomplete="off" />
        <button class="btn btn--primary btn--sm" id="ai-openai-key-save">Save</button>
        ${state.auth.openaiKeySet ? '<button class="btn btn--ghost btn--sm" id="ai-openai-key-clear">Remove</button>' : ''}
      </div>
      ${state.auth.openaiKeySet
        ? '<div class="apikey-row__status is-set"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>API key saved</div>'
        : '<div class="apikey-row__status is-missing"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>No API key</div>'}
    `;
    openaiSection.appendChild(oaKeyRow);

    const codexRow = el('div', { class: 'apikey-row' });
    const codexLabel = state.auth.codexAvailable
      ? ('Codex CLI logged in' + (state.auth.codexMethod === 'chatgpt' ? ' · ChatGPT account' : (state.auth.codexMethod === 'api_key' ? ' · API key' : '')))
      : 'No Codex CLI login found';
    codexRow.innerHTML = `
      <div class="apikey-row__label">
        <div class="apikey-row__label-main">Codex CLI auth</div>
        <div class="apikey-row__label-sub">Detects an existing CLI login at <code>~/.codex/auth.json</code>.</div>
      </div>
      <div class="apikey-row__field">
        ${state.auth.codexAvailable
          ? `<div class="apikey-row__status is-set"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>${codexLabel}</div>`
          : `<div class="apikey-row__status is-missing"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>${codexLabel}</div>`}
      </div>
    `;
    openaiSection.appendChild(codexRow);
  }

  const table = wrap.querySelector('.routing-table');
  const thead = el('div', { class: 'routing-table__head' });
  thead.innerHTML = '<span>CALL-SITE</span><span>MODEL</span><span>CONFIRM</span>';
  table.appendChild(thead);
  s.perCallSiteRouting.forEach(row => table.appendChild(makeRoutingRow(row)));
  // "Add call-site" removed (Jul 13): rows must map to real code paths —
  // a user-added row would be decorative by definition.

  // Reset defaults — restore ROUTING_CALL_SITES models/confirm flags.
  // Attached inside the render (rebuilt each renderSettings call), so the
  // wire()-once gotcha doesn't apply here.
  wrap.querySelector('#routing-reset-btn')?.addEventListener('click', () => {
    state.settings.perCallSiteRouting = ROUTING_CALL_SITES.map(r => ({ ...r }));
    persistSettings();
    renderSettings();
  });

  // Behavior / Verification / Streaming sections removed Jul 13 — they
  // persisted values with zero consumers since day 1 (dead-controls audit).
  // The chat always streams; safety prompts live in nono + Claude Code's
  // own trust dialog; verbosity is the model's job.

  return wrap;
}

function makeRoutingRow(row) {
  const el2 = el('div', { class: 'routing-row' });
  const modelColor = row.model.includes('Opus') ? '#a855f7' : row.model.includes('Sonnet') ? '#5865f2' : '#3ba55c';
  el2.innerHTML = `
    <div class="routing-row__name">
      <div class="routing-row__name-main">${row.name}</div>
      ${row.savings ? '<div class="routing-row__name-save">' + row.savings + '</div>' : ''}
      ${row.desc ? '<div class="routing-row__name-desc">' + row.desc + '</div>' : ''}
    </div>
    <div class="routing-row__model">
      <button class="model-dropdown" data-routing-model="${row.id}" style="width:148px;font-size:11.5px;padding:5px 9px;">
        <span class="model-dropdown__dot" style="background:${modelColor}"></span>
        ${row.model}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#80848e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    <div class="routing-row__confirm"></div>
  `;
  // Model dropdown — reuses the generic picker in callback mode; the row
  // owns the write + persist + re-render.
  const modelBtn = el2.querySelector('[data-routing-model]');
  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(modelBtn, null, (display) => {
      const live = routingRow(row.id);
      if (live) live.model = display;
      persistSettings();
      renderSettings();
    }, row.model);
  });
  // Confirm toggle only renders for call sites where it means something
  // (commit: show the message + Commit/Cancel chips in chat before running
  // `git commit`). Read-only call sites show a muted "auto".
  const confirmCell = el2.querySelector('.routing-row__confirm');
  if ('confirm' in row) {
    const toggle = el('div', { class: 'toggle' + (row.confirm ? ' is-on' : '') });
    toggle.appendChild(el('div', { class: 'toggle__thumb' }));
    toggle.addEventListener('click', () => {
      const live = routingRow(row.id);
      if (live) live.confirm = !live.confirm;
      persistSettings();
      renderSettings();
    });
    confirmCell.appendChild(toggle);
  } else {
    confirmCell.appendChild(el('span', { class: 'routing-row__auto' }, 'auto'));
  }
  return el2;
}

// makeBehaviorRow removed Jul 13 — its only consumers were the decorative
// Behavior verbosity/aggressiveness/confirmation rows (dead-controls audit).
// makeToggleRow STAYS: Canvas + Workspace settings pages use it (8 sites).

function makeToggleRow(title, desc, isOn, onChange) {
  const row = el('div', { class: 'toggle-row' });
  row.appendChild(el('div', { class: 'toggle-row__body' },
    el('div', { class: 'toggle-row__title' }, title),
    el('div', { class: 'toggle-row__desc' }, desc),
  ));
  const toggle = el('div', { class: 'toggle' + (isOn ? ' is-on' : '') });
  toggle.appendChild(el('div', { class: 'toggle__thumb' }));
  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('is-on');
    toggle.classList.toggle('is-on', next);
    if (onChange) onChange(next);
  });
  row.appendChild(toggle);
  return row;
}

function renderMemorySettings() {
  const m = state.settings.memory;
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:22px;">
      <div style="display:flex;align-items:center;gap:9px;">
        <div class="settings-page__title">Memory</div>
        <span class="settings-pill settings-pill--v23">TIER 3 · LIVE</span>
      </div>
      <div class="settings-page__sub">Six-stage pipeline over the SQLite store. Every-turn stages (extraction, router, section selector) run on a cheap model; consolidation, retrospective and recall re-ranking run on a stronger one. A zero-cost keyword gate skips the router on no-signal turns. Every stage degrades to its non-model fallback when disabled.</div>
    </div>
  `;
  wrap.appendChild(makeMemoryStage(1, 'Extraction', 'extraction', m.extraction,
    'Runs after each turn. Distills the exchange into one-line durable facts before they enter the buffer; the raw turn always lands in the daily archive. Disabled: raw text is buffered unfiltered.'));
  wrap.appendChild(makeMemoryStage(2, 'Consolidation', 'consolidation', m.consolidation,
    'Merges buffered facts into concept articles (appending under section headings), promotes identity-level facts to essentials, drops noise. Runs on the schedule, at the buffer threshold, or manually. Disabled: consolidate just flips buffer flags.'));
  wrap.appendChild(makeMemoryStage(3, 'Retrieval', 'retrieval', m.retrieval,
    'Re-ranks recall results (concepts + sections) by relevance when memory is searched. Disabled: raw FTS5 order.'));
  wrap.appendChild(makeMemoryStage(4, 'Memory Router', 'router', m.router,
    'Every turn: picks which concept articles to load for the new message, up to the budget. Keeps context bounded as the corpus grows. Disabled: recent-concepts preamble on the first message only.'));
  wrap.appendChild(makeMemoryStage(5, 'Section Selector', 'l2selector', m.l2selector,
    'Stage two of routing: picks the relevant sections inside routed articles so whole articles never flood context. The article lead is always included. Disabled: whole articles are injected.'));
  wrap.appendChild(makeMemoryStage(6, 'Retrospective', 'retrospective', m.retrospective,
    'Re-reads a conversation once it goes quiet and captures what per-turn extraction missed — arcs, decisions, corrections. Output lands in the buffer like any other fact. Disabled: only live extraction feeds the buffer.'));

  // Per-stage run stats — filled in async once the IPC resolves.
  if (window.farnsworth?.memoryStageStats) {
    window.farnsworth.memoryStageStats().then((r) => {
      if (!r || !r.ok) return;
      for (const key of ['extraction', 'consolidation', 'retrieval', 'router', 'l2selector', 'retrospective']) {
        const target = wrap.querySelector(`[data-stage-stats="${key}"]`);
        if (!target) continue;
        const s = r.stats && r.stats[key];
        if (!s || !s.lastRun) { target.textContent = 'no runs yet'; continue; }
        const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.lastRun)) / 60000));
        const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
        target.textContent = `${s.runs || 0} runs · last ${ago} · ${s.ms}ms · ${s.model}${s.lastError ? ' · error: ' + String(s.lastError).slice(0, 60) : ''}`;
        const extras = [s.gateSkips ? `${s.gateSkips} gate-skips` : null, s.noiseSkips ? `${s.noiseSkips} noise-skips` : null].filter(Boolean);
        if (extras.length) target.textContent += ' · ' + extras.join(' · ');
        if (s.lastError) target.style.color = 'var(--error)';
      }
      const bufEl = wrap.querySelector('[data-stage-buffer]');
      if (bufEl) bufEl.textContent = `${r.bufferCount} in buffer · ${r.sectionsCount} sections indexed`;
    }).catch(() => {});
  }

  // ---- Farnsworth Memory (Tier 1, Jul 5 2026) ----
  // Below the legacy V2/V3 pipeline UI: the actual SQLite-backed memory
  // store (essentials + concepts + buffer + archive). Edit/delete/add
  // here. Bootstrap + recall IPCs feed into the chat panel via the
  // always-loaded essentials.
  // Rendered async (data fetched via IPC); renderSettings() also triggers
  // an async re-render below that re-attaches the loaded section once the
  // IPCs resolve.
  const fmem = el('div', { id: 'memory-farnsworth-section', style: 'min-height:120px;' });
  fmem.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;padding:18px 0;' }, 'Loading Farnsworth memory store…'));
  wrap.appendChild(fmem);
  // Fetch and re-render once the data is in.
  makeMemoryContentsSection().then((section) => {
    if (fmem.parentNode) {
      fmem.parentNode.replaceChild(section, fmem);
    }
  }).catch((e) => {
    console.warn('[memory] failed to render contents:', e);
    fmem.innerHTML = '<div style="color:var(--error);font-size:12px;padding:18px 0;">Failed to load memory store: ' + (e?.message || e) + '</div>';
  });
  return wrap;
}

async function makeMemoryContentsSection() {
  const sec = el('div', { class: 'memory-stage', style: 'margin-top:18px;' });
  sec.appendChild(el('div', { class: 'memory-stage__head' },
    el('div', { class: 'memory-stage__body' },
      el('div', { class: 'memory-stage__name-row' },
        el('span', { class: 'memory-stage__num' }, '★'),
        el('span', { class: 'memory-stage__name' }, 'Farnsworth Memory (Tier 1)'),
      ),
      el('div', { class: 'memory-stage__desc' },
        'SQLite-backed memory store. Essentials are injected at conversation start. Concepts are long-form wiki articles. Buffer holds raw facts awaiting consolidation. Archive is the immutable daily log.'),
    ),
  ));

  // Essentials list
  const essBlock = el('div', { class: 'memory-stage__row', style: 'flex-direction:column;align-items:stretch;gap:6px;' });
  essBlock.appendChild(el('div', { class: 'memory-stage__label' }, 'ESSENTIALS (always-loaded)'));
  let essentials = [];
  try { essentials = await window.farnsworth.memoryEssentials(); } catch (e) { console.warn('[memory] essentials failed:', e); }
  if (!essentials.length) {
    essBlock.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;padding:6px 0;' }, '(no essentials yet — add one below)'));
  } else {
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
    for (const e of essentials) {
      const row = el('div', { style: 'display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--bg-elevated);border-radius:4px;' });
      row.appendChild(el('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--accent);min-width:140px;' }, e.key));
      row.appendChild(el('span', { style: 'font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;' }, e.value));
      const del = el('button', { class: 'memory-stage__chip', title: 'Delete' }, '×');
      del.addEventListener('click', async () => {
        await window.farnsworth.memoryEssentialDelete(e.key);
        renderSettings();
      });
      row.appendChild(del);
      list.appendChild(row);
    }
    essBlock.appendChild(list);
  }
  // Add form
  const addRow = el('div', { style: 'display:flex;gap:6px;margin-top:6px;' });
  const keyInput = el('input', { type: 'text', placeholder: 'key (e.g. long_prefers_pithy)', style: 'flex:0 0 180px;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-family:var(--mono);font-size:11px;' });
  const valInput = el('input', { type: 'text', placeholder: 'value', style: 'flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;' });
  const addBtn = el('button', { class: 'memory-stage__chip is-active' }, '+ Add');
  addBtn.addEventListener('click', async () => {
    const k = keyInput.value.trim(); const v = valInput.value.trim();
    if (!k || !v) return;
    await window.farnsworth.memoryEssentialSet(k, v, 'manual', 1.0);
    keyInput.value = ''; valInput.value = '';
    renderSettings();
  });
  addRow.appendChild(keyInput); addRow.appendChild(valInput); addRow.appendChild(addBtn);
  essBlock.appendChild(addRow);
  sec.appendChild(essBlock);

  // Concepts list (slugs only for the overview; full editor is a future panel)
  const conBlock = el('div', { class: 'memory-stage__row', style: 'flex-direction:column;align-items:stretch;gap:6px;margin-top:14px;' });
  conBlock.appendChild(el('div', { class: 'memory-stage__label' }, 'CONCEPTS (long-form articles)'));
  let concepts = [];
  try { concepts = await window.farnsworth.memoryList(50); } catch (e) { console.warn('[memory] concepts failed:', e); }
  if (!concepts.length) {
    conBlock.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;padding:6px 0;' }, '(no concepts yet)'));
  } else {
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto;' });
    for (const c of concepts) {
      const row = el('div', { style: 'display:flex;gap:6px;align-items:center;padding:6px 8px;background:var(--bg-elevated);border-radius:4px;' });
      row.appendChild(el('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--accent);min-width:140px;' }, c.slug));
      row.appendChild(el('span', { style: 'font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;' }, c.title));
      const view = el('button', { class: 'memory-stage__chip' }, 'view');
      view.addEventListener('click', async () => {
        const full = await window.farnsworth.memoryGet(c.slug);
        alert(`${full.slug}\n\n${full.lead || '(no lead)'}\n\n${full.body ? full.body.slice(0, 800) + (full.body.length > 800 ? '...' : '') : '(no body)'}`);
      });
      const del = el('button', { class: 'memory-stage__chip', title: 'Delete' }, '×');
      del.addEventListener('click', async () => {
        if (confirm(`Delete concept "${c.slug}"?`)) {
          await window.farnsworth.memoryDelete(c.slug);
          renderSettings();
        }
      });
      row.appendChild(view); row.appendChild(del);
      list.appendChild(row);
    }
    conBlock.appendChild(list);
  }
  // Add-concept form
  const addCon = el('div', { style: 'display:grid;grid-template-columns:140px 1fr 1fr auto;gap:6px;margin-top:6px;align-items:center;' });
  const slugInput = el('input', { type: 'text', placeholder: 'slug', style: 'padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-family:var(--mono);font-size:11px;' });
  const titleInput = el('input', { type: 'text', placeholder: 'title', style: 'padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;' });
  const leadInput = el('input', { type: 'text', placeholder: 'lead (1-paragraph summary)', style: 'padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:12px;' });
  const addConBtn = el('button', { class: 'memory-stage__chip is-active' }, '+ Add');
  addConBtn.addEventListener('click', async () => {
    const s = slugInput.value.trim(); const t = titleInput.value.trim(); const l = leadInput.value.trim();
    if (!s || !t) return;
    await window.farnsworth.memorySet({ slug: s, title: t, lead: l || null, body: null, sections: [], tags: [], source: 'manual', confidence: 1.0 });
    slugInput.value = ''; titleInput.value = ''; leadInput.value = '';
    renderSettings();
  });
  addCon.appendChild(slugInput); addCon.appendChild(titleInput); addCon.appendChild(leadInput); addCon.appendChild(addConBtn);
  conBlock.appendChild(addCon);
  sec.appendChild(conBlock);

  // Buffer + consolidate
  const bufBlock = el('div', { class: 'memory-stage__row', style: 'flex-direction:column;align-items:stretch;gap:6px;margin-top:14px;' });
  bufBlock.appendChild(el('div', { class: 'memory-stage__label' }, 'BUFFER (raw facts awaiting consolidation)'));
  let buf = [];
  try { buf = await window.farnsworth.memoryBuffer(true, 20); } catch (e) { console.warn('[memory] buffer failed:', e); }
  if (!buf.length) {
    bufBlock.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;padding:6px 0;' }, '(buffer empty — chat will append as it learns)'));
  } else {
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:200px;overflow:auto;' });
    for (const b of buf) {
      const row = el('div', { style: 'display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--bg-elevated);border-radius:4px;font-size:12px;' });
      row.appendChild(el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;' }, b.content));
      const conBtn = el('button', { class: 'memory-stage__chip' }, 'consolidate');
      conBtn.addEventListener('click', async () => {
        await window.farnsworth.memoryConsolidate([b.id]);
        renderSettings();
      });
      row.appendChild(conBtn);
      list.appendChild(row);
    }
    bufBlock.appendChild(list);
    const consolidateAll = el('button', { class: 'memory-stage__chip is-active', style: 'margin-top:6px;' }, 'Consolidate all buffer');
    consolidateAll.addEventListener('click', async () => {
      await window.farnsworth.memoryConsolidate(null);
      renderSettings();
    });
    bufBlock.appendChild(consolidateAll);
  }
  sec.appendChild(bufBlock);

  // ---- Tier 2: codebase indexer ----
  // Shows the current watched folder + file/chunk counts. Lets the user
  // start/stop the watcher manually. The "test recall" button runs a
  // sample query against the index so they can verify embeddings work.
  const t2Block = el('div', { class: 'memory-stage__row', style: 'flex-direction:column;align-items:stretch;gap:6px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border);' });
  t2Block.appendChild(el('div', { class: 'memory-stage__label' }, 'CODEBASE INDEX (Tier 2 — sqlite-vec)'));
  const t2Desc = el('div', { style: 'color:var(--muted);font-size:11px;padding:2px 0 8px 0;line-height:1.5;' });
  t2Desc.innerHTML = 'Watches the active project folder, chunks source files (~512 chars), and embeds each chunk via <span style="font-family:var(--mono);color:var(--accent);">all-MiniLM-L6-v2</span>. Recall blends cosine-distance hits with the Tier 1 LIKE results.';
  t2Block.appendChild(t2Desc);

  // Stats row: folder + counts + buttons
  const statsRow = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0;' });
  const folderSpan = el('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--accent);flex:1;min-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
  folderSpan.textContent = state.folder || '(no folder opened)';
  const filesSpan = el('span', { style: 'font-size:11px;color:var(--muted);' }, '— files');
  const chunksSpan = el('span', { style: 'font-size:11px;color:var(--muted);' }, '— chunks');
  statsRow.appendChild(folderSpan);
  statsRow.appendChild(filesSpan);
  statsRow.appendChild(chunksSpan);
  t2Block.appendChild(statsRow);

  // Action buttons
  const actionRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
  const startBtn = el('button', { class: 'memory-stage__chip is-active', title: 'Start chokidar watcher on the active folder' }, '▶ Watch active folder');
  const stopBtn = el('button', { class: 'memory-stage__chip', title: 'Stop the watcher' }, '■ Stop');
  const recallBtn = el('button', { class: 'memory-stage__chip', title: 'Run a sample recall to verify vec search works' }, '🔍 Test recall');
  startBtn.addEventListener('click', async () => {
    if (!state.folder) return alert('No folder open. Open a project first.');
    startBtn.disabled = true;
    try {
      const res = await window.farnsworth.memoryCodeWatch(state.folder);
      if (res?.ok) console.log('[memory tier2] watcher started');
      refreshTier2Stats();
    } catch (e) { alert('Watch failed: ' + (e?.message || e)); }
    startBtn.disabled = false;
  });
  stopBtn.addEventListener('click', async () => {
    await window.farnsworth.memoryCodeUnwatch();
    refreshTier2Stats();
  });
  recallBtn.addEventListener('click', async () => {
    const query = prompt('Test recall — enter a query (e.g. "embedding worker spawn"):');
    if (!query) return;
    try {
      const res = await window.farnsworth.memoryRecall(query, 8);
      const lines = [];
      lines.push(`Essentials: ${res.essentials?.length || 0}`);
      lines.push(`Concepts: ${res.concepts?.length || 0}${res.concepts?.some(c => c.source === 'vec') ? ' (vec hits present)' : ''}`);
      lines.push(`Sections: ${res.sections?.length || 0}${res.reranked ? ' (model re-ranked)' : ''}`);
      if (res.sections?.length) {
        lines.push('Top sections:');
        for (const s of res.sections.slice(0, 3)) lines.push(`  • ${s.slug} § ${s.heading}`);
      }
      lines.push(`Code chunks: ${res.code?.length || 0}${res.code?.length ? ' (vec search active)' : ''}`);
      lines.push(`Buffer: ${res.buffer?.length || 0}`);
      if (res.code?.length) {
        lines.push('');
        lines.push('Top code hits:');
        for (const c of res.code.slice(0, 3)) {
          lines.push(`  • ${c.file_path} (chunk ${c.chunk_index}, dist=${c.distance?.toFixed(3)})`);
          const snip = (c.chunk_text || '').slice(0, 100).replace(/\n/g, ' ');
          lines.push(`    ${snip}${c.chunk_text?.length > 100 ? '...' : ''}`);
        }
      }
      alert(lines.join('\n'));
    } catch (e) { alert('Recall failed: ' + (e?.message || e)); }
  });
  actionRow.appendChild(startBtn); actionRow.appendChild(stopBtn); actionRow.appendChild(recallBtn);
  t2Block.appendChild(actionRow);

  async function refreshTier2Stats() {
    if (!state.folder) { folderSpan.textContent = '(no folder opened)'; filesSpan.textContent = '— files'; chunksSpan.textContent = '— chunks'; return; }
    folderSpan.textContent = state.folder;
    try {
      const stats = await window.farnsworth.memoryCodeStats(state.folder);
      filesSpan.textContent = `${stats.files || 0} files`;
      chunksSpan.textContent = `${stats.chunks || 0} chunks`;
    } catch (e) { console.warn('[memory tier2] stats failed:', e); }
  }
  refreshTier2Stats();

  sec.appendChild(t2Block);

  return sec;
}

function makeMemoryStage(num, name, stageKey, cfg, desc) {
  const stage = el('div', { class: 'memory-stage' });
  const head = el('div', { class: 'memory-stage__head' });
  head.appendChild(el('div', { class: 'memory-stage__body' },
    el('div', { class: 'memory-stage__name-row' },
      el('span', { class: 'memory-stage__num' }, String(num)),
      el('span', { class: 'memory-stage__name' }, name),
    ),
    el('div', { class: 'memory-stage__desc' }, desc),
  ));
  const toggle = el('div', { class: 'toggle' + (cfg.enabled ? ' is-on' : '') });
  toggle.appendChild(el('div', { class: 'toggle__thumb' }));
  toggle.addEventListener('click', () => {
    cfg.enabled = !cfg.enabled;
    toggle.classList.toggle('is-on', cfg.enabled);
    persistSettings();
  });
  head.appendChild(toggle);
  stage.appendChild(head);

  const row = el('div', { class: 'memory-stage__row' });
  row.appendChild(el('span', { class: 'memory-stage__label' }, 'MODEL'));
  row.appendChild(makeModelChip(cfg));

  if (stageKey === 'consolidation') {
    row.appendChild(el('span', { class: 'memory-stage__divider' }));
    row.appendChild(el('span', { class: 'memory-stage__label' }, 'SCHEDULE'));
    const sched = el('button', { class: 'memory-stage__chip', title: 'Cycle Hourly → Daily → Weekly' }, cfg.schedule || 'Daily', svg('0 0 24 24', ['M6 9l6 6 6-6']));
    sched.addEventListener('click', () => {
      const order = ['Hourly', 'Daily', 'Weekly'];
      cfg.schedule = order[(order.indexOf(cfg.schedule || 'Daily') + 1) % order.length];
      persistSettings();
      renderSettings();
    });
    row.appendChild(sched);
    const auto = el('button', { class: 'memory-stage__chip' + (cfg.autoOnBuffer ? ' is-active' : ''), title: 'Run automatically when the buffer crosses the threshold' });
    if (cfg.autoOnBuffer) auto.appendChild(el('span', { html: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' }));
    auto.appendChild(document.createTextNode('Auto on buffer threshold'));
    auto.addEventListener('click', () => {
      cfg.autoOnBuffer = !cfg.autoOnBuffer;
      persistSettings();
      renderSettings();
    });
    row.appendChild(auto);
    const th = el('input', { type: 'number', value: String(cfg.bufferThreshold ?? 50), min: '5', max: '500', title: 'Buffer threshold (facts)', style: 'width:58px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:11px;font-family:var(--mono);color:inherit;' });
    th.addEventListener('change', () => {
      const v = Math.max(5, Math.min(500, Number(th.value) || 50));
      cfg.bufferThreshold = v;
      th.value = String(v);
      persistSettings();
    });
    row.appendChild(th);
    const run = el('button', { class: 'memory-stage__chip', title: 'Run consolidation now' }, '▶ Run now');
    run.addEventListener('click', async () => {
      run.disabled = true;
      run.textContent = 'Running…';
      try {
        const r = await window.farnsworth.memoryRunConsolidation();
        if (r && r.ok) {
          const a = r.applied;
          alert(`Consolidation done: ${r.processed ?? 0}/${r.total ?? 0} buffer rows${a ? `\nappend ${a.append} · create ${a.create} · essential ${a.essential} · drop ${a.drop}` : ''}`);
        } else {
          alert('Consolidation failed: ' + (r && r.error || 'unknown'));
        }
      } catch (e) { alert('Consolidation failed: ' + (e && e.message || e)); }
      renderSettings();
    });
    row.appendChild(run);
  }

  if (stageKey === 'router') {
    row.appendChild(el('span', { class: 'memory-stage__divider' }));
    row.appendChild(el('span', { class: 'memory-stage__label' }, 'BUDGET'));
    const bb = el('input', { type: 'number', value: String(cfg.bucketBudget ?? 3), min: '1', max: '6', title: 'Max concept articles injected per turn', style: 'width:44px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:11px;font-family:var(--mono);color:inherit;' });
    bb.addEventListener('change', () => {
      cfg.bucketBudget = Math.max(1, Math.min(6, Number(bb.value) || 3));
      bb.value = String(cfg.bucketBudget);
      persistSettings();
    });
    row.appendChild(bb);
    const gate = el('button', { class: 'memory-stage__chip' + (cfg.gate !== false ? ' is-active' : ''), title: 'Zero-cost FTS pre-check: when the message shares no keywords with the memory corpus, the router model is skipped entirely for the turn' }, 'Keyword gate');
    gate.addEventListener('click', () => {
      cfg.gate = (cfg.gate === false);
      persistSettings();
      renderSettings();
    });
    row.appendChild(gate);
  }

  if (stageKey === 'extraction') {
    row.appendChild(el('span', { class: 'memory-stage__divider' }));
    const noise = el('button', { class: 'memory-stage__chip' + (cfg.noiseFilter !== false ? ' is-active' : ''), title: 'Skip the extraction model on trivial acknowledgements ("ok", "thanks") — the raw text still lands in the daily archive' }, 'Noise filter');
    noise.addEventListener('click', () => {
      cfg.noiseFilter = (cfg.noiseFilter === false);
      persistSettings();
      renderSettings();
    });
    row.appendChild(noise);
  }

  if (stageKey === 'retrospective') {
    row.appendChild(el('span', { class: 'memory-stage__divider' }));
    row.appendChild(el('span', { class: 'memory-stage__label' }, 'QUIET'));
    const qm = el('input', { type: 'number', value: String(cfg.quietMinutes ?? 30), min: '5', max: '240', title: 'Minutes a conversation must be idle before it gets swept', style: 'width:52px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:11px;font-family:var(--mono);color:inherit;' });
    qm.addEventListener('change', () => {
      cfg.quietMinutes = Math.max(5, Math.min(240, Number(qm.value) || 30));
      qm.value = String(cfg.quietMinutes);
      persistSettings();
    });
    row.appendChild(qm);
    row.appendChild(el('span', { class: 'memory-stage__label' }, 'MIN'));
    const runRetro = el('button', { class: 'memory-stage__chip', title: 'Sweep the most recent conversation now' }, '▶ Run now');
    runRetro.addEventListener('click', async () => {
      runRetro.disabled = true;
      runRetro.textContent = 'Running…';
      try {
        const r = await window.farnsworth.memoryRunRetrospective();
        if (r && r.ok) alert(r.skipped ? `Retrospective skipped (${r.reason || 'nothing to do'}).` : `Retrospective done: ${r.items ?? 0} facts captured from "${r.title || 'latest conversation'}".`);
        else alert('Retrospective failed: ' + (r && r.error || 'unknown'));
      } catch (e) { alert('Retrospective failed: ' + (e && e.message || e)); }
      renderSettings();
    });
    row.appendChild(runRetro);
  }
  stage.appendChild(row);

  // Extract chips for Extraction stage — the active set is passed to the
  // extraction prompt as focus categories.
  if (cfg.extract) {
    const extractRow = el('div', { class: 'memory-stage__row' });
    extractRow.appendChild(el('span', { class: 'memory-stage__label' }, 'EXTRACT'));
    const allOptions = ['Corrections', 'Preferences', 'Decisions', 'Names', 'Plans'];
    allOptions.forEach(opt => {
      const isActive = cfg.extract.includes(opt);
      const chip = el('button', { class: 'memory-stage__chip' + (isActive ? ' is-active' : '') }, opt);
      chip.addEventListener('click', () => {
        const idx = cfg.extract.indexOf(opt);
        if (idx >= 0) cfg.extract.splice(idx, 1); else cfg.extract.push(opt);
        persistSettings();
        renderSettings();
      });
      extractRow.appendChild(chip);
    });
    stage.appendChild(extractRow);
  }

  // Per-stage run stats line, filled async by renderMemorySettings.
  const statsRow = el('div', { class: 'memory-stage__row', style: 'font-size:11px;color:var(--muted);' });
  statsRow.appendChild(el('span', { 'data-stage-stats': stageKey }, 'loading stats…'));
  if (stageKey === 'consolidation') statsRow.appendChild(el('span', { 'data-stage-buffer': '1', style: 'margin-left:auto;' }, ''));
  stage.appendChild(statsRow);
  return stage;
}

// Tier badge for a stage's model chip, derived from the model family.
function tierForModel(display) {
  if (/haiku/i.test(display)) return 'speed';
  if (/sonnet/i.test(display)) return 'balanced';
  return 'quality';
}

function makeModelChip(cfg) {
  const tier = cfg.tier || tierForModel(cfg.model || '');
  const chip = el('button', { class: 'memory-stage__chip', title: 'Pick the model for this stage' });
  chip.appendChild(el('span', { class: 'memory-stage__tier memory-stage__tier--' + tier }, tier.toUpperCase()));
  chip.appendChild(document.createTextNode(cfg.model));
  const chev = svg('0 0 24 24', ['M6 9l6 6 6-6']);
  chev.setAttribute('width', '12'); chev.setAttribute('height', '12');
  chev.setAttribute('stroke', '#80848e'); chev.setAttribute('stroke-width', '2.4');
  chip.appendChild(chev);
  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openStageModelPicker(chip, cfg);
  });
  return chip;
}

// Model picker for memory pipeline stages. Same popover as openModelPicker
// but writes into the stage config object (nested under
// state.settings.memory.<stage>) instead of a flat settings key.
function openStageModelPicker(anchorBtn, cfg) {
  const existing = document.querySelector('.model-picker');
  if (existing) existing.remove();

  const pop = el('div', { class: 'model-picker' });
  pop.style.cssText = `
    position: fixed; z-index: 9999;
    background: #1f2024; border: 1px solid #2a2c32;
    border-radius: 11px; padding: 6px;
    min-width: 320px; max-width: 380px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55);
    font-size: 13px;
  `;
  const r = anchorBtn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = r.left + 'px';

  for (const opt of CHAT_MODEL_OPTIONS) {
    const isCurrent = cfg.model === opt.display;
    const row = el('button', {
      class: 'model-picker__row' + (isCurrent ? ' is-current' : ''),
      style: `
        display: flex; flex-direction: column; align-items: flex-start;
        width: 100%; padding: 9px 13px; border: none; border-radius: 7px;
        background: ${isCurrent ? 'rgba(168,85,247,.18)' : 'transparent'};
        color: ${isCurrent ? '#c8a6ff' : '#e6e9ef'};
        cursor: pointer; text-align: left;
      `,
    });
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        <span style="font-weight:600;font-size:13px;">${opt.display}</span>
        ${opt.effort ? `<span style="font-size:10px;color:#949ba4;background:#2a2c32;border-radius:4px;padding:2px 6px;font-weight:600;">${opt.effort.toUpperCase()}</span>` : ''}
        ${isCurrent ? '<span style="margin-left:auto;font-size:10px;color:#a855f7;">✓ current</span>' : ''}
      </div>
      <div style="font-size:11.5px;color:#949ba4;margin-top:2px;">${opt.desc}</div>
    `;
    row.addEventListener('click', () => {
      cfg.model = opt.display;
      cfg.tier = tierForModel(opt.display);
      persistSettings();
      pop.remove();
      renderSettings();
    });
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  setTimeout(() => {
    const close = (ev) => {
      if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

// Tiny generic dropdown for settings rows (Jul 13). Same look as the
// model picker, minus the model-specific chrome. onPick gets the chosen
// option; caller persists + re-renders.
function openMiniPicker(anchorBtn, options, current, onPick) {
  const existing = document.querySelector('.mini-picker');
  if (existing) existing.remove();
  const pop = el('div', { class: 'mini-picker' });
  pop.style.cssText = 'position:fixed;z-index:9999;background:#1f2024;border:1px solid #2a2c32;border-radius:11px;padding:6px;min-width:180px;box-shadow:0 12px 40px rgba(0,0,0,.55);font-size:13px;';
  options.forEach(opt => {
    const item = el('button', { style: 'display:block;width:100%;text-align:left;background:' + (String(opt) === String(current) ? '#2a2c32' : 'transparent') + ';border:none;border-radius:7px;padding:8px 11px;color:#dbdee1;font-size:12.5px;cursor:pointer;' }, String(opt));
    item.addEventListener('mouseenter', () => { item.style.background = '#2a2c32'; });
    item.addEventListener('mouseleave', () => { if (String(opt) !== String(current)) item.style.background = 'transparent'; });
    item.addEventListener('click', () => { pop.remove(); onPick(opt); });
    pop.appendChild(item);
  });
  document.body.appendChild(pop);
  const r = anchorBtn.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  setTimeout(() => {
    const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}

// --- Settings -> Canvas (every control real as of Jul 13) ---
// defaultZoom + fitOnOpen feed the zoom rAF in renderCanvas (manual zoom
// wins, Test View always auto-fits); defaults.* seed state.vm at folder
// open; engine.* configure the preview WebContentsViews (partition +
// devTools at creation, network filter applied live).
function renderCanvasSettings() {
  const s = state.settings.canvas;
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:24px;"><div class="settings-page__title">Canvas</div><div class="settings-page__sub">Preview defaults and the embedded browser engine.</div></div>
    <div class="settings-section">
      <div class="settings-section__title" style="margin-bottom:13px;">Preview defaults</div>
    </div>
  `;
  const sec1 = wrap.querySelector('.settings-section');
  const zoomRow = el('div', { class: 'behavior-row' });
  const zoomLabel = el('div', { class: 'behavior-row__label' }, 'Default zoom');
  zoomLabel.appendChild(el('div', { style: 'font-size:11px;color:#80848e;margin-top:2px;font-weight:400;' }, 'Applied when a preview opens. Manual zoom wins; Test View auto-fits.'));
  zoomRow.appendChild(zoomLabel);
  const zoomBtn = el('button', { class: 'model-dropdown', style: 'font-family:JetBrains Mono,monospace;font-size:12px;padding:6px 11px;' }, s.defaultZoom + '%');
  zoomBtn.addEventListener('click', () => openMiniPicker(zoomBtn, ['50%', '75%', '100%', '125%', '150%'], s.defaultZoom + '%', picked => {
    s.defaultZoom = parseInt(picked, 10);
    persistSettings();
    renderSettings();
  }));
  zoomRow.appendChild(zoomBtn);
  sec1.appendChild(zoomRow);
  sec1.appendChild(makeToggleRow('Fit to viewport on open', 'Auto-fit the artboard to the window instead of the default zoom.', s.fitOnOpen, v => { s.fitOnOpen = v; persistSettings(); }));

  const defaults = el('div', { class: 'settings-section' });
  defaults.innerHTML = '<div class="settings-section__title" style="margin-bottom:2px;">Default view modes</div><div style="font-size:11px;color:#80848e;margin-bottom:8px;">Overlays switched on when a folder opens.</div>';
  defaults.appendChild(makeToggleRow('Mark up', '', s.defaults.markup, v => { s.defaults.markup = v; persistSettings(); }));
  defaults.appendChild(makeToggleRow('Comments', '', s.defaults.comments, v => { s.defaults.comments = v; persistSettings(); }));
  defaults.appendChild(makeToggleRow('Show tweaks', '', s.defaults.tweaks, v => { s.defaults.tweaks = v; persistSettings(); }));
  wrap.appendChild(defaults);

  const engine = el('div', { class: 'settings-section' });
  engine.innerHTML = '<div class="settings-section__title" style="margin-bottom:6px;">Browser engine</div>';
  engine.appendChild(makeToggleRow('Devtools access', 'Chromium devtools for the preview (⌘K → Canvas: Open Preview DevTools). Applies on next preview load.', s.engine.devtools, v => { s.engine.devtools = v; persistSettings(); }));
  engine.appendChild(makeToggleRow('Cookie isolation per project', 'Each project gets its own cookies + localStorage. Applies on next preview load.', s.engine.cookieIsolation, v => { s.engine.cookieIsolation = v; persistSettings(); }));
  engine.appendChild(makeToggleRow('Network access from canvas', 'Allow the preview to reach hosts beyond localhost. Applies immediately.', s.engine.network, v => { s.engine.network = v; persistSettings(); window.farnsworth?.canvasSetNetworkAccess?.(v); }));
  wrap.appendChild(engine);

  return wrap;
}

// --- Settings -> Workspace (rebuilt honest, Jul 13) ---
// Live current-folder + recents from the real DB. The old page was a
// design mock: fake storage path, decorative template cards, sharing
// controls for a sharing feature that doesn't exist.
function renderWorkspaceSettings() {
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:24px;"><div class="settings-page__title">Workspace</div><div class="settings-page__sub">The folder Farnsworth is working in.</div></div>
    <div class="settings-section">
      <div class="settings-section__title" style="margin-bottom:13px;">Current folder</div>
    </div>
  `;
  const sec1 = wrap.querySelector('.settings-section');
  const folderRow = el('div', { style: 'display:flex;align-items:center;gap:10px;' });
  const folderBox = el('div', { style: "flex:1;min-width:0;display:flex;align-items:center;gap:9px;background:#1a1b1e;border:1px solid var(--border-default);border-radius:9px;padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#9aa0a8;" });
  folderBox.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  folderBox.appendChild(el('span', { style: 'overflow:hidden;white-space:nowrap;text-overflow:ellipsis;' }, state.folder || 'No folder open'));
  folderRow.appendChild(folderBox);
  const changeBtn = el('button', { class: 'btn' }, state.folder ? 'Change' : 'Open…');
  changeBtn.addEventListener('click', async () => { await openFolderPicker(); renderSettings(); });
  folderRow.appendChild(changeBtn);
  if (state.folder && window.farnsworth?.showInFinder) {
    const revealBtn = el('button', { class: 'btn' }, 'Reveal');
    revealBtn.addEventListener('click', () => window.farnsworth.showInFinder(state.folder));
    folderRow.appendChild(revealBtn);
  }
  sec1.appendChild(folderRow);

  const recents = el('div', { class: 'settings-section' });
  const head = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;' });
  head.appendChild(el('div', { class: 'settings-section__title', style: 'margin-bottom:0;' }, 'Recent folders'));
  const clearBtn = el('button', { class: 'btn', style: 'font-size:11.5px;padding:5px 10px;' }, 'Clear');
  clearBtn.addEventListener('click', async () => {
    await window.farnsworth?.clearRecent?.();
    renderSettings();
  });
  head.appendChild(clearBtn);
  recents.appendChild(head);
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
  list.appendChild(el('div', { style: 'font-size:12px;color:#6d7178;' }, 'Loading…'));
  recents.appendChild(list);
  wrap.appendChild(recents);

  (async () => {
    let rows = [];
    try { rows = (await window.farnsworth?.getRecent?.()) || []; } catch {}
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(el('div', { style: 'font-size:12px;color:#6d7178;' }, 'No recent folders.'));
      return;
    }
    rows.forEach(r => {
      const row = el('button', { title: 'Open ' + r.path, style: 'display:flex;align-items:center;gap:9px;background:#1a1b1e;border:1px solid var(--border-default);border-radius:9px;padding:9px 12px;cursor:pointer;text-align:left;width:100%;min-width:0;' });
      row.appendChild(el('span', { style: 'font-size:12.5px;font-weight:600;color:#dbdee1;flex-shrink:0;' }, r.name || ''));
      row.appendChild(el('span', { style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:#6d7178;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" }, r.path));
      row.addEventListener('click', () => { closeSettings(); handleFolderPicked(r.path); });
      list.appendChild(row);
    });
  })();

  return wrap;
}

// --- Settings -> Appearance (wired live, Jul 13) ---
// Every change routes through applyAppearanceSettings() -> CSS vars /
// body class. Theme stays single-option (only a dark stylesheet exists;
// Light/High-contrast honestly marked "soon").
function renderAppearanceSettings() {
  const s = state.settings.appearance;
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:24px;"><div class="settings-page__title">Appearance</div><div class="settings-page__sub">Theme, density, accent and font — applied live.</div></div>
    <div class="settings-section"><div class="settings-section__title" style="margin-bottom:13px;">Theme</div></div>
  `;
  const themeSection = wrap.querySelector('.settings-section');
  const themeSeg = el('div', { class: 'segmented' });
  ['Dark', 'Light', 'High-contrast'].forEach(opt => {
    const btn = el('button', { class: 'segmented__btn' + (opt === s.theme ? ' is-active' : '') + (opt !== 'Dark' ? ' disabled' : '') }, opt);
    if (opt === 'Dark') btn.addEventListener('click', () => { state.settings.appearance.theme = opt; persistSettings(); renderSettings(); });
    if (opt !== 'Dark') btn.innerHTML = opt + ' <span class="soon">soon</span>';
    themeSeg.appendChild(btn);
  });
  themeSection.appendChild(themeSeg);

  const density = el('div', { class: 'settings-section' });
  density.innerHTML = '<div class="settings-section__title" style="margin-bottom:13px;">Density</div>';
  const dSeg = el('div', { class: 'segmented' });
  ['Comfortable', 'Compact'].forEach(opt => {
    const btn = el('button', { class: 'segmented__btn' + (opt === s.density ? ' is-active' : '') }, opt);
    btn.addEventListener('click', () => { state.settings.appearance.density = opt; persistSettings(); applyAppearanceSettings(); renderSettings(); });
    dSeg.appendChild(btn);
  });
  density.appendChild(dSeg);
  wrap.appendChild(density);

  const accent = el('div', { class: 'settings-section' });
  accent.innerHTML = '<div class="settings-section__title" style="margin-bottom:13px;">Accent color</div><div style="display:flex;gap:11px;"></div>';
  const swatches = ['#5865f2', '#3ab7f0', '#3ba55c', '#eb459e', '#f0883e', '#a855f7'];
  const swatchRow = accent.querySelector('div:last-child');
  swatches.forEach(cc => {
    const sw = el('span', { style: `width:30px;height:30px;border-radius:50%;background:${cc};cursor:pointer;${cc === s.accent || (cc === '#5865f2' && s.accent === 'blurple') ? 'box-shadow:0 0 0 2px #313338,0 0 0 4px ' + cc : ''}` });
    sw.addEventListener('click', () => { state.settings.appearance.accent = cc === '#5865f2' ? 'blurple' : cc; persistSettings(); applyAppearanceSettings(); renderSettings(); });
    swatchRow.appendChild(sw);
  });
  wrap.appendChild(accent);

  const font = el('div', { class: 'settings-section' });
  font.innerHTML = '<div class="settings-section__title" style="margin-bottom:13px;">Interface font</div>';
  const fontBtn = el('button', { class: 'model-dropdown' }, s.font);
  fontBtn.addEventListener('click', () => openMiniPicker(fontBtn, Object.keys(FONT_STACKS), s.font, picked => {
    state.settings.appearance.font = picked;
    persistSettings();
    applyAppearanceSettings();
    renderSettings();
  }));
  font.appendChild(fontBtn);
  wrap.appendChild(font);

  return wrap;
}

// --- Settings -> About (replaces the fake Account page, Jul 13) ---
// "Mara Blake / mara@studio.gg / Farnsworth Pro $30/mo" was design-mock
// data with dead Edit/Manage/Sign out buttons. There is no account system;
// this page now shows real install facts (app:info IPC) + live auth state.
function renderAboutSettings() {
  const wrap = el('div');
  wrap.innerHTML = `
    <div style="margin-bottom:24px;"><div class="settings-page__title">About</div><div class="settings-page__sub">This install — versions, storage and auth.</div></div>
    <div class="settings-section"><div class="settings-section__title" style="margin-bottom:13px;">Application</div><div id="about-app-rows" style="display:flex;flex-direction:column;gap:7px;"><div style="font-size:12px;color:#6d7178;">Loading…</div></div></div>
    <div class="settings-section"><div class="settings-section__title" style="margin-bottom:13px;">Claude auth</div><div id="about-auth-row"></div></div>
  `;

  const auth = state.auth || {};
  const authText = auth.oauthConnected ? 'Signed in via Claude.ai OAuth'
    : auth.claudeCodeAvailable ? 'Using Claude Code CLI credentials (Keychain)'
    : auth.apiKeySet ? 'API key configured'
    : 'Not signed in';
  const authRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;background:#1a1b1e;border:1px solid var(--border-default);border-radius:10px;padding:12px 14px;' });
  authRow.appendChild(el('div', { style: 'font-size:12.5px;color:#dbdee1;' }, authText));
  const aiBtn = el('button', { class: 'btn' }, 'AI settings');
  aiBtn.addEventListener('click', () => { state.settingsPage = 'ai'; renderSettings(); });
  authRow.appendChild(aiBtn);
  wrap.querySelector('#about-auth-row').appendChild(authRow);

  (async () => {
    const host = wrap.querySelector('#about-app-rows');
    let info = null;
    try { info = await window.farnsworth?.appInfo?.(); } catch {}
    host.innerHTML = '';
    if (!info?.ok) {
      host.appendChild(el('div', { style: 'font-size:12px;color:#6d7178;' }, 'App info unavailable.'));
      return;
    }
    const fmtBytes = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
    const row = (label, value, mono) => {
      const r = el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:14px;background:#1a1b1e;border:1px solid var(--border-default);border-radius:9px;padding:9px 12px;min-width:0;' });
      r.appendChild(el('span', { style: 'font-size:11.5px;color:#80848e;flex-shrink:0;' }, label));
      r.appendChild(el('span', { title: value, style: 'font-size:' + (mono ? '11px' : '12px') + ';color:#dbdee1;' + (mono ? "font-family:'JetBrains Mono',monospace;" : '') + 'overflow:hidden;white-space:nowrap;text-overflow:ellipsis;' }, value));
      return r;
    };
    host.appendChild(row('Farnsworth', 'v' + info.version));
    host.appendChild(row('Electron', info.electron + ' · Chromium ' + info.chrome + ' · Node ' + info.node));
    host.appendChild(row('Platform', info.platform));
    host.appendChild(row('Data folder', info.userData, true));
    host.appendChild(row('Database', info.dbPath ? info.dbPath + ' · ' + fmtBytes(info.dbSize) : 'not found', true));
    if (info.dbPath && window.farnsworth?.showInFinder) {
      const revealBtn = el('button', { class: 'btn', style: 'align-self:flex-start;margin-top:4px;' }, 'Reveal database in Finder');
      const slash = info.dbPath.lastIndexOf('/');
      revealBtn.addEventListener('click', () => window.farnsworth.showInFinder(info.dbPath.slice(0, slash), info.dbPath.slice(slash + 1)));
      host.appendChild(revealBtn);
    }
  })();

  return wrap;
}


// ============================================================================
// PERSISTENCE
// ============================================================================
function persistSettings() {
  if (window.farnsworth) window.farnsworth.setSettings(state.settings);
}

// Canvas + Appearance honest-wiring migration (Jul 13). Persisted values
// from the decorative era were seeds, not user choices -- reset once
// (version flag), then honor user picks. Also drops the design-mock
// workspace/account objects (no feature behind them).
function reconcileHonestSettings(loaded) {
  const CANVAS_DEFAULTS = {
    defaultZoom: 100, fitOnOpen: false,
    defaults: { markup: false, comments: false, tweaks: true },
    engine: { devtools: true, cookieIsolation: false, network: true },
  };
  if (loaded?.canvasV === 2 && loaded.canvas) {
    state.settings.canvas = {
      ...CANVAS_DEFAULTS, ...loaded.canvas,
      defaults: { ...CANVAS_DEFAULTS.defaults, ...(loaded.canvas.defaults || {}) },
      engine: { ...CANVAS_DEFAULTS.engine, ...(loaded.canvas.engine || {}) },
    };
  } else {
    state.settings.canvas = {
      ...CANVAS_DEFAULTS,
      defaults: { ...CANVAS_DEFAULTS.defaults },
      engine: { ...CANVAS_DEFAULTS.engine },
    };
  }
  state.settings.canvasV = 2;

  const APPEARANCE_DEFAULTS = { theme: 'dark', density: 'Comfortable', accent: 'blurple', font: 'Hanken Grotesk' };
  state.settings.appearance = (loaded?.appearanceV === 2 && loaded.appearance)
    ? { ...APPEARANCE_DEFAULTS, ...loaded.appearance }
    : { ...APPEARANCE_DEFAULTS };
  state.settings.appearanceV = 2;

  delete state.settings.workspace;
  delete state.settings.account;
}

// Appearance -> live CSS (Jul 13). Accent recolors --accent-blurple (+glow),
// density toggles body.density-compact, font swaps --font-sans. Only fonts
// that are actually loaded (Google Fonts link in index.html) or system
// stacks are offered -- no fake choices.
const ACCENT_NAME_HEX = { blurple: '#5865f2' };
const FONT_STACKS = {
  'Hanken Grotesk': "'Hanken Grotesk', system-ui, -apple-system, sans-serif",
  'System': "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
  'JetBrains Mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
};
function applyAppearanceSettings() {
  const ap = state.settings.appearance || {};
  const hex = ACCENT_NAME_HEX[ap.accent] || (typeof ap.accent === 'string' && ap.accent.startsWith('#') ? ap.accent : '#5865f2');
  const root = document.documentElement;
  root.style.setProperty('--accent-blurple', hex);
  const n = parseInt(hex.slice(1), 16);
  root.style.setProperty('--accent-blurple-glow', 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',.4)');
  document.body.classList.toggle('density-compact', ap.density === 'Compact');
  root.style.setProperty('--font-sans', FONT_STACKS[ap.font] || FONT_STACKS['Hanken Grotesk']);
}
// Chat input model button — keep the bottom-of-input chip in sync with
// state.settings.defaultModel. The HTML uses named spans
// (.chat__model-name, .chat__model-tier) for the dynamic parts so this
// is just text assignment. Jul 14 ~09:20 ET.
function updateChatInputModelButton() {
  const btn = document.getElementById('chat-model');
  if (!btn) return;
  const m = state.settings?.defaultModel || 'Opus 4.8 High';
  const base = String(m).replace(/\s+High$/, '');
  const tier = /\sHigh$/.test(m) ? 'High' : '';
  const nameEl = btn.querySelector('.chat__model-name');
  const tierEl = btn.querySelector('.chat__model-tier');
  if (nameEl) nameEl.textContent = base;
  if (tierEl) {
    tierEl.textContent = tier;
    tierEl.hidden = !tier;
  }
}

async function loadSettings() {
  if (!window.farnsworth) return;
  try {
    const loaded = await window.farnsworth.getSettings();
    if (loaded) Object.assign(state.settings, loaded);
    reconcileHonestSettings(loaded);
    // Jul 14 ~09:20 ET: keep the chat input's model chip in sync with
    // whatever default the user picked. The HTML had "Opus 4.8" +
    // "High" hardcoded; this rewrites the named spans in place.
    updateChatInputModelButton();
    // Per-call-site routing reconciliation (Jul 13): the table only lists
    // call sites that exist in code (ROUTING_CALL_SITES). Persisted rows
    // keep the user's model/confirm choices for surviving ids; stale rows
    // from the decorative era (refactor, preferences) are dropped; new
    // call sites appear with their defaults.
    {
      // routingV < 2 → pre-honest-wiring rows were decorative seeds, not
      // user choices; start fresh from defaults. routingV 2 → user's
      // model/confirm picks carry over for surviving call sites.
      const migrated = loaded?.routingV === 2;
      const saved = (migrated && Array.isArray(loaded?.perCallSiteRouting)) ? loaded.perCallSiteRouting : [];
      state.settings.perCallSiteRouting = ROUTING_CALL_SITES.map(def => {
        const s0 = saved.find(r => r && r.id === def.id) || {};
        const row = { ...def };
        if (typeof s0.model === 'string' && s0.model) row.model = s0.model;
        if ('confirm' in def && typeof s0.confirm === 'boolean') row.confirm = s0.confirm;
        return row;
      });
      state.settings.routingV = 2;
    }
    // Memory pipeline settings: Object.assign is shallow, so a persisted
    // 'memory' object would shadow new per-stage defaults. Deep-merge each
    // stage, drop the legacy v2migration stage, and (one-time, v3 pipeline
    // migration) force stage models to the new defaults — the old model
    // chips were dead UI, so persisted models were never a user choice.
    const memDefaults = {
      extraction:    { enabled: true, model: 'Haiku 4.5', tier: 'speed',    extract: ['Corrections', 'Preferences', 'Decisions'], noiseFilter: true },
      consolidation: { enabled: true, model: 'Sonnet 5',  tier: 'balanced', schedule: 'Daily', autoOnBuffer: true, bufferThreshold: 50 },
      retrieval:     { enabled: true, model: 'Sonnet 5',  tier: 'balanced', depth: 'Standard', summariesFirst: true, graphSpread: true },
      router:        { enabled: true, model: 'Haiku 4.5', tier: 'speed',    bucketBudget: 3, gate: true },
      l2selector:    { enabled: true, model: 'Haiku 4.5', tier: 'speed' },
      retrospective: { enabled: true, model: 'Sonnet 5',  tier: 'balanced', quietMinutes: 30 },
    };
    const savedMem = (loaded && typeof loaded.memory === 'object' && loaded.memory) || {};
    const migrated = savedMem.pipelineVersion === 3;
    const mem = { pipelineVersion: 3 };
    for (const k of Object.keys(memDefaults)) {
      mem[k] = { ...memDefaults[k], ...(savedMem[k] || {}) };
      if (!migrated) { mem[k].model = memDefaults[k].model; mem[k].tier = memDefaults[k].tier; }
    }
    state.settings.memory = mem;
    if (!migrated && loaded) persistSettings();
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
}

// Detect whether the farnsworth backend dev server is running for the open
// workspace's app type. The server is started by `npm run farnsworth:<type>`
// in the app's template repo (e.g. `farnsworth:devvit` in
// vibe-farnsworth-template) and writes its URL + PID to
// ~/.cache/farnsworth-<type>.json. When alive, canvas preview iframes point
// at it (splash/game renders); otherwise the static background-image / <img>
// fallbacks show.
async function loadFarnsworthDev() {
  if (!window.farnsworth?.devFarnsworthGet) {
    state.farnsworthDev = { available: false };
    return;
  }
  // Detect the dev server for the open workspace's app type. appType is set
  // when a folder is loaded (handleFolderPicked); at init time it may be
  // null, so we default to 'devvit'. Re-run this after folder load to pick
  // up the correct type for non-devvit workspaces.
  // Pass state.folder so main.js can validate that the cached dev server
  // belongs to THIS workspace — without this, a stale cache file from a
  // previous session's workspace would point iframes at the wrong project
  // (Long Jul 9 ~15:05 ET — lastdraft's bgMusic auto-played in Farnsworth's
  // iframe because the cache file's repoRoot didn't match the active folder).
  const appType = state.appType || 'devvit';
  try {
    const info = await window.farnsworth.devFarnsworthGet(appType, state.folder || null);
    state.farnsworthDev = info || { available: false };
    if (info?.available) {
      console.log(`[Farnsworth] ${info.type} dev server available at`, info.url, 'pid', info.pid);
    } else if (info?.dead) {
      console.warn(`[Farnsworth] ${info.type} dev meta points to dead pid`, info.pid, `— run \`npm run farnsworth:${info.type}\` to restart`);
    }
  } catch (e) {
    console.warn('Failed to detect farnsworth dev server:', e);
    state.farnsworthDev = { available: false };
  }
}

// ============================================================================
// FOLDER + WORKSPACE
// ============================================================================
async function openFolderPicker() {
  if (!window.farnsworth) return;
  console.log('[Farnsworth] openFolderPicker called');
  const folderPath = await window.farnsworth.openFolderDialog();
  console.log('[Farnsworth] folderPath returned:', folderPath);
  if (!folderPath) return;
  await handleFolderPicked(folderPath);
}

async function handleFolderPicked(folderPath) {
  state.folder = folderPath;
  // Persist to the global setting so PTYs spawned before the WS init
  // (or any code path that reads currentFolder) see the current workspace.
  if (window.farnsworth) await window.farnsworth.setSetting('currentFolder', folderPath);
  // Workspace changed — force Tasks panel + Files tree to re-load from
  // disk on next mount. Files used to walk the whole tree eagerly on
  // every folder pick (incl. boot), which blocked main process for
  // ~1-5s on the-last-draft; now we lazy-walk only when the Files tab
  // is actually visible (Long Jul 3 ~15:11 ET — boot lag spike).
  state.tasksLoadedForWs = null;
  state.files.loadedForFolder = null;
  refreshGitBranch(); // status bar branch chip follows the open folder
  // Settings -> Canvas -> Default view modes (Jul 13): seed the vm
  // overlays for the freshly-opened workspace.
  const vmDefs = state.settings?.canvas?.defaults;
  if (vmDefs) {
    state.vm.markup = !!vmDefs.markup;
    state.vm.comments = !!vmDefs.comments;
    state.vm.tweaks = !!vmDefs.tweaks;
  }
  if (window.farnsworth) await window.farnsworth.addRecent(folderPath);
  // Try to load existing config; if missing, prompt for app type
  let config = null;
  if (window.farnsworth) {
    const res = await window.farnsworth.loadWorkspaceConfig(folderPath);
    if (res.ok) config = res.config;
  }
  // Per-project Live subreddit id — read from .farnsworth/config.json so
  // each workspace has its own subreddit. One-time migration: if the
  // folder's config has no liveGameId but the legacy global setting has
  // one, copy it into the project config so the migration is silent.
  let liveId = config?.liveGameId || null;
  if (!liveId && window.farnsworth?.getSetting) {
    try {
      const legacy = await window.farnsworth.getSetting('live.subreddit');
      if (legacy && typeof legacy === 'string' && legacy.length > 0) {
        liveId = legacy;
        if (window.farnsworth?.saveWorkspaceConfig) {
          await window.farnsworth.saveWorkspaceConfig(folderPath, {
            ...(config || {}), liveGameId: liveId, appType: config?.appType,
          });
        }
      }
    } catch {}
  }
  state.liveGameId = liveId;
  // Load the per-project Live panel config (project name, subreddit name,
  // URL, post name) from .farnsworth/config.json's `live` subkey. Each
  // project has its own — this is what `state.liveConfig` reads from
  // everywhere in the renderer.
  const liveCfg = config?.live || {};
  state.liveConfig = {
    projectName: typeof liveCfg.projectName === 'string' ? liveCfg.projectName : '',
    subredditName: typeof liveCfg.subredditName === 'string' ? liveCfg.subredditName : '',
    url: typeof liveCfg.url === 'string' ? liveCfg.url : '',
    postName: typeof liveCfg.postName === 'string' ? liveCfg.postName : '',
  };
  if (config && config.appType) {
    state.appType = config.appType;
    hideWelcome();
    hideAppTypePicker();
    // Lazy file tree — only walk the folder if the Files tab is the
    // visible tab. Otherwise the tab-switch watcher (in wire()) will
    // trigger loadFolderFiles() when the user actually opens Files.
    // Cuts ~1-5s off boot on projects with deep asset trees.
    if (state.rightTab === 'files') {
      await loadFolderFiles(folderPath);
    }
    updateWindowTitle();
    // Now that the real appType is known, re-detect the farnsworth dev server
    // for this app type (init defaulted to 'devvit' when appType was null),
    // then re-render the canvas so preview iframes pick up any live server.
    await loadFarnsworthDev();
    renderCanvas();
    // Tier 2: start the codebase indexer on this workspace. Fire-and-
    // forget — failures here don't block the folder switch.
    if (window.farnsworth?.memoryCodeWatch) {
      window.farnsworth.memoryCodeWatch(folderPath).then((res) => {
        if (res?.ok) console.log('[memory tier2] code watcher started on', folderPath);
      }).catch((e) => console.warn('[memory tier2] watch failed:', e?.message || e));
    }
  } else {
    showAppTypePicker(folderPath);
  }
  // UI folder watcher — debounced add/change/unlink events trigger
  // readFolder() so the Files panel stays in sync with external writes
  // (agent file edits, shell commands, etc.). Separate from the
  // memory code watcher above; this one doesn't filter by extension
  // and emits raw events to the renderer. Fires regardless of
  // whether the folder already has a .farnsworth/config.json so
  // even first-time folders get live updates.
  startUiFolderWatcher(folderPath);
}

// UI folder watcher — keeps the Files panel in sync with disk changes
// outside the editor. Debounced 250ms so a burst of writes (e.g. a
// multi-file edit) collapses into one readFolder() refresh.
let uiFolderWatcherCleanup = null;
let uiFolderRefreshTimer = null;
async function startUiFolderWatcher(folderPath) {
  // Always tear down the previous watcher first — handles folder switches.
  stopUiFolderWatcher();
  if (!window.farnsworth?.fsWatchFolder || !folderPath) return;
  try {
    const res = await window.farnsworth.fsWatchFolder(folderPath);
    if (!res?.ok) {
      console.warn('[fs watch] start failed:', res?.error);
      return;
    }
    uiFolderWatcherCleanup = window.farnsworth.onFsFolderEvent((evt) => {
      // Only refresh if the event is for our current folder.
      if (evt.folder !== state.folder) return;
      // For 'change' events on an open file, flag it as externally
      // modified so the editor can show the diff banner.
      if (evt.type === 'change' && evt.path) {
        // evt.path is the absolute path; strip the folder prefix to get relPath.
        let relPath = evt.path;
        if (relPath.startsWith(state.folder + '/')) {
          relPath = relPath.slice(state.folder.length + 1);
        } else if (relPath === state.folder) {
          return;  // folder itself changed, not a file
        }
        const openIdx = openFiles.findIndex(o => o.path === state.folder + '/' + relPath);
        if (openIdx >= 0) {
          flagExternalChange(relPath, openIdx);
        }
      }
      if (uiFolderRefreshTimer) clearTimeout(uiFolderRefreshTimer);
      uiFolderRefreshTimer = setTimeout(() => {
        uiFolderRefreshTimer = null;
        // Only refresh if Files tab is visible (cheap) — otherwise the
        // next tab-switch will load anyway.
        if (state.rightTab === 'files' && state.folder) {
          loadFolderFiles(state.folder);
        }
      }, 250);
    });
    console.log('[fs watch] UI watcher started on', folderPath);
  } catch (e) {
    console.warn('[fs watch] start error:', e?.message || e);
  }
}

function stopUiFolderWatcher() {
  if (uiFolderRefreshTimer) {
    clearTimeout(uiFolderRefreshTimer);
    uiFolderRefreshTimer = null;
  }
  if (uiFolderWatcherCleanup) {
    try { uiFolderWatcherCleanup(); } catch (_) {}
    uiFolderWatcherCleanup = null;
  }
  if (window.farnsworth?.fsUnwatchFolder) {
    window.farnsworth.fsUnwatchFolder().catch(() => {});
  }
}

// ============================================================================
// EXTERNAL FILE CHANGES — diff banner + reload/discard (Jul 7 ~20:35 ET)
// ============================================================================

// Map of relPath → timestamp for files modified externally. Used by the
// editor banner + tab indicator. Cleared when the user reloads or discards.
const externalChanges = new Map();

async function flagExternalChange(relPath, openIdx) {
  if (!state.folder || !openFiles[openIdx]) return;
  const file = openFiles[openIdx];
  // Read the on-disk content (debounced — multiple change events may fire)
  const fullPath = file.path;
  const res = await window.farnsworth.readFile(state.folder, relPath);
  if (!res.ok) return;
  const diskContent = res.content;
  const bufferContent = file.model?.getValue() || '';
  // Only flag if disk actually differs from diskContent (saved baseline),
  // not just from the buffer (which may have local unsaved edits).
  if (diskContent === file.diskContent) {
    // No real external change — just a touch or chokidar heartbeat.
    return;
  }
  externalChanges.set(relPath, { diskContent, ts: Date.now() });
  // If this is the active file, re-render the editor to show the banner.
  if (activeFileIdx === openIdx) {
    renderCanvas();
  } else {
    // Just refresh the tab UI to add an indicator dot.
    renderTabs();
  }
}

// Reload the file from disk, overwriting the buffer. Marked not dirty.
// Clears the external-change flag.
async function reloadFileFromDisk(relPath) {
  if (!state.folder || !relPath) return;
  const fullPath = state.folder + '/' + relPath;
  const idx = openFiles.findIndex(o => o.path === fullPath);
  if (idx < 0) return;
  const file = openFiles[idx];
  const res = await window.farnsworth.readFile(state.folder, relPath);
  if (!res.ok) {
    alert('Reload failed: ' + (res.error || 'unknown'));
    return;
  }
  const wasActive = activeFileIdx === idx;
  // Apply the disk content to the model
  if (file.model) {
    file.model.setValue(res.content);
  }
  file.diskContent = res.content;
  file.dirty = false;
  externalChanges.delete(relPath);
  renderTabs();
  if (wasActive) renderCanvas();
}

// Discard the external-change flag. User keeps their buffer edits.
// On the next watcher event, if the disk still differs, it'll re-flag.
function discardExternalChange(relPath) {
  if (!relPath) return;
  externalChanges.delete(relPath);
  if (state.canvasMode === 'code') renderCanvas();
  renderTabs();
}

// Show an inline diff between the buffer and disk content. Uses Monaco's
// DiffEditor rendered into a fullscreen overlay. The user can close it
// to return to the regular editor.
async function showExternalDiff(relPath) {
  if (!state.folder || !relPath) return;
  const fullPath = state.folder + '/' + relPath;
  const file = openFiles.find(o => o.path === fullPath);
  if (!file || !file.model) return;
  const ext = langForPath(relPath);
  // Create a temporary model for the disk content
  const diskModel = monaco.editor.createModel(file.diskContent || '', ext);
  // Wrap the existing buffer model in a DiffEditor
  const overlay = document.createElement('div');
  overlay.className = 'diff-overlay';
  overlay.innerHTML = `
    <div class="diff-overlay__head">
      <span class="diff-overlay__title">Disk changes — ${escapeHtml(relPath)}</span>
      <div style="display:flex;gap:8px;">
        <button class="diff-overlay__btn diff-overlay__btn--reload" id="diff-reload">Reload from disk</button>
        <button class="diff-overlay__btn diff-overlay__btn--discard" id="diff-discard">Keep my changes</button>
        <button class="diff-overlay__btn" id="diff-close">Close</button>
      </div>
    </div>
    <div class="diff-overlay__body" id="diff-overlay-body"></div>
  `;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('#diff-overlay-body');
  const diffEditor = monaco.editor.createDiffEditor(body, {
    theme: monacoTheme,
    automaticLayout: true,
    readOnly: false,  // allow edits to the right (buffer) side
    originalEditable: false,
    renderSideBySide: true,
    ignoreTrimWhitespace: false,
  });
  diffEditor.setModel({ original: diskModel, modified: file.model });
  // Wire buttons
  const close = () => {
    diffEditor.dispose();
    diskModel.dispose();
    overlay.remove();
  };
  overlay.querySelector('#diff-close').onclick = close;
  overlay.querySelector('#diff-reload').onclick = async () => {
    close();
    await reloadFileFromDisk(relPath);
  };
  overlay.querySelector('#diff-discard').onclick = () => {
    close();
    discardExternalChange(relPath);
  };
}

async function loadFolderFiles(folderPath, force = false) {
  if (!window.farnsworth || !folderPath) return;
  // Skip if already loaded for this exact folder (called by tab-switch
  // watcher + folder pick — avoid re-walking the tree every click).
  // `force=true` bypasses the cache (used after rename/delete/create).
  if (!force && state.files.loadedForFolder === folderPath) return;
  state.files.loading = true;
  if (state.rightTab === 'files') renderRightPanel();
  // Depth 2 covers src/, lobby/, story/ + their direct children — what
  // the Files tab actually renders. Depth 4 used to crawl every
  // asset/<category>/<file> under lobby/ and story/, hitting 500+
  // fs.stat calls per boot on the-last-draft and blocking main process
  // for ~5s (Long Jul 3 ~15:11 ET). Depth 2 keeps boot under 1s while
  // showing everything useful.
  const res = await window.farnsworth.readDir(folderPath, 2);
  state.files.loading = false;
  if (res.ok) {
    state.files.entries = res.entries;
  } else {
    state.files.entries = [];
    console.warn('Failed to read folder:', res.error);
  }
  state.files.loadedForFolder = folderPath;
  if (state.rightTab === 'files') renderRightPanel();
}

function updateWindowTitle() {
  const titleEl = document.querySelector('.titlebar__project');
  if (titleEl) {
    titleEl.textContent = state.folder ? state.folder.split('/').pop() : 'No folder open';
  }
  const subEl = document.querySelector('.chat__project-name');
  if (subEl) subEl.textContent = state.folder ? state.folder.split('/').pop() : 'No folder open';
  const subCountEl = document.querySelector('.chat__project-sub');
  if (subCountEl) {
    // Jul 6 ~09:00 ET — Long: "remove the 99 files, change devvit game to
    // devvit, then have the title of the conversation beside it". So the
    // subline is now "<appType> · <current conversation title>" (or just
    // one of them if the other is empty). Drops the file count entirely.
    const label = state.appType ? appTypeLabel(state.appType) : '';
    const title = currentConvTitle();
    if (!state.folder) {
      subCountEl.textContent = 'Open a folder to start designing';
    } else if (label && title) {
      subCountEl.textContent = `${label} · ${title}`;
    } else {
      subCountEl.textContent = label || title || '';
    }
  }
}

// ============================================================
// Native menu action handler
// ============================================================
// Called when the user picks an item from the macOS menu bar (File,
// Edit, View, Window). Dispatches to the right renderer-side flow
// so menu items don't need bespoke IPC handlers per action.
async function handleMenuAction(action) {
  if (!action || !action.type) return;
  switch (action.type) {
    case 'openFolder':
      // Action comes with { path: '/Users/long/foo' } either from File →
      // Open Folder… dialog or from File → Open Recent submenu.
      if (action.payload?.path) await handleFolderPicked(action.payload.path);
      else openFolderPicker();
      break;
    case 'openFile':
      // From File → Open File… — pick a file and load its parent as
      // the workspace folder if no folder is open yet, then open the
      // file in the editor.
      if (action.payload?.path) await openFileFromPath(action.payload.path);
      else openFilePicker();
      break;
    case 'newFile':
      openNewFileDialog();
      break;
    case 'closeFolder':
      await closeFolder();
      break;
    case 'openSettings':
      state.settingsPage = 'ai';
      openSettings();
      break;
    case 'showTab':
      if (action.payload?.tab) {
        state.rightTab = action.payload.tab;
        renderRightPanel();
      }
      break;
    case 'toggleLeftPanel':
      toggleLeftPanel();
      break;
    case 'toggleRightPanel':
      toggleRightPanel();
      break;
    case 'focusTerminal':
      switchLeftTab('terminal');
      break;
    case 'focusClaudeCode':
      switchLeftTab('claudecode');
      break;
    case 'focusCommandPalette':
      openCommandPalette();
      break;
    case 'focusSearchOverlay':
      openSearchOverlay();
      break;
    case 'focusFileFinder':
      openFileFinderOverlay();
      break;
  }
}

// Open a single file from an absolute path. If no workspace folder is
// open, set state.folder to the file's parent directory so the file
// tree shows context, then open the file in Monaco.
async function openFileFromPath(absPath) {
  if (!absPath) return;
  const sep = absPath.includes('/') ? '/' : '\\';
  const parent = absPath.split(sep).slice(0, -1).join(sep);
  if (!state.folder) {
    await handleFolderPicked(parent);
  }
  // Resolve the path relative to the workspace folder.
  const relPath = state.folder && absPath.startsWith(state.folder)
    ? absPath.slice(state.folder.length).replace(/^\/+/, '')
    : absPath;
  openFile({ path: relPath, name: absPath.split(sep).pop() });
}

// Open the File menu's "New File" — quick input + create in current folder.
function openNewFileDialog() {
  if (!state.folder) {
    openFolderPicker();
    return;
  }
  const name = window.prompt('New file name (relative to workspace):', 'untitled.txt');
  if (!name) return;
  const clean = name.replace(/^\/+/, '');
  if (window.farnsworth?.writeFile) {
    window.farnsworth.writeFile(state.folder, clean, '').then(() => {
      loadFolderFiles(state.folder);
      openFile({ path: clean, name: clean.split('/').pop() });
    }).catch(err => {
      console.error('[newFile] write failed:', err);
      alert('Could not create file: ' + (err?.message || err));
    });
  }
}

async function closeFolder() {
  // Unsaved-changes prompt BEFORE tearing down openFiles. If user
  // cancels, leave the folder open so they can save manually.
  const dirtyFiles = openFiles.filter(f => f?.dirty);
  if (dirtyFiles.length > 0) {
    const choice = await confirmDiscard({
      fileName: dirtyFiles[0].name,
      count: dirtyFiles.length,
    });
    if (choice === 2) return;  // Cancel — keep folder open
    if (choice === 0) {
      // Save all dirty files first, then close. Use writeFile directly
      // because saveActiveFile only saves the active one.
      for (const file of dirtyFiles) {
        const content = file.model?.getValue() || '';
        let relPath = file.path;
        if (file.path.startsWith(state.folder)) {
          relPath = file.path.slice(state.folder.length).replace(/^\/+/, '/');
        }
        try {
          await window.farnsworth.writeFile(state.folder, relPath, content);
          file.diskContent = content;
          file.dirty = false;
        } catch (e) {
          console.error('save failed:', file.path, e);
          // If save failed, abort the close — user must decide.
          alert('Save failed: ' + (e?.message || e));
          return;
        }
      }
    }
    // 1 = Don't Save, 0 = Saved all, fall through to close.
  }
  stopUiFolderWatcher();
  state.folder = null;
  state.files.entries = [];
  state.appType = null;
  state.openFiles = [];
  state.activeFileIdx = -1;
  // Reset per-project live subreddit id so the next folder opened
  // doesn't inherit this project's subreddit. Falls back to the
  // default in getLiveGameId() until handleFolderPicked loads the
  // new workspace's config.
  state.liveGameId = null;
  state.liveGame = null;
  renderRightPanel();
  renderChat();
  updateWindowTitle();
  showWelcome();
}

// ---------------------------------------------------------------------------
// Per-call-site AI commands (Jul 13 ~23:05 ET): AI Commit + AI Review.
// Palette-invoked, run in the chat panel, use the routed models from
// Settings → AI → per-call-site routing ('commit' / 'review' rows).
// git plumbing is main-process (git:diff / git:commit IPCs, execFile arg
// arrays — a model-written commit message can't shell-inject).
// ---------------------------------------------------------------------------
const AI_COMMIT_SYSTEM = 'You write git commit messages. Given a diff, output ONLY the commit message: an imperative subject line under 72 characters, optionally followed by a blank line and up to 4 short bullet points. No code fences, no quotes, no commentary.';
const AI_REVIEW_SYSTEM = 'You are a senior code reviewer. Given a git diff, produce a concise markdown review: one-line verdict first, then "## Issues" (only real problems: bugs, security, correctness — say "None found" if clean), then "## Suggestions" (optional improvements, max 4 bullets). No preamble, no restating the diff.';

function sanitizeCommitMessage(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  // Strip a wrapping code fence if the model added one despite instructions.
  t = t.replace(/^```[a-z]*\n([\s\S]*?)\n```$/m, '$1').trim();
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.slice(0, 2000);
}

// Push an agent task message into the chat and return an in-place updater.
// Shared by aiCommitCommand / aiReviewCommand — same shape as the chat
// agent's updateAgentMsg but scoped to a standalone message.
function pushAgentTask(label) {
  const msgId = 'm' + Date.now() + '-' + Math.floor(Math.random() * 1e4);
  state.chatMessages.push({ id: msgId, role: 'agent', working: true, workingLabel: label });
  renderChat();
  return (patch) => {
    const i = state.chatMessages.findIndex(x => x.id === msgId);
    if (i >= 0) {
      state.chatMessages[i] = { ...state.chatMessages[i], ...patch };
      renderChat();
    }
    return state.chatMessages[i];
  };
}

async function aiCommitCommand() {
  switchLeftTab('chat');
  if (!state.folder) {
    pushAgentTask('')({ working: false, text: 'AI Commit needs an open folder (⇧⌘O) with a git repository.', error: true });
    return;
  }
  const upd = pushAgentTask('Reading git diff');
  const d = await window.farnsworth.gitDiff({ cwd: state.folder });
  if (!d?.ok) { upd({ working: false, text: 'AI Commit: ' + (d?.message || d?.error || 'git diff failed'), error: true }); return; }
  if (d.clean) { upd({ working: false, text: 'Working tree clean — nothing to commit.', verified: true }); return; }
  const row = routingRow('commit');
  upd({ working: true, workingLabel: `Writing commit message (${row?.model || 'Haiku 4.5'})` });
  const res = await window.farnsworth.sendMessage({
    model: routedModelApiId('commit'),
    maxTokens: 300,
    system: AI_COMMIT_SYSTEM,
    messages: [{ role: 'user', content: `Branch ${d.branch}, ${d.source} changes${d.truncated ? ' (diff truncated)' : ''}:\n\n${d.diff}` }],
  });
  if (!res?.ok || !res.text?.trim()) {
    upd({ working: false, text: 'AI Commit: model call failed — ' + (res?.message || res?.error || 'empty response'), error: true });
    return;
  }
  const message = sanitizeCommitMessage(res.text);
  const addAll = d.source === 'working'; // nothing staged → stage all on commit
  const usageChip = res.usage ? { label: `${res.usage.input_tokens}→${res.usage.output_tokens} tok`, kind: 'read' } : null;
  if (row?.confirm) {
    // Confirm-before-commit (the routing row's toggle): show the message
    // with Commit/Cancel chips. The chip handlers live in renderMessage.
    upd({
      working: false,
      preambleText: `Proposed commit on ${d.branch}${addAll ? ' (will stage all changes)' : ' (staged changes only)'}:`,
      responseText: '```\n' + message + '\n```',
      chips: [
        { label: 'Commit', kind: 'check', action: 'git-commit-run', payload: message, addAll },
        { label: 'Cancel', kind: 'edit', action: 'git-commit-cancel' },
        ...(usageChip ? [usageChip] : []),
      ],
    });
  } else {
    upd({ working: true, workingLabel: 'Committing' });
    const c = await window.farnsworth.gitCommit({ cwd: state.folder, message, addAll });
    if (!c?.ok) { upd({ working: false, text: 'git commit failed: ' + (c?.message || c?.error), error: true }); return; }
    upd({
      working: false,
      responseText: `Committed \`${c.hash}\` on ${c.branch}:\n\n\`\`\`\n${message}\n\`\`\``,
      verified: true,
      chips: usageChip ? [usageChip] : [],
    });
  }
  scheduleChatHistorySave();
}

// Chip handlers for the confirm flow. m is the live message object from
// state.chatMessages (renderMessage passes it through).
async function runPendingGitCommit(m) {
  if (m._commitDone) return;
  const runChip = (m.chips || []).find(c => c.action === 'git-commit-run');
  if (!runChip) return;
  m._commitDone = true;
  m.working = true;
  m.workingLabel = 'Committing';
  renderChat();
  const c = await window.farnsworth.gitCommit({ cwd: state.folder, message: runChip.payload, addAll: !!runChip.addAll });
  m.working = false;
  if (c?.ok) {
    m.preambleText = '';
    m.responseText = `Committed \`${c.hash}\` on ${c.branch}:\n\n\`\`\`\n${runChip.payload}\n\`\`\``;
    m.verified = true;
    m.chips = (m.chips || []).filter(x => x.kind === 'read'); // keep usage chip
  } else {
    m._commitDone = false; // allow retry
    m.responseText += '\n\ngit commit failed: ' + (c?.message || c?.error || 'unknown');
    m.error = true;
  }
  renderChat();
  scheduleChatHistorySave();
}

function cancelPendingGitCommit(m) {
  if (m._commitDone) return;
  m._commitDone = true;
  m.preambleText = '';
  m.responseText = 'Commit cancelled — nothing was committed.';
  m.chips = [];
  renderChat();
  scheduleChatHistorySave();
}

async function aiReviewCommand() {
  switchLeftTab('chat');
  if (!state.folder) {
    pushAgentTask('')({ working: false, text: 'AI Review needs an open folder (⇧⌘O) with a git repository.', error: true });
    return;
  }
  const upd = pushAgentTask('Reading git diff');
  const d = await window.farnsworth.gitDiff({ cwd: state.folder });
  if (!d?.ok) { upd({ working: false, text: 'AI Review: ' + (d?.message || d?.error || 'git diff failed'), error: true }); return; }
  if (d.clean) { upd({ working: false, text: 'Working tree clean — nothing to review.', verified: true }); return; }
  const row = routingRow('review');
  upd({ working: true, workingLabel: `Reviewing changes (${row?.model || 'Sonnet 5'})` });
  const res = await window.farnsworth.sendMessage({
    model: routedModelApiId('review'),
    maxTokens: 1500,
    system: AI_REVIEW_SYSTEM,
    messages: [{ role: 'user', content: `Branch ${d.branch}, ${d.source} changes${d.truncated ? ' (diff truncated)' : ''}:\n\n${d.diff}` }],
  });
  if (!res?.ok || !res.text?.trim()) {
    upd({ working: false, text: 'AI Review: model call failed — ' + (res?.message || res?.error || 'empty response'), error: true });
    return;
  }
  const usageChip = res.usage ? { label: `${res.usage.input_tokens}→${res.usage.output_tokens} tok`, kind: 'read' } : null;
  upd({
    working: false,
    preambleText: `Code review — ${d.branch} (${d.source} changes, ${row?.model || 'Sonnet 5'}):`,
    responseText: res.text.trim(),
    verified: true,
    chips: usageChip ? [usageChip] : [],
  });
  scheduleChatHistorySave();
}

function openCommandPalette() {
  let overlay = document.getElementById('command-palette-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'command-palette-overlay';
    overlay.className = 'command-palette';
    overlay.innerHTML = `
      <div class="command-palette__panel">
        <input type="text" class="command-palette__input" id="command-palette-input" placeholder="Type a command or search recent folders…" />
        <div class="command-palette__results" id="command-palette-results"></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const input = overlay.querySelector('#command-palette-input');
  input.value = '';
  input.focus();
  const renderResults = async () => {
    const list = overlay.querySelector('#command-palette-results');
    const q = input.value.trim().toLowerCase();
    const recents = window.farnsworth?.getRecent ? await window.farnsworth.getRecent() : [];
    const cmds = [
      { id: 'open-folder', label: 'Open Folder…', shortcut: '⇧⌘O', run: () => openFolderPicker() },
      { id: 'open-file',   label: 'Open File…',   shortcut: '⌘O',  run: () => openFilePicker() },
      { id: 'new-file',    label: 'New File',     shortcut: '⌘N', run: () => openNewFileDialog() },
      { id: 'close-file',  label: 'Close File',   shortcut: '⌘W', run: () => closeActiveFile() },
      { id: 'reopen-closed', label: 'Reopen Closed Editor', shortcut: '⇧⌘T', run: () => reopenLastClosedFile() },
      { id: 'close-folder',label: 'Close Folder', shortcut: '⌥⌘W', run: () => closeFolder() },
      { id: 'reveal-in-finder', label: 'Reveal Active File in Finder', shortcut: '⌘R', run: () => revealActiveInFinder() },
      { id: 'go-to-line',     label: 'Go to Line…',     shortcut: '⌃G',  run: () => goToLine() },
      { id: 'format-document',label: 'Format Document', shortcut: '⇧⌥F', run: () => formatActiveDocument() },
      { id: 'toggle-word-wrap', label: 'Toggle Word Wrap', shortcut: '⌥Z', run: () => toggleWordWrap() },
      { id: 'fold-all',       label: 'Fold All',       shortcut: '⌘K ⌘0', run: () => foldAll() },
      { id: 'unfold-all',     label: 'Unfold All',     shortcut: '⌘K ⌘J', run: () => unfoldAll() },
      { id: 'settings',    label: 'Settings',     shortcut: '⌘,',  run: () => openSettings('ai') },
      { id: 'toggle-files', label: 'Show Files Tab', shortcut: '⌘1', run: () => { state.rightTab = 'files'; renderRightPanel(); } },
      { id: 'toggle-tasks', label: 'Show Tasks Tab', shortcut: '⌘2', run: () => { state.rightTab = 'tasks'; renderRightPanel(); } },
      { id: 'toggle-live',  label: 'Show Live Tab',  shortcut: '⌘3', run: () => { state.rightTab = 'live';  renderRightPanel(); } },
      { id: 'toggle-left',  label: 'Toggle Left Panel',  shortcut: '⌥⌘B', run: () => toggleLeftPanel() },
      { id: 'toggle-right', label: 'Toggle Right Panel', shortcut: '⌥⌘R', run: () => toggleRightPanel() },
      { id: 'focus-term',   label: 'Focus Terminal', shortcut: '⌘`', run: () => switchLeftTab('terminal') },
      { id: 'focus-cc',     label: 'Focus Claude Code', shortcut: '⇧⌘`', run: () => switchLeftTab('claudecode') },
      { id: 'search-in-files', label: 'Search in Files…', shortcut: '⇧⌘F', run: () => openSearchOverlay() },
      { id: 'find-in-file',    label: 'Find in File…',    shortcut: '⌘F',  run: () => { state.codeFindOpen = true; renderCanvas(); } },
      { id: 'find-file-by-name', label: 'Find File by Name…', shortcut: '⇧⌘P', run: () => openFileFinderOverlay() },
      { id: 'rename-file',     label: 'Rename File/Folder', shortcut: 'F2', run: () => renameSelectedFile() },
      { id: 'delete-file',     label: 'Delete File/Folder', shortcut: '⌫',   run: () => deleteSelectedFile() },
      { id: 'ai-commit',       label: 'AI: Commit Changes', shortcut: '',   run: () => aiCommitCommand() },
      { id: 'canvas-devtools',  label: 'Canvas: Open Preview DevTools', shortcut: '', run: () => {
        if (state.settings.canvas?.engine?.devtools === false) {
          pushAgentTask('Canvas DevTools')({ working: false, text: 'DevTools are disabled in Settings → Canvas → Browser engine.' });
          return;
        }
        window.farnsworth?.canvasOpenDevTools?.();
      } },
      { id: 'ai-review',       label: 'AI: Review Changes', shortcut: '',   run: () => aiReviewCommand() },
    ];
    const recentItems = recents.map(r => ({
      id: 'recent:' + r.path,
      label: r.label || r.path.split('/').pop(),
      sublabel: r.path,
      run: () => handleFolderPicked(r.path),
    }));
    const all = [...cmds, ...recentItems];
    const filtered = q ? all.filter(it => it.label.toLowerCase().includes(q) || (it.sublabel || '').toLowerCase().includes(q)) : all;
    list.innerHTML = filtered.slice(0, 20).map((it, i) => `
      <button class="command-palette__item${i === 0 ? ' is-active' : ''}" data-id="${it.id}">
        <span class="command-palette__item-label">${it.label}</span>
        ${it.sublabel ? `<span class="command-palette__item-sub">${it.sublabel}</span>` : ''}
        ${it.shortcut ? `<span class="command-palette__item-kbd">${it.shortcut}</span>` : ''}
      </button>
    `).join('');
    list.querySelectorAll('.command-palette__item').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = filtered.find(it => it.id === btn.dataset.id);
        if (item) { item.run(); overlay.remove(); }
      });
    });
  };
  input.oninput = renderResults;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { overlay.remove(); return; }
    if (e.key === 'Enter') {
      const active = overlay.querySelector('.command-palette__item.is-active');
      if (active) active.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...overlay.querySelectorAll('.command-palette__item')];
      const idx = items.findIndex(b => b.classList.contains('is-active'));
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      items.forEach(b => b.classList.remove('is-active'));
      if (items[next]) items[next].classList.add('is-active');
      e.preventDefault();
    }
  };
  renderResults();
}

// Cmd+Shift+F — Search in Files. Modal overlay with input + options bar +
// results list grouped by file. Clicking a result opens the file in the
// code editor and scrolls to the matching line. State persists in
// state.searchOverlayOpen and state.searchOverlayTerm so the overlay can
// be re-rendered without losing the query.
function openSearchOverlay() {
  let overlay = document.getElementById('search-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'search-overlay';
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
      <div class="search-overlay__panel">
        <div class="search-overlay__input-row">
          <input type="text" class="search-overlay__input" id="search-overlay-input" placeholder="Search in files…" />
          <label class="search-overlay__opt" title="Case sensitive"><input type="checkbox" id="search-overlay-case" />Aa</label>
          <label class="search-overlay__opt" title="Whole word"><input type="checkbox" id="search-overlay-word" />\\b</label>
          <label class="search-overlay__opt" title="Regex"><input type="checkbox" id="search-overlay-regex" />.*</label>
        </div>
        <div class="search-overlay__meta" id="search-overlay-meta"></div>
        <div class="search-overlay__results" id="search-overlay-results"></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { state.searchOverlayOpen = false; overlay.style.display = 'none'; }
    });
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const input = overlay.querySelector('#search-overlay-input');
  const meta = overlay.querySelector('#search-overlay-meta');
  const results = overlay.querySelector('#search-overlay-results');
  const caseEl = overlay.querySelector('#search-overlay-case');
  const wordEl = overlay.querySelector('#search-overlay-word');
  const regexEl = overlay.querySelector('#search-overlay-regex');
  // Restore prior query + options if reopening
  if (state.searchOverlayTerm) input.value = state.searchOverlayTerm;
  if (state.searchOverlayCase) caseEl.checked = true;
  if (state.searchOverlayWord) wordEl.checked = true;
  if (state.searchOverlayRegex) regexEl.checked = true;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  // Debounce the search so we don't spam grep while typing
  let debounceTimer = null;
  let lastSearch = 0;
  const runSearch = async () => {
    const q = input.value;
    state.searchOverlayTerm = q;
    state.searchOverlayCase = caseEl.checked;
    state.searchOverlayWord = wordEl.checked;
    state.searchOverlayRegex = regexEl.checked;
    if (!q) { meta.textContent = ''; results.innerHTML = '<div class="search-overlay__empty">Type a query to search across all files in the workspace.</div>'; return; }
    if (!state.folder) { meta.textContent = 'No folder open'; results.innerHTML = ''; return; }
    const stamp = ++lastSearch;
    meta.textContent = 'Searching…';
    results.innerHTML = '';
    // Build the query: wrap with word-boundary if whole-word, escape special chars if not regex
    let term = q;
    if (!regexEl.checked) term = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wordEl.checked) term = `\\b${term}\\b`;
    const res = await window.farnsworth.grepWorkspace(state.folder, term, {
      regex: true,
      caseSensitive: caseEl.checked,
      includeGlobs: [],
      maxResults: 500,
    });
    if (stamp !== lastSearch) return; // a newer keystroke superseded us
    if (!res.ok) { meta.textContent = 'Error: ' + res.error; results.innerHTML = ''; return; }
    meta.textContent = `${res.matches.length} match${res.matches.length === 1 ? '' : 'es'} in ${res.files} file${res.files === 1 ? '' : 's'}`;
    if (!res.matches.length) { results.innerHTML = '<div class="search-overlay__empty">No matches.</div>'; return; }
    // Group by file for readability
    const byFile = {};
    for (const m of res.matches) {
      (byFile[m.file_path] = byFile[m.file_path] || []).push(m);
    }
    const sortedFiles = Object.keys(byFile).sort();
    results.innerHTML = sortedFiles.map(f => {
      const fileMatches = byFile[f];
      return `
        <div class="search-overlay__file">
          <div class="search-overlay__file-name">${escapeHtml(f)} (${fileMatches.length})</div>
          ${fileMatches.slice(0, 50).map(m => `
            <button class="search-overlay__match" data-file="${escapeHtml(f)}" data-line="${m.line_number}">
              <span class="search-overlay__match-lineno">${m.line_number}</span>
              <span class="search-overlay__match-text">${escapeHtml(m.line_text)}</span>
            </button>
          `).join('')}
          ${fileMatches.length > 50 ? `<div class="search-overlay__more">… ${fileMatches.length - 50} more in this file</div>` : ''}
        </div>
      `;
    }).join('');
    results.querySelectorAll('.search-overlay__match').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.file;
        const line = parseInt(btn.dataset.line, 10);
        overlay.style.display = 'none';
        state.searchOverlayOpen = false;
        // Open the file in code view and jump to the line
        const fileName = file.split('/').pop();
        const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
        openFile({ path: file, name: fileName, ext, type: 'file' });
        // Poll for monacoEditor to mount (Monaco loads async; 150ms isn't
        // always enough on first file open), then jump to the matched line.
        let attempts = 0;
        const pollForEditor = setInterval(() => {
          attempts++;
          if (monacoEditor && monacoEditor.getModel && monacoEditor.getModel()) {
            clearInterval(pollForEditor);
            const model = monacoEditor.getModel();
            const lineCount = model.getLineCount();
            const safeLine = Math.max(1, Math.min(lineCount, line));
            monacoEditor.revealLineInCenter(safeLine);
            monacoEditor.setPosition({ lineNumber: safeLine, column: 1 });
            monacoEditor.focus();
          } else if (attempts > 40) {
            clearInterval(pollForEditor);
          }
        }, 100);
      });
    });
  };
  const scheduleSearch = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 150);
  };
  input.oninput = scheduleSearch;
  caseEl.onchange = runSearch;
  wordEl.onchange = runSearch;
  regexEl.onchange = () => { if (input.value) runSearch(); else input.oninput = scheduleSearch; };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { state.searchOverlayOpen = false; overlay.style.display = 'none'; }
  };
  runSearch();
}

// Cmd+Shift+P — Find File by Name. Modal overlay with input + flat file list
// from fs:listFiles, fuzzy-matched on path. Arrow keys / Enter navigate the
// list; Enter or click opens the file in Monaco. Caches the file list for
// the active workspace for 30s so opening multiple times is instant.
let fileFinderCache = { folder: null, files: null, fetchedAt: 0 };
const FILE_FINDER_TTL_MS = 30000;

function openFileFinderOverlay() {
  let overlay = document.getElementById('file-finder-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'file-finder-overlay';
    overlay.className = 'file-finder-overlay';
    overlay.innerHTML = `
      <div class="file-finder-overlay__panel">
        <input type="text" class="file-finder-overlay__input" id="file-finder-overlay-input" placeholder="Find file by name…" />
        <div class="file-finder-overlay__meta" id="file-finder-overlay-meta"></div>
        <div class="file-finder-overlay__results" id="file-finder-overlay-results"></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { state.fileFinderOpen = false; overlay.style.display = 'none'; }
    });
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const input = overlay.querySelector('#file-finder-overlay-input');
  const meta = overlay.querySelector('#file-finder-overlay-meta');
  const results = overlay.querySelector('#file-finder-overlay-results');
  if (state.fileFinderTerm) input.value = state.fileFinderTerm;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  // Fuzzy match: each char in `q` must appear in `path` in order (case-insensitive).
  // Score = earlier matches + matches after a path separator score higher, matches
  // on the basename score highest. Returns null if not a match.
  const fuzzy = (path, q) => {
    if (!q) return 100;
    const p = path.toLowerCase();
    const qq = q.toLowerCase();
    if (p.includes(qq)) return 200 - p.indexOf(qq); // substring match → high score, earlier = better
    let pi = 0, qi = 0, score = 0, lastMatch = -1;
    while (pi < p.length && qi < qq.length) {
      if (p[pi] === qq[qi]) {
        // Reward contiguous matches + matches right after a separator
        if (lastMatch === pi - 1) score += 8;
        if (pi > 0 && (p[pi - 1] === '/' || p[pi - 1] === '-' || p[pi - 1] === '_' || p[pi - 1] === '.')) score += 5;
        // Reward basename hits (after last '/')
        const lastSlash = p.lastIndexOf('/', pi);
        if (lastSlash > 0 && pi - lastSlash < 12) score += 3;
        lastMatch = pi;
        qi++;
      }
      pi++;
    }
    if (qi < qq.length) return null;
    return score;
  };

  const refreshFileList = async () => {
    if (!state.folder) return null;
    const now = Date.now();
    if (fileFinderCache.folder === state.folder && fileFinderCache.files && (now - fileFinderCache.fetchedAt) < FILE_FINDER_TTL_MS) {
      return fileFinderCache.files;
    }
    const r = await window.farnsworth.listFiles(state.folder, { maxDepth: 8 });
    if (!r.ok) return null;
    fileFinderCache = { folder: state.folder, files: r.files, fetchedAt: now };
    return r.files;
  };

  let lastQuery = 0;
  const renderList = async () => {
    const q = input.value;
    state.fileFinderTerm = q;
    const stamp = ++lastQuery;
    const files = await refreshFileList();
    if (stamp !== lastQuery) return;
    if (!files) {
      meta.textContent = state.folder ? 'Failed to list files' : 'No folder open';
      results.innerHTML = '';
      return;
    }
    if (!q) {
      // No query — show recently-changed files (just the first 50 in alphabetical order)
      meta.textContent = `${files.length} files in workspace`;
      const list = [...files].sort().slice(0, 50);
      renderItems(list.map(f => ({ path: f, score: 0 })), '');
      return;
    }
    const scored = [];
    for (const f of files) {
      const s = fuzzy(f, q);
      if (s !== null) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 50);
    meta.textContent = `${top.length} of ${scored.length} match${top.length === 1 ? '' : 'es'}`;
    renderItems(top, q);
  };

  const renderItems = (items, q) => {
    if (!items.length) {
      results.innerHTML = '<div class="file-finder-overlay__empty">No matches.</div>';
      return;
    }
    results.innerHTML = items.map((it, i) => {
      // Highlight the matched substring in the basename
      const lastSlash = it.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? it.path.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? it.path.slice(lastSlash + 1) : it.path;
      let nameHtml = escapeHtml(name);
      let dirHtml = dir ? `<span class="file-finder-overlay__item-dir">${escapeHtml(dir)}</span>` : '';
      if (q) {
        const lower = name.toLowerCase();
        const qLower = q.toLowerCase();
        const idx = lower.indexOf(qLower);
        if (idx >= 0) {
          nameHtml = escapeHtml(name.slice(0, idx)) + '<mark>' + escapeHtml(name.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(name.slice(idx + q.length));
        }
      }
      return `
        <button class="file-finder-overlay__item${i === 0 ? ' is-active' : ''}" data-path="${escapeHtml(it.path)}">
          ${dirHtml}<span class="file-finder-overlay__item-name">${nameHtml}</span>
        </button>
      `;
    }).join('');
    results.querySelectorAll('.file-finder-overlay__item').forEach(btn => {
      btn.addEventListener('click', () => {
        const filePath = btn.dataset.path;
        const fileName = filePath.split('/').pop();
        const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
        overlay.style.display = 'none';
        state.fileFinderOpen = false;
        openFile({ path: filePath, name: fileName, ext, type: 'file' });
      });
    });
  };

  let debounceTimer = null;
  const schedule = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderList, 80);
  };
  input.oninput = schedule;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { state.fileFinderOpen = false; overlay.style.display = 'none'; return; }
    if (e.key === 'Enter') {
      const active = overlay.querySelector('.file-finder-overlay__item.is-active');
      if (active) active.click();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...overlay.querySelectorAll('.file-finder-overlay__item')];
      const idx = items.findIndex(b => b.classList.contains('is-active'));
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      items.forEach(b => b.classList.remove('is-active'));
      if (items[next]) items[next].classList.add('is-active');
      items[next]?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    }
  };
  renderList();
}

function openFilePicker() {
  // Delegate to the existing IPC bridge (same dialog the native menu uses).
  // Implemented as a direct electron dialog via main process IPC; the
  // renderer's file:open IPC isn't wired yet, so we fall through to
  // openFolderPicker for now (Long can drop a file into the file tree).
  openFolderPicker();
}

function toggleLeftPanel() {
  const btn = document.getElementById('left-panel-toggle-btn');
  if (btn) btn.click();
}
function toggleRightPanel() {
  const btn = document.getElementById('right-panel-toggle-btn');
  if (btn) btn.click();
}
function switchLeftTab(tab) {
  const btn = document.getElementById('lefttab-' + tab);
  if (btn) btn.click();
}

function appTypeLabel(type) {
  // Short lowercase label for the chat header subline. Was 'Three.js Game' /
  // 'Blockchain Game' / 'Devvit Game' — Long flagged the "Game" suffix as
  // visual noise on Jul 6 ~09:00 ET. Now just the project type name.
  // Returns '' for unknown types so the subline stays clean.
  if (type === 'threejs') return 'threejs';
  if (type === 'blockchain') return 'blockchain';
  if (type === 'devvit') return 'devvit';
  return '';
}

// ============================================================================
// WELCOME OVERLAY
// ============================================================================
function showWelcome() {
  $('#welcome-overlay').hidden = false;
  renderRecentFolders();
}
function hideWelcome() {
  $('#welcome-overlay').hidden = true;
}
async function renderRecentFolders() {
  const list = $('#welcome-recent-list');
  if (!list) return;
  list.innerHTML = '';
  let recent = [];
  if (window.farnsworth) recent = await window.farnsworth.getRecent();
  if (!recent.length) {
    list.innerHTML = '<div class="welcome__recent-empty">No recent folders yet</div>';
    return;
  }
  recent.forEach(r => {
    const row = el('button', { class: 'welcome__recent-item', onClick: () => handleFolderPicked(r.path) });
    row.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <div class="welcome__recent-body">
        <div class="welcome__recent-name">${r.name}</div>
        <div class="welcome__recent-path">${r.path}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6d7178" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
    `;
    list.appendChild(row);
  });
}

// ============================================================================
// APP TYPE PICKER
// ============================================================================
function showAppTypePicker(folderPath) {
  hideWelcome();
  $('#apptype-folder-name').textContent = folderPath;
  $('#apptype-overlay').hidden = false;
}
function hideAppTypePicker() {
  $('#apptype-overlay').hidden = true;
}
async function selectAppType(type) {
  state.appType = type;
  if (window.farnsworth && state.folder) {
    await window.farnsworth.saveWorkspaceConfig(state.folder, { appType: type, createdAt: new Date().toISOString() });
  }
  hideAppTypePicker();
  await loadFolderFiles(state.folder);
  updateWindowTitle();
  // App type just chosen — re-detect the matching farnsworth dev server and
  // re-render the canvas so preview iframes point at it if it's running.
  await loadFarnsworthDev();
  renderCanvas();
}

// ============================================================================
// AUTH
// ============================================================================
async function detectAuth() {
  if (!window.farnsworth) return;
  const keyRes = await window.farnsworth.hasApiKey();
  state.auth.apiKeySet = keyRes.ok && keyRes.hasKey;
  // OpenAI credentials (stored key + Codex CLI login detection)
  try {
    const oaRes = await window.farnsworth.hasApiKey('openai-api');
    state.auth.openaiKeySet = !!(oaRes.ok && oaRes.hasKey);
    const cxRes = await window.farnsworth.codexStatus();
    state.auth.codexAvailable = !!(cxRes.ok && cxRes.available);
    state.auth.codexMethod = cxRes.method || null;
  } catch {}
  const ccRes = await window.farnsworth.checkClaudeCode();
  state.auth.claudeCodeAvailable = ccRes.ok && ccRes.hasAuth;
  // Store Keychain details so the Settings panel can show them.
  if (ccRes.ok && ccRes.hasAuth) {
    state.auth.claudeCodeSubscriptionType = ccRes.subscriptionType || null;
    state.auth.claudeCodeExpiresAt = ccRes.expiresAt || null;
  } else {
    state.auth.claudeCodeSubscriptionType = null;
    state.auth.claudeCodeExpiresAt = null;
  }
  // OAuth status
  try {
    const oauthRes = await window.farnsworth.oauthStatus();
    if (oauthRes.ok && oauthRes.connected) {
      state.auth.oauthConnected = true;
      state.auth.oauthExpiresAt = oauthRes.expiresAt;
      state.auth.oauthExpiresInSec = oauthRes.expiresInSec;
      state.auth.oauthAccountInfo = oauthRes.accountInfo;
      // Auto-refresh if expires in < 1 hour
      if (oauthRes.expiresInSec !== null && oauthRes.expiresInSec < 3600) {
        window.farnsworth.oauthRefresh().then(r => {
          if (r.ok) {
            state.auth.oauthExpiresAt = r.expiresAt;
            state.auth.oauthExpiresInSec = Math.floor((new Date(r.expiresAt) - new Date()) / 1000);
          }
        });
      }
    }
  } catch {}
  updateStatusBar(); // connection chip reads state.auth
}

async function saveApiKey() {
  const input = $('#ai-apikey-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;
  if (!key.startsWith('sk-ant-')) {
    alert('Anthropic API keys start with sk-ant-. Check the value and try again.');
    return;
  }
  const res = await window.farnsworth.setApiKey(key);
  if (res.ok) {
    state.auth.apiKeySet = true;
    renderSettings();
    updateStatusBar();
  } else {
    alert('Could not save API key: ' + res.error);
  }
}

async function clearApiKey() {
  if (window.farnsworth) await window.farnsworth.clearApiKey();
  state.auth.apiKeySet = false;
  renderSettings();
  updateStatusBar();
}

async function saveOpenaiKey() {
  const input = $('#ai-openai-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;
  // OpenAI keys: sk-..., sk-proj-..., org-scoped variants — all start sk-.
  // Reject Anthropic keys pasted in the wrong box (sk-ant- also starts
  // with sk-, so check the specific prefix first).
  if (key.startsWith('sk-ant-')) {
    alert('That looks like an Anthropic key (sk-ant-…). Paste it in the Anthropic section above.');
    return;
  }
  if (!key.startsWith('sk-')) {
    alert('OpenAI API keys start with sk-. Check the value and try again.');
    return;
  }
  const res = await window.farnsworth.setApiKey(key, 'openai-api');
  if (res.ok) {
    state.auth.openaiKeySet = true;
    renderSettings();
  } else {
    alert('Could not save API key: ' + res.error);
  }
}

async function clearOpenaiKey() {
  if (window.farnsworth) await window.farnsworth.clearApiKey('openai-api');
  state.auth.openaiKeySet = false;
  renderSettings();
}

// Settings section ⓘ buttons (Jul 14) — headers carry an info button whose
// explainer lives in data-info; one popover at a time, closes on outside
// mousedown or a second click. Delegated because renderSettings() rebuilds
// innerHTML on every call (the wire()-once gotcha).
function toggleSettingsInfoPop(btn) {
  const wrap = btn.closest('.settings-info-wrap');
  if (!wrap) return;
  const existing = wrap.querySelector('.settings-info-pop');
  document.querySelectorAll('.settings-info-pop').forEach(p => p.remove());
  if (existing) return; // second click on the same ⓘ = close
  const pop = el('div', { class: 'settings-info-pop' });
  pop.textContent = btn.dataset.info || '';
  wrap.appendChild(pop);
  const dismiss = (e) => {
    if (!wrap.contains(e.target)) {
      pop.remove();
      document.removeEventListener('mousedown', dismiss, true);
    }
  };
  document.addEventListener('mousedown', dismiss, true);
}

// ============================================================================
// OAUTH FLOW — Sign in with Claude.ai (subscription-based)
// ============================================================================
function oauthConnectedHTML(expiresInSec) {
  const expiresLabel = expiresInSec !== null
    ? (expiresInSec < 3600 ? `Expires in ${Math.max(1, Math.floor(expiresInSec / 60))} min — refresh now`
                           : `Expires in ${Math.floor(expiresInSec / 3600)} hours`)
    : 'Connected';
  return `
    <div style="flex:1;">
      <div class="apikey-row__status is-set">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        Signed in via Claude.ai · ${expiresLabel}
      </div>
    </div>
    <button class="btn btn--ghost btn--sm" id="oauth-refresh-btn">Refresh</button>
    <button class="btn btn--ghost btn--sm" id="oauth-disconnect-btn">Disconnect</button>
  `;
}

// Claude Code CLI auth via Keychain is a valid auth state — same OAuth token
// shape as Claude.ai OAuth, so Farnsworth can use it for inference. Renders
// the same "is-set" status indicator with the subscription type from the
// Keychain entry instead of the claude.ai OAuth expiry timer.
function claudeCodeConnectedHTML(subscriptionType, expiresAt) {
  // No expiry countdown here (Jul 14, Long: "why is there a lot of text").
  // getValidAccessToken() silently refreshes the token within 60s of expiry
  // on every inference call, so "expires in 1 min" was permanent-looking
  // alarm noise about a value designed to go stale. expiresAt param kept
  // for signature stability; state.auth still carries it for debugging.
  const sub = subscriptionType ? ` · ${subscriptionType}` : '';
  return `
    <div style="flex:1;">
      <div class="apikey-row__status is-set">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        Signed in via Claude Code CLI${sub}
      </div>
    </div>
    <button class="btn btn--ghost btn--sm" id="oauth-disconnect-btn">Disconnect</button>
  `;
}

function oauthDisconnectedHTML() {
  return `
    <div style="flex:1;">
      <button class="btn btn--primary btn--full" id="oauth-import-keychain-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Sign in with Claude Code CLI
      </button>
      <div class="oauth-help">Uses the login Claude Code CLI already stored in your Keychain.</div>
      <div class="oauth-help" style="margin-top:10px;">Don't have Claude Code CLI? Install with <code>npm i -g @anthropic-ai/claude-code</code> and run <code>claude login</code> first, then click above.</div>
      <details style="margin-top:14px;">
        <summary style="cursor:pointer; font-size:12px; color:var(--text-dim); user-select:none;">Sign in with claude.ai directly (likely broken)</summary>
        <div style="margin-top:8px;">
          <button class="btn btn--ghost btn--full" id="oauth-start-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
            Try the claude.ai OAuth flow
          </button>
          <div class="oauth-help">Opens claude.ai in your browser. The authorize flow is currently broken on Anthropic's side — kept here in case they ship a fix.</div>
        </div>
      </details>
    </div>
  `;
}

function oauthInProgressHTML(authUrl) {
  return `
    <div style="flex:1;">
      <div class="apikey-row__status is-missing">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>
        Awaiting authorization code…
      </div>
      <div class="oauth-instr">
        1. Browser opened to claude.ai · <a href="#" id="oauth-reopen">reopen</a><br>
        2. Approve the request — you'll land on a <code>console.anthropic.com/oauth/code/callback</code> page showing an authorization code<br>
        3. Copy the entire code (it may look like <code>abc123...xyz#statevalue</code> — paste the whole thing)<br>
        4. Paste below and press Enter
      </div>
      <div class="oauth-input-row">
        <input type="text" id="oauth-code-input" class="apikey-input" placeholder="paste the code (or CODE#STATE) here…" autocomplete="off" />
        <button class="btn btn--primary btn--sm" id="oauth-submit-btn">Submit</button>
        <button class="btn btn--ghost btn--sm" id="oauth-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
}

async function startOAuth() {
  if (!window.farnsworth) return;
  const res = await window.farnsworth.oauthStart();
  if (!res.ok) {
    alert('Could not start OAuth: ' + res.error);
    return;
  }
  state.auth.oauthInProgress = true;
  state.auth.oauthState = res.state;
  renderSettings();

  // Platform code flow: no loopback server. After user approves on claude.ai,
  // browser shows platform.claude.com/oauth/code/callback page with the auth code
  // formatted `<48chars>#<fragment>`. User copies just the 48 chars and submits
  // via submitOAuthCode(). The code input is already visible after renderSettings().
  // Auto-focus the input so paste-and-Enter works without an extra click.
  setTimeout(() => {
    const codeInput = $('#oauth-code-input');
    if (codeInput) codeInput.focus();
  }, 100);
}

async function submitOAuthCode() {
  const codeInput = $('#oauth-code-input');
  if (!codeInput || !codeInput.value.trim()) return;
  if (!window.farnsworth || !state.auth.oauthState) return;
  const code = codeInput.value.trim();
  // Strip URL if user pasted the whole callback URL (e.g. https://console.anthropic.com/oauth/code/callback?code=XXX&state=YYY)
  const urlMatch = code.match(/code=([a-zA-Z0-9_-]+)/);
  let cleanCode = urlMatch ? urlMatch[1] : code;
  // Also strip the surrounding state param if it came along
  const stateMatch = code.match(/state=([a-zA-Z0-9_-]+)/);
  if (stateMatch && !cleanCode.includes('#')) {
    cleanCode = `${cleanCode}#${stateMatch[1]}`;
  }
  const submitBtn = $('#oauth-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Exchanging…'; }
  const res = await window.farnsworth.oauthComplete(cleanCode, state.auth.oauthState);
  if (res.ok) {
    state.auth.oauthConnected = true;
    state.auth.oauthExpiresAt = res.expiresAt;
    state.auth.oauthExpiresInSec = Math.floor((new Date(res.expiresAt) - new Date()) / 1000);
    state.auth.oauthAccountInfo = res.accountInfo;
    state.auth.oauthInProgress = false;
    state.auth.oauthState = null;
    renderSettings();
  } else {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
    alert('Could not complete OAuth: ' + res.error);
  }
}

async function cancelOAuth() {
  state.auth.oauthInProgress = false;
  state.auth.oauthState = null;
  renderSettings();
}

async function disconnectOAuth() {
  if (!confirm('Disconnect from Claude.ai? You can sign in again anytime.')) return;
  if (window.farnsworth) await window.farnsworth.oauthDisconnect();
  state.auth.oauthConnected = false;
  state.auth.oauthExpiresAt = null;
  state.auth.oauthExpiresInSec = null;
  state.auth.oauthAccountInfo = null;
  renderSettings();
}

async function importFromKeychain() {
  if (!window.farnsworth) return;
  const importBtn = $('#oauth-import-keychain-btn');
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Importing…'; }
  let res = await window.farnsworth.importFromKeychain();

  // No credential store entry — drive `claude login` ourselves. The CLI opens
  // the browser, captures the local-loopback callback, writes the token to
  // the OS credential store, and exits. Main then auto-imports the entry.
  if (!res.ok && res.error === 'no_credentials' && window.farnsworth.runClaudeLogin) {
    if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Running claude login… (browser opened, please authorize)'; }
    res = await window.farnsworth.runClaudeLogin();
  }

  if (res.ok) {
    state.auth.oauthConnected = true;
    state.auth.oauthExpiresAt = res.expiresAt;
    state.auth.oauthExpiresInSec = res.expiresInSec;
    state.auth.oauthAccountInfo = res.accountInfo;
    state.auth.oauthInProgress = false;
    state.auth.oauthState = null;
    renderSettings();
  } else {
    if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'Sign in with Claude Code CLI'; }
    alert('Could not sign in: ' + (res.message || res.error) + '\n\nRun `claude login` in a Terminal first if you don\'t have Claude Code CLI installed.');
  }
}

async function refreshOAuth() {
  if (!window.farnsworth) return;
  const res = await window.farnsworth.oauthRefresh();
  if (res.ok) {
    state.auth.oauthExpiresAt = res.expiresAt;
    state.auth.oauthExpiresInSec = Math.floor((new Date(res.expiresAt) - new Date()) / 1000);
    renderSettings();
  } else {
    alert('Could not refresh token: ' + res.error + '. You may need to sign in again.');
    state.auth.oauthConnected = false;
    renderSettings();
  }
}

// ============================================================================
// EVENT WIRING
// ============================================================================
function updateModeToggles() {
  $$('.mode-toggle').forEach(t => {
    t.classList.toggle('is-active', t.dataset.mode === state.canvasMode);
    // Pulse the Live Preview chip only when the Farnsworth dev server
    // is actually running — otherwise it blinks green by default.
    if (t.dataset.mode === 'live') {
      t.classList.toggle('is-live', !!state.farnsworthDev?.available);
    }
  });
  $$('.size-toggle').forEach(t => t.classList.toggle('is-active', t.dataset.size === state.preview));
  $$('.vm-toggle').forEach(t => {
    const k = t.dataset.vm;
    t.classList.toggle('is-active', state.vm[k]);
  });
}

function wire() {
  // ⌘Z / Ctrl+Z = undo last mark-up stroke when markup mode is active.
  // Skip when typing in an input/textarea/contenteditable so we don't
  // intercept undo in the chat composer, find bar, comment box, etc.
  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.key !== 'z' || ev.shiftKey) return;
    if (!state.vm.markup) return;
    const a = document.activeElement;
    const tag = (a?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || a?.isContentEditable) return;
    ev.preventDefault();
    if (state.vmMarkupStrokes?.length) {
      state.vmMarkupStrokes.pop();
      drawMarkupStrokes();
    }
  });

  // Right panel tabs
  $$('.righttab').forEach(t => t.addEventListener('click', () => {
    state.rightTab = t.dataset.tab;
    renderRightPanel();
    // Lazy file tree — if user opens the Files tab and the tree hasn't
    // been walked for the current folder yet, walk it now. Without this
    // hook the panel would render an empty tree for any folder that
    // was picked while a different tab was active (Jul 3 ~15:11 ET).
    if (state.rightTab === 'files' && state.folder && state.files.loadedForFolder !== state.folder) {
      loadFolderFiles(state.folder);
    }
  }));

  // Left panel tabs (Terminal / Chat)
  $('#lefttab-chat')?.addEventListener('click', () => switchLeftPanel('chat'));
  $('#lefttab-terminal')?.addEventListener('click', () => switchLeftPanel('terminal'));
  $('#lefttab-claudecode')?.addEventListener('click', () => switchLeftPanel('claudecode'));
  $('#claude-code-new-tab')?.addEventListener('click', () => {
    if (state.leftPanel !== 'claudecode') switchLeftPanel('claudecode');
    addClaudeCodeTab();
  });
  $('#terminal-new-tab')?.addEventListener('click', addTerminalTab);
  // Initial active state
  $('#lefttab-chat')?.classList.add('is-active');

  // Canvas mode toggles
  $$('.mode-toggle').forEach(t => t.addEventListener('click', () => {
    state.canvasMode = t.dataset.mode;
    updateModeToggles();
    renderCanvas();
  }));

  // Size toggles — switching preview category also resets the resolution
  // dropdown to the matching preset for that category (Post View → 480,
  // Mobile → 360, Desktop → 628 Reddit Desktop, Fullscreen → 1120). This
  // keeps the dropdown in sync with the category defaults so the user
  // isn't surprised by a mismatched value after clicking a category.
  $$('.size-toggle').forEach(t => t.addEventListener('click', () => {
    // Nuke every canvas WebContentsView BEFORE changing preview so no
    // orphan views survive the switch. The async setup race (Jul 11
    // ~16:30 ET -- testview WebContentsView persisted across the
    // Post View switch because canvasCreateView resolved after teardown
    // had already run) is caught here: regardless of in-flight
    // createView promises, every view in main.js's canvasWebContentsViews
    // map gets destroyed before the new DOM is rendered. The fresh
    // preview's setupCanvasBrowserViews will recreate any views it
    // needs immediately after.
    window.farnsworth?.canvasRemoveAllViews?.();
    state.preview = t.dataset.size;
    // Reset the resolution dropdown to the category's default preset.
    syncResolutionDropdownToCategory();
    // Switching category drops any custom height override (the new
    // category's aspect ratio applies unless the user re-picks a preset).
    if (state.previewCustomHeight) delete state.previewCustomHeight[state.preview];
    updateModeToggles();
    renderCanvas();
  }));

  // Resolution preset dropdown — sets the canvas artboard width (and
  // optional height for custom). Picking a preset writes
  // state.previewWidths[state.preview] and re-renders. "Custom…" reveals
  // two number inputs the user can type any W × H into.
  // syncResolutionDropdownToCategory() — selects the matching dropdown
  // option for the current preview category's default width so the
  // dropdown doesn't lie about what's on screen after a category swap.
  function syncResolutionDropdownToCategory() {
    const sel = $('#canvas-resolution-select');
    if (!sel) return;
    const w = state.previewWidths[state.preview];
    // Find the option whose width matches the category default. Options
    // are keyed on "width,height" strings (e.g. "390,844") so we split
    // and compare only the width portion. If the user has set a custom
    // height, fall through to the Custom branch.
    const hasCustomH = !!state.previewCustomHeight?.[state.preview];
    const opt = Array.from(sel.options).find(o => {
      const v = o.value;
      if (v === 'custom') return false;
      const [wStr] = v.split(',');
      return parseInt(wStr, 10) === w;
    });
    // Special case: Post View's default 480 has no height component.
    if (!opt && w === 480 && state.preview === 'post') {
      const post480 = Array.from(sel.options).find(o => o.value === '480');
      if (post480) { sel.value = '480'; const c = $('#canvas-resolution-custom'); if (c) c.hidden = true; return; }
    }
    if (opt && !hasCustomH) {
      sel.value = opt.value;
      const custom = $('#canvas-resolution-custom');
      if (custom) custom.hidden = true;
      return;
    }
    // No matching preset (or user set a custom height) — show the
    // Custom inputs with the current values.
    sel.value = 'custom';
    const custom = $('#canvas-resolution-custom');
    const wIn = $('#canvas-resolution-w');
    const hIn = $('#canvas-resolution-h');
    if (custom) custom.hidden = false;
    if (wIn) wIn.value = String(w);
    const h = state.previewCustomHeight?.[state.preview];
    if (hIn) hIn.value = h ? String(h) : '';
  }
  const resSelect = $('#canvas-resolution-select');
  const resCustom = $('#canvas-resolution-custom');
  const resW = $('#canvas-resolution-w');
  const resH = $('#canvas-resolution-h');
  if (resSelect) {
    resSelect.addEventListener('change', () => {
      const v = resSelect.value;
      if (v === 'custom') {
        // Show the custom input row, leave existing width alone.
        if (resCustom) resCustom.hidden = false;
        // Seed with current width so the user has something to edit.
        const cur = state.previewWidths[state.preview] || 720;
        if (resW) resW.value = cur;
        if (resH) resH.value = '';
        return;
      }
      if (resCustom) resCustom.hidden = true;
      const [wRaw, hRaw] = v.split(',');
      const w = parseInt(wRaw, 10);
      const h = hRaw ? parseInt(hRaw, 10) : null;
      if (!Number.isFinite(w)) return;
      // Store the new width under the current preview category; the
      // height gets re-derived from the category's aspect ratio in
      // renderCanvas() unless we have a custom h.
      state.previewWidths[state.preview] = w;
      if (h) {
        // Stash custom height alongside the width so renderCanvas can
        // use it directly instead of recomputing from the category
        // aspect ratio. We piggyback on previewCustomHeight[category].
        state.previewCustomHeight = state.previewCustomHeight || {};
        state.previewCustomHeight[state.preview] = h;
      } else {
        if (state.previewCustomHeight) delete state.previewCustomHeight[state.preview];
      }
      renderCanvas();
    });
  }
  // Apply custom W × H on Enter or blur. The preview's height overrides
  // the category-derived aspect ratio when set.
  const applyCustom = () => {
    const w = parseInt(resW?.value || '', 10);
    const h = parseInt(resH?.value || '', 10);
    if (!Number.isFinite(w)) return;
    state.previewWidths[state.preview] = w;
    state.previewCustomHeight = state.previewCustomHeight || {};
    state.previewCustomHeight[state.preview] = Number.isFinite(h) ? h : null;
    renderCanvas();
  };
  if (resW) { resW.addEventListener('change', applyCustom); resW.addEventListener('blur', applyCustom); resW.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustom(); }); }
  if (resH) { resH.addEventListener('change', applyCustom); resH.addEventListener('blur', applyCustom); resH.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustom(); }); }

  // View mode toggles
  $$('.vm-toggle').forEach(t => t.addEventListener('click', () => {
    const k = t.dataset.vm;
    state.vm[k] = !state.vm[k];
    updateModeToggles();
    // Mark up + Comments live as overlays in the canvas — re-render
    // to mount/unmount them. Edit/Tweaks have no DOM effect yet.
    if (k === 'markup' || k === 'comments') renderCanvas();
  }));

  // Zoom
  $('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(200, state.zoom + 10); state._zoomManualFor = state.preview; updateZoom(); });
  $('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(25, state.zoom - 10); state._zoomManualFor = state.preview; updateZoom(); });

  // Settings
  $('#btn-settings').addEventListener('click', openSettings);
  $$('[data-close-settings]').forEach(el => el.addEventListener('click', closeSettings));
  $$('.settings__rail-item').forEach(item => item.addEventListener('click', () => {
    state.settingsPage = item.dataset.page;
    renderSettings();
  }));

  // Chat input
  $('#chat-send').addEventListener('click', sendChatMessage);
  $('#chat-input').addEventListener('keydown', e => {
    // Enter submits; Shift+Enter inserts a newline (default textarea
    // behavior preserved). The old handler required Cmd+Enter which made
    // a bare Enter insert a newline instead of sending — Long flagged
    // this Jul 6 ~08:30 ET.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Chat input auto-grow (Jul 11 ~16:57 ET) — textarea grows with content
  // up to .chat__textarea's max-height (200px ≈ 8 lines), then scrolls.
  // Resets height to 'auto' before measuring scrollHeight so backspace
  // actually SHRINKS the box. Runs on input + on every value-mutation
  // (paste, programmatic set). Called once at init to handle any preloaded
  // value across renderer reloads.
  const chatInput = $('#chat-input');
  const autoresizeChatInput = () => {
    if (!chatInput) return;
    // Reset to 'auto' so backspace / delete actually shrinks the box;
    // scrollHeight reflects only the content + min-height floor after reset.
    chatInput.style.height = 'auto';
    // Cap at the .chat__textarea max-height (200px ≈ 8 lines). Past that,
    // overflow-y:auto on the textarea scrolls the content internally.
    const targetH = Math.min(chatInput.scrollHeight, 200);
    chatInput.style.height = targetH + 'px';
  };
  if (chatInput) {
    chatInput.addEventListener('input', autoresizeChatInput);
    // Initial sizing (in case value was preloaded from a draft)
    autoresizeChatInput();
  }

  // Chat history dropdown — toggle, new chat, list delegation, delete.
  $('#chat-history-toggle')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleChatHistory();
  });
  $('#chat-history-panel')?.addEventListener('click', (ev) => ev.stopPropagation());
  $('#chat-history-new')?.addEventListener('click', startNewConversation);
  $('#chat-history-list')?.addEventListener('click', (ev) => {
    const delId = ev.target.closest('[data-del-conv]')?.getAttribute('data-del-conv');
    if (delId) {
      ev.stopPropagation();
      deleteConversation(delId);
      return;
    }
    const item = ev.target.closest('[data-conv-id]');
    if (item) {
      const id = item.getAttribute('data-conv-id');
      switchConversation(id);
    }
  });
  // Click anywhere outside the dropdown closes it.
  document.addEventListener('click', (ev) => {
    if (!state.chatHistoryOpen) return;
    if (ev.target.closest('#chat-history-wrap')) return;
    toggleChatHistory(false);
  });

  // Jul 6 ~09:00 ET — Long: "when you click anywhere on that side open the
  // conversations dropdown". The .chat__project area (avatar + name + sub)
  // is the entire left side of the chat header. Clicking it toggles the
  // conversations dropdown, mirroring the toggle button behavior.
  const chatProjectEl = document.querySelector('.chat__project');
  if (chatProjectEl) {
    chatProjectEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleChatHistory();
    });
    chatProjectEl.style.cursor = 'pointer';
    chatProjectEl.title = 'Open conversations';
  }

  // CTA buttons
  $('#btn-new-chat').addEventListener('click', () => {
    startNewConversation();
  });
  $('#btn-continue-here').addEventListener('click', () => {
    // Reset to first state of fresh chat in same project
    renderChat();
  });

  // Model pickers — the dropdowns at Settings → AI (Default model + Testing
  // model). Wired via document-level delegation because renderSettings()
  // rebuilds #settings-pane innerHTML on every render, which orphans direct
  // listeners: wire() runs once at boot, before the buttons exist. (Jul 12 —
  // this is why a direct `$('#ai-model-picker-btn')` here never attached.)
  document.addEventListener('click', (e) => {
    const dm = e.target.closest('#ai-model-picker-btn');
    if (dm) { e.stopPropagation(); openModelPicker(dm); return; }
    const tm = e.target.closest('#ai-testing-model-btn');
    if (tm) { e.stopPropagation(); openModelPicker(tm, 'testingModel'); }
  });

  // Esc closes settings
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.settingsOpen) closeSettings();
  });

  // Delegated handlers on #settings-pane. The pane itself is in static HTML
  // (only its children get wiped by renderSettings()), so a single listener
  // attached here survives every Settings re-render. Without this, OAuth and
  // API-key buttons sit dead because their IDs are created AFTER wire() runs.
  const settingsPane = $('#settings-pane');
  if (settingsPane && !settingsPane._farnsworthWired) {
    settingsPane._farnsworthWired = true;
    settingsPane.addEventListener('click', (e) => {
      // Climb to the nearest element with an ID so clicks on SVG/text inside
      // a button still match the button's id.
      // Section-header ⓘ buttons are class-matched (no ids — there's one
      // per section and the explainer text rides in data-info).
      const infoBtn = e.target.closest('.settings-info-btn');
      if (infoBtn) { toggleSettingsInfoPop(infoBtn); return; }
      const target = e.target.closest('[id]') || e.target;
      const id = target.id;
      if (!id) return;
      switch (id) {
        case 'ai-apikey-save':       saveApiKey(); break;
        case 'ai-apikey-clear':      clearApiKey(); break;
        case 'ai-openai-key-save':   saveOpenaiKey(); break;
        case 'ai-openai-key-clear':  clearOpenaiKey(); break;
        case 'oauth-start-btn':      startOAuth(); break;
        case 'oauth-submit-btn':     submitOAuthCode(); break;
        case 'oauth-cancel-btn':     cancelOAuth(); break;
        case 'oauth-refresh-btn':    refreshOAuth(); break;
        case 'oauth-disconnect-btn': disconnectOAuth(); break;
        case 'oauth-import-keychain-btn': importFromKeychain(); break;
        case 'oauth-reopen':
          e.preventDefault();
          if (window.farnsworth) window.farnsworth.oauthStart();
          break;
      }
    });
    settingsPane.addEventListener('keydown', (e) => {
      if (e.target.id === 'oauth-code-input' && e.key === 'Enter') {
        submitOAuthCode();
      }
    });
  }

  // Welcome overlay open folder button
  const welcomeBtn = $('#welcome-open-btn');
  if (welcomeBtn) welcomeBtn.addEventListener('click', openFolderPicker);

  // App type picker cards
  $$('.apptype__card').forEach(card => {
    card.addEventListener('click', () => selectAppType(card.dataset.type));
  });
  const apptypeSkip = $('#apptype-skip');
  if (apptypeSkip) apptypeSkip.addEventListener('click', async () => {
    hideAppTypePicker();
    if (state.folder) await loadFolderFiles(state.folder);
    updateWindowTitle();
  });

  // Cmd+O opens folder picker
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
      e.preventDefault();
      openFolderPicker();
    }
  });

  // Global file-management shortcuts. These fire when Monaco does NOT
  // have focus (e.g. when the canvas tab is active but the user isn't
  // editing). Monaco's own addCommand bindings cover the editor-focus
  // case — Monaco captures the keydown before it bubbles, so this
  // listener only fires for keys Monaco didn't consume.
  document.addEventListener('keydown', e => {
    const cmd = e.metaKey || e.ctrlKey;
    // ⌘N — New file in workspace
    if (cmd && !e.shiftKey && !e.altKey && e.key === 'n') {
      e.preventDefault();
      openNewFileDialog();
      return;
    }
    // ⌘W — Close active file
    if (cmd && !e.shiftKey && !e.altKey && e.key === 'w') {
      e.preventDefault();
      closeActiveFile();
      return;
    }
    // ⇧⌘T — Reopen last closed file
    if (cmd && e.shiftKey && !e.altKey && e.key === 't') {
      e.preventDefault();
      reopenLastClosedFile();
      return;
    }
    // ⌘R — Reveal active file (or workspace) in Finder. We rebind from
    // the browser's reload-default (which Cmd+R triggers in iframes but
    // not Electron windows) to a project action. Cmd+Shift+R is still
    // available as a no-op for muscle memory.
    if (cmd && !e.shiftKey && !e.altKey && e.key === 'r') {
      e.preventDefault();
      revealActiveInFinder();
      return;
    }
    // F2 — Rename the selected file/folder in the Files panel.
    if (!cmd && !e.shiftKey && !e.altKey && e.key === 'F2') {
      if (state.files.selected) {
        e.preventDefault();
        renameSelectedFile();
        return;
      }
    }
    // Delete — Delete the selected file/folder in the Files panel.
    // Skip when an input has focus (so the user can backspace in inputs).
    if (!cmd && !e.shiftKey && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (state.files.selected) {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault();
          deleteSelectedFile();
          return;
        }
      }
    }
  });

  // Test creator (NLP-driven test script authoring, Jul 10 ~23:50 ET)
  // DEPRECATED Jul 11 ~16:42 ET — combined into Test View's inline
  // editor (openTestViewEditor / saveTestViewEditor / generateTestViewEditor).
  // The NLP helpers (TEST_CREATOR_SYSTEM_PROMPT, generateTestFromNLP,
  // keywordFallbackParse, deriveTestName) are still used by Test View's
  // "Generate from description" button — they're not removed.
  // setupTestCreator() intentionally NOT called: the modal HTML + button
  // in index.html were removed; the NLP functions remain callable.
}

function updateZoom() {
  // Update both labels (the bottom-right zoom widget shows %, the
  // top-right zoom-display button in the canvas toolbar does too).
  $('#zoom-value').textContent = state.zoom + '%';
  const zd = $('#zoom-display');
  if (zd && zd.firstChild) zd.firstChild.textContent = state.zoom + '% ';
  // Apply scale transform to the canvas artboard — `transform: scale()`
  // is unitless and grows from the center. We set it on the wrapper so
  // the entire artboard (frame, label, content) zooms together without
  // triggering reflow. transition gives the +/- clicks a 120ms ease so
  // it's not jarring. The artboard is sized by renderCanvas() via
  // width/height in pixels — scale multiplies that visual size while
  // leaving the layout box unchanged (so the canvas scroll container
  // doesn't reshuffle).
  const art = $('#canvas-artboard');
  if (art) {
    const scale = state.zoom / 100;
    // Origin top-left + negative right/bottom margin compensation makes the
    // LAYOUT box track the visual size (transform alone never changes
    // layout). Without this, a zoomed-out artboard still occupies its full
    // unscaled box — flex centering centers the box, the visual drifts, and
    // auto-fit "fits" while content hangs outside the stage (the Jul 13
    // Test View + New clipping). Also fixes zoom >100%: the box grows, so
    // the stage can scroll to the far edges.
    const w = art.offsetWidth, h = art.offsetHeight;
    art.style.transform = `scale(${scale})`;
    art.style.transformOrigin = 'top left';
    art.style.transition = 'transform 120ms ease-out, margin 120ms ease-out';
    art.style.marginRight = (-(w * (1 - scale))) + 'px';
    art.style.marginBottom = (-(h * (1 - scale))) + 'px';
  }
  // WebContentsViews don't follow CSS transforms (separate composited
  // layer) and ResizeObservers don't fire on transforms — before Jul 13,
  // zooming left every game view at its old screen rect with unscaled
  // content. Scale the content via zoom factor (keeps the game's logical
  // CSS viewport constant, e.g. 390x844) and re-clip bounds now + after
  // the 120ms transform transition settles.
  const vScale = state.zoom / 100;
  document.querySelectorAll('[data-canvas-view-id]').forEach(el => {
    const viewId = el.dataset.canvasViewId;
    if (viewId && window.farnsworth?.canvasSetZoomFactor) {
      window.farnsworth.canvasSetZoomFactor(viewId, vScale);
    }
  });
  syncCanvasViewBounds();
  setTimeout(syncCanvasViewBounds, 160);
}

// ============================================================================
// CHAT SURFACES — inline UI surfaces in the agent message stream.
//
// Assistant emits `ui_show` tool calls. We intercept them in the tool loop
// (before executeTool runs) and call renderChatSurface(). The surface is
// appended to agentMsg.surfaces[] and rendered inline by renderMessage().
// For surfaces with stable surfaceIds (task_progress, work_result), re-emits
// update the existing surface in place.
// ============================================================================

function renderChatSurface(agentMsg, input) {
  if (!input || !input.surfaceType) return;
  if (!window.FarnsworthSurfaces || !window.FarnsworthSurfaces.hasSurface(input.surfaceType)) {
    console.warn('[surface] Unknown surfaceType:', input.surfaceType);
    return;
  }
  const surfaceId = input.surfaceId || ('surf-' + Math.random().toString(36).slice(2, 10));

  // In-place update path (task_progress step flips, work_result section
  // accumulation). If the same surfaceId already exists for this agent
  // message, mutate its data and re-render — no append. This is what lets
  // a long-running emit (3-7 ui_show calls with the same id) animate
  // step-by-step instead of stacking duplicate cards.
  if (!state.chatSurfaces) state.chatSurfaces = {};
  const existing = state.chatSurfaces[surfaceId];
  if (existing && existing.surfaceType === input.surfaceType) {
    // Replace data in place; renderChat() will re-render the surface node.
    existing.data = input.data || {};
    renderChat();
    return;
  }

  const surface = {
    surfaceId,
    surfaceType: input.surfaceType,
    data: input.data || {},
  };
  // Append to the agent message's surface list
  if (!agentMsg.surfaces) agentMsg.surfaces = [];
  agentMsg.surfaces.push(surface);
  state.chatSurfaces[surfaceId] = surface;
  // Re-render the chat to show the surface
  renderChat();
}

// Surface action dispatcher — called from any surface's interaction handler.
// action.kind is one of:
//   'synthetic-turn'  -> append a user message and continue the conversation
//   'direct-action'   -> invoke a local action (clipboard, reveal, open-file)
//   'credential'      -> prompt for a secret via main IPC
//   'oauth'           -> start an OAuth flow
window.__surfaceRegistry = {};
window.__onSurfaceAction = function (surface, action) {
  if (action.kind === 'synthetic-turn') {
    // Append the synthetic user message and send the next turn
    const userMsgId = 'm' + Date.now();
    state.chatMessages.push({ id: userMsgId, role: 'user', text: action.userText });
    renderChat();
    sendChatMessage();
  } else if (action.kind === 'direct-action') {
    handleDirectAction(action);
  } else if (action.kind === 'credential') {
    if (window.farnsworth?.promptSecret) {
      window.farnsworth.promptSecret(action.label || 'Credential', action.id || '').then(value => {
        if (value) {
          window.__onSurfaceAction(surface, {
            kind: 'synthetic-turn',
            userText: '[credential:' + (action.id || '') + '] submitted (value not exposed to renderer)',
          });
        }
      }).catch(e => console.warn('[surface] promptSecret failed:', e));
    } else {
      console.warn('[surface] window.farnsworth.promptSecret not available yet (Phase 2)');
    }
  } else if (action.kind === 'oauth') {
    if (window.farnsworth?.oauthStart) {
      window.farnsworth.oauthStart(action.provider).then(() => {
        window.__onSurfaceAction(surface, {
          kind: 'synthetic-turn',
          userText: '[oauth:' + action.provider + '] flow started',
        });
      }).catch(e => console.warn('[surface] oauthStart failed:', e));
    } else {
      console.warn('[surface] window.farnsworth.oauthStart not available yet (Phase 2)');
    }
  } else {
    console.warn('[surface] Unknown action kind:', action.kind);
  }
};

function handleDirectAction(action) {
  switch (action.id) {
    case 'copy':
      navigator.clipboard.writeText(action.text || '').catch(e => console.warn('[surface] copy failed:', e));
      break;
    case 'reveal':
      if (window.farnsworth?.showInFinder) {
        window.farnsworth.showInFinder(action.path || '');
      }
      break;
    case 'open-file':
      if (window.farnsworth?.fsRead) {
        window.farnsworth.fsRead(action.path || '').then(content => {
          openFile({ path: action.path, content: content?.content || '' });
        }).catch(e => console.warn('[surface] open-file failed:', e));
      }
      break;
    case 'open-terminal':
      switchLeftPanel('terminal');
      break;
    case 'open-canvas':
      // Switch to the canvas view if not already there
      const canvasMode = state.canvasMode || 'desktop';
      switchLeftPanel(canvasMode);
      break;
    case 'open-settings':
      openSettings(action.page || null);
      break;
    case 'show-tasks':
      state.rightTab = 'tasks';
      renderRightPanel();
      break;
    default:
      console.warn('[surface] Unknown direct-action id:', action.id);
  }
}

async function sendChatMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!window.farnsworth || !window.farnsworth.sendMessage) {
    state.chatMessages.push({ id: 'm' + Date.now(), role: 'agent', text: 'Inference not wired — preload missing sendMessage.', error: true });
    renderChat();
    return;
  }
  const userMsgId = 'm' + Date.now();
  const agentMsgId = 'm' + (Date.now() + 1);
  state.chatMessages.push({ id: userMsgId, role: 'user', text });
  state.chatMessages.push({ id: agentMsgId, role: 'agent', working: true, workingLabel: 'Thinking' });
  input.value = '';
  renderChat();

  // Memory preamble — Tier 3 (Jul 12 2026). Stages 4+5: the router picks
  // which concept articles matter for THIS message (cheap model, every
  // turn) and the section selector picks sections within them. Essentials
  // are injected on the first message of a conversation; routed articles
  // are injected the first time they're picked (tracked per conversation
  // so repeats don't re-inject). Falls back to the Tier-1 bootstrap dump
  // (essentials + recent concept leads, first message only) when the
  // router stage is disabled or unavailable.
  let memoryPreamble = '';
  const isNewMemConv = !state.memoryLoadedForConv || state.memoryLoadedForConv !== state.chatActiveId;
  if (isNewMemConv || !state.memoryInjectedSlugs) state.memoryInjectedSlugs = new Set();
  if (state.settings?.memory?.router?.enabled && window.farnsworth?.memoryRoute) {
    try {
      const routed = await window.farnsworth.memoryRoute({ context: String(text).slice(0, 800) });
      if (routed && routed.ok) {
        const lines = [];
        if (isNewMemConv && routed.essentials && routed.essentials.length) {
          lines.push('# Memory essentials (always-loaded)');
          for (const e of routed.essentials) lines.push(`- ${e.key}: ${e.value}`);
        }
        // v3.1 pinned lanes: threads (open loops) + recent (rolling digest),
        // injected once per conversation like essentials.
        if (isNewMemConv && routed.lanes && routed.lanes.length) {
          for (const lane of routed.lanes) {
            state.memoryInjectedSlugs.add(lane.slug);
            lines.push('');
            lines.push(`# Memory: ${lane.title || lane.slug} (always-loaded)`);
            if (lane.body) lines.push(lane.body);
          }
        }
        const fresh = (routed.concepts || []).filter(c => !state.memoryInjectedSlugs.has(c.slug));
        if (fresh.length) {
          lines.push('');
          lines.push('# Memory: concepts routed for this message');
          for (const c of fresh) {
            state.memoryInjectedSlugs.add(c.slug);
            lines.push(`## ${c.title} (${c.slug})`);
            if (c.lead) lines.push(c.lead);
            if (c.body) lines.push(c.body);
            else if (c.sections && c.sections.length) {
              for (const s of c.sections) lines.push(`### ${s.heading}\n${s.content}`);
            }
          }
        }
        if (isNewMemConv && state.folder && window.farnsworth?.memoryCodeStats) {
          try {
            const stats = await window.farnsworth.memoryCodeStats(state.folder);
            if (stats && stats.files > 0) {
              lines.push('');
              lines.push(`# Codebase index (Tier 2 — ${stats.files} files, ${stats.chunks} chunks, ${state.folder})`);
            }
          } catch {}
        }
        if (lines.length) {
          memoryPreamble = '[Farnsworth memory — routed]\n' + lines.join('\n') + '\n[/Farnsworth memory]\n\n';
        }
        state.memoryLoadedForConv = state.chatActiveId;
      }
    } catch (e) {
      console.warn('[memory] route failed, falling back to bootstrap:', e);
    }
  }
  if (isNewMemConv && !memoryPreamble && (!state.memoryLoadedForConv || state.memoryLoadedForConv !== state.chatActiveId)) {
    try {
      const boot = await window.farnsworth.memoryBootstrap();
      const lines = [];
      if (boot.essentials && boot.essentials.length) {
        lines.push('# Memory essentials (always-loaded)');
        for (const e of boot.essentials) lines.push(`- ${e.key}: ${e.value}`);
      }
      if (boot.recentConcepts && boot.recentConcepts.length) {
        lines.push('');
        lines.push('# Recent concepts (loaded for context)');
        for (const c of boot.recentConcepts.slice(0, 5)) {
          if (c.lead) lines.push(`- ${c.slug}: ${c.lead}`);
          else lines.push(`- ${c.slug}: ${c.title}`);
        }
      }
      // Tier 2: append codebase index status so the assistant knows
      // which project files are searchable. The actual recall happens
      // via memoryRecall() when the user sends a message.
      if (state.folder && window.farnsworth?.memoryCodeStats) {
        try {
          const stats = await window.farnsworth.memoryCodeStats(state.folder);
          if (stats && stats.files > 0) {
            lines.push('');
            lines.push(`# Codebase index (Tier 2 — ${stats.files} files, ${stats.chunks} chunks, ${state.folder})`);
            lines.push('Recall blends sqlite-vec cosine search with LIKE; Tier 2 returns code chunks alongside concepts.');
          }
        } catch {}
      }
      if (lines.length) {
        memoryPreamble = '[Farnsworth memory — auto-loaded at conversation start]\n' + lines.join('\n') + '\n[/Farnsworth memory]\n\n';
      }
      state.memoryLoadedForConv = state.chatActiveId;
    } catch (e) {
      console.warn('[memory] bootstrap failed:', e);
    }
  }
  const userTextForAgent = memoryPreamble ? memoryPreamble + text : text;

  // Get agent tool definitions (read_file, write_file, list_files, run_command)
  let tools = null;
  try {
    const tRes = await window.farnsworth.getAgentTools();
    if (tRes && tRes.ok && Array.isArray(tRes.tools)) tools = tRes.tools;
  } catch {}

  // Build the messages array — include prior turns but stop at the new user msg
  const prior = state.chatMessages
    .filter(m => (m.role === 'user' || m.role === 'agent') && !m.working && m.text && m.id !== userMsgId)
    .slice(-20)
    .map(m => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }));
  const history = [...prior, { role: 'user', content: userTextForAgent }];

  // Mutable copy of the agent placeholder so we can update its chips/working label as tools execute
  let agentMsg = { id: agentMsgId, role: 'agent', working: true, workingLabel: 'Thinking', chips: [],
    // Jul 14 ~09:20 ET: snapshot the model at message creation so the
    // bubble header can show what was actually used, even after the
    // user changes the default mid-conversation. See msg__model render
    // ~line 776.
    model: state.settings?.defaultModel || 'Opus 4.8',
  };
  const updateAgentMsg = (patch) => {
    agentMsg = { ...agentMsg, ...patch };
    const idx = state.chatMessages.findIndex(m => m.id === agentMsgId);
    if (idx >= 0) {
      state.chatMessages[idx] = agentMsg;
      renderChat();
    }
  };

  // Stream chat:start to companion so it can render an in-progress message bubble
  // immediately instead of waiting for the final 'chat' event at the end.
  sendChatEventToCompanions('chat:start', { messageId: agentMsgId });

  try {
    // Tool-use loop — iterate up to 10 times (read_file → answer is the common path)
    for (let iter = 0; iter < 10; iter++) {
      // Throttled renderChat for streaming — updates the DOM at most every 40ms.
      let renderTimer = null;
      const scheduleRender = () => {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = null;
          const idx = state.chatMessages.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            state.chatMessages[idx] = agentMsg;
            renderChat();
          }
        }, 40);
      };

      let res;
      try {
        // Build a system prompt that tells the agent what tools it has and
        // when to use them. Currently includes test_view instructions; see
        // ~/Documents/Farnsworth/app/DEVVIT-TESTS.md for the test format
        // spec the agent reads on its own (via the read_file tool). The
        // DEVVIT-TESTS.md path is stable — don't move the file without
        // updating this string. Jul 11 ~18:50 ET.
        const systemPrompt = [
          'You are the Farnsworth chat agent — an AI assistant inside the Farnsworth IDE (Electron app for building Reddit games). You have access to a workspace folder and Farnsworth\'s canvas preview.',
          '',
          '## Tools you have',
          '',
          '**Workspace tools:**',
          '- read_file(path) — read a file relative to the workspace folder (e.g. "src/app.js", "package.json")',
          '- write_file(path, content) — write a file relative to the workspace folder (creates parent dirs)',
          '- list_files(pattern?) — list workspace files (optional glob filter)',
          '- run_command(command) — run a shell command in the workspace (30s timeout)',
          '- ui_show(surfaceType, data) — render an inline UI surface in the chat stream (card, choice, form, copy_block, work_result, etc.)',
          '- memory_recall(query) — search long-term memory (concept articles, sections, past conversations, code index) for facts from previous sessions',
          '',
          '**Test View tools (Jul 11 ~18:50 ET):**',
          '- open_testview() — switch the canvas to Test View so the user sees the test runner',
          '- test_list() — list all tests in the active workspace\'s .farnsworth/devvit-tests/',
          '- test_read(name) — read a test JSON file by name',
          '- test_save(name, json) — save a test JSON file (validates JSON first)',
          '- test_run(path) — run a test (path is ABSOLUTE, not relative — get it from test_list or test_save)',
          '',
          '## When to use Test View tools',
          '',
          'When the user asks any of: "create a test that...", "make a test for X", "run the test that...", "show me the tests", "edit the test X to...", "what tests exist?", "delete the X test" — call `open_testview` FIRST (so they see Test View in the canvas), then the appropriate test_* tool. Report the result in chat with concrete detail (stdout/stderr if a run failed).',
          '',
          '## The test format spec',
          '',
          'Tests are JSON files. The full format spec is at `~/Documents/Farnsworth/app/DEVVIT-TESTS.md` — read it with the read_file tool BEFORE creating or editing tests so you get the action list, step shape, and common selectors right. Do NOT guess the format from this prompt — read the MD file.',
          '',
          '## General guidance',
          '',
          '- The active workspace folder is set via File → Open Folder. If the user asks you to do workspace work and no folder is open, tell them to open one.',
          '- Use ui_show surfaces when the work has multiple steps (task_progress), produces a structured outcome (work_result), needs a choice (choice), or needs a credential (credential).',
          '- Be direct, concise, and act. The user runs Farnsworth as their IDE; surface errors with the underlying stdout/stderr so they can fix the issue.',
        ].join('\n');

        res = await window.farnsworth.streamMessage({
          messages: history,
          system: systemPrompt,
          // Translate Farnsworth display name (state.settings.defaultModel,
          // e.g. 'Opus 4.8 High') to the Anthropic API id (e.g.
          // 'claude-opus-4-8'). state.settings.model was the old wrong key
          // (always undefined) -- reading the right key + translating
          // fixed the 404 model-name errors. See modelToApiId() below.
          model: modelToApiId(state.settings?.defaultModel),
          tools,
        }, (chunk) => {
          if (chunk.type === 'text_delta') {
            const deltaText = chunk.text || '';
            // Jul 13 ~18:50 ET: split text into preamble (before any tool_use)
            // and response (after tools complete). Preamble becomes a small
            // italic "thinking" indicator at the TOP of the message; response
            // becomes the formatted markdown text at the BOTTOM (after chips).
            // Vellum-style chat layout -- text doesn't appear at the top
            // above the code executions.
            if (agentMsg._hasSeenToolUse) {
              agentMsg.responseText = (agentMsg.responseText || '') + deltaText;
            } else {
              agentMsg.preambleText = (agentMsg.preambleText || '') + deltaText;
            }
            // Keep m.text as the concatenated view for backward compat (history
            // saves, etc.). renderMessage uses preambleText + responseText.
            agentMsg.text = (agentMsg.preambleText || '') + (agentMsg.responseText || '');
            scheduleRender();
            // Forward text chunk to companion so it streams incrementally
            sendChatEventToCompanions('chat:delta', {
              messageId: agentMsgId,
              delta: deltaText,
            });
          } else if (chunk.type === 'block_start') {
            const block = chunk.block || {};
            if (block.type === 'tool_use') {
              // Once we've seen a tool_use, subsequent text goes to responseText
              // (the formatted answer at the bottom), not preambleText.
              agentMsg._hasSeenToolUse = true;
              agentMsg.working = true;
              agentMsg.workingLabel = `Preparing ${block.name || 'tool'}…`;
              scheduleRender();
            }
          } else if (chunk.type === 'block_stop') {
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            const idx = state.chatMessages.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              state.chatMessages[idx] = agentMsg;
              renderChat();
            }
          }
        });
      } catch (errRes) {
        const msg = errRes?.message || errRes?.error || 'Inference failed';
        // no_auth gets a one-click "Open Settings → AI" chip — Long should
        // never have to dig through Settings to fix this. The main process
        // emits error:'no_auth' when both OAuth and API-key paths are empty
        // (see getValidAccessToken in main.js).
        const extraChips = [];
        if (errRes?.error === 'no_auth') {
          extraChips.push({ label: 'Open Settings → AI', kind: 'settings', action: 'open-ai' });
        }
        if (errRes?.status) {
          extraChips.push({ label: `HTTP ${errRes.status}`, kind: 'edit' });
        }
        updateAgentMsg({
          working: false,
          text: msg,
          error: true,
          chips: [...(agentMsg.chips || []), ...extraChips],
        });
        // Forward the error as a chat:done with error info so companion can
        // mark the in-progress bubble as failed and stop its spinner.
        sendChatEventToCompanions('chat:done', {
          messageId: agentMsgId,
          error: msg,
          finalText: agentMsg.text || '',
        });
        return;
      }
      if (!res || !res.ok) {
        const msg = res?.message || res?.error || 'Inference failed';
        const extraChips = [];
        if (res?.error === 'no_auth') {
          extraChips.push({ label: 'Open Settings → AI', kind: 'settings', action: 'open-ai' });
        }
        if (res?.status) {
          extraChips.push({ label: `HTTP ${res.status}`, kind: 'edit' });
        }
        updateAgentMsg({
          working: false,
          text: msg,
          error: true,
          chips: [...(agentMsg.chips || []), ...extraChips],
        });
        // Forward the error as a chat:done with error info so companion can
        // mark the in-progress bubble as failed and stop its spinner.
        sendChatEventToCompanions('chat:done', {
          messageId: agentMsgId,
          error: msg,
          finalText: agentMsg.text || '',
        });
        return;
      }

      // Append assistant message to history (full content blocks so Claude can see its own tool_use)
      // Strip the streaming handler's renderer-side accumulator fields (inputJson, caller) from
      // tool_use blocks — only { type, id, name, input } are valid Anthropic API fields; extras
      // cause "messages.N.content.M.tool_use.inputJson: Extra inputs are not permitted" rejections
      // on the next turn. The API was rejecting every tool call sent back through history. Bug
      // discovered Jul 11 ~19:45 ET; see /tmp/farnsworth-stream-debug.json for the captured diff.
      const sanitizedContent = (res.content || []).map(b => {
        if (b?.type === 'tool_use') {
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
        }
        return b;
      });
      history.push({ role: 'assistant', content: sanitizedContent.length ? sanitizedContent : [{ type: 'text', text: res.text || '' }] });

      // No tool_use blocks — final response, render and stop
      if (!res.toolUses || res.toolUses.length === 0) {
        // Feed the status bar's ctx gauge: the chat thread is the context
        // that matters (commit/review/title one-shots stay out of it).
        if (res.usage) { state.session.lastUsage = res.usage; try { updateStatusBar(); } catch {} }
        const usageChip = res.usage ? { label: `${res.usage.input_tokens}→${res.usage.output_tokens} tok`, kind: 'read' } : null;
        updateAgentMsg({
          working: false,
          text: res.text || '(empty response)',
          verified: true,
          chips: [...(agentMsg.chips || []), ...(usageChip ? [usageChip] : [])],
        });
        // Final response (no tool use) - send chat:done here too so companion
        // gets the done event before sendChatMessage returns.
        sendChatEventToCompanions('chat:done', {
          messageId: agentMsgId,
          finalText: agentMsg.text || '',
        });
        return;
      }

      // Execute each tool_use in order, then send results back
      const toolResultBlocks = [];
      for (const tu of res.toolUses) {
        // Surfaces are renderer-side — intercept BEFORE executeTool so we
        // never round-trip them as a tool result back to main. Render the
        // surface inline and synthesize a tool_result ack so the model can
        // continue its turn.
        if (tu.name === 'ui_show') {
          renderChatSurface(agentMsg, tu.input);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Surface rendered: ' + (tu.input?.surfaceType || 'unknown') + (tu.input?.surfaceId ? ' (' + tu.input.surfaceId + ')' : ''),
          });
          continue;
        }
        const preview = JSON.stringify(tu.input).slice(0, 60);
        updateAgentMsg({
          working: true,
          workingLabel: `Running ${tu.name}…`,
          chips: [...(agentMsg.chips || []), { label: `${tu.name}(${preview})`, kind: 'edit' }],
        });
        const toolRes = await window.farnsworth.executeTool(tu.name, tu.input);
        let resultContent;
        if (!toolRes.ok) {
          resultContent = `Error: ${toolRes.message || toolRes.error || 'tool failed'}`;
        } else if (tu.name === 'read_file') {
          resultContent = toolRes.content;
        } else if (tu.name === 'list_files') {
          resultContent = JSON.stringify(toolRes.files || [], null, 2);
        } else if (tu.name === 'run_command') {
          resultContent = (toolRes.stdout || '') + (toolRes.stderr ? '\nstderr: ' + toolRes.stderr : '') + `\nexit ${toolRes.exitCode}`;
          // Capture output for the terminal chip. Long requested that chat-agent
          // commands stay in chat -- no panel switch, no second execution in the
          // PTY. The exec() in main.js handles the actual run; its stdout/stderr
          // is rendered inline by the chip's chip__term-body below (see renderChat
          // ~line 630).
          agentMsg.runOutputs = [...(agentMsg.runOutputs || []), {
            command: tu.input?.command,
            stdout: toolRes.stdout || '',
            stderr: toolRes.stderr || '',
            exitCode: toolRes.exitCode,
          }];
          updateAgentMsg({
            chips: [
              ...(agentMsg.chips || []),
              {
                label: '$ ' + (tu.input?.command || '').slice(0, 80),
                kind: 'terminal',
                runIndex: (agentMsg.runOutputs?.length || 1) - 1,
              },
            ],
          });
        } else if (tu.name === 'memory_recall') {
          resultContent = toolRes.result || 'No memory matches.';
        } else {
          resultContent = toolRes.message || 'OK';
        }
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultContent,
        });
        // Auto-open files the agent wrote in Monaco
        if (tu.name === 'write_file' && toolRes.ok && state.folder && tu.input?.path) {
          const absPath = state.folder + '/' + tu.input.path;
          // Switch to code mode + open
          state.canvasMode = 'code';
          renderCanvas();
          updateModeToggles();
          openFileByPath(absPath);
        }
      }
      // Send tool results back as a user message
      history.push({ role: 'user', content: toolResultBlocks });
      updateAgentMsg({ working: true, workingLabel: 'Thinking' });
    }
    // Hit the iter cap
    updateAgentMsg({ working: false, text: agentMsg.text || 'Tool loop reached max iterations', error: true });
  } catch (e) {
    const idx = state.chatMessages.findIndex(m => m.id === agentMsgId);
    if (idx >= 0) {
      state.chatMessages[idx] = { id: agentMsgId, role: 'agent', text: `Error: ${e.message}`, error: true };
      renderChat();
    }
  } finally {
    // Memory: archive the completed turn (user msg + final agent reply).
    // Goes to the immutable daily log; doesn't auto-add to the concept
    // store (that's the consolidation job's job). Tier 1: archive-only.
    if (window.farnsworth?.memoryRemember) {
      const finalAgent = state.chatMessages.find(m => m.id === agentMsgId);
      const userText = String(text || '').slice(0, 800);
      const agentText = String(finalAgent?.text || '').slice(0, 800);
      if (userText) window.farnsworth.memoryRemember(userText, { kind: 'fact', source: 'chat.user', context: `conv=${state.chatActiveId}` });
      if (agentText && !finalAgent?.error) window.farnsworth.memoryRemember(agentText, { kind: 'fact', source: 'chat.agent', context: `conv=${state.chatActiveId}` });
    }
    // Per-call-site 'titles': LLM-name the conversation after the first
    // successful exchange. Fire-and-forget — never blocks the chat flow.
    maybeGenerateConvTitle();
  }
  // chat:done was already sent on the error paths (inner catch + res.ok check).
  // For the success path, send it here so companion always gets exactly one
  // chat:done per user message. Idempotent if called twice (companion v0.4
  // collapses duplicates by messageId).
  sendChatEventToCompanions('chat:done', {
    messageId: agentMsgId,
    finalText: agentMsg.text || '',
  });
}

// ============================================================================
// TERMINAL PANEL (Phase 2) + multi-tab support
// ============================================================================
//
// xterm.js + node-pty via WebSocket bridge. Each terminal tab owns its own
// PTY (in the main process), its own WS connection, and its own xterm.js
// instance mounted in a dedicated .termtab__pane div. Switching tabs toggles
// [hidden] on the panes — xterm is never destroyed on switch so scrollback
// survives, but fit() is called on the visible pane to recover from any
// stale geometry. Closing a tab kills its PTY + WS + disposes xterm.
//
// Tab IDs are generated client-side as `term-<n>` (incrementing). Each tab
// has a short label (`tty`, `tty 2`, ...) shown in the tab pill. The label
// can be renamed later (e.g. "npm run dev") once we wire rename UX.

const terminalSessions = new Map(); // tabId -> { term, fit, ws, paneEl, label, createdAt }
let activeTerminalTabId = null;
let terminalTabCounter = 0;

// Parallel state for the Claude Code panel — mirrors terminalSessions structure
// but spawns the `claude` binary via the claude-code WebSocket server (port 9224).
// This is the "official Claude Code embedded in Farnsworth" path: same
// xterm.js rendering, but the underlying PTY runs `claude` instead of bash.
const claudeCodeSessions = new Map(); // tabId -> { term, fit, ws, paneEl, label, createdAt, ptyTabId }
let activeClaudeCodeTabId = null;
let claudeCodeTabCounter = 0;

// Tabs to persist across Farnsworth restarts (Jun 28 ~15:51 ET).
// Mirrors the open tabs in `claudeCodeSessions` so the UI can recreate the
// tab pills on startup before any PTYs are spawned. PTYs themselves are
// not persisted — each tab re-spawns a fresh `claude` child process when
// the user activates it (lazy init pattern, same as terminal tabs).
let claudeCodePersistedTabs = []; // [{ id, label, createdAt, sessionId }]
let claudeCodePersistedActiveId = null;

// Session ID per tab (Jun 28 ~16:30 ET) — keyed by Farnsworth tabId so
// the renderer can look up the Claude Code session UUID before the PTY
// spawns. Populated by restoreClaudeCodeTabs() from the persisted list,
// and updated when the server's `ready` message echoes back the
// sessionId it actually used (which may be the one we sent, or a fresh
// UUID main generated for new tabs).
const claudeCodePersistedSessionsByTab = new Map(); // tabId -> uuid

// Snapshot the current open tabs and active selection, then write to SQLite.
// Called after any tab add/close/switch. Debounced via saveClaudeCodeTabsTimeout
// so a burst of changes coalesces into one DB write.
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) {
  return typeof s === 'string' && uuidRe.test(s);
}
let saveClaudeCodeTabsTimeout = null;
function persistClaudeCodeTabs() {
  if (!window.farnsworth?.claudeCodeSaveTabs) return;
  clearTimeout(saveClaudeCodeTabsTimeout);
  saveClaudeCodeTabsTimeout = setTimeout(() => {
    const tabs = Array.from(claudeCodeSessions.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .map(([id, sess]) => ({
        id,
        label: sess.label,
        createdAt: sess.createdAt,
        // Persist the Claude Code sessionId so a fresh launch can
        // `claude --resume <sessionId>` and pick up the prior
        // conversation instead of starting blank. Only persist valid
        // UUIDs — the claude CLI rejects anything else with "Invalid
        // session ID" (Jun 28 ~16:33 ET bug). Stale junk from the
        // first attempt (ffffffff-prefix fakes) gets dropped here so
        // the next restore starts a fresh session instead of erroring.
        sessionId: (() => {
          const cand = sess.sessionId || claudeCodePersistedSessionsByTab.get(id);
          return isValidUuid(cand) ? cand : null;
        })(),
      }));
    window.farnsworth.claudeCodeSaveTabs({
      tabs,
      activeId: activeClaudeCodeTabId,
    }).catch(() => {});
  }, 200);
}

// Read saved tabs on startup. Returns the list and the active id; the
// caller decides when to actually spawn each PTY (we restore tab pills
// immediately so the user sees them, but only init PTYs for the active
// tab + on tab switch).
async function loadPersistedClaudeCodeTabs() {
  if (!window.farnsworth?.claudeCodeListTabs) return { tabs: [], activeId: null };
  try {
    const r = await window.farnsworth.claudeCodeListTabs();
    if (!r || !r.ok) return { tabs: [], activeId: null };
    return { tabs: r.tabs || [], activeId: r.activeId || null };
  } catch {
    return { tabs: [], activeId: null };
  }
}

function nextClaudeCodeTabId() {
  claudeCodeTabCounter++;
  return 'cc-' + claudeCodeTabCounter;
}

function nextClaudeCodeLabel() {
  const n = claudeCodeTabCounter;
  return n === 1 ? 'claude' : 'claude ' + n;
}

function nextTerminalTabId() {
  terminalTabCounter++;
  return 'term-' + terminalTabCounter;
}

function nextTerminalLabel(tabId) {
  // tty, tty 2, tty 3 ... so the labels stay stable even if a tab in the middle closes.
  const n = terminalTabCounter;
  return n === 1 ? 'tty' : 'tty ' + n;
}

async function initTerminal(tabId) {
  const host = document.getElementById('terminal-host');
  if (!host || typeof Terminal === 'undefined') return;
  if (terminalSessions.has(tabId)) {
    // Re-mount: xterm's element may have been moved; ensure it's inside its pane.
    const sess = terminalSessions.get(tabId);
    if (sess.term.element && sess.paneEl && sess.term.element.parentNode !== sess.paneEl) {
      sess.paneEl.appendChild(sess.term.element);
    }
    setTimeout(() => { try { sess.fit.fit(); } catch {} }, 50);
    return;
  }

  // Create a per-tab pane div and add it to the host.
  const paneEl = document.createElement('div');
  paneEl.className = 'termtab__pane';
  paneEl.id = 'termtab-pane-' + tabId;
  paneEl.dataset.tabId = tabId;
  host.appendChild(paneEl);

  const label = nextTerminalLabel(tabId);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    theme: {
      background: '#0d0e10',
      foreground: '#e5e7eb',
      cursor: '#a855f7',
      cursorAccent: '#0d0e10',
      selectionBackground: '#3b3d44',
      black: '#0d0e10', red: '#f87171', green: '#4ade80', yellow: '#facc15',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
      brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#f9fafb',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(paneEl);
  fit.fit();

  const wsUrl = await window.farnsworth.getTerminalWsUrl();
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  // We'll get a { type: 'ready', tabId } from main when the PTY is bound —
  // remember the WS-assigned tabId so close() can target it later.
  let ptyTabId = tabId;

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  ws.onopen = () => {
    fit.fit();
    // Tell main the workspace cwd so the PTY spawns in the right directory.
    // Falls back to currentFolder setting / homedir in main if absent.
    ws.send(JSON.stringify({ type: 'init', cwd: state.folder || null }));
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready' && msg.tabId) {
        // Main has bound this PTY to msg.tabId. Update our map key for close() routing.
        ptyTabId = msg.tabId;
        const sess = terminalSessions.get(tabId);
        if (sess) sess.ptyTabId = ptyTabId;
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
      }
    } catch {}
  };
  ws.onclose = () => {
    term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
  };

  // Keep xterm sized to its pane whenever the host container changes.
  const resizeObserver = new ResizeObserver(() => {
    try { fit.fit(); ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
  });
  resizeObserver.observe(paneEl);

  terminalSessions.set(tabId, { term, fit, ws, paneEl, label, createdAt: Date.now(), ptyTabId });
  activeTerminalTabId = tabId;
  renderTerminalTabs();
  // Hide every other pane; show this one.
  for (const [id, sess] of terminalSessions.entries()) {
    if (sess.paneEl) sess.paneEl.hidden = (id !== tabId);
  }
}

// ------------------------------------------------------------
// Claude Code panel — spawns `claude` binary in a PTY (port 9224).
// Same protocol as initTerminal but the underlying process is Claude Code
// itself, not bash. The TUI is rendered raw — permission prompts, MCP
// server picks, etc. all come from Claude Code's own UI. Farnsworth's
// theming is just the xterm background + the surrounding chrome.
//
// Auth gate: if `claude` CLI isn't authenticated (no OAuth token in the
// macOS Keychain), we render a sign-in card instead of dumping a raw
// `claude login` prompt into xterm. The card has a "Sign in with Claude
// Code CLI" button that spawns `claude login` as a child process, waits
// for the Keychain to update, and re-inits the tab on success.
// ------------------------------------------------------------
async function initClaudeCode(tabId) {
  const host = document.getElementById('claude-code-host');
  if (!host || typeof Terminal === 'undefined') return;
  if (claudeCodeSessions.has(tabId)) {
    const sess = claudeCodeSessions.get(tabId);
    // Re-mount: xterm's element may have been moved; sign-in card stays
    // where it is. Only fit xterm if the session has one (auth-gated tabs
    // store the sign-in card instead of an xterm instance).
    if (sess.term && sess.term.element && sess.paneEl && sess.term.element.parentNode !== sess.paneEl) {
      sess.paneEl.appendChild(sess.term.element);
    }
    setTimeout(() => { try { sess.fit && sess.fit.fit(); } catch {} }, 50);
    return;
  }

  const paneEl = document.createElement('div');
  paneEl.className = 'cctab__pane';
  paneEl.id = 'cctab-pane-' + tabId;
  paneEl.dataset.tabId = tabId;
  host.appendChild(paneEl);

  const label = nextClaudeCodeLabel();

  // ---- Auth gate ----
  // Check the OS Keychain for an existing OAuth token before spawning
  // anything. If there's no token, render a sign-in card; the user clicks
  // the button which spawns `claude login` as a child process.
  let authRes = null;
  try {
    authRes = await window.farnsworth.claudeCodeCheckAuth();
  } catch (e) {
    authRes = { ok: false, hasAuth: false, message: 'Auth check failed: ' + e.message };
  }

  if (!authRes || !authRes.hasAuth) {
    // Render sign-in card instead of xterm. The card has a primary CTA
    // that calls claudeCodeRunLogin. On success, we tear the card down
    // and re-init the tab to spawn the real `claude` session.
    const card = document.createElement('div');
    card.className = 'claudecode__signin';
    const reason = (authRes && authRes.message) || 'Claude Code CLI is not logged in.';
    card.innerHTML = `
      <div class="claudecode__signin-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
      </div>
      <div class="claudecode__signin-title">Sign in to Claude Code</div>
      <div class="claudecode__signin-sub">${escapeHtml(reason)}<br>Claude Code runs as a child process — login opens a browser tab on your Mac.</div>
      <button class="btn btn--primary claudecode__signin-btn" data-act="login">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
        Sign in with Claude Code CLI
      </button>
      <button class="btn btn--ghost claudecode__signin-btn claudecode__signin-btn--secondary" data-act="refresh" title="Re-check auth status">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>
        Re-check
      </button>
      <div class="claudecode__signin-status" data-role="status"></div>
    `;
    paneEl.appendChild(card);

    const btn = card.querySelector('[data-act="login"]');
    const refreshBtn = card.querySelector('[data-act="refresh"]');
    const statusEl = card.querySelector('[data-role="status"]');

    const startLogin = async () => {
      btn.disabled = true;
      btn.classList.add('is-loading');
      refreshBtn.disabled = true;
      statusEl.className = 'claudecode__signin-status is-loading';
      statusEl.textContent = 'Opening browser for sign-in… complete the consent screen, then return here.';
      try {
        const res = await window.farnsworth.claudeCodeRunLogin();
        if (res && res.ok) {
          statusEl.className = 'claudecode__signin-status is-success';
          statusEl.textContent = 'Signed in. Starting Claude Code…';
          // Tear the card down and re-init the tab to spawn the real session.
          setTimeout(() => {
            try { card.remove(); } catch {}
            claudeCodeSessions.delete(tabId);
            initClaudeCode(tabId);
          }, 600);
        } else {
          statusEl.className = 'claudecode__signin-status is-error';
          statusEl.textContent = (res && res.message) || 'Sign-in failed. Try again or run `claude login` in Terminal.';
          btn.disabled = false;
          btn.classList.remove('is-loading');
          refreshBtn.disabled = false;
        }
      } catch (e) {
        statusEl.className = 'claudecode__signin-status is-error';
        statusEl.textContent = 'Sign-in error: ' + e.message;
        btn.disabled = false;
        btn.classList.remove('is-loading');
        refreshBtn.disabled = false;
      }
    };

    const refreshAuth = async () => {
      refreshBtn.disabled = true;
      statusEl.className = 'claudecode__signin-status is-loading';
      statusEl.textContent = 'Checking…';
      try {
        const res = await window.farnsworth.claudeCodeCheckAuth();
        if (res && res.hasAuth) {
          statusEl.className = 'claudecode__signin-status is-success';
          statusEl.textContent = 'Signed in. Starting Claude Code…';
          setTimeout(() => {
            try { card.remove(); } catch {}
            claudeCodeSessions.delete(tabId);
            initClaudeCode(tabId);
          }, 400);
        } else {
          statusEl.className = 'claudecode__signin-status';
          statusEl.textContent = 'Still not signed in.';
          refreshBtn.disabled = false;
        }
      } catch (e) {
        statusEl.className = 'claudecode__signin-status is-error';
        statusEl.textContent = 'Check failed: ' + e.message;
        refreshBtn.disabled = false;
      }
    };

    btn.addEventListener('click', startLogin);
    refreshBtn.addEventListener('click', refreshAuth);

    // Track this tab so close/render functions know it exists. No xterm yet.
    claudeCodeSessions.set(tabId, { term: null, fit: null, ws: null, paneEl, card, label, createdAt: Date.now(), ptyTabId: null, isSignIn: true });
    activeClaudeCodeTabId = tabId;
    renderClaudeCodeTabs();
    for (const [id, sess] of claudeCodeSessions.entries()) {
      if (sess.paneEl) sess.paneEl.hidden = (id !== tabId);
    }
    return;
  }

  // ---- Authenticated path: spawn xterm + WebSocket bridge to `claude` ----
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    theme: {
      background: '#0d0e10',
      foreground: '#e5e7eb',
      // Warm orange cursor to distinguish Claude Code from Terminal (purple).
      cursor: '#fb923c',
      cursorAccent: '#0d0e10',
      selectionBackground: '#3b3d44',
      black: '#0d0e10', red: '#f87171', green: '#4ade80', yellow: '#facc15',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
      brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#f9fafb',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(paneEl);
  fit.fit();

  const wsUrl = await window.farnsworth.getClaudeCodeWsUrl();
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  let ptyTabId = tabId;

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  // Shift+Enter inserts a newline instead of submitting (Jul 13, Long's
  // report). xterm has no distinct sequence for Shift+Enter — it emits a
  // plain \r, identical to Enter, so claude submits the message. Intercept
  // the keydown and send ESC+CR (meta-Enter) instead: the sequence claude's
  // TUI binds to "insert newline" — the same one its own /terminal-setup
  // wires Shift+Enter to in iTerm2/VS Code. The chat panel's textarea
  // handles Shift+Enter separately; this brings the Claude Code panel to
  // parity. Scoped to this panel only — a plain shell has no use for
  // meta-CR, so the Terminal panel keeps stock behavior.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (ev.type === 'keydown' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data: '\x1b\r' }));
      }
      return false; // swallow keydown/keypress/keyup so xterm never emits its own \r
    }
    return true;
  });
  ws.onopen = () => {
    fit.fit();
    // Tell main the workspace cwd so the PTY spawns in the right directory
    // (same pattern as the terminal panel's init at line 5541). Without this,
    // main falls back to the currentFolder setting captured at WS-connect
    // time, which lags behind state.folder if the panel mounted before a
    // folder was opened (verified Jul 5 ~23:55 ET: state.folder was null at
    // mount, currentFolder was set later, captured cwd stayed as homedir).
    ws.send(JSON.stringify({ type: 'init', cwd: state.folder || null }));
    // Tell main to spawn the claude PTY for this tab with the persisted
    // sessionId (so prior conversations resume across restarts). If the
    // tab doesn't have a sessionId yet, main generates a deterministic
    // UUID via `claude --session-id <uuid>` and returns it in the ready
    // message — we persist it from there. Long asked for this Jun 28
    // ~16:30 ET so Claude Code sessions don't start fresh every restart.
    const persistedSessionId = claudeCodePersistedSessionsByTab.get(tabId) || null;
    ws.send(JSON.stringify({ type: 'spawn', sessionId: persistedSessionId, tabId }));
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready' && msg.tabId) {
        ptyTabId = msg.tabId;
        const sess = claudeCodeSessions.get(tabId);
        if (sess) {
          sess.ptyTabId = ptyTabId;
          // Capture the sessionId main returned (either our persisted
          // one or the new UUID it generated for fresh tabs). Persist
          // it so a later restart can `--resume` this exact session.
          if (msg.sessionId) {
            sess.sessionId = msg.sessionId;
            claudeCodePersistedSessionsByTab.set(tabId, msg.sessionId);
            persistClaudeCodeTabs();
          }
        }
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[2m[claude exited — type something or click + to start a new session]\x1b[0m\r\n');
      } else if (msg.type === 'error') {
        term.write('\r\n\x1b[31m[error: ' + (msg.message || 'unknown') + ']\x1b[0m\r\n');
      }
    } catch {}
  };
  ws.onclose = () => {
    term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
  };

  const resizeObserver = new ResizeObserver(() => {
    try { fit.fit(); ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
  });
  resizeObserver.observe(paneEl);

  claudeCodeSessions.set(tabId, { term, fit, ws, paneEl, label, createdAt: Date.now(), ptyTabId });
  activeClaudeCodeTabId = tabId;
  renderClaudeCodeTabs();
  for (const [id, sess] of claudeCodeSessions.entries()) {
    if (sess.paneEl) sess.paneEl.hidden = (id !== tabId);
  }
}

function renderClaudeCodeTabs() {
  const container = document.getElementById('claude-code-tabs');
  if (!container) return;
  Array.from(container.querySelectorAll('.cctab')).forEach(n => n.remove());
  const tabs = Array.from(claudeCodeSessions.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  const newBtn = document.getElementById('claude-code-new-tab');
  for (const [tabId, sess] of tabs) {
    const pill = document.createElement('button');
    pill.className = 'cctab' + (tabId === activeClaudeCodeTabId ? ' is-active' : '');
    pill.dataset.tabId = tabId;
    pill.title = sess.label;
    pill.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>
      <span class="cctab__label">${escapeHtml(sess.label)}</span>
      <span class="cctab__close" data-close="${tabId}" title="Close Claude Code session">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>
      </span>
    `;
    pill.addEventListener('click', (ev) => {
      if (ev.target.closest('.cctab__close')) return;
      switchClaudeCodeTab(tabId);
    });
    const closeBtn = pill.querySelector('.cctab__close');
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeClaudeCodeTab(tabId);
    });
    container.insertBefore(pill, newBtn);
  }
}

function switchClaudeCodeTab(tabId) {
  const sess = claudeCodeSessions.get(tabId);
  if (!sess) return;
  activeClaudeCodeTabId = tabId;
  for (const [id, s] of claudeCodeSessions.entries()) {
    if (s.paneEl) s.paneEl.hidden = (id !== tabId);
  }
  renderClaudeCodeTabs();
  persistClaudeCodeTabs();
  setTimeout(() => {
    try { sess.fit.fit(); sess.term.focus(); } catch {}
  }, 30);
}

async function closeClaudeCodeTab(tabId) {
  const sess = claudeCodeSessions.get(tabId);
  if (!sess) return;
  try { await window.farnsworth.claudeCodeClose(sess.ptyTabId || tabId); } catch {}
  try { sess.ws.close(); } catch {}
  try { sess.term.dispose(); } catch {}
  try { sess.paneEl.remove(); } catch {}
  claudeCodeSessions.delete(tabId);
  if (activeClaudeCodeTabId === tabId) {
    const remaining = Array.from(claudeCodeSessions.keys()).sort((a, b) => {
      return claudeCodeSessions.get(a).createdAt - claudeCodeSessions.get(b).createdAt;
    });
    activeClaudeCodeTabId = remaining[0] || null;
    if (activeClaudeCodeTabId) {
      const next = claudeCodeSessions.get(activeClaudeCodeTabId);
      for (const [id, s] of claudeCodeSessions.entries()) {
        if (s.paneEl) s.paneEl.hidden = (id !== activeClaudeCodeTabId);
      }
      setTimeout(() => { try { next.fit.fit(); next.term.focus(); } catch {} }, 30);
    }
  }
  renderClaudeCodeTabs();
  persistClaudeCodeTabs();
}

function renderTerminalTabs() {
  const container = document.getElementById('terminal-tabs');
  if (!container) return;
  // Remove every existing tab pill (keep the "+" new-tab button at the end).
  Array.from(container.querySelectorAll('.termtab')).forEach(n => n.remove());
  // Insert pills in tabId-creation order.
  const tabs = Array.from(terminalSessions.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  const newBtn = document.getElementById('terminal-new-tab');
  for (const [tabId, sess] of tabs) {
    const pill = document.createElement('button');
    pill.className = 'termtab' + (tabId === activeTerminalTabId ? ' is-active' : '');
    pill.dataset.tabId = tabId;
    pill.title = sess.label;
    pill.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      <span class="termtab__label">${escapeHtml(sess.label)}</span>
      <span class="termtab__close" data-close="${tabId}" title="Close terminal">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>
      </span>
    `;
    pill.addEventListener('click', (ev) => {
      // Don't switch when the click was on the close button.
      if (ev.target.closest('.termtab__close')) return;
      switchTerminalTab(tabId);
    });
    const closeBtn = pill.querySelector('.termtab__close');
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTerminalTab(tabId);
    });
    container.insertBefore(pill, newBtn);
  }
}

function switchTerminalTab(tabId) {
  const sess = terminalSessions.get(tabId);
  if (!sess) return;
  activeTerminalTabId = tabId;
  // Toggle pane visibility
  for (const [id, s] of terminalSessions.entries()) {
    if (s.paneEl) s.paneEl.hidden = (id !== tabId);
  }
  renderTerminalTabs();
  setTimeout(() => {
    try { sess.fit.fit(); sess.term.focus(); } catch {}
  }, 30);
}

async function closeTerminalTab(tabId) {
  const sess = terminalSessions.get(tabId);
  if (!sess) return;
  // Tell main to kill the PTY (and drop the WS).
  try { await window.farnsworth.terminalClose(sess.ptyTabId || tabId); } catch {}
  try { sess.ws.close(); } catch {}
  try { sess.term.dispose(); } catch {}
  try { sess.paneEl.remove(); } catch {}
  terminalSessions.delete(tabId);
  // If we closed the active tab, activate the next available one.
  if (activeTerminalTabId === tabId) {
    const remaining = Array.from(terminalSessions.keys()).sort((a, b) => {
      return terminalSessions.get(a).createdAt - terminalSessions.get(b).createdAt;
    });
    activeTerminalTabId = remaining[0] || null;
    if (activeTerminalTabId) {
      const next = terminalSessions.get(activeTerminalTabId);
      for (const [id, s] of terminalSessions.entries()) {
        if (s.paneEl) s.paneEl.hidden = (id !== activeTerminalTabId);
      }
      setTimeout(() => { try { next.fit.fit(); next.term.focus(); } catch {} }, 30);
    }
  }
  renderTerminalTabs();
}

function switchLeftPanel(tab) {
  state.leftPanel = tab;
  const chatPane = $('#chat-pane');
  const termPane = $('#terminal-pane');
  const ccPane = $('#claude-code-pane');
  const chatTab = $('#lefttab-chat');
  const termTab = $('#lefttab-terminal');
  const ccTab = $('#lefttab-claudecode');
  if (chatPane) chatPane.hidden = (tab !== 'chat');
  if (termPane) termPane.hidden = (tab !== 'terminal');
  if (ccPane) ccPane.hidden = (tab !== 'claudecode');
  chatTab && chatTab.classList.toggle('is-active', tab === 'chat');
  termTab && termTab.classList.toggle('is-active', tab === 'terminal');
  ccTab && ccTab.classList.toggle('is-active', tab === 'claudecode');
  if (tab === 'terminal') {
    // Lazily spawn the first tab if none exist yet.
    if (terminalSessions.size === 0) {
      addTerminalTab();
    } else if (activeTerminalTabId) {
      const sess = terminalSessions.get(activeTerminalTabId);
      setTimeout(() => { try { sess && sess.fit.fit(); sess && sess.term.focus(); } catch {} }, 50);
    }
  }
  if (tab === 'claudecode') {
    // Same lazy-spawn pattern as terminal: first switch creates the first
    // session; subsequent switches just focus the active one.
    if (claudeCodeSessions.size === 0) {
      // Restore previously open tabs (Jun 28 ~15:51 ET) before spawning
      // anything fresh — if Long had two Claude Code tabs open last time
      // and quit, we want those same two back, not a single new one.
      restoreClaudeCodeTabs().then((restored) => {
        if (!restored) {
          addClaudeCodeTab();
        }
      });
    } else if (activeClaudeCodeTabId) {
      const sess = claudeCodeSessions.get(activeClaudeCodeTabId);
      setTimeout(() => { try { sess && sess.fit.fit(); sess && sess.term.focus(); } catch {} }, 50);
    }
  }
}

// Restore Claude Code tabs that were open at last shutdown. Spawns a PTY
// for the saved active tab (so the user lands on something useful), and
// creates visual tab pills for the others (PTYs spawn lazily when the
// user clicks them). Returns true if any tabs were restored, false if
// the persisted list was empty (caller can fall back to fresh-spawn).
async function restoreClaudeCodeTabs() {
  const { tabs, activeId } = await loadPersistedClaudeCodeTabs();
  if (!tabs.length) return false;
  // Bump the counter past the highest persisted id so future tabs get a
  // unique number. Each persisted id has the form 'cc-<n>'.
  for (const t of tabs) {
    const m = /^cc-(\d+)$/.exec(t.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > claudeCodeTabCounter) claudeCodeTabCounter = n;
    }
    // Seed the sessionId lookup (Jun 28 ~16:30 ET) so initClaudeCode
    // passes the right UUID to main when it spawns the PTY, which makes
    // main invoke `claude --resume <sessionId>` instead of starting a
    // blank session. Skip invalid UUIDs (Jun 28 ~16:33 ET: stale
    // ffffffff-prefix junk from the first attempt) so main falls
    // through to the fresh-session path with `crypto.randomUUID()`.
    if (t.sessionId && isValidUuid(t.sessionId)) {
      claudeCodePersistedSessionsByTab.set(t.id, t.sessionId);
    }
  }
  // Spawn each tab in order. We pass each tabId through the existing
  // initClaudeCode path so the auth-gate + xterm setup stays consistent.
  for (const t of tabs) {
    await new Promise((resolve) => {
      initClaudeCode(t.id).then(() => {
        const sess = claudeCodeSessions.get(t.id);
        if (sess) {
          // Override the auto-generated label so persisted labels win.
          if (t.label) {
            sess.label = t.label;
          }
          // Set createdAt so sort order matches persisted order.
          if (t.createdAt) {
            sess.createdAt = new Date(t.createdAt).getTime() || sess.createdAt;
          }
        }
        resolve();
      });
    });
  }
  // Activate the saved active tab (or the first one if the saved active
  // tab no longer exists). Spawns its PTY lazily via switchClaudeCodeTab.
  const targetId = (activeId && claudeCodeSessions.has(activeId)) ? activeId : tabs[0].id;
  if (targetId) switchClaudeCodeTab(targetId);
  else renderClaudeCodeTabs();
  return true;
}

function addTerminalTab() {
  const tabId = nextTerminalTabId();
  initTerminal(tabId).then(() => {
    const sess = terminalSessions.get(tabId);
    if (sess) setTimeout(() => { try { sess.fit.fit(); sess.term.focus(); } catch {} }, 50);
  });
}

function addClaudeCodeTab() {
  const tabId = nextClaudeCodeTabId();
  initClaudeCode(tabId).then(() => {
    const sess = claudeCodeSessions.get(tabId);
    if (sess) {
      activeClaudeCodeTabId = tabId;
      setTimeout(() => { try { sess.fit.fit(); sess.term.focus(); } catch {} }, 50);
    }
    renderClaudeCodeTabs();
    persistClaudeCodeTabs();
  });
}

// ============================================================================
// INIT
// ============================================================================
// ============================================================================
// MONACO EDITOR (Phase 3)
// ============================================================================
//
// Singleton Monaco editor instance mounted in #monaco-container when canvasMode
// is 'code'. Multi-file tabs above the editor; opening a file from the right
// panel Files tree calls openFileInEditor(). Cmd+S saves the active buffer
// via fs:writeFile (already wired in IPC).

const openFiles = []; // [{ path, name, dirty, model, diskContent }]
let activeFileIdx = -1;
// Stack of recently-closed files for "Reopen Closed Editor" (⇧⌘T). Each
// entry stores enough to re-mount the buffer in Monaco without re-reading
// from disk: path, last-known content, and the cursor position the user
// left at. We push on closeFile() and shift on reopenLastClosedFile().
// Capped at 20 entries so memory stays bounded across long sessions.
const closedFiles = [];
let monacoEditor = null;
let monacoTheme = 'vs-dark';

// Toggle word wrap on the Monaco editor. Reads the current wordWrap
// option, flips between 'on' and 'off', and re-renders the canvas so the
// tab strip + dirty markers repaint. Persists via in-memory only — wrap
// is a view preference that resets on reload, matching VS Code's
// default behavior.
function toggleWordWrap() {
  if (!monacoEditor) return;
  const cur = monacoEditor.getOption(monaco.editor.EditorOption.wordWrap);
  const next = cur === 'on' ? 'off' : 'on';
  monacoEditor.updateOptions({ wordWrap: next });
  renderCanvas();
}

// Format the active document. Uses Monaco's built-in formatter action
// (`editor.action.formatDocument`) which respects per-language formatters
// registered by the worker. No-op when there is no active file or no
// editor. Same as ⇧⌥F in VS Code.
function formatActiveDocument() {
  if (!monacoEditor || activeFileIdx < 0) return;
  monacoEditor.getAction('editor.action.formatDocument').run();
}

// Fold / unfold all in the active document. Both are Monaco built-ins
// (`editor.foldAll` / `editor.unfoldAll`). The ⌘K prefix means ⌘K ⌘0
// and ⌘K ⌘J — Monaco accepts the chord via the KeyMod chord syntax.
function foldAll() {
  if (!monacoEditor || activeFileIdx < 0) return;
  monacoEditor.getAction('editor.foldAll').run();
}
function unfoldAll() {
  if (!monacoEditor || activeFileIdx < 0) return;
  monacoEditor.getAction('editor.unfoldAll').run();
}

// Prompt for a 1-based line number and jump to it. VS Code's Ctrl+G
// equivalent. Reuses Monaco's `editor.action.gotoLine` which opens its
// own input widget, but we wrap it in a custom prompt so the palette
// entry has a clean handler. Cancel returns silently.
function goToLine() {
  if (!monacoEditor || activeFileIdx < 0) return;
  const lineStr = window.prompt('Go to line:', '');
  if (!lineStr) return;
  const line = parseInt(lineStr, 10);
  if (!Number.isFinite(line) || line < 1) return;
  monacoEditor.revealLineInCenter(line);
  monacoEditor.setPosition({ lineNumber: line, column: 1 });
  monacoEditor.focus();
}

// Reveal the active file in Finder (or its workspace folder if there's
// no active file). Uses the TCC-safe `fs:showInFinder` IPC, which calls
// `/usr/bin/open -R <path>` so it goes through LaunchServices directly
// instead of tripping macOS AppleEvents TCC.
async function revealActiveInFinder() {
  if (!window.farnsworth?.showInFinder) return;
  if (activeFileIdx < 0 || !openFiles[activeFileIdx]) {
    if (state.folder) await window.farnsworth.showInFinder(state.folder, '');
    return;
  }
  const file = openFiles[activeFileIdx];
  if (!state.folder) return;
  await window.farnsworth.showInFinder(state.folder, file.path);
}

// Close the file at activeFileIdx (or no-op if nothing is open). Wraps
// `closeFile(idx)` so the global keybinding has a clean handler. The
// closeFile function pushes to closedFiles so ⇧⌘T can reopen it.
function closeActiveFile() {
  if (activeFileIdx < 0 || !openFiles[activeFileIdx]) return;
  closeFile(activeFileIdx);
}

// Reopen the most recently closed file. Pops from the closedFiles
// stack and re-mounts the model via openFileInEditor(), which handles
// the "already open" case as a no-op (just switches to it). Cursor
// restoration is best-effort — we restore if the line is still in
// bounds, otherwise we leave the cursor at line 1.
async function reopenLastClosedFile() {
  const entry = closedFiles.shift();
  if (!entry) return;
  await openFileInEditor(entry.path, entry.diskContent || '');
  if (monacoEditor && entry.cursor && entry.cursor.lineNumber) {
    try {
      const lineCount = monacoEditor.getModel()?.getLineCount() || 0;
      if (entry.cursor.lineNumber <= lineCount) {
        monacoEditor.setPosition(entry.cursor);
        monacoEditor.revealLineInCenter(entry.cursor.lineNumber);
      }
    } catch {}
  }
  monacoEditor?.focus();
}

const FILE_LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', mdx: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', svg: 'xml',
  sql: 'sql', graphql: 'graphql',
};

function langForPath(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase().split('?')[0];
  return FILE_LANG_BY_EXT[ext] || 'plaintext';
}

function initMonacoEditor() {
  const container = document.getElementById('monaco-container');
  if (!container) return null;

  // Editor exists AND is mounted in the current container — reuse it. Monaco
  // stays attached across renderCodeView() calls because renderCodeView() now
  // reuses the same #monaco-container element instead of creating a new one.
  if (monacoEditor && monacoEditor.getContainerDomNode() === container) {
    return monacoEditor;
  }

  // Container changed (mode switch, etc.) OR no editor yet — dispose old +
  // create a fresh one in the current container. Models in openFiles[] stay
  // alive across disposal because Monaco keeps them in the editor service.
  if (monacoEditor) {
    try { monacoEditor.dispose(); } catch {}
    monacoEditor = null;
  }

  if (!window.__monacoReady) return null;

  monacoEditor = monaco.editor.create(container, {
    value: '',
    language: 'plaintext',
    theme: monacoTheme,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
  });
  monacoEditor.onDidChangeModelContent(() => {
    const idx = activeFileIdx;
    if (idx < 0) return;
    const file = openFiles[idx];
    if (!file) return;
    const model = monacoEditor.getModel();
    if (!model || file.model !== model) return;
    const isDirty = model.getValue() !== file.diskContent;
    if (isDirty !== file.dirty) {
      file.dirty = isDirty;
      // Update ONLY the dirty indicator on the tab — do NOT call
      // renderCanvas() here. renderCanvas() does `stage.innerHTML = ''`
      // and re-mounts the code-view subtree, which disposes + recreates
      // the Monaco editor instance (see initMonacoEditor's "container
      // changed" branch). That recreates the editor on every dirty flip,
      // which loses focus and resets the visible cursor — the user has
      // to click back into the editor after every delete / first
      // keystroke. updateTabUI() only touches the .code-view__tabs
      // element so Monaco keeps focus and the cursor stays put.
      updateTabUI();
    }
  });
  // Cmd+S / Ctrl+S to save
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveFile);
  // Cmd+F / Ctrl+F to open the find bar
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
    const sel = monacoEditor.getSelection();
    if (sel && !sel.isEmpty()) {
      const model = monacoEditor.getModel();
      state.codeFindTerm = model.getValueInRange(sel);
    }
    state.codeFindOpen = true;
    renderCanvas();
  });
  // ⇧⌥F / Ctrl+Shift+Alt+F — Format Document (Monaco built-in formatter)
  monacoEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
    formatActiveDocument
  );
  // ⌥Z / Alt+Z — Toggle Word Wrap
  monacoEditor.addCommand(
    monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
    toggleWordWrap
  );
  // ⌘K ⌘0 — Fold All. KeyMod.chord() takes the two halves: ⌘K then ⌘0.
  monacoEditor.addCommand(
    monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0),
    foldAll
  );
  // ⌘K ⌘J — Unfold All
  monacoEditor.addCommand(
    monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ),
    unfoldAll
  );
  // Ctrl+G / Ctrl+L — Go to Line. Monaco's editor.action.gotoLine opens
  // its own input widget. Ctrl+G is VS Code's default; Ctrl+L is kept
  // as an alias because some platforms swallow Ctrl+G.
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, goToLine);
  // ⌘W — Close active file (also wired at the global level so it works
  // outside Monaco focus). The handler is a no-op when nothing is open.
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, closeActiveFile);
  // ⇧⌘T — Reopen last closed file
  monacoEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT,
    reopenLastClosedFile
  );
  // ⌘N — New file (also wired at the global level). Monaco's ⌘N would
  // conflict with the global handler; this binding only fires when the
  // editor has focus, and the global handler swallows the event first.
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, openNewFileDialog);

  // Restore the active file's model into the fresh editor so open tabs survive
  // the container swap. focusActiveFile() also handles this on tab click, but
  // we need it eagerly on first init too.
  if (activeFileIdx >= 0 && openFiles[activeFileIdx] && openFiles[activeFileIdx].model) {
    try { monacoEditor.setModel(openFiles[activeFileIdx].model); } catch {}
  }
  return monacoEditor;
}

async function openFileInEditor(filePath, content) {
  // Already open? just switch to it.
  const existing = openFiles.findIndex(f => f.path === filePath);
  if (existing >= 0) {
    activeFileIdx = existing;
    return focusActiveFile();
  }
  if (!monacoEditor) initMonacoEditor();
  if (!monacoEditor) return; // monaco not ready yet
  const name = filePath.split('/').pop();
  const uri = monaco.Uri.parse('file://' + filePath);
  const model = monaco.editor.createModel(content || '', langForPath(filePath), uri);
  openFiles.push({ path: filePath, name, dirty: false, model, diskContent: content || '' });
  activeFileIdx = openFiles.length - 1;
  focusActiveFile();
  renderCanvas();
}

async function readFileFromDisk(filePath) {
  if (!window.farnsworth || !state.folder) return null;
  // Strip the workspace prefix from the path so fs:readFile receives a workspace-relative path
  let relPath = filePath;
  if (filePath.startsWith(state.folder)) relPath = filePath.slice(state.folder.length).replace(/^\/+/, '/');
  try {
    const res = await window.farnsworth.readFile(state.folder, relPath);
    return res?.content ?? null;
  } catch (e) {
    console.error('readFile failed:', e);
    return null;
  }
}

async function openFileByPath(filePath) {
  const content = await readFileFromDisk(filePath);
  if (content === null) return;
  await openFileInEditor(filePath, content);
}

function focusActiveFile() {
  if (!monacoEditor || activeFileIdx < 0) return;
  const file = openFiles[activeFileIdx];
  if (!file) return;
  monacoEditor.setModel(file.model);
  updateTabUI();
  monacoEditor.focus();
}

function updateTabUI() {
  const tabs = document.querySelector('.code-view__tabs');
  if (!tabs) return;
  // First child(ren) are tab buttons; re-render
  while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
  openFiles.forEach((f, i) => {
    const tab = document.createElement('div');
    tab.className = 'code-view__tab' + (i === activeFileIdx ? ' is-active' : '');
    tab.dataset.fileIdx = i;
    const dot = document.createElement('span');
    dot.className = 'code-view__tab--dot' + (f.dirty ? ' is-dirty' : '');
    dot.style.width = '6px'; dot.style.height = '6px'; dot.style.borderRadius = '50%';
    dot.style.background = f.dirty ? '#f0883e' : 'transparent';
    dot.style.marginRight = '4px';
    tab.appendChild(dot);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = f.name;
    tab.appendChild(nameSpan);
    const close = document.createElement('span');
    close.className = 'code-view__tab--close';
    close.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(i); });
    tab.appendChild(close);
    tab.addEventListener('click', () => { activeFileIdx = i; focusActiveFile(); });
    tabs.appendChild(tab);
  });
  // Spacer
  tabs.appendChild(Object.assign(document.createElement('div'), { style: 'flex:1' }));
}

function closeFile(idx) {
  const file = openFiles[idx];
  if (!file) return;
  // Unsaved changes — prompt Save / Don't Save / Cancel via main-side
  // dialog.showMessageBox (TCC-safe, OS-native look).
  if (file.dirty) {
    // Sync active idx to the file being closed so saveActiveFile writes
    // the right buffer. Otherwise save would target whatever was active
    // when the user clicked the X.
    const wasActive = (activeFileIdx === idx);
    if (!wasActive) {
      // Switch active model so saveActiveFile resolves to `file`.
      const prevActive = activeFileIdx;
      activeFileIdx = idx;
      focusActiveFile();
    }
    confirmDiscard({ fileName: file.name }).then((choice) => {
      // Restore prior active idx regardless of outcome (cancel means
      // we keep the user's original active tab too).
      activeFileIdx = wasActive ? idx : prevActive;
      if (choice === 2) return;  // Cancel — leave the tab open
      if (choice === 0) {
        // Save then close. We call writeFile directly because we may
        // not be the active file — saveActiveFile targets activeFileIdx.
        const content = file.model?.getValue() || '';
        let relPath = file.path;
        if (file.path.startsWith(state.folder)) {
          relPath = file.path.slice(state.folder.length).replace(/^\/+/, '/');
        }
        window.farnsworth.writeFile(state.folder, relPath, content)
          .then(() => {
            file.diskContent = content;
            file.dirty = false;
            actuallyCloseFile(idx);
          })
          .catch((e) => {
            console.error('save failed:', e);
            alert('Save failed: ' + (e?.message || e));
          });
        return;
      }
      // 1 = Don't Save — close without saving.
      actuallyCloseFile(idx);
    });
    return;
  }
  actuallyCloseFile(idx);
}

function actuallyCloseFile(idx) {
  const file = openFiles[idx];
  if (!file) return;
  // Push to the closed-files history BEFORE disposing the model so
  // reopenLastClosedFile() can re-mount the buffer. We capture the
  // current content + cursor so the user lands back where they were.
  // Dirty buffers are still pushed — VS Code does the same and prompts
  // on save later if needed. Capped at 20 to bound memory.
  if (file) {
    const cursor = monacoEditor && monacoEditor.getModel() === file.model
      ? monacoEditor.getPosition()
      : null;
    const content = (file.model && file.model.getValue && !file.model.isDisposed())
      ? file.model.getValue()
      : file.diskContent;
    closedFiles.unshift({
      path: file.path,
      name: file.name,
      diskContent: content || '',
      cursor,
    });
    if (closedFiles.length > 20) closedFiles.length = 20;
    if (file.model) file.model.dispose();
  }
  openFiles.splice(idx, 1);
  if (activeFileIdx >= openFiles.length) activeFileIdx = openFiles.length - 1;
  if (openFiles.length === 0) {
    activeFileIdx = -1;
    if (monacoEditor) monacoEditor.setModel(null);
  } else {
    focusActiveFile();
  }
  renderCanvas();
}

// Prompt user about unsaved changes. Returns 0=Save, 1=Don't Save, 2=Cancel.
// Always resolves (never rejects) — errors default to Cancel.
async function confirmDiscard({ fileName, count } = {}) {
  if (!window.farnsworth?.dialogConfirmDiscard) return 2;
  try {
    const res = await window.farnsworth.dialogConfirmDiscard({ fileName, count });
    return res?.choice ?? 2;
  } catch {
    return 2;
  }
}

async function saveActiveFile() {
  if (activeFileIdx < 0 || !state.folder) return;
  const file = openFiles[activeFileIdx];
  if (!file) return;
  const content = monacoEditor.getValue();
  let relPath = file.path;
  if (file.path.startsWith(state.folder)) relPath = file.path.slice(state.folder.length).replace(/^\/+/, '/');
  try {
    await window.farnsworth.writeFile(state.folder, relPath, content);
    file.diskContent = content;
    file.dirty = false;
    renderCanvas();
  } catch (e) {
    console.error('save failed:', e);
    alert('Save failed: ' + e.message);
  }
}

// Init Monaco as soon as the loader signals ready
if (window.__monacoReady) {
  initMonacoEditor();
} else {
  window.addEventListener('monaco-ready', () => {
    initMonacoEditor();
    // Re-mount any pending models
    if (activeFileIdx >= 0) focusActiveFile();
  });
}

// Toggle the left panel between expanded (normal width) and collapsed (36px icon strip).
function toggleLeftPanel() {
  const panel = document.getElementById('left-panel');
  const btn = document.getElementById('left-panel-toggle-btn');
  if (!panel || !btn) return;

  // Measure the pre-toggle width FIRST. Reading getBoundingClientRect
  // after classList.toggle would capture the 36px collapsed width and
  // save that — then expanding restores to 36px instead of the original
  // width. Drag-resize worked around this because it overwrites the
  // inline width fresh.
  const wasCollapsed = panel.classList.contains('is-collapsed');
  if (!wasCollapsed) {
    state.leftPanelWidth = Math.round(panel.getBoundingClientRect().width);
  }
  const collapsed = panel.classList.toggle('is-collapsed');
  state.leftPanelCollapsed = collapsed;
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  btn.setAttribute('aria-label', btn.title);

  // Clear inline width so the collapsed CSS rule can apply; restore on expand.
  if (collapsed) {
    panel.style.width = '';
    panel.style.flex = '';
  } else if (state.leftPanelWidth) {
    panel.style.width = state.leftPanelWidth + 'px';
    panel.style.flex = `0 0 ${state.leftPanelWidth}px`;
  }
}

// Toggle the right panel between expanded (normal width) and collapsed (36px icon strip).
function toggleRightPanel() {
  const panel = document.getElementById('right-panel');
  const btn = document.getElementById('right-panel-toggle-btn');
  if (!panel || !btn) return;

  // Measure the pre-toggle width FIRST. Reading getBoundingClientRect
  // after classList.toggle would capture the 36px collapsed width and
  // save that — then expanding restores to 36px instead of the original
  // width. Drag-resize worked around this because it overwrites the
  // inline width fresh.
  const wasCollapsed = panel.classList.contains('is-collapsed');
  if (!wasCollapsed) {
    state.rightPanelWidth = Math.round(panel.getBoundingClientRect().width);
  }
  const collapsed = panel.classList.toggle('is-collapsed');
  state.rightPanelCollapsed = collapsed;
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  btn.setAttribute('aria-label', btn.title);

  // Clear inline width so the collapsed CSS rule can apply; restore on expand.
  if (collapsed) {
    panel.style.width = '';
    panel.style.flex = '';
  } else if (state.rightPanelWidth) {
    panel.style.width = state.rightPanelWidth + 'px';
    panel.style.flex = `0 0 ${state.rightPanelWidth}px`;
  }
}

// Wire up the right-panel drag handle. Drag left to grow, capped at 66% of viewport.
function initRightPanelResize() {
  const panel = document.getElementById('right-panel');
  const handle = document.getElementById('right-panel-resize-handle');
  if (!panel || !handle) return;

  // Restore collapsed state FIRST so the collapsed CSS wins over inline width
  if (state.rightPanelCollapsed) {
    panel.classList.add('is-collapsed');
    const btn = document.getElementById('right-panel-toggle-btn');
    if (btn) {
      btn.title = 'Expand panel';
      btn.setAttribute('aria-label', 'Expand panel');
    }
  } else if (state.rightPanelWidth && state.rightPanelWidth !== 352) {
    // Apply initial width from state (only when not collapsed)
    panel.style.width = state.rightPanelWidth + 'px';
    panel.style.flex = `0 0 ${state.rightPanelWidth}px`;
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const maxW = Math.floor(window.innerWidth * 0.66);
    const minW = 240;

    handle.classList.add('is-dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    // Note: drag left (negative dx) makes the panel GROW because it's on the right edge.
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newW = Math.max(minW, Math.min(maxW, Math.round(startW - dx)));
      panel.style.width = newW + 'px';
      panel.style.flex = `0 0 ${newW}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      state.rightPanelWidth = Math.round(panel.getBoundingClientRect().width);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Wire up the toggle button
  const toggleBtn = document.getElementById('right-panel-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleRightPanel);
  }
}

// Wire up the left-panel drag handle. Drag right to grow, capped at 66% of viewport.
function initLeftPanelResize() {
  const panel = document.getElementById('left-panel');
  const handle = document.getElementById('left-panel-resize-handle');
  if (!panel || !handle) return;
  // Left-panel min-width bumped from 240 → 340 (Jul 11 ~16:11 ET). The three
  // left tabs (Chat / Terminal / Claude Code) need ~332px including icon +
  // padding + toggle button + outer padding. Below that, "Claude Code" tab
  // text wraps to two lines before spilling. Enforced here AND in styles.css
  // (`.lefttab { white-space: nowrap; flex-shrink: 0 }`).

  // Restore collapsed state FIRST so the collapsed CSS wins over inline width
  if (state.leftPanelCollapsed) {
    panel.classList.add('is-collapsed');
    const btn = document.getElementById('left-panel-toggle-btn');
    if (btn) {
      btn.title = 'Expand panel';
      btn.setAttribute('aria-label', 'Expand panel');
    }
  } else if (state.leftPanelWidth && state.leftPanelWidth !== 384) {
    // Apply initial width from state (only when not collapsed)
    panel.style.width = state.leftPanelWidth + 'px';
    panel.style.flex = `0 0 ${state.leftPanelWidth}px`;
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const maxW = Math.floor(window.innerWidth * 0.66);
    // Bumped from 240 → 340 so all three left tabs (Chat / Terminal /
    // Claude Code) stay on one line without wrapping. See comment above.
    const minW = 340;

    handle.classList.add('is-dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newW = Math.max(minW, Math.min(maxW, Math.round(startW + dx)));
      panel.style.width = newW + 'px';
      panel.style.flex = `0 0 ${newW}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      state.leftPanelWidth = Math.round(panel.getBoundingClientRect().width);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Wire up the toggle button
  const toggleBtn = document.getElementById('left-panel-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleLeftPanel);
  }
}

async function init() {
  await loadSettings();
  // Appearance -> CSS vars/body class; canvas network policy -> main
  // (main defaults to allowed, so only an explicit OFF needs pushing).
  applyAppearanceSettings();
  if (state.settings.canvas?.engine?.network === false) {
    window.farnsworth?.canvasSetNetworkAccess?.(false);
  }
  await loadFarnsworthDev();
  // Load the Live panel request timeout from settings (defaults to 15s
  // if never set). Backed by the SQLite settings table key
  // `live.timeout_seconds`. The cogwheel popover shows this value and
  // writes a new one via the same key on save (Long Jul 3 ~11:55 ET —
  // "We need a way to configure the loading and for it to timeout if
  // loading too long"). Applied to every loadLiveGame / refreshLiveGame /
  // loadLiveTickets Promise.race in the renderer + the AbortController
  // timeout in main.js IPC handlers.
  if (window.farnsworth?.getSetting) {
    try {
      const savedTimeout = await window.farnsworth.getSetting('live.timeout_seconds');
      const n = Number(savedTimeout);
      if (Number.isFinite(n) && n >= 1 && n <= 600) state.liveTimeoutSeconds = n;
    } catch {}
  }
  // state.liveGameId is driven by the active workspace's
  // .farnsworth/config.json (liveGameId field) — loaded lazily by
  // handleFolderPicked and persisted by the Live cogwheel popover.
  // When no folder is open, getLiveGameId() falls back to
  // LIVE_DEFAULT_GAME_ID. We deliberately do NOT read from the global
  // settings table here — that path was removed when the subreddit
  // became per-project (Jul 2).
  await detectAuth();
  wire();
  // Status bar (Jul 14): seed every chip at boot, then let events/polls
  // keep them live. detectAuth() above already painted the connection chip.
  wireStatusBar();
  updateStatusBar();
  refreshGitBranch();
  refreshMemStats();
  // Native macOS menu bridge — listen for actions from File / Edit / View
  // / Window menus. Each menu item in main.js sends 'menu:action' to the
  // focused window; we dispatch based on type. Replaces the old workflow
  // where the only way to open a folder was via the welcome overlay.
  if (window.farnsworth?.onMenuAction) {
    window.farnsworth.onMenuAction(handleMenuAction);
  }
  // Programmatic canvas preview switcher (chat agent's open_testview tool,
  // Jul 11 ~18:50 ET). Mirror the size-toggle click handler — nuke every
  // WebContentsView, set state.preview, sync the resolution dropdown,
  // update toggles, re-render. Only meaningful in live mode (the only mode
  // with a preview region); the IPC still fires but the renderer becomes
  // a no-op if we're not in live.
  if (window.farnsworth?.onCanvasSetPreview) {
    window.farnsworth.onCanvasSetPreview((payload) => {
      const preview = payload?.preview;
      const allowed = ['post', 'mobile', 'desktop', 'fullscreen', 'testview'];
      if (!preview || !allowed.includes(preview)) return;
      if (state.canvasMode !== 'live') {
        // Auto-switch to live mode so the preview actually renders.
        state.canvasMode = 'live';
      }
      window.farnsworth?.canvasRemoveAllViews?.();
      state.preview = preview;
      if (typeof syncResolutionDropdownToCategory === 'function') {
        syncResolutionDropdownToCategory();
      }
      if (state.previewCustomHeight) delete state.previewCustomHeight[state.preview];
      updateModeToggles();
      renderCanvas();
    });
  }
  // Initial title bar / chat header — shows folder name when set, else
  // "No folder open" placeholder.
  updateWindowTitle();
  renderChat();
  updateModeToggles();
  renderCanvas();
  renderRightPanel();
  // Bootstrap: load any saved conversations, then try to restore the
  // last active one (Jun 28 ~16:12 ET) so a close-then-reopen cycle
  // lands on the same conversation instead of creating a fresh one.
  // Falls back to creating a new conversation if no saved active id
  // exists or if the saved id no longer exists in the DB.
  await refreshChatHistoryList();
  let activeRestored = false;
  if (!state.chatActiveId && window.farnsworth?.getSetting) {
    try {
      const savedActiveId = await window.farnsworth.getSetting('chat.activeId');
      if (savedActiveId && typeof savedActiveId === 'string') {
        const conv = await window.farnsworth.chatConvLoad(savedActiveId);
        if (conv) {
          state.chatActiveId = conv.id;
          state.chatMessages = Array.isArray(conv.messages) ? conv.messages : [];
          activeRestored = true;
        }
      }
    } catch {}
  }
  if (!state.chatActiveId) {
    const res = await window.farnsworth.chatConvCreate({ messages: state.chatMessages });
    state.chatActiveId = res.id;
    await persistChatActiveId(res.id);
    await saveActiveConversation();
    await refreshChatHistoryList();
  } else if (activeRestored) {
    renderChat();
    await refreshChatHistoryList();
  }
  // Restore last opened folder if recent has one
  let recent = [];
  if (window.farnsworth) recent = await window.farnsworth.getRecent();
  if (recent.length > 0) {
    await handleFolderPicked(recent[0].path);
  } else {
    showWelcome();
  }
  // Apply the default left panel — `claudecode` is the new default per
  // Long's request. switchLeftPanel() handles lazy-spawn for claudecode +
  // terminal (chat has no per-panel init, so it's a no-op for chat).
  switchLeftPanel(state.leftPanel);

  // Wire up left-panel resize handle + collapse toggle (Jun 29 ~00:46 ET)
  initLeftPanelResize();
  // Wire up right-panel resize handle + collapse toggle (Jun 29 ~01:01 ET)
  initRightPanelResize();
  // Wire up the relay: receive chat/command/canvas:subscribe from
  // companion apps via the cloud relay, and push canvas state back.
  // No-op if the relay isn't connected.
  wireRelay();
}

init();
