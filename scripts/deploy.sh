#!/usr/bin/env bash
# 코드를 변경할 때마다 .app 을 재빌드하고 /Applications 에 갱신한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶ .app 빌드 중…"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64

SRC="$ROOT/dist/mac-arm64/Termix.app"
DEST="/Applications/Termix.app"

echo "▶ 실행 중인 앱 종료…"
pkill -f "$DEST" 2>/dev/null || true
sleep 1

echo "▶ /Applications 갱신…"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "✅ 갱신 완료: $DEST ($(date '+%Y-%m-%d %H:%M:%S'))"
