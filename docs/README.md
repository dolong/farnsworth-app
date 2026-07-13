# Farnsworth documentation

Wiki-style docs for the Farnsworth IDE. One page per system.

**Published site:** https://farnsworth-docs.vercel.app — built from `~/Documents/farnsworth-docs/` (VitePress). The testing content there is the site-split version of [tests.md](tests.md); keep both in sync when the test system changes.

## Pages

| Page | What it covers |
|---|---|
| [tests.md](tests.md) | How tests work: the JSON test system, Test View, the CDP runner, chat agent authoring, format reference, best practices, internals |
| [ipc-surface.md](ipc-surface.md) | Full inventory of the 121 renderer→main IPC methods exposed on `window.farnsworth`, organized by category. Auto-generated 1:1 from `preload.js` — keep in sync when methods are added. |

## Related docs at the app root

These predate this folder and stay where they are because code and the chat agent reference them by path:

| File | What it covers |
|---|---|
| `../DEVVIT-TESTS.md` | Agent-facing test format quick reference (the chat agent reads this before authoring tests) |
| `../FARNSWORTH-MENU-BAR.md` | Native macOS menu bar + command palette |
| `../MEMORY-TIER1.md` | SQLite memory system, Tier 1 |
| `../NONO-INTEGRATION.md` | nono isolation profile for the Claude Code panel |
| `../BULLETPROOF-TCC.md` | macOS TCC handling patterns |

New documentation pages go in this folder.
