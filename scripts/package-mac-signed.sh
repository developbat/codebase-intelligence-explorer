#!/bin/sh
set -e

# Build a Developer ID signed macOS release.
#
# The project lives on an ExFAT volume where extended attributes are stored as
# AppleDouble (._*) files. codesign writes extended attributes, so signing must
# happen on an APFS volume, otherwise every signature creates a ._ companion
# that osx-sign then tries to sign and fails with "Operation not permitted".
OUT="${TMPDIR:-/tmp}/bad-ide-signed-release"

# Notarize only when credentials are present.
NOTARIZE=false
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  NOTARIZE=true
elif [ -n "$APPLE_API_KEY" ] && [ -n "$APPLE_API_KEY_ID" ] && [ -n "$APPLE_API_ISSUER" ]; then
  NOTARIZE=true
fi

rm -rf "$OUT"
npm run build
npm run build:server
npm run build:electron
npm run clean:appledouble

npx electron-builder --mac dmg zip \
  -c.directories.output="$OUT" \
  -c.mac.notarize="$NOTARIZE" \
  --publish never

APP=$(find "$OUT" -maxdepth 2 -name "*.app" -type d | head -n 1)
if [ -n "$APP" ]; then
  echo "Verifying signature: $APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign --display --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier" || true
  if [ "$NOTARIZE" = "true" ]; then
    spctl --assess --type execute --verbose=2 "$APP" || true
  fi
fi

mkdir -p release
cp "$OUT"/*.dmg "$OUT"/*.zip "$OUT"/*.blockmap "$OUT"/latest-mac.yml release/ 2>/dev/null || true
echo "Signed artifacts copied to release/"
