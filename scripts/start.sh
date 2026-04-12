#!/usr/bin/env bash
# =============================================================================
# start.sh — Start the Web Mobile Simulator (API + Web dev servers)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/.pids"
API_PID_FILE="$PID_DIR/api.pid"
WEB_PID_FILE="$PID_DIR/web.pid"
LOG_DIR="$PROJECT_ROOT/.logs"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"

# Default ports (match .env.example / environment.ts)
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-4200}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[  ok]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; }

# --- Pre-flight checks ---

# Check if already running
if [[ -f "$API_PID_FILE" ]] && kill -0 "$(cat "$API_PID_FILE")" 2>/dev/null; then
  warn "API server is already running (PID $(cat "$API_PID_FILE")). Run scripts/stop.sh first."
  exit 1
fi

if [[ -f "$WEB_PID_FILE" ]] && kill -0 "$(cat "$WEB_PID_FILE")" 2>/dev/null; then
  warn "Web server is already running (PID $(cat "$WEB_PID_FILE")). Run scripts/stop.sh first."
  exit 1
fi

# Check if ports are in use
if lsof -iTCP:"$API_PORT" -sTCP:LISTEN -t &>/dev/null; then
  fail "Port $API_PORT is already in use. Free it or set API_PORT env var."
  exit 1
fi

if lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN -t &>/dev/null; then
  fail "Port $WEB_PORT is already in use. Free it or set WEB_PORT env var."
  exit 1
fi

# Ensure pnpm is available
if ! command -v pnpm &>/dev/null; then
  fail "pnpm is required but not found. Install it: https://pnpm.io/installation"
  exit 1
fi

# --- Setup directories ---
mkdir -p "$PID_DIR" "$LOG_DIR"

# --- Start API server ---
info "Starting API server (port $API_PORT)…"

cd "$PROJECT_ROOT/packages/api"
nohup pnpm run dev > "$API_LOG" 2>&1 &
API_PID=$!
echo "$API_PID" > "$API_PID_FILE"

# Wait for API to be ready (up to 15 seconds)
API_READY=false
for i in $(seq 1 30); do
  if lsof -iTCP:"$API_PORT" -sTCP:LISTEN -t &>/dev/null; then
    API_READY=true
    break
  fi
  sleep 0.5
done

if $API_READY; then
  ok "API server started (PID $API_PID, port $API_PORT)"
else
  warn "API server started (PID $API_PID) but port $API_PORT not yet listening — check $API_LOG"
fi

# --- Start Web dev server ---
info "Starting Web dev server (port $WEB_PORT)…"

cd "$PROJECT_ROOT/packages/web"
nohup pnpm run dev --port "$WEB_PORT" > "$WEB_LOG" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" > "$WEB_PID_FILE"

# Wait for Web to be ready (up to 30 seconds — Angular can be slow to compile)
WEB_READY=false
for i in $(seq 1 60); do
  if lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN -t &>/dev/null; then
    WEB_READY=true
    break
  fi
  sleep 0.5
done

if $WEB_READY; then
  ok "Web dev server started (PID $WEB_PID, port $WEB_PORT)"
else
  warn "Web dev server started (PID $WEB_PID) but port $WEB_PORT not yet listening — check $WEB_LOG"
fi

# --- Summary ---
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Web Mobile Simulator is running!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐  Frontend:  ${BLUE}http://localhost:${WEB_PORT}${NC}"
echo -e "  🔌  API:       ${BLUE}http://localhost:${API_PORT}${NC}"
echo -e "  📋  API logs:  ${API_LOG}"
echo -e "  📋  Web logs:  ${WEB_LOG}"
echo ""
echo -e "  Stop with:     ${YELLOW}scripts/stop.sh${NC}  or  ${YELLOW}pnpm stop${NC}"
echo ""
