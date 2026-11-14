#!/bin/bash
# Builds /Applications/backerUpper.app, a launcher you can open from Spotlight.
# Opening it starts the backerUpper server in the background if it isn't running,
# then opens the page in your browser. Rerun this script if Node or the project moves.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-/Applications/backerUpper.app}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "ERROR: node is not on PATH. Run this from a shell where node works." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE")"

if [[ -e "$APP" && ! -f "$APP/Contents/Resources/backerupper-launcher" ]]; then
  echo "ERROR: $APP exists and wasn't made by this script. Remove it yourself first." >&2
  exit 1
fi

TMP_APP="$(mktemp -d)/backerUpper.app"
mkdir -p "$TMP_APP/Contents/MacOS" "$TMP_APP/Contents/Resources"
touch "$TMP_APP/Contents/Resources/backerupper-launcher"

cat > "$TMP_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>backerUpper</string>
  <key>CFBundleDisplayName</key><string>backerUpper</string>
  <key>CFBundleIdentifier</key><string>local.tedshaffer.backerupper</string>
  <key>CFBundleExecutable</key><string>backerUpper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Paths are fixed when the app is built, because apps opened from Finder or Spotlight
# don't get your shell's PATH (so nvm's node isn't visible to them).
cat > "$TMP_APP/Contents/MacOS/backerUpper" <<LAUNCHER
#!/bin/bash
PROJECT_DIR="$PROJECT_DIR"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PORT="\${BACKERUPPER_PORT:-4199}"
URL="http://127.0.0.1:\$PORT"
LOG="\$HOME/Library/Logs/backerUpper.log"

running() { curl -s -o /dev/null --max-time 2 "\$URL/api/state"; }

if ! running; then
  cd "\$PROJECT_DIR" || exit 1
  {
    echo "=== Starting \$(date)"
    ./node_modules/.bin/vite build --logLevel warn
  } >>"\$LOG" 2>&1
  # The server outlives this launcher, so closing the browser tab doesn't stop a backup.
  nohup ./node_modules/.bin/tsx src/server/index.ts >>"\$LOG" 2>&1 </dev/null &
  disown
  for _ in \$(seq 1 60); do running && break; sleep 0.5; done
fi

if running; then
  [[ -n "\${BACKERUPPER_NO_OPEN:-}" ]] || open "\$URL"
else
  osascript -e 'display alert "backerUpper could not start" message "See ~/Library/Logs/backerUpper.log for details."'
  exit 1
fi
LAUNCHER
chmod +x "$TMP_APP/Contents/MacOS/backerUpper"

# An ad-hoc signature gives macOS a stable identity for its privacy permissions.
codesign --force --sign - "$TMP_APP" >/dev/null 2>&1 || true

rm -rf "$APP"
mv "$TMP_APP" "$APP"
mdimport "$APP" 2>/dev/null || true
echo "Installed $APP"
