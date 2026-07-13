# Bulletproof TCC Persistence for Farnsworth

Last updated: Jun 28 ~20:33 ET

## TL;DR

The current ad-hoc-signed setup works (0 prompts in 90s as of this writing) but is **fragile**. Every re-sign, every `npm install` that touches node-pty, and every Electron update risks wiping TCC and bringing the prompts back. The only true bulletproof fix is a paid Apple Developer ID. Without it, every option below is mitigation, not a fix.

---

## Current state (Jun 28 ~20:33 ET)

All four binaries are signed with `Farnsworth Dev (Long)` identity, hardened runtime enabled, and identifier-only codesign requirements:

| Binary | Bundle ID / Identifier | Requirement |
|---|---|---|
| `/Applications/Farnsworth.app/Contents/MacOS/Farnsworth` | `dev.probablynothing.farnsworth` | `host => identifier "com.apple.bash"` |
| `/Users/long/Documents/Farnsworth/app/node_modules/electron/dist/Farnsworth.app` | `dev.probablynothing.farnsworth.electron` | `designated => identifier "dev.probablynothing.farnsworth.electron"` |
| `node_modules/node-pty/build/Release/spawn-helper` | `spawn-helper` | `designated => identifier "spawn-helper"` |
| `node_modules/node-pty/build/Release/pty.node` | `pty.node` | `designated => identifier "pty.node"` |
| `node_modules/node-pty/bin/darwin-arm64-125/node-pty.node` | `node-pty.node` | `designated => identifier "node-pty.node"` |

Entitlements at `~/Documents/Farnsworth/app/entitlements.mac.plist`:
```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.app-sandbox</key><false/>
```

---

## Why the ad-hoc setup is fragile

TCC tracks permissions by **(bundle ID + csreq blob)**. The csreq blob is the codesign requirement embedded in the binary's signature at grant time. For an entry to apply on a later launch, the binary's signature must still satisfy that same csreq.

**The trap**: every re-sign changes the signature (even with the same identity), and macOS can also re-evaluate the cert root hash stored in keychain. For ad-hoc-signed apps with `certificate root = H"..."` requirements, every re-sign OR every keychain change can wipe TCC.

The fix applied tonight drops the cert-root requirement — but only down to identifier-level matching. If anything changes the **identifier** (Info.plist edit, package.json rename, bundle restructure) the csreq won't match either.

**What triggers a wipe**:
- `npm install` that touches `node_modules/electron/` or `node_modules/node-pty/` (re-extracts binaries → new cdhash → new linker-signature)
- Electron version upgrade (renames `Farnsworth.app/Contents/MacOS/Farnsworth`)
- `npm rebuild` on node-pty (rebuilds `spawn-helper` → new cdhash)
- Re-signing any of the four binaries (any reason)
- Touching `~/Library/Keychains/` (changes cert root hash)

---

## Option A: Apple Developer ID (bulletproof, costs $99/year)

**Why it works**: a Developer ID certificate comes from Apple's root CA, so the cert root requirement is anchored to Apple — same hash forever. TCC entries persist across re-signs, node_modules updates, and keychain changes.

**Setup steps**:

1. **Buy a Developer ID** at https://developer.apple.com/account ($99/year USD, recurring). This is a personal/individual account, not the $299/yr org account.
2. **Create a Developer ID Application certificate** in Xcode → Settings → Accounts → select Apple ID → Manage Certificates → + → Developer ID Application. Or via `certreq` CLI.
3. **Export the cert + private key as a `.p12`** for portability (Keychain Access → My Certificates → right-click → Export).
4. **Build the Farnsworth distribution** as a notarized `.dmg` or `.pkg`. Don't run from `/Applications/Farnsworth.app/` against `~/Documents/Farnsworth/app/` — that's a dev setup, not a distributable one. Move the app bundle into the app dir or use the wrapper pattern but with a real signed bundle inside.
5. **Notarize** with `xcrun notarytool submit Farnsworth.dmg --apple-id <id> --password <app-specific-password> --team-id <TEAMID> --wait`.
6. **Staple the notarization ticket** with `xcrun stapler staple Farnsworth.dmg`.
7. **Replace the wrapper at `/Applications/Farnsworth.app`** with the notarized bundle (keep the wrapper script pattern if you want the iris icon + dock name).
8. **Re-sign the inner `node_modules/electron/dist/Farnsworth.app`** with the Developer ID.
9. **Re-sign node-pty's binaries** with the Developer ID.
10. **Delete the ad-hoc TCC entries** so the new identity takes over: `tccutil reset AppleEvents dev.probablynothing.farnsworth.electron` and `tccutil reset SystemPolicyAppData dev.probablynothing.farnsworth.electron` (and one per node-pty binary).
11. **Launch + Allow once per TCC service**. From then on, prompts should never re-fire even after signature changes.

**Cost-benefit**: $99/year is cheap insurance against this exact class of bug. Worth it if Farnsworth is something Long uses daily for the next 12+ months.

---

## Option B: Pre-allow via `tccutil` + direct `TCC.db` write (free, fragile)

This writes TCC entries to `~/Library/Application Support/com.apple.TCC/TCC.db` directly. It works until anything triggers a re-sign.

**Limitations**:
- The user-level TCC.db requires sudo (System Integrity Protection blocks it on `/Library/Application Support/com.apple.TCC/TCC.db`).
- Each csreq must be generated from the actual binary signature (DER-encoded requirement blob).
- Any re-sign invalidates the entry.

**Recipe** (advanced, only attempt if Option A is rejected):

```bash
# 1. Extract the csreq from each binary
codesign -d -r- /Users/long/Documents/Farnsworth/app/node_modules/electron/dist/Farnsworth.app 2>&1 | tail -1 > /tmp/electron_req.txt
# Convert text requirement → DER csreq blob:
# (no built-in tool — use `csreq` from `security-framework`, or python-cryptography)

# 2. Open the user TCC.db (requires sudo)
sudo sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db

# 3. Insert a row per binary per service. Schema:
# service, client, client_type (0=app), auth_value (2=allowed),
# auth_reason (2=user), auth_version (1), csreq (BLOB)

INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq)
VALUES (
  'kTCCServiceSystemPolicyAppData',
  'dev.probablynothing.farnsworth.electron', 0, 2, 2, 1,
  <DER csreq blob from step 1>
);
-- Repeat for kTCCServiceAppleEvents, kTCCServiceScreenCapture, etc.
-- Repeat for each node-pty binary.
```

**Don't recommend** unless Long specifically rejects Option A. The fragility tax is high.

---

## Option C: Avoid triggering TCC entirely (free, requires code changes)

Several Electron behaviors trigger TCC. If we remove them, the prompts stop firing regardless of signing.

**C.1: Stop using `node-pty` for the Claude Code panel**

The Claude Code panel uses `pty.spawn(claudeBin, ...)` which routes through `spawn-helper`. The spawn-helper signature is what caused tonight's flood of prompts.

**Workaround**: spawn claude via `child_process.spawn()` with stdio piped to a manual terminal emulator (e.g., `node-pty` is just a binding — we could write a thin PTY emulator in pure JS using `Socket` pairs). OR use the existing renderer-side terminal (xterm.js) which can drive a non-PTY child process.

**Cost**: loses some terminal fidelity (no `stty` features like signal forwarding for raw mode). The Claude Code CLI mostly doesn't need that — it just reads stdin and writes stdout.

**C.2: Replace `shell.openExternal()` with system `open`**

In `main.js`:
- Line 89: `shell.openExternal(url)` (OAuth callback window handler)
- Line 414: `shell.openExternal(authUrl.toString())` (OAuth start)

Both trigger Apple Events for the default browser, which fires TCC. Replacing with:
```js
const { exec } = require('child_process');
exec(`open "${url}"`, { shell: '/bin/sh' });
```
routes through the system `open` command (Apple-signed) — no TCC attribution to Farnsworth.

**C.3: Disable `app.requestSingleInstanceLock()` if used**

Forces a per-launch Apple Event. Grep main.js to confirm Farnsworth doesn't use it (current grep shows it doesn't — good).

**C.4: Move Farnsworth out of `~/Documents/`**

The dev tree currently lives at `~/Documents/Farnsworth/app/`. This triggers the Documents folder TCC prompt on first launch (memory: that one DOES persist). Moving to `~/Developer/Farnsworth/app/` or `/Applications/Farnsworth.app/Contents/Resources/dev-tree/` avoids the prompt entirely.

**Cost**: breaks the "edit live dev tree, restart, pick up changes" workflow unless the path is parameterized in the launcher script.

---

## Immediate mitigation (if prompt reappears)

If TCC prompts come back (after a re-sign, npm update, etc.), the recovery is:

```bash
# 1. Re-sign with the recipe below
# 2. Restart Farnsworth
# 3. Click Allow once per prompt
# 4. Verify quiet
log show --predicate 'subsystem == "com.apple.TCC"' --last 60s --style compact 2>/dev/null \
  | grep -c 'AUTHREQ_PROMPTING.*farnsworth'
# Expect 0 within 30s of clicking Allow.

# 5. If still firing, the cdhash of a binary changed (npm update touched it).
#    Re-sign that binary again.
codesign -d -r- <binary>  # check current requirement
codesign --force --sign "Farnsworth Dev (Long)" \
  --options=runtime \
  --requirements "=designated => identifier \"<actual-identifier>\"" \
  <binary>
```

### The re-sign recipe (copy-paste)

```bash
ENT="/Users/long/Documents/Farnsworth/app/entitlements.mac.plist"
ELEC="/Users/long/Documents/Farnsworth/app/node_modules/electron/dist/Farnsworth.app"
WRAP="/Applications/Farnsworth.app"
PTY="/Users/long/Documents/Farnsworth/app/node_modules/node-pty/build/Release/spawn-helper"
PTY2="/Users/long/Documents/Farnsworth/app/node_modules/node-pty/build/Release/pty.node"
PTY3="/Users/long/Documents/Farnsworth/app/node_modules/node-pty/bin/darwin-arm64-125/node-pty.node"

# Wrapper (bash script → host requirement)
codesign --force --deep --sign "Farnsworth Dev (Long)" \
  --options=runtime --entitlements "$ENT" \
  --requirements "=host => identifier \"com.apple.bash\"" "$WRAP"

# Real Electron binary (Mach-O → designated identifier)
codesign --force --deep --sign "Farnsworth Dev (Long)" \
  --options=runtime --entitlements "$ENT" \
  --requirements "=designated => identifier \"dev.probablynothing.farnsworth.electron\"" "$ELEC"

# node-pty binaries (each → its own identifier, matching the actual binary id)
codesign --force --sign "Farnsworth Dev (Long)" --options=runtime \
  --requirements "=designated => identifier \"spawn-helper\"" "$PTY"
codesign --force --sign "Farnsworth Dev (Long)" --options=runtime \
  --requirements "=designated => identifier \"pty.node\"" "$PTY2"
codesign --force --sign "Farnsworth Dev (Long)" --options=runtime \
  --requirements "=designated => identifier \"node-pty.node\"" "$PTY3"

# Verify all
codesign --verify --strict "$WRAP" "$ELEC" "$PTY" "$PTY2" "$PTY3"
```

---

## Don't break this

Rules for future Farnsworth changes:

1. **Never `npm install electron` or `npm install @anthropic-ai/claude-code`** without re-running the re-sign recipe. Both can change the underlying binary's cdhash.
2. **Never `npm rebuild node-pty`** without re-running the recipe. Same reason.
3. **Never edit `Info.plist`** CFBundleIdentifier without re-signing.
4. **Never delete `~/Library/Application Support/com.apple.TCC/TCC.db`**. This wipes all TCC entries for every app on the Mac.
5. **Never `touch` the keychain** (`/Users/long/Library/Keychains/login.keychain-db`). For ad-hoc identities, the cert root hash is tied to the keychain.
6. **After any Electron version bump**, run the recipe even if you didn't touch anything else — Electron renames files inside its bundle on extraction.

If you MUST do any of the above, expect TCC prompts to come back. Have the recipe ready.

---

## Recommended path

1. **Short term (now)**: ship the current setup as-is. Don't touch it. TCC is quiet.
2. **Medium term (when Long decides)**: Option A — buy the Developer ID. The $99/year pays for itself the first time a TCC prompt blocks Long from working.
3. **Long term**: combine A + C — Developer ID for TCC, plus replace `shell.openExternal` with system `open` to drop the AppleEvents trigger entirely, plus consider moving the dev tree out of Documents.

---

## Debugging commands

```bash
# What's currently prompting?
log show --predicate 'subsystem == "com.apple.TCC"' --last 5m --style compact \
  | grep -E "AUTHREQ_PROMPTING" | grep -i farnsworth

# What's the attribution chain for the most recent prompt?
log show --predicate 'subsystem == "com.apple.TCC"' --last 5m --style compact \
  | grep -E "AUTHREQ_ATTRIBUTION" | grep -i farnsworth | tail -1

# What services are tracked for Farnsworth?
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "SELECT service, client, auth_value FROM access WHERE client LIKE '%farnsworth%' ORDER BY last_modified DESC;"
# (Requires sudo or Terminal Full Disk Access — the db is locked otherwise.)

# What's the current requirement on each binary?
for f in /Applications/Farnsworth.app \
  ~/Documents/Farnsworth/app/node_modules/electron/dist/Farnsworth.app \
  ~/Documents/Farnsworth/app/node_modules/node-pty/build/Release/spawn-helper \
  ~/Documents/Farnsworth/app/node_modules/node-pty/build/Release/pty.node \
  ~/Documents/Farnsworth/app/node_modules/node-pty/bin/darwin-arm64-125/node-pty.node; do
  echo "=== $f ==="
  codesign -d -r- "$f" 2>&1 | tail -1
done
```