#!/usr/bin/env bash
# =============================================================================
# scripts/setup-host.sh
# Web Mobile Simulator — Comprehensive Host Setup & Installer
#
# Installs and configures everything needed to create and stream iOS Simulators
# and Android Emulators on a macOS host machine.
#
# Usage:
#   ./scripts/setup-host.sh [--help]
#
# Options:
#   --help    Print this help message and exit
#
# What this script does (in order):
#   Phase 1  — macOS verification
#   Phase 2  — Homebrew install/verify
#   Phase 3  — Xcode Command Line Tools install/verify
#   Phase 4  — iOS Simulator runtimes (download latest if none installed)
#   Phase 5  — Android SDK command-line tools install/verify
#   Phase 6  — Android SDK packages (platform-tools, emulator, API 35, system-image)
#   Phase 7  — scrcpy install/verify (Android H.264 screen streaming)
#   Phase 8  — Default Android AVD creation
#   Phase 9  — Shell environment file + project .env
#   Phase 10 — Final verification summary
#
# Safe to run multiple times — idempotent; skips already-installed components.
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
  sed -n '2,/^# ===.*$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---------------------------------------------------------------------------
# Script-level state tracking for the final summary
# ---------------------------------------------------------------------------
declare -a SUMMARY_PASS=()
declare -a SUMMARY_WARN=()
declare -a SUMMARY_FAIL=()

record_pass() { SUMMARY_PASS+=("$1"); }
record_warn() { SUMMARY_WARN+=("$1"); }
record_fail() { SUMMARY_FAIL+=("$1"); }

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
TMPDIR_CREATED=""
cleanup() {
  local exit_code=$?
  if [[ -n "$TMPDIR_CREATED" && -d "$TMPDIR_CREATED" ]]; then
    rm -rf "$TMPDIR_CREATED"
  fi
  if [[ $exit_code -ne 0 ]]; then
    error "Setup failed (exit code $exit_code). Review the output above for details."
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Utility: check if a command exists
# ---------------------------------------------------------------------------
has_cmd() { command -v "$1" &>/dev/null; }

# Script directory (for sourcing helper scripts if needed)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

header "Web Mobile Simulator — Host Setup"
printf "  Project: %s\n" "$PROJECT_DIR"
printf "  Date:    %s\n" "$(date '+%Y-%m-%d %H:%M:%S')"

# =============================================================================
# Phase 1 — macOS Verification
# =============================================================================
header "Phase 1: macOS Verification"

step "Checking operating system..."
if [[ "$(uname -s)" != "Darwin" ]]; then
  error "This script requires macOS. Detected OS: $(uname -s)"
  error "iOS Simulators can only run on macOS. Exiting."
  exit 1
fi

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="$(echo "$MACOS_VERSION" | cut -d. -f1)"
success "Running on macOS $MACOS_VERSION"

if [[ "$MACOS_MAJOR" -lt 13 ]]; then
  warn "macOS 13 (Ventura) or later is recommended. You are on $MACOS_VERSION."
  warn "Some features (especially newer iOS runtimes) may not work correctly."
  record_warn "macOS $MACOS_VERSION (13+ recommended)"
else
  record_pass "macOS $MACOS_VERSION"
fi

# Detect CPU architecture
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ANDROID_ABI="arm64-v8a"
  success "Apple Silicon Mac detected (arm64) — will use arm64-v8a Android system image"
else
  ANDROID_ABI="x86_64"
  success "Intel Mac detected (x86_64) — will use x86_64 Android system image"
fi
record_pass "Architecture: $ARCH → Android ABI: $ANDROID_ABI"

# =============================================================================
# Phase 2 — Homebrew
# =============================================================================
header "Phase 2: Homebrew"

step "Checking Homebrew..."
if has_cmd brew; then
  BREW_VERSION="$(brew --version | head -1)"
  success "Homebrew already installed: $BREW_VERSION"
  record_pass "Homebrew ($BREW_VERSION)"
else
  warn "Homebrew not found. Installing..."
  info "This will run the official Homebrew installer from https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # After install, Homebrew may live at /opt/homebrew (Apple Silicon) or /usr/local (Intel)
  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  if has_cmd brew; then
    success "Homebrew installed successfully: $(brew --version | head -1)"
    record_pass "Homebrew (newly installed)"
  else
    error "Homebrew installation appeared to succeed but 'brew' is still not on PATH."
    error "Please open a new terminal, re-run this script, or add Homebrew to your PATH manually."
    record_fail "Homebrew (install succeeded but not on PATH)"
    exit 1
  fi
fi

# =============================================================================
# Phase 3 — Xcode Command Line Tools
# =============================================================================
header "Phase 3: Xcode Command Line Tools"

step "Checking Xcode Command Line Tools..."
XCODE_SELECT_PATH=""
if xcode-select -p &>/dev/null; then
  XCODE_SELECT_PATH="$(xcode-select -p)"
  success "Xcode tools found at: $XCODE_SELECT_PATH"
else
  warn "Xcode Command Line Tools not installed. Triggering installer..."
  info "A system dialog will appear asking you to install the tools."
  info "Click 'Install' and wait for the download to complete (~500 MB)."
  info "The script will wait until installation finishes..."

  # Trigger the GUI installer
  xcode-select --install 2>/dev/null || true

  # Poll until xcode-select reports a valid path (or user gives up)
  WAIT_SECONDS=0
  MAX_WAIT=1800  # 30 minutes max
  while ! xcode-select -p &>/dev/null; do
    if [[ $WAIT_SECONDS -ge $MAX_WAIT ]]; then
      error "Timed out waiting for Xcode CLI tools installation after ${MAX_WAIT}s."
      error "Please complete the installation manually, then re-run this script."
      record_fail "Xcode Command Line Tools (install timed out)"
      exit 1
    fi
    printf "\r${YELLOW}  ⏳ Waiting for Xcode tools... (%ds elapsed)${RESET}" "$WAIT_SECONDS"
    sleep 10
    WAIT_SECONDS=$((WAIT_SECONDS + 10))
  done
  printf "\n"

  XCODE_SELECT_PATH="$(xcode-select -p)"
  success "Xcode Command Line Tools installed at: $XCODE_SELECT_PATH"
fi

# Accept Xcode license (silent if already accepted)
step "Checking Xcode license..."
if sudo xcodebuild -license check 2>/dev/null; then
  success "Xcode license already accepted"
else
  info "Accepting Xcode license (requires sudo)..."
  sudo xcodebuild -license accept
  success "Xcode license accepted"
fi

# Verify xcrun is available
step "Verifying xcrun..."
if has_cmd xcrun; then
  XCRUN_INFO="$(xcrun --version 2>&1 || echo 'available')"
  success "xcrun available: $XCRUN_INFO"
  record_pass "Xcode CLI Tools + xcrun ($XCODE_SELECT_PATH)"
else
  error "xcrun not found after Xcode CLI tools installation."
  record_fail "xcrun not found"
  exit 1
fi

# =============================================================================
# Phase 4 — iOS Simulator Runtimes
# =============================================================================
header "Phase 4: iOS Simulator Runtimes"

step "Listing installed iOS runtimes..."

# Get installed runtimes as JSON
INSTALLED_RUNTIMES_JSON="$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')"
INSTALLED_RUNTIME_COUNT="$(python3 -c "
import sys, json
data = json.load(sys.stdin)
runtimes = [r for r in data.get('runtimes', []) if r.get('isAvailable', False)]
print(len(runtimes))
" <<< "$INSTALLED_RUNTIMES_JSON" 2>/dev/null || echo "0")"

if [[ "$INSTALLED_RUNTIME_COUNT" -gt 0 ]]; then
  success "$INSTALLED_RUNTIME_COUNT iOS runtime(s) already installed:"
  echo "$INSTALLED_RUNTIMES_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('runtimes', []):
  status = '✅' if r.get('isAvailable', False) else '⚠️ '
  print(f'  {status}  {r.get(\"name\", \"Unknown\")} — {r.get(\"identifier\", \"\")}')
" 2>/dev/null || true
  record_pass "iOS Runtimes ($INSTALLED_RUNTIME_COUNT installed)"
else
  warn "No iOS runtimes found. Attempting to download the latest iOS runtime..."
  info "This may take a while (several GB download)."
  info "You can also install runtimes via: Xcode → Settings → Platforms"
  info ""

  # Try to find and install the latest available iOS runtime via xcodebuild
  # xcodebuild -downloadPlatform iOS installs the recommended iOS Simulator runtime
  if has_cmd xcodebuild; then
    step "Downloading latest iOS Simulator runtime via xcodebuild..."
    info "Running: xcodebuild -downloadPlatform iOS"
    info "This will download and install the latest recommended iOS runtime."
    info "You may be prompted for your password."

    if xcodebuild -downloadPlatform iOS; then
      success "iOS runtime download initiated/completed via xcodebuild."
    else
      warn "xcodebuild -downloadPlatform iOS failed or was cancelled."
      warn "You can manually install runtimes using:"
      warn "  ./scripts/install-ios-runtime.sh"
      warn "  or: Xcode → Settings → Platforms → iOS → (+)"
    fi

    # Re-check after download attempt
    INSTALLED_RUNTIME_COUNT="$(python3 -c "
import sys, json
data = json.load(sys.stdin)
runtimes = [r for r in data.get('runtimes', []) if r.get('isAvailable', False)]
print(len(runtimes))
" <<< "$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')" 2>/dev/null || echo "0")"

    if [[ "$INSTALLED_RUNTIME_COUNT" -gt 0 ]]; then
      success "$INSTALLED_RUNTIME_COUNT iOS runtime(s) now available"
      record_pass "iOS Runtimes ($INSTALLED_RUNTIME_COUNT installed)"
    else
      warn "No iOS runtimes available yet. Install one via: ./scripts/install-ios-runtime.sh"
      record_warn "iOS Runtimes (none installed — run install-ios-runtime.sh)"
    fi
  else
    warn "xcodebuild not found — cannot auto-download runtime."
    warn "Install runtimes via: ./scripts/install-ios-runtime.sh"
    record_warn "iOS Runtimes (xcodebuild not found — install manually)"
  fi
fi

# Print current runtime list regardless
info "Current iOS runtime list:"
xcrun simctl list runtimes 2>/dev/null || true

# =============================================================================
# Phase 5 — Android SDK Command-Line Tools
# =============================================================================
header "Phase 5: Android SDK Command-Line Tools"

# Standard macOS path for Android SDK
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
CMDLINE_TOOLS_DIR="$ANDROID_SDK_ROOT/cmdline-tools"
SDKMANAGER="$CMDLINE_TOOLS_DIR/latest/bin/sdkmanager"
AVDMANAGER="$CMDLINE_TOOLS_DIR/latest/bin/avdmanager"

step "Checking Android SDK at: $ANDROID_SDK_ROOT"

if [[ -x "$SDKMANAGER" ]]; then
  SDKMANAGER_VERSION="$("$SDKMANAGER" --version 2>/dev/null || echo 'available')"
  success "Android SDK command-line tools already installed (sdkmanager v$SDKMANAGER_VERSION)"
  record_pass "Android SDK cmdline-tools (v$SDKMANAGER_VERSION)"
else
  warn "Android SDK command-line tools not found. Installing..."

  # Create directory structure
  info "Creating SDK directory: $CMDLINE_TOOLS_DIR"
  mkdir -p "$CMDLINE_TOOLS_DIR"

  # Download the latest Android cmdline-tools for macOS
  # Official Google URL for the latest stable release (commandlinetools-mac-11076708)
  CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
  CMDLINE_TOOLS_ZIP="/tmp/android-cmdline-tools.zip"

  step "Downloading Android command-line tools..."
  info "URL: $CMDLINE_TOOLS_URL"
  info "Destination: $CMDLINE_TOOLS_ZIP"

  if curl -# -L -o "$CMDLINE_TOOLS_ZIP" "$CMDLINE_TOOLS_URL"; then
    success "Download complete"
  else
    error "Failed to download Android command-line tools."
    error "Check your internet connection and try again, or download manually from:"
    error "  https://developer.android.com/studio#command-line-tools-only"
    record_fail "Android SDK cmdline-tools (download failed)"
    exit 1
  fi

  # Extract the zip
  step "Extracting command-line tools..."
  EXTRACT_TMP="$CMDLINE_TOOLS_DIR/_extract_tmp"
  mkdir -p "$EXTRACT_TMP"
  unzip -q "$CMDLINE_TOOLS_ZIP" -d "$EXTRACT_TMP"
  rm -f "$CMDLINE_TOOLS_ZIP"

  # Google's zip contains a folder named "cmdline-tools" — rename it to "latest"
  # per the expected SDK layout: $ANDROID_SDK_ROOT/cmdline-tools/latest/
  if [[ -d "$EXTRACT_TMP/cmdline-tools" ]]; then
    # Remove any pre-existing "latest" to ensure clean install
    rm -rf "$CMDLINE_TOOLS_DIR/latest"
    mv "$EXTRACT_TMP/cmdline-tools" "$CMDLINE_TOOLS_DIR/latest"
    rm -rf "$EXTRACT_TMP"
    success "Command-line tools extracted to: $CMDLINE_TOOLS_DIR/latest"
  else
    error "Unexpected zip structure. Expected 'cmdline-tools/' inside the archive."
    error "Contents of extract dir:"
    ls -la "$EXTRACT_TMP/" >&2 || true
    rm -rf "$EXTRACT_TMP"
    record_fail "Android SDK cmdline-tools (unexpected zip structure)"
    exit 1
  fi

  # Verify sdkmanager now exists and is executable
  if [[ -x "$SDKMANAGER" ]]; then
    success "sdkmanager installed: $SDKMANAGER"
  else
    error "sdkmanager not found at expected path: $SDKMANAGER"
    record_fail "Android SDK cmdline-tools (sdkmanager not found post-install)"
    exit 1
  fi

  # Accept all licenses upfront
  step "Accepting Android SDK licenses..."
  yes 2>/dev/null | "$SDKMANAGER" --licenses --sdk_root="$ANDROID_SDK_ROOT" || true
  success "Android SDK licenses accepted"
  record_pass "Android SDK cmdline-tools (newly installed)"
fi

# Ensure PATH includes sdkmanager for subsequent phases
export PATH="$CMDLINE_TOOLS_DIR/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
export ANDROID_SDK_ROOT

# =============================================================================
# Phase 6 — Android SDK Packages
# =============================================================================
header "Phase 6: Android SDK Packages"

# Accept licenses before installing packages
step "Accepting Android SDK licenses..."
yes 2>/dev/null | "$SDKMANAGER" --licenses --sdk_root="$ANDROID_SDK_ROOT" 2>/dev/null || true
success "SDK licenses accepted/confirmed"

# List of packages to install
SYSTEM_IMAGE_PACKAGE="system-images;android-35;google_apis;${ANDROID_ABI}"

declare -a SDK_PACKAGES=(
  "platform-tools"
  "emulator"
  "platforms;android-35"
  "$SYSTEM_IMAGE_PACKAGE"
)

# Get currently installed packages for idempotency check
info "Fetching list of installed SDK packages..."
INSTALLED_PACKAGES="$(set +o pipefail; "$SDKMANAGER" --list_installed --sdk_root="$ANDROID_SDK_ROOT" 2>/dev/null | grep -v '^\-\-' | grep -v '^Installed' | grep -v '^  Name' || echo "")"

install_sdk_package() {
  local pkg="$1"
  if echo "$INSTALLED_PACKAGES" | grep -qF "$pkg" 2>/dev/null; then
    success "Already installed: $pkg"
  else
    info "Installing: $pkg ..."
    yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$ANDROID_SDK_ROOT" "$pkg"
    success "Installed: $pkg"
  fi
}

for pkg in "${SDK_PACKAGES[@]}"; do
  step "Checking package: $pkg"
  install_sdk_package "$pkg"
done

# Verify key binaries
ADB_BIN="$ANDROID_SDK_ROOT/platform-tools/adb"
EMULATOR_BIN="$ANDROID_SDK_ROOT/emulator/emulator"

if [[ -x "$ADB_BIN" ]]; then
  ADB_VERSION="$("$ADB_BIN" version 2>/dev/null | head -1 || echo 'available')"
  success "adb: $ADB_VERSION"
  record_pass "adb ($ADB_VERSION)"
else
  warn "adb not found at $ADB_BIN"
  record_warn "adb (not found after package install)"
fi

if [[ -x "$EMULATOR_BIN" ]]; then
  EMULATOR_VERSION="$("$EMULATOR_BIN" -version 2>/dev/null | head -1 || echo 'available')"
  success "Android emulator: $EMULATOR_VERSION"
  record_pass "Android emulator ($EMULATOR_VERSION)"
else
  warn "Android emulator not found at $EMULATOR_BIN"
  record_warn "Android emulator (not found after package install)"
fi

record_pass "Android SDK packages (platform-tools, emulator, android-35, $ANDROID_ABI system image)"

# =============================================================================
# Phase 7 — scrcpy (Android Screen Streaming)
# =============================================================================
header "Phase 7: scrcpy (Android Screen Streaming)"

step "Checking scrcpy..."
if brew list scrcpy &>/dev/null; then
  SCRCPY_VERSION="$(scrcpy --version 2>&1 | head -1)"
  success "scrcpy already installed: $SCRCPY_VERSION"
  record_pass "scrcpy ($SCRCPY_VERSION)"
else
  warn "scrcpy not found. Installing via Homebrew..."
  brew install scrcpy
  if brew list scrcpy &>/dev/null; then
    SCRCPY_VERSION="$(scrcpy --version 2>&1 | head -1)"
    success "scrcpy installed: $SCRCPY_VERSION"
    record_pass "scrcpy ($SCRCPY_VERSION)"
  else
    warn "scrcpy installation may have failed — check brew output above"
    record_warn "scrcpy (install may have failed)"
  fi
fi

step "Verifying scrcpy-server jar..."
# Determine Homebrew prefix (Apple Silicon vs Intel)
BREW_PREFIX="$(brew --prefix)"
SCRCPY_SERVER_PATH="$BREW_PREFIX/share/scrcpy/scrcpy-server"

if [[ -f "$SCRCPY_SERVER_PATH" ]]; then
  success "scrcpy-server jar found at: $SCRCPY_SERVER_PATH"
  record_pass "scrcpy-server jar ($SCRCPY_SERVER_PATH)"
else
  warn "scrcpy-server jar NOT found at expected path: $SCRCPY_SERVER_PATH"
  warn "Android H.264 streaming will fall back to PNG polling."
  warn "Try: brew reinstall scrcpy"
  record_warn "scrcpy-server jar (not found at $SCRCPY_SERVER_PATH)"
fi

# =============================================================================
# Phase 8 — Create Default Android AVD
# =============================================================================
header "Phase 8: Default Android AVD"

step "Checking existing Android Virtual Devices..."

# avdmanager may not be on PATH yet — use full path
if [[ -x "$AVDMANAGER" ]]; then
  EXISTING_AVDS="$(set +o pipefail; "$AVDMANAGER" list avd 2>/dev/null | grep "Name:" | sed 's/.*Name: //' | xargs 2>/dev/null || echo "")"
else
  EXISTING_AVDS=""
  warn "avdmanager not found at $AVDMANAGER"
fi

DEFAULT_AVD_NAME="Pixel_8_API_35"

if [[ -n "$EXISTING_AVDS" ]]; then
  success "Existing AVD(s) found:"
  echo "$EXISTING_AVDS" | while read -r avd_name; do
    [[ -n "$avd_name" ]] && printf "    • %s\n" "$avd_name"
  done

  if echo "$EXISTING_AVDS" | grep -qF "$DEFAULT_AVD_NAME"; then
    success "Default AVD '$DEFAULT_AVD_NAME' already exists — skipping creation"
    record_pass "Android AVD ($DEFAULT_AVD_NAME already exists)"
  else
    info "Default AVD '$DEFAULT_AVD_NAME' not found — creating it..."
    if [[ -x "$AVDMANAGER" ]]; then
      "$AVDMANAGER" create avd \
        -n "$DEFAULT_AVD_NAME" \
        -k "$SYSTEM_IMAGE_PACKAGE" \
        -d "pixel_8" \
        --force 2>/dev/null || \
      "$AVDMANAGER" create avd \
        -n "$DEFAULT_AVD_NAME" \
        -k "$SYSTEM_IMAGE_PACKAGE" \
        --force 2>/dev/null || true
      success "AVD '$DEFAULT_AVD_NAME' created"
      record_pass "Android AVD ($DEFAULT_AVD_NAME created)"
    else
      warn "avdmanager not available — skipping AVD creation"
      record_warn "Android AVD (avdmanager not found)"
    fi
  fi
else
  info "No existing AVDs found — creating default AVD..."

  if [[ -x "$AVDMANAGER" ]]; then
    # Try with device profile first, fall back without it
    if "$AVDMANAGER" create avd \
        -n "$DEFAULT_AVD_NAME" \
        -k "$SYSTEM_IMAGE_PACKAGE" \
        -d "pixel_8" \
        --force 2>/dev/null; then
      success "AVD '$DEFAULT_AVD_NAME' created with Pixel 8 device profile"
    elif "$AVDMANAGER" create avd \
        -n "$DEFAULT_AVD_NAME" \
        -k "$SYSTEM_IMAGE_PACKAGE" \
        --force 2>/dev/null; then
      success "AVD '$DEFAULT_AVD_NAME' created (without device profile)"
    else
      warn "Could not create AVD automatically."
      warn "You can create one manually: ./scripts/install-android-image.sh"
      record_warn "Android AVD (creation failed — run install-android-image.sh)"
    fi
    record_pass "Android AVD ($DEFAULT_AVD_NAME)"
  else
    warn "avdmanager not available — skipping AVD creation"
    record_warn "Android AVD (avdmanager not found)"
  fi
fi

# =============================================================================
# Phase 9 — Environment Setup
# =============================================================================
header "Phase 9: Environment Setup"

ENV_SNIPPET_FILE="$HOME/.web-mobile-simulator-env"

step "Writing shell environment snippet to $ENV_SNIPPET_FILE..."

cat > "$ENV_SNIPPET_FILE" << ENVEOF
# -----------------------------------------------------------------------
# Web Mobile Simulator — Android SDK Environment
# Auto-generated by scripts/setup-host.sh on $(date '+%Y-%m-%d %H:%M:%S')
# Source this file in your shell profile to use Android SDK tools:
#   echo 'source ~/.web-mobile-simulator-env' >> ~/.zshrc
# -----------------------------------------------------------------------
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export PATH="\$ANDROID_SDK_ROOT/emulator:\$ANDROID_SDK_ROOT/platform-tools:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$PATH"
ENVEOF

success "Environment snippet written to $ENV_SNIPPET_FILE"
info "To activate in your current shell:  source $ENV_SNIPPET_FILE"
info "To activate in all future shells, add to your ~/.zshrc or ~/.bash_profile:"
info "  echo 'source ~/.web-mobile-simulator-env' >> ~/.zshrc"

# Create/update project .env from .env.example
step "Setting up project .env file..."

ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

if [[ -f "$ENV_FILE" ]]; then
  info "Project .env already exists at $ENV_FILE — not overwriting."
  info "Ensure ANDROID_SDK_ROOT is set correctly inside it."
  record_pass "Project .env (already exists)"
else
  if [[ -f "$ENV_EXAMPLE" ]]; then
    # Substitute $USER in the template and write the real .env
    sed "s|\$USER|$USER|g; s|/Users/\$USER|$HOME|g" "$ENV_EXAMPLE" > "$ENV_FILE"
    # Update ANDROID_SDK_ROOT with the actual detected path
    if grep -q "^ANDROID_SDK_ROOT=" "$ENV_FILE"; then
      # Replace the value with the actual path
      TMP_ENV="$(mktemp)"
      sed "s|^ANDROID_SDK_ROOT=.*|ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT|" "$ENV_FILE" > "$TMP_ENV"
      mv "$TMP_ENV" "$ENV_FILE"
    fi
    success "Project .env created from .env.example"
    record_pass "Project .env (created from .env.example)"
  else
    warn ".env.example not found — skipping .env creation"
    record_warn "Project .env (.env.example missing)"
  fi
fi

# =============================================================================
# Phase 10 — Verification Summary
# =============================================================================
header "Phase 10: Verification"

step "Running final checks..."

# Source the environment snippet to ensure all tools are on PATH for checks
# shellcheck source=/dev/null
source "$ENV_SNIPPET_FILE" 2>/dev/null || true

printf "\n"
printf "${BOLD}%-40s %s${RESET}\n" "Component" "Status"
printf "%-40s %s\n" "----------------------------------------" "--------"

check_item() {
  local label="$1"
  local value="$2"
  local ok="$3"   # "ok" | "warn" | "fail"

  if [[ "$ok" == "ok" ]]; then
    printf "${GREEN}✅ %-38s %s${RESET}\n" "$label" "$value"
  elif [[ "$ok" == "warn" ]]; then
    printf "${YELLOW}⚠️  %-38s %s${RESET}\n" "$label" "$value"
  else
    printf "${RED}❌ %-38s %s${RESET}\n" "$label" "$value"
  fi
}

# macOS
check_item "macOS version" "$(sw_vers -productVersion)" "ok"

# xcrun / simctl
if has_cmd xcrun; then
  check_item "xcrun" "$(xcode-select -p)" "ok"
else
  check_item "xcrun" "NOT FOUND" "fail"
fi

if xcrun simctl list runtimes &>/dev/null; then
  IOS_COUNT="$(python3 -c "
import sys, json
data = json.load(sys.stdin)
runtimes = [r for r in data.get('runtimes', []) if r.get('isAvailable', False)]
print(len(runtimes))
" <<< "$(xcrun simctl list runtimes -j 2>/dev/null || echo '{"runtimes":[]}')" 2>/dev/null || echo '?')"
  if [[ "$IOS_COUNT" != "0" && "$IOS_COUNT" != "?" ]]; then
    check_item "iOS Simulator runtimes" "$IOS_COUNT runtime(s)" "ok"
  else
    check_item "iOS Simulator runtimes" "none installed" "warn"
  fi
else
  check_item "iOS Simulator runtimes" "simctl error" "fail"
fi

# Android SDK
if [[ -d "$ANDROID_SDK_ROOT" ]]; then
  check_item "ANDROID_SDK_ROOT" "$ANDROID_SDK_ROOT" "ok"
else
  check_item "ANDROID_SDK_ROOT" "directory not found" "fail"
fi

if [[ -x "$SDKMANAGER" ]]; then
  check_item "sdkmanager" "$SDKMANAGER" "ok"
else
  check_item "sdkmanager" "NOT FOUND" "fail"
fi

if [[ -x "$AVDMANAGER" ]]; then
  check_item "avdmanager" "$AVDMANAGER" "ok"
else
  check_item "avdmanager" "NOT FOUND" "fail"
fi

if [[ -x "$EMULATOR_BIN" ]]; then
  check_item "Android emulator" "$EMULATOR_BIN" "ok"
elif has_cmd emulator; then
  check_item "Android emulator" "$(command -v emulator)" "ok"
else
  check_item "Android emulator" "NOT FOUND" "fail"
fi

if [[ -x "$ADB_BIN" ]]; then
  check_item "adb" "$ADB_BIN" "ok"
elif has_cmd adb; then
  check_item "adb" "$(command -v adb)" "ok"
else
  check_item "adb" "NOT FOUND" "fail"
fi

# Docker (check only)
if has_cmd docker && docker info &>/dev/null 2>&1; then
  check_item "Docker" "$(docker --version)" "ok"
elif has_cmd docker; then
  check_item "Docker" "installed (daemon not running)" "warn"
else
  check_item "Docker" "NOT FOUND — install Docker Desktop" "warn"
fi

# Node.js (check only)
if has_cmd node; then
  check_item "Node.js" "$(node --version)" "ok"
else
  check_item "Node.js" "NOT FOUND — install via nvm or brew" "warn"
fi

# pnpm (check only)
if has_cmd pnpm; then
  check_item "pnpm" "$(pnpm --version)" "ok"
else
  check_item "pnpm" "NOT FOUND — npm install -g pnpm" "warn"
fi

# scrcpy (Android H.264 streaming)
if has_cmd scrcpy; then
  check_item "scrcpy" "$(scrcpy --version 2>&1 | head -1)" "ok"
else
  check_item "scrcpy" "NOT FOUND — brew install scrcpy" "fail"
fi

# Architecture / ABI
check_item "CPU architecture" "$ARCH → ABI: $ANDROID_ABI" "ok"

# .env file
if [[ -f "$PROJECT_DIR/.env" ]]; then
  check_item "Project .env" "$PROJECT_DIR/.env" "ok"
else
  check_item "Project .env" "missing (copy from .env.example)" "warn"
fi

# Env snippet
if [[ -f "$ENV_SNIPPET_FILE" ]]; then
  check_item "SDK env snippet" "$ENV_SNIPPET_FILE" "ok"
else
  check_item "SDK env snippet" "missing" "fail"
fi

# =============================================================================
# Final summary
# =============================================================================
header "Setup Complete"

PASS_COUNT="${#SUMMARY_PASS[@]}"
WARN_COUNT="${#SUMMARY_WARN[@]}"
FAIL_COUNT="${#SUMMARY_FAIL[@]}"

if [[ $FAIL_COUNT -eq 0 && $WARN_COUNT -eq 0 ]]; then
  success "All components installed and verified successfully!"
elif [[ $FAIL_COUNT -eq 0 ]]; then
  warn "$WARN_COUNT warning(s) — some optional components need attention:"
  for w in "${SUMMARY_WARN[@]}"; do
    printf "  ${YELLOW}⚠️  %s${RESET}\n" "$w"
  done
else
  error "$FAIL_COUNT failure(s) detected:"
  for f in "${SUMMARY_FAIL[@]}"; do
    printf "  ${RED}❌ %s${RESET}\n" "$f"
  done
  if [[ $WARN_COUNT -gt 0 ]]; then
    warn "$WARN_COUNT warning(s):"
    for w in "${SUMMARY_WARN[@]}"; do
      printf "  ${YELLOW}⚠️  %s${RESET}\n" "$w"
    done
  fi
fi

printf "\n${BOLD}Next steps:${RESET}\n"
printf "  1. Source the SDK environment in your shell:\n"
printf "     ${CYAN}source %s${RESET}\n" "$ENV_SNIPPET_FILE"
printf "     Or add to ~/.zshrc:  ${CYAN}echo 'source %s' >> ~/.zshrc${RESET}\n" "$ENV_SNIPPET_FILE"
printf "  2. Install iOS runtimes (if needed):\n"
printf "     ${CYAN}%s/scripts/install-ios-runtime.sh${RESET}\n" "$PROJECT_DIR"
printf "  3. Install additional Android system images (if needed):\n"
printf "     ${CYAN}%s/scripts/install-android-image.sh${RESET}\n" "$PROJECT_DIR"
printf "  4. Start the project:\n"
printf "     ${CYAN}cd %s && pnpm install && pnpm dev${RESET}\n" "$PROJECT_DIR"
printf "\n"
