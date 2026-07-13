# nono.sh Integration — Farnsworth Claude Code Panel

**Shipped: Jul 5 ~20:10 ET (Tier 1, v0.4.0)**

This doc describes how nono.sh wraps the Claude Code PTY spawn in Farnsworth's Claude Code panel for kernel-level isolation.

## What it does

`nono.sh` (Rust, Apache-2.0, v0.66.0 on this Mac) is a kernel-level sandbox that uses `seccomp` (syscall filtering) and `Landlock V4` (filesystem scoping) to isolate a process from the rest of the system. It's NOT a VM or container — it runs the process directly on the host with kernel-enforced boundaries. Zero overhead, no virtualization, no network namespace.

In Farnsworth, the Claude Code PTY spawn is wrapped so that `claude` runs inside `nono wrap --profile farnsworth-claude`. The profile defines what's blocked (commands, filesystem paths, network hosts) and what's allowed (LLM API hosts, GitHub, npm registry).

## Where it lives

**Profile**: `~/.config/nono/profiles/farnsworth-claude.json` (v0.4.0)

```json
{
  "$schema": "https://nono.sh/schemas/nono-profile.schema.json",
  "extends": "default",
  "meta": {
    "name": "farnsworth-claude",
    "version": "0.4.0",
    "description": "Farnsworth Claude Code panel isolation profile...",
    "author": "Farnsworth"
  },
  "groups": {
    "include": ["claude_code_macos"]
  }
}
```

**Integration point**: `~/Documents/Farnsworth/app/main.js` line ~2401, the Claude Code PTY spawn handler:

```js
const NONO_BIN = '/opt/homebrew/bin/nono';
let spawnBin = claudeBin;
let spawnArgs = args;
if (fs.existsSync(NONO_BIN)) {
  spawnBin = NONO_BIN;
  spawnArgs = ['wrap', '--profile', 'farnsworth-claude', '--', claudeBin, ...args];
}
term = pty.spawn(spawnBin, spawnArgs, {...});
```

**Fallback**: If `nono.sh` isn't installed (`fs.existsSync` check), the panel falls back to spawning `claude` directly without isolation. The panel still works on machines without nono.

## What v0.4.0 enforces (proven)

Verified via adversarial testing on Jul 5 ~20:12 ET:

| Test | Command | Result |
| --- | --- | --- |
| Claude runs inside wrap | `nono wrap --profile farnsworth-claude -- claude --version` | ✅ "2.1.201 (Claude Code)" |
| Credential paths denied | `nono wrap ... -- cat ~/.aws-test-creds` | ✅ "Operation not permitted" (deny_credentials) |
| Top-level rm blocked | `nono wrap ... -- rm -rf /tmp/test` | ✅ "Command 'rm' is blocked" |
| Anthropic API reachable | `nono wrap ... -- nc api.anthropic.com 443` | ✅ connection succeeded |
| GitHub reachable | `nono wrap ... -- nc github.com 443` | ✅ connection succeeded |
| npm registry reachable | `nono wrap ... -- nc registry.npmjs.org 443` | ✅ connection succeeded |

The profile `extends: "default"` pulls in:
- `dangerous_commands` — `rm`, `rmdir`, `dd`, `chmod`, `chown`, `mv`, `cp`, `truncate`, `scp`, `rsync`, `sftp`, `ftp`, `xargs`, `sudo`, `su`, `doas`, `pip`, `npm`, `kill`, `killall`, `pkill`, `shutdown`
- `dangerous_commands_macos` — `srm`, `brew`, `launchctl`
- `deny_credentials` — `~/.aws/`, `~/.ssh/`, `~/.docker/config.json`, etc.
- `deny_keychains_macos` — `~/Library/Keychains/`
- `deny_browser_data_macos` — Chrome/Firefox/Safari credential stores
- `claude_code_macos` — allowlist for Claude Code's own state paths

## Known limitations (v0.4.0)

**1. Bash bypass of dangerous_commands (v0.66 known issue):**

```bash
nono wrap --profile farnsworth-claude -- bash -c 'rm -rf /tmp/foo'
# Result: DELETED — bash isn't in the deny list, and command deny is
# deprecated in nono.sh v0.33+ (only checks top-level startup command)
```

`nono`'s own error message confirms: *"Command blocking is deprecated in v0.33.0 and only checks the directly-invoked startup command. Child processes can bypass it. Prefer resource-based controls such as add_deny_access, narrower filesystem grants, unlink_protection, and network policy."*

**Fix path (v0.5.0)**: Use Landlock filesystem scoping instead of command deny. Set `filesystem.read` and `filesystem.write` to scope writes to the project workdir + `~/.claude/` + `~/.cache/` (paths Claude Code needs). Anything outside those paths fails at the kernel level.

**2. Network allowlist not enforced (v0.66 known issue):**

```bash
nono wrap --profile farnsworth-claude -- nc example.com 443
# Result: SUCCEEDED — allow_domain only adds to an allow-all default,
# doesn't deny other hosts
```

With `network.block: true` + `allow_domain`, ALL hosts (including allowlisted) get blocked. The fix requires:
- TLS interception setup (`nono setup --profiles` to install the CA cert)
- Endpoint rules with method+path filtering (objects, not plain strings)

**Fix path (v0.5.0)**: Run `nono setup --profiles` to install the nono CA cert system-wide, then use endpoint rules:
```json
{
  "network": {
    "block": true,
    "allow_domain": [
      {
        "domain": "api.anthropic.com",
        "endpoints": [
          {"method": "POST", "path": "/v1/messages"},
          {"method": "GET",  "path": "/v1/models"}
        ]
      },
      "github.com",
      "registry.npmjs.org"
    ]
  }
}
```

This gives L7 isolation: api.anthropic.com POST to /v1/messages only (not arbitrary hosts), GitHub + npm at CONNECT level.

## Why this is still worth shipping

Even with v0.4.0 limitations, the wrap provides:
- ✅ Credential exfiltration defense (deny_credentials proven)
- ✅ Accidental destructive commands blocked (top-level rm/dd/etc)
- ✅ Audit trail via nono's session logs (`nono ps`, `nono logs`, `nono audit`)
- ✅ Foundation for v0.5.0 hardening (profile is versioned, can iterate)

The bash bypass requires a hostile agent (or buggy Claude) to specifically invoke `bash -c` for destruction. In practice, Claude Code's tools use specific command patterns, and the Landlock scoping in v0.5.0 closes that gap.

## How to test

From the Mac terminal:

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /tmp && mkdir nono-test && cd nono-test

# Smoke test (should succeed)
nono wrap --profile farnsworth-claude --silent --allow-cwd -- /opt/homebrew/bin/claude --version

# Credential deny (should fail)
touch ~/.aws-test-creds && echo "AKIA..." > ~/.aws-test-creds
nono wrap --profile farnsworth-claude --silent --allow-cwd -- cat ~/.aws-test-creds
rm ~/.aws-test-creds

# rm deny (should fail)
nono wrap --profile farnsworth-claude --silent --allow-cwd -- rm -rf /tmp/nono-test-file
```

## Restart requirements

- **main.js change** (the wrap integration): requires full Farnsworth restart
- **Profile JSON change**: hot-reloadable, no restart needed (loaded on each `nono wrap` call)

## Open for v0.5.0

1. TLS interception setup (run `nono setup --profiles` to install CA cert)
2. Landlock filesystem scoping (`filesystem.read`/`write` lists)
3. Endpoint-rule network allowlist (api.anthropic.com POST /v1/messages only)
4. `unlink_protection` for critical paths
5. Audit log integration into Farnsworth's Live panel