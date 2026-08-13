#!/bin/bash
# release.sh — cut a signed Mac Farnsworth release in ONE command.
#
# Encodes the whole electron-mac-release-pipeline procedure: preflight gates,
# version bump, signed build, asar symbol audit, isolated boot test, tag push,
# asset upload, public verification, cleanup.
#
# The ORDER is load-bearing: the tag is pushed only AFTER the Mac artifacts are
# built and verified. Pushing early lets CI publish a release with no
# latest-mac.yml, which 404s every Mac auto-updater until the upload lands.
#
#   ./scripts/release.sh 0.1.35 "what changed"
#   ./scripts/release.sh --patch "what changed"      # auto-bump 0.1.N -> 0.1.N+1
#   ./scripts/release.sh --patch "..." --resume      # re-run after a failure
#   ./scripts/release.sh --patch "..." --dry-run     # stop before pushing anything
#
# Verbose output goes to the log; stdout is one line per step plus a verdict
# block, so an agent can run this without ingesting a build transcript.

set -uo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

REPO="dolong/farnsworth-app"
KEYCHAIN_ACCT="5479531"
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APPDIR" || exit 1

LOG="/tmp/fw-release-$(date +%Y%m%d-%H%M%S).log"
DRY_RUN=0; RESUME=0; VERSION=""; SUMMARY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --patch)   VERSION="__PATCH__"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --resume)  RESUME=1; shift ;;
    -*)        echo "unknown flag: $1"; exit 2 ;;
    *)         if [ -z "$VERSION" ]; then VERSION="$1"; elif [ -z "$SUMMARY" ]; then SUMMARY="$1"; fi; shift ;;
  esac
done

step=0
say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
ok()   { step=$((step+1)); printf '  [%02d] OK    %s\n' "$step" "$*" | tee -a "$LOG"; }
info() { printf '             %s\n' "$*" | tee -a "$LOG"; }
die()  { printf '\n  FAIL  %s\n  log:  %s\n' "$*" "$LOG" | tee -a "$LOG"; exit 1; }
run()  { echo "+ $*" >> "$LOG"; "$@" >> "$LOG" 2>&1; }

say "=== Farnsworth release ==="
say "log: $LOG"

# ── Gate 0: preflight ────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "not running on Darwin (this must run on the Mac)"
command -v node >/dev/null || die "node not on PATH"
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $APPDIR"
security find-identity -v -p basic 2>/dev/null | grep -q "Developer ID Application" \
  || die "no Developer ID Application signing identity in keychain"
TOKEN=$(security find-internet-password -s "github.com" -a "$KEYCHAIN_ACCT" -w 2>/dev/null)
[ -n "$TOKEN" ] || die "no GitHub token in keychain (service github.com, account $KEYCHAIN_ACCT) — is the keychain locked?"
GHURL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"
ok "preflight: Darwin, git, signing identity, keychain token"

CUR=$(node -p "require('$APPDIR/package.json').version")
if [ "$VERSION" = "__PATCH__" ]; then
  VERSION=$(echo "$CUR" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')
fi
[ -n "$VERSION" ] || die "no version given (pass 0.1.N or --patch)"
[ -n "$SUMMARY" ] || SUMMARY="v$VERSION"
TAG="v$VERSION"
info "current $CUR  ->  releasing $VERSION"

# Uncommitted work is almost always a mistake at release time: it silently
# does NOT ship, and the built artifact won't match the tag.
DIRTY=$(git status --porcelain | grep -v '^?? ' | head -20)
if [ -n "$DIRTY" ]; then
  say ""
  say "  FAIL  tracked files are modified but not committed — they will NOT ship:"
  git status --short | grep -v '^?? ' | sed 's/^/          /'
  say "        commit or stash them, then re-run."
  exit 1
fi
ok "working tree clean (nothing uncommitted would be silently dropped)"

# ── Step 1: clear stale dist ─────────────────────────────────────────────────
find dist -maxdepth 1 -type f \( -name '*Farnsworth*' -o -name '*.yml' -o -name '*.json' \) -delete 2>/dev/null
rm -rf dist/mac dist/mac-arm64 dist/.icon-set dist/builder-* 2>/dev/null
ok "cleared stale dist artifacts"

# ── Step 2: bump + commit + tag (tag NOT pushed yet) ─────────────────────────
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null)
if git rev-parse "$TAG" >/dev/null 2>&1; then
  [ "$RESUME" = "1" ] || die "tag $TAG already exists locally (pass --resume to continue an interrupted release)"
  ok "tag $TAG already exists (resuming)"
  PREV_TAG=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null)
else
  run npm version "$VERSION" --no-git-tag-version || die "npm version failed"
  run git add package.json package-lock.json
  run git commit -m "v$VERSION" || die "commit failed"
  run git tag -a "$TAG" -m "$TAG - $SUMMARY" || die "tag failed"
  ok "bumped to $VERSION, committed, tagged $TAG (not pushed yet)"
fi
info "comparing against previous tag: ${PREV_TAG:-none}"

# ── Step 3: signed build ─────────────────────────────────────────────────────
# On --resume, reuse artifacts that already built and match this version rather
# than burning another 3 minutes rebuilding identical bytes.
SKIP_BUILD=0
if [ "$RESUME" = "1" ] && [ -d "dist/mac-arm64/Farnsworth.app" ]; then
  HAVE_VER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" \
             "dist/mac-arm64/Farnsworth.app/Contents/Info.plist" 2>/dev/null)
  if [ "$HAVE_VER" = "$VERSION" ] && [ -f "dist/latest-mac.yml" ]; then
    SKIP_BUILD=1
    ok "reusing already-built v$VERSION artifacts (--resume)"
  fi
fi

BUILD_START=$(date +%s)
if [ "$SKIP_BUILD" = "1" ]; then
  BUILD_RC=0; BUILD_SECS=0
else
info "building signed Mac artifacts (typically ~2-3 min)..."
npx electron-builder --mac --publish never >> "$LOG" 2>&1
BUILD_RC=$?
BUILD_SECS=$(( $(date +%s) - BUILD_START ))
if [ $BUILD_RC -ne 0 ]; then
  grep -E "⨯|error|failed" "$LOG" | tail -15 | sed 's/^/          /'
  die "electron-builder exited $BUILD_RC after ${BUILD_SECS}s"
fi
[ -d "dist/mac-arm64/Farnsworth.app" ] || die "build finished but dist/mac-arm64/Farnsworth.app is missing"
ok "signed build complete (${BUILD_SECS}s)"

# The x64 leg rewrites native modules in the dev tree; restore arm64 or the
# dev app boots against the wrong ABI afterwards.
run ./node_modules/.bin/electron-rebuild --arch arm64 --only better-sqlite3,keytar,node-pty --force \
  && ok "arm64 native modules restored" \
  || info "WARN electron-rebuild arm64 failed — check log before running the dev tree"
fi

# ── Step 4: asar audit — referenced-but-undefined symbol gate ────────────────
rm -rf /tmp/fw-relasar
run npx asar extract "dist/mac-arm64/Farnsworth.app/Contents/Resources/app.asar" /tmp/fw-relasar \
  || die "asar extract failed"
for f in main.js src/app.js; do
  [ -f "/tmp/fw-relasar/$f" ] || die "packaged asar is missing $f"
done

if [ -n "$PREV_TAG" ]; then
  git show "$PREV_TAG:main.js"   > /tmp/fw-prev-main.js  2>/dev/null
  git show "$PREV_TAG:src/app.js" > /tmp/fw-prev-app.js  2>/dev/null
  AUDIT=$(python3 - <<'PY'
import re, sys
def symbols(src):
    return (set(re.findall(r'^(?:async )?function ([A-Za-z0-9_$]+)', src, re.M))
          | set(re.findall(r'^(?:const|let|var) ([A-Za-z0-9_$]+)', src, re.M)))
bad = []
for prev_path, cur_path, label in (
    ('/tmp/fw-prev-main.js', '/tmp/fw-relasar/main.js', 'main.js'),
    ('/tmp/fw-prev-app.js',  '/tmp/fw-relasar/src/app.js', 'src/app.js')):
    try:
        prev = open(prev_path, encoding='utf-8').read()
        cur  = open(cur_path,  encoding='utf-8').read()
    except OSError:
        continue
    gone = [s for s in sorted(symbols(prev) - symbols(cur))
            if re.search(r'\b' + re.escape(s) + r'\b', cur)]
    if gone:
        bad.append(f"{label}: {', '.join(gone)}")
print('\n'.join(bad) if bad else 'CLEAN')
PY
)
  if [ "$AUDIT" != "CLEAN" ]; then
    echo "$AUDIT" | sed 's/^/          /'
    die "symbol audit: declarations vanished but are still referenced — latent ReferenceError. Release BLOCKED."
  fi
  ok "symbol audit CLEAN (no referenced-but-undefined declarations vs $PREV_TAG)"
else
  info "SKIP symbol audit — no previous tag to diff against"
fi

# ── Step 5: isolated boot test ───────────────────────────────────────────────
# The asar audit proves the right code shipped. It does not prove it runs.
# A clean --user-data-dir also exercises the fresh-install path.
rm -rf /tmp/fw-bootcheck /tmp/fw-bootcheck.log
# Subshell + disown: without it, bash job control prints "Killed: 9" to stdout
# when the pkill below lands, which pollutes the otherwise clean step output.
( nohup "dist/mac-arm64/Farnsworth.app/Contents/MacOS/Farnsworth" \
    --user-data-dir=/tmp/fw-bootcheck --instance=relcheck > /tmp/fw-bootcheck.log 2>&1 & disown ) 2>/dev/null
sleep 22
RENDERERS=$(ps -eo command -ww | grep "dist/mac-arm64" | grep -c -- "--type=renderer")
BOOTERR=$(grep -iE "error|fail" /tmp/fw-bootcheck.log 2>/dev/null \
          | grep -viE "EADDRINUSE|port in use|devtools|sqlite-vec|FTS5|ERR_BLOCKED" | head -5)
pkill -9 -f "dist/mac-arm64/Farnsworth.app" 2>/dev/null
sleep 1
[ "$RENDERERS" -ge 1 ] || { cat /tmp/fw-bootcheck.log | tail -20 | sed 's/^/          /'; die "boot test: no renderer process spawned (blank-window signature)"; }
[ -z "$BOOTERR" ] || { echo "$BOOTERR" | sed 's/^/          /'; die "boot test: errors in packaged app log"; }
BUNDLE_VER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "dist/mac-arm64/Farnsworth.app/Contents/Info.plist" 2>/dev/null)
[ "$BUNDLE_VER" = "$VERSION" ] || die "built bundle reports $BUNDLE_VER, expected $VERSION"
codesign --verify --deep --strict "dist/mac-arm64/Farnsworth.app" >> "$LOG" 2>&1 \
  || die "codesign verification failed on the built bundle"
ok "boot test passed ($RENDERERS renderers, v$BUNDLE_VER, codesign valid)"

# ── Step 6: confirm all 9 assets exist before touching the remote ────────────
cd dist || die "no dist dir"
ASSETS=(
  "Farnsworth-$VERSION-arm64.dmg" "Farnsworth-$VERSION-arm64.dmg.blockmap"
  "Farnsworth-$VERSION.dmg" "Farnsworth-$VERSION.dmg.blockmap"
  "Farnsworth-$VERSION-arm64-mac.zip" "Farnsworth-$VERSION-arm64-mac.zip.blockmap"
  "Farnsworth-$VERSION-mac.zip" "Farnsworth-$VERSION-mac.zip.blockmap"
  "latest-mac.yml"
)
MISSING=""
for f in "${ASSETS[@]}"; do [ -f "$f" ] || MISSING="$MISSING $f"; done
[ -z "$MISSING" ] || die "built artifacts missing:$MISSING"
ok "all 9 Mac assets present on disk"

if [ "$DRY_RUN" = "1" ]; then
  say ""
  say "  DRY RUN — stopping before push. Nothing was sent to GitHub."
  say "  Local state: version $VERSION committed, tag $TAG created (not pushed)."
  say "  To undo:  git tag -d $TAG && git reset --hard HEAD~1"
  exit 0
fi

# ── Step 7: push commit + tag (artifacts are verified, so no updater gap) ────
cd "$APPDIR"
run git -c credential.helper= push "$GHURL" main    || die "push main failed"
run git -c credential.helper= push "$GHURL" "$TAG"  || die "push tag failed"
git -c credential.helper= ls-remote "$GHURL" "refs/tags/$TAG" >> "$LOG" 2>&1
ok "pushed main + $TAG (CI now builds Windows/Linux)"

# ── Step 8: wait for CI to create the release, then upload ───────────────────
info "waiting for CI to create the release (can take ~5-6 min)..."
RID=""
for i in $(seq 1 90); do
  RID=$(curl -s -H "Authorization: Bearer $TOKEN" \
        "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  [ -n "$RID" ] && break
  sleep 10
done
[ -n "$RID" ] || die "CI did not create a release for $TAG within 15 min — check GitHub Actions"
ok "release created by CI (id $RID)"

cd dist || die "no dist dir"
FAILED=""
for f in "${ASSETS[@]}"; do
  CT="application/octet-stream"; case "$f" in *.yml) CT="text/yaml";; esac
  # On a --resume the asset may already exist; replace it so retries are safe.
  EXISTING=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$REPO/releases/$RID/assets?per_page=100" \
    | python3 -c "import sys,json;print(next((str(a['id']) for a in json.load(sys.stdin) if a['name']=='$f'),''))" 2>/dev/null)
  if [ -n "$EXISTING" ]; then
    curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" \
      "https://api.github.com/repos/$REPO/releases/assets/$EXISTING"
  fi
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: $CT" \
    --data-binary "@$f" \
    "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$f")
  echo "upload $f -> $CODE" >> "$LOG"
  [ "$CODE" = "201" ] || FAILED="$FAILED $f($CODE)"
done
[ -z "$FAILED" ] || die "asset upload failed:$FAILED"
ok "all 9 Mac assets uploaded (HTTP 201)"

# ── Step 9: verify what the public actually sees ─────────────────────────────
LATEST_TAG=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/$REPO/releases/latest" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null)
YML_CODE=$(curl -s -L -o /dev/null -w '%{http_code}' \
  "https://github.com/$REPO/releases/download/$TAG/latest-mac.yml")
YML_VER=$(curl -s -L "https://github.com/$REPO/releases/download/$TAG/latest-mac.yml" \
  | grep '^version:' | awk '{print $2}')
[ "$YML_CODE" = "200" ] || die "latest-mac.yml is not publicly served (HTTP $YML_CODE) — Mac updaters would 404"
[ "$YML_VER" = "$VERSION" ] || die "public latest-mac.yml reports version $YML_VER, expected $VERSION"
ok "public latest-mac.yml serves HTTP 200 at version $YML_VER"
[ "$LATEST_TAG" = "$TAG" ] && ok "releases/latest points to $TAG" \
                           || info "NOTE releases/latest is $LATEST_TAG (CI may still be publishing)"

# ── Cleanup ──────────────────────────────────────────────────────────────────
rm -rf /tmp/fw-relasar /tmp/fw-prev-main.js /tmp/fw-prev-app.js /tmp/fw-bootcheck /tmp/fw-bootcheck.log
ok "temp files cleaned"

say ""
say "=== SHIPPED $TAG ==="
say "  version:  $VERSION (was $CUR)"
say "  release:  https://github.com/$REPO/releases/tag/$TAG"
say "  id:       $RID"
say "  assets:   9/9 uploaded, latest-mac.yml public at $YML_VER"
say "  installed app updates via auto-updater; direct swap is a separate step"
say "  log:      $LOG"
