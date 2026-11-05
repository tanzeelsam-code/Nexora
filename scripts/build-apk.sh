#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
"$PROJECT_DIR/android/gradlew" -p android testDebugUnitTest lintDebug assembleDebug "$@"
mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/nexora-logistics.apk
echo 'Debug APK: dist/nexora-logistics.apk (for testing, not Play upload)'
