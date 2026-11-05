#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
"$PROJECT_DIR/android/gradlew" -p android testDebugUnitTest lintDebug assembleDebug "$@"
mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/nexora-logistics.apk
# A v4 signature belongs to one exact APK; never leave a signature from an older build.
rm -f dist/nexora-logistics.apk.idsig
if [ -f android/app/build/outputs/apk/debug/app-debug.apk.idsig ]; then
  cp android/app/build/outputs/apk/debug/app-debug.apk.idsig dist/nexora-logistics.apk.idsig
fi
echo 'Debug APK: dist/nexora-logistics.apk (for testing, not Play upload)'
