#!/usr/bin/env bash
#
# fetch-bundled-binaries.sh — populate Resources/bin with the `claude` and
# `nono` CLIs for the CURRENT platform, so packaged artifacts are complete.
#
# Why this exists
# ---------------
# Resources/bin is gitignored (claude alone is ~226 MB, well over GitHub's
# 100 MB file limit), so it exists only on machines that put it there by hand.
# On a CI runner the directory is absent, electron-builder logs a single
# forgettable `file source doesn't exist` line, and then happily packages an
# artifact WITHOUT the binaries. Every CI-published Windows and Linux build
# through v0.1.26 shipped that way.
#
# Platform-correctness is the whole point
# ---------------------------------------
# The Mac mini's Resources/bin holds arm64 Mach-O binaries. Copying those into
# a Windows or Linux artifact would ship ~242 MB of dead weight that can never
# execute. So each platform fetches its own build:
#
#   macOS   — claude + nono, both available (darwin-arm64 / darwin-x64)
#   Linux   — claude + nono, both available (linux-x64 / linux-arm64)
#   Windows — NEITHER is available as a native binary. Anthropic's installer
#             refuses outright ("Windows is not supported by this script") and
#             nono publishes no Windows asset. main.js findClaudePath() already
#             falls back to `where claude.cmd` + %APPDATA%\npm, which is the
#             supported Windows path (npm i -g @anthropic-ai/claude-code).
#             nono-based sandboxing is simply unavailable on Windows upstream.
#
# Idempotent: an existing binary is left alone, so running this on Long's Mac
# never clobbers the local 0.66.0 nono or the pinned claude.
#
# Usage: scripts/fetch-bundled-binaries.sh [--force]

set -euo pipefail

NONO_VERSION="${NONO_VERSION:-0.71.0}"
CLAUDE_BASE="https://downloads.claude.ai/claude-code-releases"
NONO_BASE="https://github.com/nolabs-ai/nono/releases/download/v${NONO_VERSION}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/Resources/bin"
mkdir -p "$BIN_DIR"

note() { echo "[bundled-binaries] $*"; }

# GitHub Actions annotations when present; plain echo otherwise.
warn() {
  echo "[bundled-binaries] WARNING: $*" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- :warning: $*" >> "$GITHUB_STEP_SUMMARY"
  fi
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::warning title=Bundled binaries::$*"
  fi
}

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ---------------------------------------------------------------- platform
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) OS=windows ;;
  *) warn "unrecognised OS $(uname -s); skipping"; exit 0 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64;   RUST_ARCH=x86_64 ;;
  arm64|aarch64) ARCH=arm64; RUST_ARCH=aarch64 ;;
  *) warn "unrecognised arch $(uname -m); skipping"; exit 0 ;;
esac

note "platform: $OS-$ARCH"

if [ "$OS" = "windows" ]; then
  warn "Windows has no upstream native build of either \`claude\` or \`nono\`. This artifact ships without them; Claude Code on Windows installs via \`npm i -g @anthropic-ai/claude-code\` and is found by the existing PATH fallback. nono sandboxing is unavailable on Windows."
  summary "- :information_source: **Windows**: \`claude\` / \`nono\` intentionally not bundled (no upstream native builds)."
  exit 0
fi

# ------------------------------------------------------------------ claude
if [ -x "$BIN_DIR/claude" ] && [ "$FORCE" -eq 0 ]; then
  note "claude already present, leaving it alone"
else
  CLAUDE_PLATFORM="${OS}-${ARCH}"
  # musl detection matches Anthropic's own installer.
  if [ "$OS" = "linux" ]; then
    if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] \
       || ldd /bin/ls 2>&1 | grep -q musl; then
      CLAUDE_PLATFORM="linux-${ARCH}-musl"
    fi
  fi

  CLAUDE_VERSION="$(curl -fsSL "$CLAUDE_BASE/latest")"
  if ! echo "$CLAUDE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'; then
    warn "could not resolve a Claude Code version (got: $(echo "$CLAUDE_VERSION" | head -c 60)); skipping claude"
    CLAUDE_VERSION=""
  fi

  if [ -n "$CLAUDE_VERSION" ]; then
    note "claude $CLAUDE_VERSION ($CLAUDE_PLATFORM)"
    MANIFEST="$(curl -fsSL "$CLAUDE_BASE/$CLAUDE_VERSION/manifest.json")"
    # Pull the checksum for our platform without depending on jq.
    EXPECTED="$(printf '%s' "$MANIFEST" | tr -d '\n\r\t' \
      | grep -o "\"$CLAUDE_PLATFORM\"[^}]*}" \
      | grep -oE '"checksum"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' \
      | grep -oE '[a-f0-9]{64}' | head -1)"

    if [ -z "$EXPECTED" ]; then
      warn "platform $CLAUDE_PLATFORM absent from the Claude Code manifest; skipping claude"
    else
      curl -fsSL -o "$BIN_DIR/claude.tmp" "$CLAUDE_BASE/$CLAUDE_VERSION/$CLAUDE_PLATFORM/claude"
      ACTUAL="$(sha256_of "$BIN_DIR/claude.tmp")"
      if [ "$ACTUAL" != "$EXPECTED" ]; then
        rm -f "$BIN_DIR/claude.tmp"
        echo "[bundled-binaries] FATAL: claude checksum mismatch" >&2
        echo "  expected $EXPECTED" >&2
        echo "  actual   $ACTUAL" >&2
        exit 1
      fi
      chmod 0755 "$BIN_DIR/claude.tmp"
      mv -f "$BIN_DIR/claude.tmp" "$BIN_DIR/claude"
      note "claude verified + installed"
      summary "- \`claude\` $CLAUDE_VERSION ($CLAUDE_PLATFORM), sha256 verified"
    fi
  fi
fi

# -------------------------------------------------------------------- nono
if [ -x "$BIN_DIR/nono" ] && [ "$FORCE" -eq 0 ]; then
  note "nono already present, leaving it alone"
else
  case "$OS" in
    darwin) NONO_TARGET="${RUST_ARCH}-apple-darwin" ;;
    linux)  NONO_TARGET="${RUST_ARCH}-unknown-linux-gnu" ;;
  esac
  TARBALL="nono-v${NONO_VERSION}-${NONO_TARGET}.tar.gz"
  note "nono $NONO_VERSION ($NONO_TARGET)"

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  if ! curl -fsSL -o "$TMP/$TARBALL" "$NONO_BASE/$TARBALL"; then
    warn "could not download $TARBALL; skipping nono"
  else
    # SHA256SUMS.txt covers every asset in the release.
    if curl -fsSL -o "$TMP/SHA256SUMS.txt" "$NONO_BASE/SHA256SUMS.txt"; then
      EXPECTED="$(grep " \*\?$TARBALL\$" "$TMP/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
      ACTUAL="$(sha256_of "$TMP/$TARBALL")"
      if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "[bundled-binaries] FATAL: nono checksum mismatch" >&2
        echo "  expected $EXPECTED" >&2
        echo "  actual   $ACTUAL" >&2
        exit 1
      fi
      [ -z "$EXPECTED" ] && warn "no SHA256SUMS entry for $TARBALL (continuing unverified)"
    else
      warn "could not fetch nono SHA256SUMS.txt (continuing unverified)"
    fi

    tar -xzf "$TMP/$TARBALL" -C "$TMP"
    FOUND="$(find "$TMP" -type f -name nono -perm -u+x 2>/dev/null | head -1)"
    [ -z "$FOUND" ] && FOUND="$(find "$TMP" -type f -name nono | head -1)"
    if [ -z "$FOUND" ]; then
      warn "no \`nono\` executable inside $TARBALL; skipping"
    else
      # 0755, never 0555. A mode-555 file in the bundle breaks Squirrel.Mac
      # auto-update: it must strip the quarantine xattr from every file and
      # removexattr() needs write permission. This exact bug (Resources/bin/nono
      # shipped 555) silently killed every macOS update install once already.
      chmod 0755 "$FOUND"
      mv -f "$FOUND" "$BIN_DIR/nono"
      note "nono verified + installed"
      summary "- \`nono\` $NONO_VERSION ($NONO_TARGET), sha256 verified"
    fi
  fi
fi

# ----------------------------------------------------------------- report
note "Resources/bin now contains:"
ls -lh "$BIN_DIR" 2>/dev/null | tail -n +2 | sed 's/^/[bundled-binaries]   /' || true
