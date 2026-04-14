#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Compile the IndigoHID POC binary
#
# The binary uses dlopen/dlsym at runtime to load CoreSimulator and
# SimulatorKit, so we don't need -framework flags for those private
# frameworks.  Only Foundation + AppKit are needed at link time for
# NSRunningApplication, NSClassFromString, etc.
#
# Requirements:
#   • Xcode installed (full Xcode.app, not just Command Line Tools)
#   • swiftc on PATH (via `xcode-select -p` → full Xcode)
#   • macOS 13+ / arm64 or x86_64
#
# Usage:
#   cd poc/indigo-hid
#   ./build.sh
#   ./wms-indigo-poc --discover
#   ./wms-indigo-poc <UDID> tap 0.5 0.5
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/wms-indigo-poc.swift"
BINARY="${SCRIPT_DIR}/wms-indigo-poc"

echo "──────────────────────────────────────────────────────────"
echo "  Building WMS IndigoHID POC"
echo "──────────────────────────────────────────────────────────"
echo "  Source : ${SOURCE}"
echo "  Output : ${BINARY}"
echo ""

# Remove stale binary
if [[ -f "${BINARY}" ]]; then
    echo "🗑  Removing stale binary…"
    rm -f "${BINARY}"
fi

# Compile
echo "🔨 Compiling…"
swiftc "${SOURCE}" \
    -o "${BINARY}" \
    -framework Foundation \
    -framework AppKit \
    -framework CoreGraphics \
    -O \
    -whole-module-optimization 2>&1

echo ""
echo "✅ Build succeeded: ${BINARY}"
echo ""
echo "Usage:"
echo "  ${BINARY} --discover"
echo "  ${BINARY} <UDID> tap <normX> <normY>"
