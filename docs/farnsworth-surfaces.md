# Farnsworth chat surfaces — design doc

The Farnsworth chat panel currently renders only plain text + a few tool-use chips. This design brings the full assistant-surface vocabulary (step progress cards, choice buttons, forms, credential prompts, OAuth CTAs, copy blocks, work-result receipts, plus Farnsworth-specific surfaces) into the chat stream.

**Decision summary (locked Jul 7):**
- **Render location:** inline in chat (Claude.ai style). Mobile-friendly, simplest to implement, no side-rail real estate to fight over.
- **Interaction model:** mixed. `choice` / `form` / `confirmation` → synthetic user message fed back as the next turn. `copy_block` / "reveal in Finder" / "open file" → direct action.
- **Streaming updates:** yes for `task_progress` and `work_result` (steps/sections flip in place via `surfaceId`). Other surfaces are atomic when emitted.

## Architecture

### How a surface enters the chat

The assistant emits a `tool_use` block with `name: "ui_show"` and an input payload that matches the surface shape. The renderer's stream handler detects this tool, renders the surface inline at the agent message position, and registers interaction handlers.

```json
{
  "type": "tool_use",
  "name": "ui_show",
  "input": {
    "surfaceId": "task-2026-07-07-build",
    "surfaceType": "card",
    "data": {
      "template": "task_progress",
      "templateData": {
        "title": "Shipping surfaces",
        "status": "in_progress",
        "steps": [...]
      }
    }
  }
}
```

### Why a tool and not a content block?

Claude's API supports arbitrary content blocks, but tools are easier because:
- The renderer already has a tool-use loop (it executes local tools like `read_file`, `list_files`, `run_command`)
- `ui_show` slots into that loop naturally — execute the surface locally instead of round-tripping it as a tool result to the API
- Tools give us clean input/output shapes
- A surface doesn't need to come back to the model as a tool_result; it's a renderer-side side effect

### IPC + bridge

- New IPC channel `chat:emitSurface` (main → renderer) — used for server-side surfaces (e.g. when the assistant backend itself emits one, not the model). For model-emitted surfaces, we use the existing tool loop.
- New bridge `window.farnsworth.executeTool('ui_show', input)` is already covered by the existing `executeTool` IPC.

### Surface renderer module

A single module (`renderSurface(surface, ctx)`) that takes a surface payload + context (mount point, callbacks) and returns a DOM node. Each surface type has a render function:

```
src/surfaces/
  index.js          (entry: renderSurface)
  card.js           (title, subtitle, body, metadata; templates: weather, task_progress)
  choice.js
  confirmation.js
  form.js
  copy_block.js
  work_result.js
  credential.js     (uses window.farnsworth.promptSecret() for secure entry)
  oauth_connect.js  (uses window.farnsworth.oauthStart())
  file_change.js    (Farnsworth-specific: diff display)
  live_preview.js   (Farnsworth-specific: canvas iframe inline)
  test_status.js    (Farnsworth-specific: pass/fail summary)
  memory_recall.js  (Farnsworth-specific: shows memory hits before the answer)
  shared/
    button.js
    kbd.js
    css.js          (class-name constants)
```

### Interaction callbacks

When a surface emits an action, the renderer dispatches to one of two paths:

```
onSurfaceAction(surface, action):
  if (action.kind === 'synthetic-turn'):
    state.chatMessages.push({ role: 'user', text: action.userText })
    sendChatMessage() // continue the same conversation
  else if (action.kind === 'direct-action'):
    switch (action.id):
      case 'copy':          navigator.clipboard.writeText(action.text)
      case 'reveal':        window.farnsworth.showInFinder(folder, action.path)
      case 'open-file':     openFile({...})
      case 'open-terminal': switchLeftTab('terminal')
      case 'open-canvas':   switchLeftTab(state.canvasMode)
      case 'open-settings': openSettings(action.page)
      case 'refresh-live':  window.farnsworth.liveRefreshGame(getLiveGameId())
      case 'show-tasks':    state.rightTab = 'tasks'
  else if (action.kind === 'credential'):
    window.farnsworth.promptSecret(action.label, action.id)
      .then(value => onSurfaceAction(surface, {kind:'synthetic-turn', userText:`[credential:${action.id}] submitted`}))
  else if (action.kind === 'oauth'):
    window.farnsworth.oauthStart(action.provider)
      .then(() => onSurfaceAction(surface, {kind:'synthetic-turn', userText:`OAuth flow started for ${action.provider}`}))
```

### Streaming updates

Each surface has a stable `surfaceId`. When the assistant emits a `ui_show` with an `surfaceId` that already exists in the chat, the renderer updates in place instead of inserting a new surface:

```
state.chatSurfaces[surfaceId] = { surface, domNode, mountPoint, ... }
// On update:
state.chatSurfaces[surfaceId].domNode.replaceWith(newDomNode)
```

This lets `task_progress` flip steps as the model emits them, and `work_result` accumulate sections incrementally.

### Persistence

Chat history is already saved to `db.js` as `messages: [{role, text}]`. For surfaces, we extend the message shape:

```
{
  role: 'agent',
  text: 'optional prose around the surface',
  surfaces: [{ surfaceId, surfaceType, data }, ...]
}
```

When a conversation is reloaded, the renderer iterates `surfaces[]` and re-renders them inline. Updates from the current session don't affect the persisted record — the persisted record captures the final state at the time of saving.

## v1 surface specs

### 1. `card` (with `task_progress` template)

```js
{
  surfaceType: 'card',
  data: {
    title: 'Shipping chat surfaces',
    subtitle: 'Phases 1-6',
    template: 'task_progress',
    templateData: {
      title: 'Building chat surface system',
      status: 'in_progress',  // in_progress | completed | failed
      steps: [
        { label: 'Write design doc', status: 'completed' },
        { label: 'Add IPC + parser',  status: 'in_progress' },
        { label: 'Build renderer',    status: 'pending' },
      ]
    }
  }
}
```

### 2. `choice`

```js
{
  surfaceType: 'choice',
  data: {
    description: 'Which project should I work in?',
    options: [
      { id: 'farnsworth', label: 'Farnsworth', description: 'AI-native IDE' },
      { id: 'the-last-draft', label: 'the-last-draft', description: 'MBA basketball game' },
      { id: 'vibe-farnsworth-template', label: 'vibe-farnsworth-template', description: 'Devvit fork' },
    ],
    selectionMode: 'single', // or 'multiple'
    submitLabel: 'Continue'
  }
}
```

### 3. `confirmation`

```js
{
  surfaceType: 'confirmation',
  data: {
    message: 'Delete 3 tasks?',
    detail: 'This can\'t be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Keep',
    destructive: true
  }
}
```

### 4. `form`

```js
{
  surfaceType: 'form',
  data: {
    description: 'Configure the new project',
    fields: [
      { id: 'name', type: 'text', label: 'Project name', required: true },
      { id: 'subreddit', type: 'text', label: 'Subreddit' },
      { id: 'private', type: 'toggle', label: 'Private subreddit', defaultValue: false },
      { id: 'theme', type: 'select', label: 'Theme', options: [
        { label: 'Light', value: 'light' },
        { label: 'Dark', value: 'dark' }
      ]},
    ],
    submitLabel: 'Create'
  }
}
```

### 5. `copy_block`

```js
{
  surfaceType: 'copy_block',
  data: {
    text: 'git -c credential.helper= push "https://x-access-token:${TOKEN}@github.com/owner/repo.git" main:main',
    label: 'Inline-token git push',
    language: 'bash'
  }
}
```

### 6. `work_result`

```js
{
  surfaceType: 'work_result',
  data: {
    eyebrow: 'Built',
    status: 'completed', // completed | partial | failed
    summary: '10 commands shipped, doc written, verified via CDP',
    metrics: [
      { label: 'Lines changed', value: '347', detail: '+218/-129', tone: 'positive' },
      { label: 'New IPCs', value: '1', tone: 'neutral' },
    ],
    sections: [
      { id: 'files', title: 'Files changed', type: 'items', items: [
        { title: 'src/app.js', description: '10 new commands + helpers', tone: 'positive' },
        { title: 'main.js', description: 'fs:showInFinder IPC', tone: 'positive' },
      ]}
    ]
  }
}
```

### 7. `credential`

```js
{
  surfaceType: 'credential',
  data: {
    id: 'github-token',           // identifier passed back as synthetic message
    label: 'GitHub personal access token',
    description: 'Needed to push to your repo',
    placeholder: 'ghp_...',
    submitLabel: 'Save'
  }
}
```

### 8. `oauth_connect`

```js
{
  surfaceType: 'oauth_connect',
  data: {
    providerKey: 'github',
    displayName: 'GitHub',
    description: 'Connect GitHub to push commits and open PRs',
    logoUrl: '...'
  }
}
```

### Farnsworth-specific

#### `file_change`

```js
{
  surfaceType: 'file_change',
  data: {
    title: 'Edited 3 files',
    items: [
      { path: 'src/app.js', additions: 218, deletions: 129, status: 'modified' },
      { path: 'new.js', additions: 40, deletions: 0, status: 'created' },
      { path: 'old.js', additions: 0, deletions: 50, status: 'deleted' },
    ],
    expandOnClick: true  // clicking shows inline diff
  }
}
```

#### `live_preview`

```js
{
  surfaceType: 'live_preview',
  data: {
    url: 'http://localhost:5174/?view=desktop',
    title: 'MBA Basketball — desktop preview',
    width: 720,
    height: 460,
    refreshable: true
  }
}
```

#### `test_status`

```js
{
  surfaceType: 'test_status',
  data: {
    summary: '47 passed, 2 failed, 1 skipped',
    duration: '12.4s',
    items: [
      { name: 'auth.test.js', status: 'passed', duration: '1.2s' },
      { name: 'tasks.test.js', status: 'failed', duration: '0.8s', error: 'expected undefined, got null' },
    ]
  }
}
```

#### `memory_recall`

```js
{
  surfaceType: 'memory_recall',
  data: {
    query: 'cursor loss after delete',
    hits: [
      { kind: 'concept', slug: 'farnsworth-electron-app', lead: '...', score: 0.82 },
      { kind: 'code', path: 'src/app.js', chunk: '...onDidChangeModelContent...', score: 0.71 },
    ]
  }
}
```

## Implementation phases

| Phase | What | Estimate | Status |
|---|---|---|---|
| 1 | Add `ui_show` tool registration + parser in `sendChatMessage` | 1-2 hr | pending |
| 2 | Build surface renderer module (8 templates + 4 Farnsworth-specific) | 3-4 hr | pending |
| 3 | Wire interaction callbacks (synthetic-turn + direct-action) | 2-3 hr | pending |
| 4 | Streaming updates via `surfaceId` for `task_progress` + `work_result` | 1-2 hr | pending |
| 5 | Chat history persistence for surfaces | 1-2 hr | pending |
| 6 | Farnsworth-specific surfaces (file_change, live_preview, test_status, memory_recall) | 2-3 hr | pending |
| 7 | Wire 2-3 surfaces into actual assistant responses (smoke tests) | 1 hr | pending |

**Total: ~12-18 hours** end-to-end.

## Open design questions (defer until v1 ships)

1. **Should surfaces persist to chat history?** My take: yes (so the user can scroll back and see what the assistant did). But this is more complex (need to serialize surface state to DB).
2. **Can users disable certain surfaces?** (e.g. an "incognito mode" that suppresses inline previews.) My take: yes, add a chat setting later.
3. **Should surfaces have a "compact" mode for narrow chat panels?** My take: yes, but defer to v2.

## Source of truth

- Renderer entry: `src/surfaces/index.js`
- Parser hook: `sendChatMessage()` in `src/app.js` (~line 5970)
- Tool registration: `getAgentTools()` in main.js (need to add `ui_show`)
- IPC: existing `executeTool` channel for surface emission; new `chat:emitSurface` for server-side surfaces (rare)
- CSS: `src/styles.css` — surface styles section
- Persistence: `db.js` `chat_messages` table — extend `messages` to include `surfaces` array