#!/usr/bin/env bash
# build-and-run.sh — Build and launch the WMSInputRunner XCTest command loop.
#
# Usage:
#   ./build-and-run.sh [simulator-name]
#
# Arguments:
#   simulator-name   Name of the iOS Simulator to target (default: "iPhone 17")
#
# The script builds the test bundle (cached after first run), then starts the
# persistent testCommandLoop via xcodebuild test-without-building.
#
# stdin/stdout protocol:
#   Send JSON commands to stdin (one per line).
#   Read JSON responses from stdout (one per line).
#   The runner signals readiness with: {"ready":true}
#
# Example (interactive):
#   ./build-and-run.sh
#   # Wait for {"ready":true}
#   # Then type commands:
#   {"cmd":"ping"}        → {"ok":true}
#   {"cmd":"tap","x":0.5,"y":0.5}  → {"ok":true}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/WMSInputRunner"
PROJECT="${PROJECT_DIR}/WMSInputRunner.xcodeproj"
SCHEME="WMSInputRunner"
SIM_NAME="${1:-iPhone 17}"
CONFIGURATION="Debug"

# ── Validate that the project exists ─────────────────────────────────────────
if [[ ! -d "$PROJECT" ]]; then
    echo "ERROR: Xcode project not found at: $PROJECT" >&2
    exit 1
fi

# ── Step 1: Build for testing (idempotent — xcodebuild skips unchanged files) ─
echo "[build-and-run] Building for testing (scheme: $SCHEME, simulator: $SIM_NAME)…" >&2

xcodebuild build-for-testing \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,name=${SIM_NAME}" \
    -configuration "$CONFIGURATION" \
    -quiet

echo "[build-and-run] Build complete. Starting test runner…" >&2
echo "[build-and-run] Waiting for {\"ready\":true} on stdout before sending commands." >&2

# ── Step 2: Run the persistent command loop ───────────────────────────────────
# -only-testing limits execution to our single persistent test method.
# stdin is inherited from the caller so Node.js (or a terminal) can pipe in commands.
# stdout is inherited so JSON responses flow back to the caller.
#
# NOTE: xcodebuild wraps its own output around the test runner's stdout.
# Use the -resultBundlePath option + parse xcresult for production use.
# For this POC, responses from the runner appear inline with xcodebuild logs.
# The runner uses "READY" and JSON response lines that can be identified by
# their {"…"} shape.

exec xcodebuild test-without-building \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,name=${SIM_NAME}" \
    -configuration "$CONFIGURATION" \
    -only-testing:"WMSInputRunnerUITests/WMSInputRunnerUITests/testCommandLoop"
