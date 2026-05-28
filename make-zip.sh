#!/usr/bin/env bash
# Creates a clean distributable zip of the project.
# Excludes: node_modules, snapshots, reports, debug, and your personal config/data.

OUT="blueflag-threat-dashboard.zip"
cd "$(dirname "$0")"

rm -f "$OUT"

zip -r "$OUT" . \
  --exclude "*.zip" \
  --exclude ".DS_Store" \
  --exclude "__MACOSX" \
  --exclude "node_modules/*" \
  --exclude "snapshots/*" \
  --exclude "reports/*" \
  --exclude "debug/*" \
  --exclude "config.json" \
  --exclude "intel.json" \
  --exclude "notes.json" \
  --exclude "*.prev.json"

echo ""
echo "  ✓ Created: $OUT ($(du -sh "$OUT" | cut -f1))"
echo "  → Share this file. Peers unzip and run ./setup.sh"
echo ""
