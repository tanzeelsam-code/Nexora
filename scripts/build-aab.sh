#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
# Do not silently publish an unsigned or debug-signed release.
for name in NEXORA_KEYSTORE NEXORA_STORE_PASSWORD NEXORA_KEY_ALIAS NEXORA_KEY_PASSWORD; do
  if [ -z "${!name:-}" ]; then echo "Missing signing setting: $name" >&2; exit 1; fi
done
if [ ! -f "$NEXORA_KEYSTORE" ]; then echo 'Upload keystore was not found.' >&2; exit 1; fi
"$PROJECT_DIR/android/gradlew" -p android testReleaseUnitTest lintRelease bundleRelease "$@"
mkdir -p dist
cp android/app/build/outputs/bundle/release/app-release.aab dist/nexora-logistics-release.aab
echo 'Upload bundle: dist/nexora-logistics-release.aab'
