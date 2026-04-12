#!/usr/bin/env bash
# =============================================================================
# stop.sh — Stop the Web Mobile Simulator (API + Web dev servers)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$PROJECT_ROOT/.pids"
API_PID_FILE="$PID_DIR/api.pid"
WEB_PID_FILE="$PID_DIR/web.pid"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[  ok]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; }

# --- Helper: stop a process by PID file ---
stop_process() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    warn "$name: no PID file found — not running?"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if ! kill -0 "$pid" 2>/dev/null; then
    warn "$name: process $pid is not running (stale PID file) — cleaning up."
    rm -f "$pid_file"
    return 0
  fi

  info "Stopping $name (PID $pid)…"

  # Send SIGTERM for graceful shutdown
  kill -TERM "$pid" 2>/dev/null || true

  # Wait up to 10 seconds for the process to exit
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  # Force kill if still running
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not stop gracefully after 10s — sending SIGKILL."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  rm -f "$pid_file"
  ok "$name stopped."
}

# --- Also kill any child processes of the main PIDs ---
# pnpm spawns child processes (tsx, ng), so we need to kill the entire
# process group, not just the parent shell.
stop_process_tree() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    warn "$name: no PID file found — not running?"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if ! kill -0 "$pid" 2>/dev/null; then
    warn "$name: process $pid is not running (stale PID file) — cleaning up."
    rm -f "$pid_file"
    return 0
  fi

  info "Stopping $name (PID $pid and children)…"

  # Find all child processes in the process group
  # Use pkill to send SIGTERM to the entire process tree
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)

  # Send SIGTERM to main process
  kill -TERM "$pid" 2>/dev/null || true

  # Also SIGTERM children (tsx, node, ng serve)
  if [[ -n "$children" ]]; then
    for child_pid in $children; do
      kill -TERM "$child_pid" 2>/dev/null || true
    done
  fi

  # Wait up to 10 seconds
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  # Force kill if still alive
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not stop gracefully after 10s — sending SIGKILL."
    kill -9 "$pid" 2>/dev/null || true
    if [[ -n "$children" ]]; then
      for child_pid in $children; do
        kill -9 "$child_pid" 2>/dev/null || true
      done
    fi
    sleep 1
  fi

  rm -f "$pid_file"
  ok "$name stopped."
}

# --- Stop both servers ---
echo ""
stop_process_tree "Web dev server" "$WEB_PID_FILE"
stop_process_tree "API server" "$API_PID_FILE"

# Clean up PID directory if empty
rmdir "$PID_DIR" 2>/dev/null || true

echo ""
ok "Web Mobile Simulator stopped."
echo ""
