#!/usr/bin/env bash
# =============================================================================
# scripts/install-ios-runtime.sh
# Web Mobile Simulator — iOS Simulator Runtime Installer
#
# Downloads and installs iOS Simulator runtimes on a macOS host.
#
# Usage:
#   ./scripts/install-ios-runtime.sh [--help]
#   ./scripts/install-ios-runtime.sh                     # List available runtimes
#   ./scripts/install-ios-runtime.sh "iOS 18.2"          # Install specific version
#   ./scripts/install-ios-runtime.sh latest              # Install the latest runtime
#
# Examples:
#   ./scripts/install-ios-runtime.sh
#       → Lists all available iOS runtimes (installed and downloadable)
#
#   ./scripts/install-ios-runtime.sh "iOS 18.2"
#       → Downloads and installs the iOS 18.2 Simulator runtime
#
#   ./scripts/install-ios-runtime.sh latest
#       → Finds and installs the newest available iOS runtime
#
# Requirements:
#   - macOS with Xcode Command Line Tools installed
#   - xcrun (provided by Xcode CLI tools)
#   - xcodebuild (provided by Xcode.app or CLI tools)
#   - Sufficient disk space (~5–10 GB per runtime)
#
# Notes:
#   - Runtime downloads are several GB — ensure a stable internet connection
#   - Already-installed runtimes are skipped automatically (idempotent)
#   - Some runtimes may require full Xcode.app (not just CLI tools)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers — colour output
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { printf "${CYAN}ℹ️  %s${RESET}\n" "$*"; }
success() { printf "${GREEN}✅ %s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}⚠️  %s${RESET}\n" "$*"; }
error()   { printf "${RED}❌ %s${RESET}\n" "$*" >&2; }
header()  { printf "\n${BOLD}${CYAN}══════════════════════════════════════════════════${RESET}\n${BOLD}  %s${RESET}\n${BOLD}${CYAN}══════════════════════════════════════════════════${RESET}\n" "$*"; }
step()    { printf "\n${BOLD}▶  %s${RESET}\n" "$*"; }

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,/^# ===.*$/p' "$0" | head -n -1 | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---------------------------------------------------------------------------
# macOS guard
# ---------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  error "This script requires macOS. iOS Simulators are only supported on macOS."
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify xcrun is available
# ---------------------------------------------------------------------------
if ! command -v xcrun &>/dev/null; then
  error "xcrun not found. Install Xcode Command Line Tools first:"
  error "  xcode-select --install"
  error "  Or run: ./scripts/setup-host.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# List installed runtimes (helper)
# ---------------------------------------------------------------------------
list_installed_runtimes() {
  local json
  json="$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')"
  python3 -c "
import sys, json
data = json.load(sys.stdin)
runtimes = data.get('runtimes', [])
if not runtimes:
    print('  (none)')
else:
    for r in sorted(runtimes, key=lambda x: x.get('version', ''), reverse=True):
        avail = '✅ installed' if r.get('isAvailable', False) else '⚠️  unavailable'
        name = r.get('name', 'Unknown')
        ident = r.get('identifier', '')
        build = r.get('buildversion', '')
        print(f'  {avail}  {name}  [{ident}]  build={build}')
" <<< "$json" 2>/dev/null || echo "  (could not parse runtime list)"
}

# ---------------------------------------------------------------------------
# List available (downloadable) runtimes
# ---------------------------------------------------------------------------
list_available_runtimes() {
  # xcrun simctl runtime list shows available runtimes (requires Xcode 14+)
  # Falls back to xcodebuild output if simctl runtime subcommand is unavailable
  if xcrun simctl runtime list &>/dev/null 2>&1; then
    xcrun simctl runtime list 2>/dev/null
  else
    # Fallback: try xcrun simctl list runtimes which shows installed ones
    warn "xcrun simctl runtime list is not available on this version of Xcode."
    warn "Showing currently installed runtimes only."
    xcrun simctl list runtimes 2>/dev/null || echo "(none)"
  fi
}

# ---------------------------------------------------------------------------
# Get the identifier for the latest available iOS runtime
# ---------------------------------------------------------------------------
get_latest_ios_runtime_name() {
  # Parse installed runtimes sorted by version, return highest iOS version name
  python3 -c "
import sys, json, re
data = json.load(sys.stdin)
ios_runtimes = [
    r for r in data.get('runtimes', [])
    if 'iOS' in r.get('name', '') or 'com.apple.CoreSimulator.SimRuntime.iOS' in r.get('identifier', '')
]
if ios_runtimes:
    # Sort by version string descending
    def version_key(r):
        v = r.get('version', '0.0')
        parts = re.findall(r'\d+', v)
        return tuple(int(p) for p in parts)
    latest = sorted(ios_runtimes, key=version_key, reverse=True)[0]
    print(latest.get('name', ''))
" <<< "$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Check if a runtime is already installed
# ---------------------------------------------------------------------------
is_runtime_installed() {
  local search_version="$1"   # e.g. "18.2" or "iOS 18.2"
  local version_num
  # Normalise: strip "iOS " prefix if present
  version_num="${search_version#iOS }"
  version_num="${version_num#ios }"

  python3 -c "
import sys, json
data = json.load(sys.stdin)
version_search = '${version_num}'
for r in data.get('runtimes', []):
    v = r.get('version', '')
    name = r.get('name', '')
    # Match if version string contains search or name contains search
    if version_search in v or version_search in name:
        if r.get('isAvailable', False):
            print('installed')
            sys.exit(0)
        else:
            print('unavailable')
            sys.exit(0)
print('not_found')
" <<< "$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')" 2>/dev/null || echo "not_found"
}

# ---------------------------------------------------------------------------
# Install a runtime using xcodebuild or xcrun simctl runtime add
# ---------------------------------------------------------------------------
install_runtime_by_name() {
  local target_version="$1"   # e.g. "iOS 18.2" or "18.2"
  local version_num
  version_num="${target_version#iOS }"
  version_num="${target_version#ios }"

  # Normalise to "iOS X.Y" format
  local ios_version_label
  if [[ "$target_version" == iOS* || "$target_version" == ios* ]]; then
    ios_version_label="iOS ${version_num}"
  else
    ios_version_label="iOS $target_version"
  fi

  info "Target runtime: $ios_version_label"

  # Try xcrun simctl runtime add (Xcode 14+ with downloadable runtimes)
  # This is the most reliable method when available
  step "Attempting install via: xcrun simctl runtime add \"$ios_version_label\""
  info "This will download several GB — please be patient..."

  if xcrun simctl runtime add "$ios_version_label" 2>/dev/null; then
    success "Runtime '$ios_version_label' installed via xcrun simctl runtime add"
    return 0
  fi

  # Fallback: xcodebuild -downloadPlatform iOS (downloads the recommended runtime)
  warn "xcrun simctl runtime add failed or is unsupported. Trying xcodebuild..."
  step "Attempting install via: xcodebuild -downloadPlatform iOS"
  info "Note: xcodebuild installs the recommended iOS runtime, not necessarily $ios_version_label"

  if command -v xcodebuild &>/dev/null; then
    if xcodebuild -downloadPlatform iOS; then
      success "iOS runtime downloaded via xcodebuild"
      return 0
    else
      warn "xcodebuild download failed or was cancelled"
    fi
  else
    warn "xcodebuild not found (full Xcode.app may be required for this step)"
  fi

  # Fallback: guide user to Xcode GUI
  warn "Automatic installation was not successful."
  warn "Please install the runtime manually via one of these methods:"
  warn ""
  warn "  Option A — Xcode GUI:"
  warn "    1. Open Xcode"
  warn "    2. Go to Xcode → Settings → Platforms"
  warn "    3. Find '$ios_version_label' and click the download icon"
  warn ""
  warn "  Option B — Command line (Xcode 14+):"
  warn "    xcrun simctl runtime add '$ios_version_label'"
  warn ""
  return 1
}

# ===========================================================================
# Main logic
# ===========================================================================
VERSION_ARG="${1:-}"

if [[ -z "$VERSION_ARG" ]]; then
  # ── No argument: list mode ────────────────────────────────────────────────
  header "iOS Simulator Runtimes"

  step "Installed runtimes:"
  list_installed_runtimes

  printf "\n"
  step "Available runtimes (downloadable):"
  list_available_runtimes

  printf "\n"
  info "To install a runtime, run:"
  info "  $0 \"iOS 18.2\""
  info "  $0 latest"
  exit 0
fi

# ── Install mode ─────────────────────────────────────────────────────────────
header "iOS Simulator Runtime Installer"

if [[ "$VERSION_ARG" == "latest" ]]; then
  step "Determining the latest available iOS runtime..."

  # Try to find the latest from currently known runtimes
  LATEST_KNOWN="$(get_latest_ios_runtime_name)"

  if [[ -n "$LATEST_KNOWN" ]]; then
    info "Latest installed runtime: $LATEST_KNOWN"
    RUNTIME_STATUS="$(is_runtime_installed "$LATEST_KNOWN")"
    if [[ "$RUNTIME_STATUS" == "installed" ]]; then
      success "Runtime '$LATEST_KNOWN' is already installed and available."
      step "Current runtimes:"
      list_installed_runtimes
      exit 0
    fi
  fi

  # Try xcrun simctl runtime list to get available (not yet installed) runtimes
  step "Checking available runtimes from Apple..."
  if xcrun simctl runtime list -j &>/dev/null 2>&1; then
    LATEST_AVAILABLE="$(python3 -c "
import sys, json, re
try:
    data = json.load(sys.stdin)
    # runtime list returns a dict of versions
    ios_versions = []
    if isinstance(data, dict):
        for k, v in data.items():
            if 'iOS' in k or 'ios' in k.lower():
                ios_versions.append(k)
    if ios_versions:
        def ver_key(s):
            nums = re.findall(r'\d+', s)
            return tuple(int(n) for n in nums)
        latest = sorted(ios_versions, key=ver_key, reverse=True)[0]
        print(latest)
except Exception:
    pass
" <<< "$(xcrun simctl runtime list -j 2>/dev/null || echo '{}')" 2>/dev/null || echo "")"

    if [[ -n "$LATEST_AVAILABLE" ]]; then
      VERSION_ARG="$LATEST_AVAILABLE"
      info "Latest available runtime: $VERSION_ARG"
    else
      warn "Could not determine the latest runtime automatically."
      warn "Defaulting to downloading the recommended runtime via xcodebuild."
      VERSION_ARG="latest-xcodebuild"
    fi
  else
    warn "xcrun simctl runtime list not available — using xcodebuild fallback."
    VERSION_ARG="latest-xcodebuild"
  fi
fi

# Handle the xcodebuild-only fallback
if [[ "$VERSION_ARG" == "latest-xcodebuild" ]]; then
  step "Downloading latest iOS runtime via xcodebuild -downloadPlatform iOS..."
  if command -v xcodebuild &>/dev/null; then
    xcodebuild -downloadPlatform iOS
    success "iOS runtime download initiated via xcodebuild."
    step "Current runtimes after download:"
    list_installed_runtimes
  else
    error "xcodebuild not found. Install Xcode from the App Store or the Xcode CLI tools."
    exit 1
  fi
  exit 0
fi

# Normalise version argument
TARGET_VERSION="$VERSION_ARG"
# Strip leading "iOS " if given, then re-add for consistency
TARGET_NUM="${TARGET_VERSION#iOS }"
TARGET_NUM="${TARGET_NUM#ios }"
TARGET_VERSION="iOS $TARGET_NUM"

step "Checking if '$TARGET_VERSION' is already installed..."
RUNTIME_STATUS="$(is_runtime_installed "$TARGET_NUM")"

case "$RUNTIME_STATUS" in
  installed)
    success "Runtime '$TARGET_VERSION' is already installed and available."
    step "Current runtimes:"
    list_installed_runtimes
    exit 0
    ;;
  unavailable)
    warn "Runtime '$TARGET_VERSION' is present but marked as unavailable."
    info "Attempting to repair/reinstall..."
    ;;
  not_found)
    info "Runtime '$TARGET_VERSION' is not installed. Starting download..."
    ;;
esac

# Perform installation
if install_runtime_by_name "$TARGET_VERSION"; then
  # Verify installation
  step "Verifying installation..."
  sleep 2  # Give simctl a moment to register the new runtime

  VERIFY_STATUS="$(is_runtime_installed "$TARGET_NUM")"
  if [[ "$VERIFY_STATUS" == "installed" ]]; then
    success "Runtime '$TARGET_VERSION' is now installed and available!"
  else
    warn "Runtime download may still be in progress or require Xcode restart."
    warn "Verify with: xcrun simctl list runtimes"
  fi
else
  error "Failed to install runtime '$TARGET_VERSION'."
  error "See the output above for troubleshooting steps."
  exit 1
fi

step "Current installed runtimes:"
list_installed_runtimes

printf "\n"
success "Done. You can now create simulators with: xcrun simctl create MyDevice 'iPhone 16' '$TARGET_VERSION'"
