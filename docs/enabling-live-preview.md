# Farnsworth project integration architecture

This guide belongs to Farnsworth, not to any project template. It explains how Farnsworth runs, previews, and emulates a project, and how to adapt a greenfield or inherited Devvit repository without depending on `vibe-farnsworth-template` or a project-local `FARNSWORTH.md`.

## Ownership model

### Farnsworth owns
- The IDE shell and canvas controls.
- The Reddit-style outer shell used by Post View.
- The preview route vocabulary: `?view=post`, `?view=mobile`, and `?view=desktop`.
- Starting `npm run farnsworth:<appType>` through Go Live.
- Dependency preflight and child-process environment setup.
- Port allocation for projects that declare `package.json.farnsworth.ports`.
- Preview metadata discovery and validation against the active repository.
- The persistent Devvit Redis and Reddit emulators.
- The emulator-backed server-runner binary.
- The selected emulator user and subreddit.
- Test View, screenshots, recordings, and canvas automation.

### The project owns
- `.farnsworth/config.json`, including `appType` and optional project chrome metadata.
- The `farnsworth:<appType>` package script and launcher.
- The local Vite preview harness and its `?view=` router.
- Which real client component is rendered in each preview route.
- The development-only `@devvit/web/client` shim.
- Project-specific API proxy routes.
- The correct server entrypoint when the project has server code.
- Publishing preview metadata containing the actual URL, PID, and exact `repoRoot`, plus server metadata when applicable.

### Devvit production owns
- `devvit.json` or `devvit.shared.json`.
- Production entrypoints and built assets.
- Reddit's hosted runtime, real auth, and production data.

Farnsworth local preview is additive. Do not rewrite production configuration merely to make the local canvas work.

## Runtime path

1. Farnsworth opens an arbitrary repository. It does not assume the repository came from a particular template.
2. `.farnsworth/config.json` identifies `appType`.
3. Go Live finds `package.json` script `farnsworth:<appType>`.
4. Farnsworth allocates declared ports, finds npm, installs missing dependencies when needed, and injects Farnsworth-owned runtime values.
5. For Devvit, Farnsworth injects:
   - `FARNSWORTH_DEVVIT_RUNNER`: the installed or source-tree server-runner path.
   - `DEVVIT_EMULATOR_CONFIG`: the selected user/subreddit and emulator library snapshot.
   - `DEVVIT_EMULATOR_STATE`: the persistent emulator state file.
   - `VITE_DEVVIT_EMULATOR_CONFIG_JSON`: the same selected identity for the browser-side shim.
   - `FARNSWORTH_PORT_<ROLE>` for each declared port role.
6. The project launcher starts its Vite harness and, if required, `FARNSWORTH_DEVVIT_RUNNER` against the project's server entry.
7. The launcher writes `~/.cache/farnsworth-<appType>.json` with the real preview URL, PID, exact repository root, and optional server PID, URL, and log.
8. Farnsworth validates that metadata belongs to the open repository.
9. The canvas loads the published URL with `?view=post`, `?view=mobile`, or `?view=desktop`.

The metadata URL is authoritative. Never assume the preview is always on port 5174 or the backend is always on port 3000.

## Canvas contract

| Surface | Project URL | Render shape |
|---|---|---|
| Post | `/?view=post` | DOM iframe inside Farnsworth's Reddit shell |
| Mobile | `/?view=mobile` | Electron WebContentsView |
| Desktop | `/?view=desktop` | Electron WebContentsView |
| Fullscreen | `/?view=desktop` | Electron WebContentsView |
| Test View | `/?view=mobile` | Electron WebContentsView beside the test runner |

The project chooses the components. Post commonly renders an inline/splash creative. Mobile and Desktop commonly render the expanded app. A project may render one root component everywhere if its shim reports the correct webview mode.

Post View is not routed by `devvit.json`, and Farnsworth does not load `dist/client` directly. Production files are references for intended behavior, not the local router.

### Production parity is required

The harness routes the preview. It must not own the application. Every surface must render a component imported from the project's real production entrypoints, and game code belongs under `src/`, not under the harness directory.

A harness that defines its own copy of a surface will drift, and the drift is silent: the preview looks finished while `devvit.json` still builds `dist/client` from untouched template files, so the deployed post shows the stock template. Preview correctness is not shipment evidence.

Two rules keep the two in sync:

- If making the preview correct required no edit under `src/`, nothing has shipped.
- Verify by building. After `npm run build`, a string unique to the app must appear in `dist/client`. If it does not, Reddit will not render it.

## Devvit identity and emulator contract

Farnsworth already has a persistent Redis and Reddit emulator. The selected identity is not a query parameter and not project-local browser state.

A browser shim must derive `context.username` and `context.subredditName` from `VITE_DEVVIT_EMULATOR_CONFIG_JSON`. Server code receives the same selection through `DEVVIT_EMULATOR_CONFIG`.

Use `switch_devvit_user` to change identity. Never create:
- `?as=` or another identity URL parameter.
- A client-side user picker that bypasses Farnsworth.
- A localStorage identity override.
- A second fixed development identity.

Those mechanisms split browser identity from server and emulator identity.

## Server contract

The Vite harness serves the browser client. It does not replace project server code.

If the client calls tRPC, Hono, Redis-backed APIs, `@devvit/web/server`, `@devvit/redis`, or `@devvit/public-api`, the launcher must also start Farnsworth's emulator-backed server-runner. Use the path supplied in `FARNSWORTH_DEVVIT_RUNNER`; never hardcode a source checkout such as `~/Documents/Farnsworth/app/...`, because installed Farnsworth keeps the runner inside the application bundle.

Inspect `src/server` and choose the entry that actually starts the project's HTTP app. Set `DEVVIT_EMULATOR_SERVER_ENTRY` when the default `src/server/index.ts` is not correct. Bind the server to the allocated server port and point the Vite proxy at that same port.

Record `serverPid`, `serverUrl`, and `serverLog` in preview metadata. This lets Farnsworth stop the process and lets `devvit_emulator_status` diagnose it.

Do not stack the old emulator loader hook with `tsx`. Server code should run through `server-runner.mjs`, which bundles the server against Farnsworth's emulator implementations.

A local `/api/trpc` 502, 503, 504, `ECONNREFUSED`, failed save, or missing server-derived identity means runtime health first. Call `devvit_emulator_status`. If the server is unavailable, inspect `serverLogTail` and repair or restart the launcher before inventing a client fallback.

## Port contract

New or adapted projects should opt into Farnsworth port allocation:

```json
{
  "farnsworth": {
    "ports": {
      "vite": { "default": 5174, "rangeStart": 5174, "rangeEnd": 5199 },
      "server": { "default": 3000, "rangeStart": 3000, "rangeEnd": 3099 }
    }
  }
}
```

Farnsworth passes the results as `FARNSWORTH_PORT_VITE` and `FARNSWORTH_PORT_SERVER`. The launcher and Vite config must bind those exact values with strict-port behavior. Legacy projects without the manifest keep their existing hardcoded behavior, but they can collide across projects and instances.

## Adapting a greenfield or inherited repository

1. Inspect first:
   - `package.json` and scripts.
   - `.farnsworth/config.json`, if any.
   - client entrypoints and every `@devvit/web/client` import.
   - server entries and API routes.
   - existing Vite configs, local launchers, and environment loading.
2. Decide which case you are in, because the entrypoint rule differs.
   - **Inherited and already working:** preserve production behavior. Add a separate development harness rather than rewriting working production entrypoints.
   - **Greenfield, or a template being built out:** the harness is where the app is authored, so the production entrypoints are the deliverable. Build features in the components that `splash.tsx`, `game.tsx`, or their equivalents actually render, and let the harness import those entrypoints. Never let the harness accumulate a private implementation of a surface.

   In both cases the harness routes and never re-implements. See "Production parity is required".
3. Add `.farnsworth/config.json` with the correct `appType` and project-specific Post/Live chrome where relevant.
4. Add the `farnsworth:<appType>` script and launcher.
5. Add a Vite harness whose router handles Post, Mobile, and Desktop.
6. Add a development-only Devvit client shim matching the symbols this project imports and reading Farnsworth's injected identity.
7. If server code exists, wire `FARNSWORTH_DEVVIT_RUNNER`, select the correct server entry, share the allocated port with the proxy, and publish server metadata.
8. Test the direct preview URLs before debugging Farnsworth's outer shell.
9. Use `devvit_emulator_status` for backend health and identity truth.
10. Verify Post, Mobile, Desktop, and Test View in Farnsworth.

Do not copy a template blindly. Adapt component imports, shim exports, server entry, proxies, ports, environment loading, and metadata to the repository in front of you.

## Diagnostic order

1. No `farnsworth:<appType>` script: the project is not integrated. Follow this guide.
2. Go Live script fails: report the exact command output and fix the launcher or dependency issue.
3. Direct preview URL fails: fix the project harness, imports, shim, CSS, or runtime exception.
4. Direct preview works but canvas is stale: reload or reopen the workspace, then retest.
5. Wrong project appears: inspect metadata `repoRoot`, URL, PID, and port collision.
6. Local API is 5xx or refused: call `devvit_emulator_status`, inspect the server log, and restore the server-runner.
7. Production Reddit is broken too: only then investigate production entrypoints and `devvit.json`.

This order assumes the preview is failing. It does not apply when the preview looks correct and only the deployed post is wrong. That is the parity failure above: check first whether the harness renders the real entrypoints and whether `dist/client` contains the app's own code.

## Project-local documentation

A project may have `FARNSWORTH.md`, but it is optional and may be stale. Use it only for repository-specific choices such as component mapping, unusual API routes, or server entrypoints. Farnsworth's own guide and live runtime tools are authoritative for IDE architecture.
