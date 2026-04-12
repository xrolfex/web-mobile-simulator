#!/usr/bin/env bash
# =============================================================================
# scripts/install-android-image.sh
# Web Mobile Simulator — Android System Image Installer
#
# Downloads and installs Android system images and (optionally) creates an AVD.
#
# Usage:
#   ./scripts/install-android-image.sh [--help]
#   ./scripts/install-android-image.sh                   # List installed + available images
#   ./scripts/install-android-image.sh <api-level>       # Install image for given API level
#   ./scripts/install-android-image.sh <api-level> [--create-avd]  # Install + create AVD
#
# Arguments:
#   api-level     Android API level integer (e.g. 35, 34, 33)
#                 Corresponds to: android-35 = Android 15, android-34 = Android 14, etc.
#
# Options:
#   --create-avd  After installing the system image, create a default AVD for it
#   --help        Print this help message and exit
#
# Examples:
#   ./scripts/install-android-image.sh
#       → Lists currently installed and available system images
#
#   ./scripts/install-android-image.sh 35
#       → Installs system-images;android-35;google_apis;<arch> for your CPU
#
#   ./scripts/install-android-image.sh 34 --create-avd
#       → Installs the Android 34 image and creates a Pixel_8_API_34 AVD
#
# Architecture detection:
#   - Apple Silicon (arm64) → arm64-v8a
#   - Intel Mac  (x86_64)  → x86_64
#
# Requirements:
#   - Android SDK command-line tools (sdkmanager, avdmanager)
#   - ANDROID_SDK_ROOT set, or defaults to ~/Library/Android/sdk
#   - Run ./scripts/setup-host.sh first if SDK tools are not installed
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
  error "This script requires macOS. Android Emulator is only supported on macOS for this project."
  exit 1
fi

# ---------------------------------------------------------------------------
# Architecture detection
# ---------------------------------------------------------------------------
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ANDROID_ABI="arm64-v8a"
  info "Apple Silicon detected → using arm64-v8a system images"
else
  ANDROID_ABI="x86_64"
  info "Intel Mac detected → using x86_64 system images"
fi

# ---------------------------------------------------------------------------
# Locate Android SDK tools
# ---------------------------------------------------------------------------
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"

# Source the env snippet if it exists (to pick up PATH additions from setup-host.sh)
ENV_SNIPPET="$HOME/.web-mobile-simulator-env"
if [[ -f "$ENV_SNIPPET" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_SNIPPET" 2>/dev/null || true
fi

SDKMANAGER_BIN="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER_BIN="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager"

# Fall back to PATH-resolved binaries if SDK-relative paths are not found
if ! [[ -x "$SDKMANAGER_BIN" ]]; then
  if command -v sdkmanager &>/dev/null; then
    SDKMANAGER_BIN="$(command -v sdkmanager)"
  else
    error "sdkmanager not found at $SDKMANAGER_BIN and not on PATH."
    error "Run ./scripts/setup-host.sh to install the Android SDK command-line tools first."
    exit 1
  fi
fi

if ! [[ -x "$AVDMANAGER_BIN" ]]; then
  if command -v avdmanager &>/dev/null; then
    AVDMANAGER_BIN="$(command -v avdmanager)"
  else
    warn "avdmanager not found — AVD creation will be skipped even if --create-avd is used."
    AVDMANAGER_BIN=""
  fi
fi

# Common sdkmanager flags
SDKMANAGER_FLAGS="--sdk_root=$ANDROID_SDK_ROOT"

# ---------------------------------------------------------------------------
# List installed system images (helper)
# ---------------------------------------------------------------------------
list_installed_images() {
  info "Installed system images:"
  (set +o pipefail; "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS --list_installed 2>/dev/null \
    | grep "system-images" \
    | awk '{print "  "$1}') \
    || echo "  (none or could not query)"
}

# ---------------------------------------------------------------------------
# List all available system images matching a pattern (helper)
# ---------------------------------------------------------------------------
list_available_images() {
  local filter="${1:-system-images}"
  info "Available system images (may take a moment to fetch):"
  (set +o pipefail; "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS --list 2>/dev/null \
    | grep "$filter" \
    | grep -v "Installed" \
    | awk '{print "  "$1}' \
    | head -60) \
    || echo "  (could not fetch list — check internet connection)"
}

# ---------------------------------------------------------------------------
# Check if a specific package is already installed
# ---------------------------------------------------------------------------
is_package_installed() {
  local pkg="$1"
  (set +o pipefail; "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS --list_installed 2>/dev/null \
    | grep -qF "$pkg")
}

# ---------------------------------------------------------------------------
# Install a package via sdkmanager
# ---------------------------------------------------------------------------
install_package() {
  local pkg="$1"
  info "Installing: $pkg"
  yes 2>/dev/null | "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS "$pkg"
  success "Installed: $pkg"
}

# ---------------------------------------------------------------------------
# Create an AVD for the given API level
# ---------------------------------------------------------------------------
create_avd_for_api() {
  local api_level="$1"
  local system_image_pkg="$2"
  local avd_name="Pixel_8_API_${api_level}"

  if [[ -z "$AVDMANAGER_BIN" ]]; then
    warn "avdmanager not available — skipping AVD creation."
    return 1
  fi

  step "Checking existing AVDs..."
  local existing
  existing="$(set +o pipefail; "$AVDMANAGER_BIN" list avd 2>/dev/null | grep "Name:" | sed 's/.*Name: //' | xargs 2>/dev/null || echo "")"

  if echo "$existing" | grep -qF "$avd_name"; then
    success "AVD '$avd_name' already exists — skipping creation."
    return 0
  fi

  step "Creating AVD: $avd_name"
  info "Using system image: $system_image_pkg"
  info "Device profile: pixel_8"

  # Try with device profile first
  if "$AVDMANAGER_BIN" create avd \
      -n "$avd_name" \
      -k "$system_image_pkg" \
      -d "pixel_8" \
      --force 2>/dev/null; then
    success "AVD '$avd_name' created with Pixel 8 device profile"
  elif "$AVDMANAGER_BIN" create avd \
      -n "$avd_name" \
      -k "$system_image_pkg" \
      --force 2>/dev/null; then
    success "AVD '$avd_name' created (generic device profile)"
  else
    warn "Could not create AVD '$avd_name' automatically."
    warn "Create it manually:"
    warn "  $AVDMANAGER_BIN create avd -n '$avd_name' -k '$system_image_pkg'"
    return 1
  fi

  # Show summary
  info "AVD details:"
  "$AVDMANAGER_BIN" list avd 2>/dev/null | grep -A5 "Name: $avd_name" || true
}

# ===========================================================================
# Parse arguments
# ===========================================================================
API_LEVEL=""
CREATE_AVD=false

for arg in "$@"; do
  case "$arg" in
    --create-avd) CREATE_AVD=true ;;
    --help|-h)    ;;  # handled above
    [0-9]*)       API_LEVEL="$arg" ;;
    *)
      error "Unknown argument: $arg"
      error "Usage: $0 [api-level] [--create-avd] [--help]"
      exit 1
      ;;
  esac
done

# ===========================================================================
# Main logic
# ===========================================================================

if [[ -z "$API_LEVEL" ]]; then
  # ── List mode ─────────────────────────────────────────────────────────────
  header "Android System Images"

  list_installed_images

  printf "\n"
  info "Architecture for this Mac: $ANDROID_ABI"
  printf "\n"

  # Show available images for common API levels
  info "Available system images (google_apis, $ANDROID_ABI):"
  (set +o pipefail; "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS --list 2>/dev/null \
    | grep "system-images" \
    | grep "google_apis" \
    | grep "$ANDROID_ABI" \
    | awk '{print "  "$1}' \
    | head -30) \
    || echo "  (could not fetch list)"

  printf "\n"
  info "To install a system image, run:"
  info "  $0 35           # Install Android 15 (API 35)"
  info "  $0 34           # Install Android 14 (API 34)"
  info "  $0 33           # Install Android 13 (API 33)"
  info "  $0 35 --create-avd  # Install + create default AVD"
  exit 0
fi

# ── Install mode ─────────────────────────────────────────────────────────────
header "Android System Image Installer — API $API_LEVEL"

# Validate API level is a sensible integer
if ! [[ "$API_LEVEL" =~ ^[0-9]+$ ]]; then
  error "API level must be a positive integer (e.g. 35, 34, 33)."
  exit 1
fi

if [[ "$API_LEVEL" -lt 21 ]]; then
  warn "API level $API_LEVEL is very old and may not have a google_apis image."
  warn "Consider using API 33 or higher for best compatibility."
fi

if [[ "$API_LEVEL" -gt 40 ]]; then
  warn "API level $API_LEVEL is higher than current known releases."
  warn "This may not exist yet — continuing anyway."
fi

# Build the package identifier
SYSTEM_IMAGE_PKG="system-images;android-${API_LEVEL};google_apis;${ANDROID_ABI}"
PLATFORM_PKG="platforms;android-${API_LEVEL}"

info "Target package: $SYSTEM_IMAGE_PKG"
info "Platform package: $PLATFORM_PKG"
info "Architecture: $ANDROID_ABI"
info "SDK root: $ANDROID_SDK_ROOT"

# ── Step 1: Accept licenses ──────────────────────────────────────────────────
step "Accepting Android SDK licenses..."
yes 2>/dev/null | "$SDKMANAGER_BIN" $SDKMANAGER_FLAGS --licenses 2>/dev/null || true
success "Licenses accepted"

# ── Step 2: Install platform (needed by AVD) ─────────────────────────────────
step "Checking platform package: $PLATFORM_PKG"
if is_package_installed "$PLATFORM_PKG"; then
  success "Already installed: $PLATFORM_PKG"
else
  install_package "$PLATFORM_PKG"
fi

# ── Step 3: Install system image ─────────────────────────────────────────────
step "Checking system image: $SYSTEM_IMAGE_PKG"
if is_package_installed "$SYSTEM_IMAGE_PKG"; then
  success "Already installed: $SYSTEM_IMAGE_PKG"
else
  info "Downloading system image — this may be several hundred MB to ~1 GB..."
  install_package "$SYSTEM_IMAGE_PKG"
fi

# ── Step 4: Verify installation ──────────────────────────────────────────────
step "Verifying installation..."
if is_package_installed "$SYSTEM_IMAGE_PKG"; then
  success "System image confirmed installed: $SYSTEM_IMAGE_PKG"
else
  error "System image not found in installed packages list after install."
  error "Something may have gone wrong. Try running:"
  error "  $SDKMANAGER_BIN $SDKMANAGER_FLAGS \"$SYSTEM_IMAGE_PKG\""
  exit 1
fi

# ── Step 5: Create AVD (optional) ────────────────────────────────────────────
if [[ "$CREATE_AVD" == true ]]; then
  step "Creating Android Virtual Device (AVD) for API $API_LEVEL..."
  create_avd_for_api "$API_LEVEL" "$SYSTEM_IMAGE_PKG"
else
  info "Skipping AVD creation (pass --create-avd to also create an AVD)."
  info "Create an AVD manually:"
  info "  avdmanager create avd -n Pixel_8_API_${API_LEVEL} -k '$SYSTEM_IMAGE_PKG' -d pixel_8"
fi

# ── Final summary ─────────────────────────────────────────────────────────────
printf "\n"
success "Installation complete for API level $API_LEVEL ($ANDROID_ABI)"

step "All installed system images:"
list_installed_images

printf "\n"
info "To launch an emulator with this image:"
info "  \$ANDROID_SDK_ROOT/emulator/emulator -avd Pixel_8_API_${API_LEVEL}"
