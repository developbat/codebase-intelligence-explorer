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
#  1) APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD (+ APPLE_TEAM_ID)
#  2) APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
#  3) APPLE_KEYCHAIN_PROFILE created with `xcrun notarytool store-credentials`
NOTARIZE=false
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  NOTARIZE=true
elif [ -n "$APPLE_API_KEY" ] && [ -n "$APPLE_API_KEY_ID" ] && [ -n "$APPLE_API_ISSUER" ]; then
  NOTARIZE=true
elif [ -n "$APPLE_KEYCHAIN_PROFILE" ]; then
  NOTARIZE=true
fi

# `npm run package:mac` is the sign-only build (no notarization).
if [ "${CIE_NOTARIZE:-}" = "0" ]; then
  NOTARIZE=false
fi

# electron-builder 26 passes the certificate common name to codesign. When the
# login keychain holds two Developer ID certificates with the same name, that is
# ambiguous, so pin the SHA-1 of a valid identity. CI imports a fresh keychain
# from CSC_LINK and does not need this.
IDENTITY_ARGS=""
if [ -z "$CSC_LINK" ]; then
  IDENTITY_HASH=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Developer ID Application:.*(C928N2FQ94)"$/\1/p' \
    | head -n 1)
  if [ -n "$IDENTITY_HASH" ]; then
    IDENTITY_ARGS="-c.mac.identity=$IDENTITY_HASH"
  fi
fi

if [ "$NOTARIZE" = "true" ] && [ -z "$IDENTITY_ARGS" ] && [ -z "$CSC_LINK" ]; then
  echo "Notarization requested but no Developer ID Application identity was found." >&2
  exit 1
fi

npm run fetch:node

rm -rf "$OUT"
npm run build
npm run build:server
npm run build:electron
npm run clean:appledouble

npx electron-builder --mac dmg zip \
  -c.directories.output="$OUT" \
  -c.mac.notarize="$NOTARIZE" \
  $IDENTITY_ARGS \
  --publish never

APP=$(find "$OUT" -maxdepth 2 -name "*.app" -type d | head -n 1)
if [ -n "$APP" ]; then
  echo "Verifying signature: $APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign --display --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier" || true
  if [ "$NOTARIZE" = "true" ]; then
    xcrun stapler validate "$APP" || true
    spctl --assess --type execute --verbose=2 "$APP" || true
  fi
  node scripts/verify-package.mjs "$OUT"
fi

mkdir -p release
cp "$OUT"/*.dmg "$OUT"/*.zip "$OUT"/*.blockmap "$OUT"/latest-mac.yml release/ 2>/dev/null || true
echo "Signed artifacts copied to release/"
