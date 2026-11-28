#!/usr/bin/env bash
# Build openComposer and install it to /Applications, signed with a stable local identity
# ("openComposer Local Signing" in the login keychain) so macOS remembers keychain and
# local-network approvals across rebuilds instead of asking after every build.
set -euo pipefail
cd "$(dirname "$0")/.."

identity="${APPLE_SIGNING_IDENTITY:-openComposer Local Signing}"
if ! security find-identity -v -p codesigning | grep -q "\"$identity\""; then
  echo "No code-signing identity \"$identity\" in the keychain; see README (Building)." >&2
  exit 1
fi

npm ci --prefix ui --silent
(cd app && APPLE_SIGNING_IDENTITY="$identity" npx -y @tauri-apps/cli@2.12.3 build --bundles app)

# Quit a running copy; don't wait on it if a dialog is holding it up.
pkill -f '/Applications/openComposer.app/Contents/MacOS/openComposer' || true
sleep 1
rm -rf /Applications/openComposer.app
ditto target/release/bundle/macos/openComposer.app /Applications/openComposer.app
codesign --verify --deep --strict /Applications/openComposer.app
codesign -dvv /Applications/openComposer.app 2>&1 | grep -m1 '^Authority' || true
open -a /Applications/openComposer.app
