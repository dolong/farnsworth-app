# NOW

## Latest (Jul 11 ~21:25 ET): docs/ folder + tests wiki
- New `docs/` folder: `docs/tests.md` (full wiki on the test system) + `docs/README.md` (index).
- DEVVIT-TESTS.md rewritten to match farnsworth-test.py reality (it had drifted: label/frame/waitAfter/xpath/screenshot-name never existed in the runner; if/while/extract/setVar/increment/llm-step DO exist and were missing from the doc).
- play-and-screenshot-lobby.json repaired to the real dialect; verified 6/6 pass against live game.

## Current focus
**Chat agent → Test View wiring shipped (Jul 11 ~18:50 - ~19:55 ET).** Long asked the chat agent to be able to navigate to Test View and create tests from natural-language requests. Built end-to-end and verified via CDP: chat message "create a test called play-and-screenshot-lobby..." → agent calls open_testview + test_save → file on disk (843 bytes, valid JSON with real Devvit selectors `.splash-stage`, `.bnav-play`, `iframe#game`).

**What shipped:**
- `~/Documents/Farnsworth/app/DEVVIT-TESTS.md` (~9.2KB) — spec doc the agent reads via `read_file` before creating tests
- 5 new tools in AGENT_TOOLS: `open_testview`, `test_list`, `test_read`, `test_save`, `test_run`
- New `canvas:setPreview` IPC + `canvasSetPreview` / `onCanvasSetPreview` bridges + renderer-side handler (mirrors size-toggle click logic)
- Full system prompt in chat agent (references DEVVIT-TESTS.md + describes the 5 test tools + when to use them)
- Root cause fix at `src/app.js` line ~8194: sanitize `tool_use` blocks before pushing to history — strip the streaming handler's renderer-side accumulator fields (`inputJson`, `caller`) that the API rejects as "Extra inputs not permitted"

**Earlier today (Jul 11):**
- Test View + 3 sample tests listed + run/reset flows — Jul 11 14:39-14:55 ET
- Post View iframe bug — fixed via hideAllCanvasViews/showAllCanvasViews — Jul 11 15:00-15:50 ET
- WebContentsView orphan bug — fixed via canvas:removeAllViews IPC — Jul 11 ~16:30 ET
- Test View inline editor (deprecated standalone NLP test creator modal) — Jul 11 ~16:42-16:55 ET
- **Chat agent → Test View wiring (this turn) — Jul 11 ~18:50-19:55 ET**

## Files touched today (Jul 11)
- `~/Documents/Farnsworth/app/main.js` — test:read + test:delete IPCs; canvas:removeAllViews IPC; canvas:setPreview IPC; 5 new AGENT_TOOLS entries; 5 executeAgentTool handlers; (debug logging removed)
- `~/Documents/Farnsworth/app/preload.js` — testRead + testDelete + canvasRemoveAllViews + canvasSetPreview + onCanvasSetPreview bridges
- `~/Documents/Farnsworth/app/src/app.js` — renderTestView() + helpers + new editor functions; onCanvasSetPreview listener in init(); sanitized tool_use blocks before pushing to history (~line 8194); system prompt with test tools reference in sendChatMessage
- `~/Documents/Farnsworth/app/DEVVIT-TESTS.md` — NEW (~9.2KB spec doc)
- `~/Documents/Farnsworth/app/index.html` — removed standalone test creator modal + Tests button from canvas overlay bar
- `~/Documents/Farnsworth/app/src/styles.css` — new editor section CSS + --accent + --danger button styles

## Verified end-to-end (Jul 11 ~19:55 ET)
- Tools: 10 total (5 new + 5 existing) confirmed via getAgentTools()
- IPC: canvasSetPreview('testview') switches canvas to Test View
- IPC: open_testview tool handler returns ok + switches preview
- IPC: testList returns 3 tests from per-project folder
- Chat agent end-to-end: "Create a test called play-and-screenshot-lobby..." → agent used open_testview + test_save → file written in 2s (843 bytes, valid JSON with `.splash-stage`, `.bnav-play`, `iframe#game`)

## Radar
1. **Devvit emulator Phase 2 (Tier 2 Reddit completion)** — mod actions, modmail, wiki, widgets, vault, leaderboard. ~8 hrs.
2. **Anomalyint R2 key rotation** — URGENT security debt. Old Cloudflare R2 keys still active from Feb 4 commit `8bdf246`. Dashboard-only revocation.
3. **Canvas automation suite beyond the seed** — Test View + inline editor + chat agent wiring done; remaining: more sample tests, full E2E with Devvit emulator Phase 2 (matchmaking-queue persistence gap).
4. **NLP test creator cleanup** — remove the now-unused setTestCreatorStatus/setTestCreatorButtonsEnabled functions and their DOM lookups; the test creator modal HTML is gone but the helper functions still reference it.

## Key rule (load-bearing)
**Never use bare `sudo` from host_bash.** macOS sudo from non-TTY shells pops a GUI prompt that wedges the Vellum macOS daemon's bash pipe until dismissed. Two safe paths: (1) `SUDO_ASKPASS=~/.config/nono/sudo-askpass.sh sudo -A` when Long is at keyboard; (2) credential vault entry `mac-mini:sudo_password` for unattended. Use (2) by default.