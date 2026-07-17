#!/bin/bash
# sign-and-notarize.sh — sign the Farnsworth bundle with Developer ID Application
# + submit for Apple notarization + staple the ticket.
#
# Usage:
#   ./sign-and-notarize.sh                       # sign + notarize /Applications/Farnsworth.app
#   ./sign-and-notarize.sh /path/to/MyApp.app    # sign + notarize a different bundle
#   ./sign-and-notarize.sh --sign-only           # sign but skip notarize (e.g. local dev)
#
# Required Keychain entries:
#   service: notarytool-farnsworth  account: notarytool
#     (app-specific password from appleid.apple.com, label it "notarytool")
#
# After running, verify with:
#   spctl --assess --type execute --verbose /Applications/Farnsworth.app
#   xcrun stapler validate /Applications/Farnsworth.app

set -euo pipefail

# Config
TEAM_ID="66RHAVPZ4J"
APPLE_ID="1988.dolong@gmail.com"
KEYCHAIN_SERVICE="notarytool-farnsworth"
KEYCHAIN_ACCOUNT="notarytool"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/entitlements-electron.plist"

# Args
SIGN_ONLY=false
BUNDLE="/Applications/Farnsworth.app"
while [ $# -gt 0 ]; do
  case "$1" in
    --sign-only) SIGN_ONLY=true; shift ;;
    *)           BUNDLE="$1"; shift ;;
  esac
done

if [ ! -d "$BUNDLE" ]; then
  echo "ERROR: bundle not found: $BUNDLE" >&2
  exit 1
fi

# 1. Identify the signing identity
echo "Looking up Developer ID Application identity (team $TEAM_ID)..."
IDENTITY=$(security find-identity -p codesigning -v | grep "Developer ID Application: Long Do (${TEAM_ID})" | head -1 | awk -F'"' '{print $2}')
if [ -z "$IDENTITY" ]; then
  echo "ERROR: Developer ID Application identity not found in login Keychain" >&2
  echo "Expected: 'Developer ID Application: Long Do (${TEAM_ID})'" >&2
  echo "Run: security find-identity -p codesigning -v" >&2
  exit 1
fi
echo "  → $IDENTITY"

# 2. Sign with hardened runtime + entitlements
echo "Signing $BUNDLE..."
codesign --force --deep \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$BUNDLE"

echo "Verifying signature..."
codesign --verify --verbose=2 "$BUNDLE"

if [ "$SIGN_ONLY" = true ]; then
  echo ""
  echo "Signed (sign-only mode — skipping notarize). To notarize later:"
  echo "  ./sign-and-notarize.sh"
  exit 0
fi

# 3. Get app-specific password for notarytool from Keychain
echo ""
echo "Looking up app-specific password (Keychain service '$KEYCHAIN_SERVICE')..."
APP_PWD=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || true)
if [ -z "$APP_PWD" ]; then
  echo "ERROR: app-specific password not in Keychain (service: $KEYCHAIN_SERVICE, account: $KEYCHAIN_ACCOUNT)" >&2
  echo "" >&2
  echo "To set up:" >&2
  echo "  1. Go to https://appleid.apple.com → Sign-In and Security → App-Specific Passwords" >&2
  echo "  2. Generate one labeled 'notarytool'" >&2
  echo "  3. Save to Keychain:" >&2
  echo "     security add-generic-password -s '$KEYCHAIN_SERVICE' -a '$KEYCHAIN_ACCOUNT' -w '<password>'" >&2
  exit 1
fi

# 4. Submit for notarization (wait for completion)
echo ""
echo "Submitting for notarization (this can take 1-5 minutes)..."
SUBMISSION_OUTPUT=$(xcrun notarytool submit "$BUNDLE" \
  --apple-id "$APPLE_ID" \
  --password "$APP_PWD" \
  --team-id "$TEAM_ID" \
  --wait 2>&1)
echo "$SUBMISSION_OUTPUT"

# Extract submission ID for reference
SUBMISSION_ID=$(echo "$SUBMISSION_OUTPUT" | grep -oE 'submission [a-f0-9-]{36}' | head -1 || echo "")
if [ -n "$SUBMISSION_ID" ]; then
  echo ""
  echo "Submission ID: $SUBMISSION_ID"
  echo "Track at: https://developer.apple.com/account/notary-tool/submission/$SUBMISSION_ID"
fi

# 5. Staple the notarization ticket
echo ""
echo "Stapling notarization ticket..."
xcrun stapler staple "$BUNDLE"

# 6. Final verification
echo ""
echo "Final verification (Gatekeeper)..."
spctl --assess --type execute --verbose "$BUNDLE" || echo "(spctl may reject — but stapler validate will confirm)"

echo ""
echo "Final verification (stapler)..."
xcrun stapler validate "$BUNDLE"

echo ""
echo "✅ $BUNDLE is signed + notarized + stapled."