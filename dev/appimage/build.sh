#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT/build/appimage}"

mkdir -p "$OUTPUT_DIR"

echo "Building Arc AppImage..."
docker build \
    -t arc-player-appimage \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$PROJECT_ROOT"

echo "Extracting AppImage..."
docker run --rm \
    -v "$OUTPUT_DIR:/host-output" \
    arc-player-appimage

echo ""
echo "AppImage: $OUTPUT_DIR/Arc-x86_64.AppImage"
