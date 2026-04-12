#!/usr/bin/env bash
# scripts/dev.sh — Start the full development environment.
#
# Starts the API server on the host (for macOS tool access) and the
# Angular dev server + nginx reverse proxy in Docker containers.
#
# Usage:
#   ./scripts/dev.sh          # Start everything
#   ./scripts/dev.sh --stop   # Stop everything
#
# Prerequisites:
#   - Node.js 22+ and pnpm installed
#   - Docker Desktop running
#   - Dependencies installed (pnpm install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# --stop: tear down Docker containers and kill the host API process
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--stop" ]]; then
  echo "🛑 Stopping Docker containers…"
  docker compose -f docker-compose.dev.yml down 2>/dev/null || true

  echo "🛑 Stopping API server on port 3000…"
  lsof -ti:3000 | xargs kill -SIGTERM 2>/dev/null || true

  echo "Dev environment stopped."
  exit 0
fi

# ---------------------------------------------------------------------------
# Start sequence
# ---------------------------------------------------------------------------

# 1. Build shared types (required by both API and web)
echo "📦 Building shared types…"
pnpm --filter @web-mobile-simulator/shared build

# 2. Start the API on the host in the background
echo "🚀 Starting API server on host (port 3000)…"
pnpm --filter @web-mobile-simulator/api run dev &
API_PID=$!

# 3. Register a cleanup trap now that API_PID is defined
cleanup() {
  echo ""
  echo "🛑 Shutting down…"
  docker compose -f docker-compose.dev.yml down 2>/dev/null || true
  kill $API_PID 2>/dev/null || true
  wait $API_PID 2>/dev/null || true
  echo "Dev environment stopped."
}
trap cleanup SIGINT SIGTERM

# 4. Wait briefly for the API to initialise before bringing up Docker
sleep 2

# 5. Start Docker containers (Angular dev server + nginx reverse proxy)
echo "🐳 Starting Docker containers (web + nginx)…"
docker compose -f docker-compose.dev.yml up --build -d

# 6. Print helpful summary
echo ""
echo "✅ Development environment is running!"
echo ""
echo "   🌐 App:       http://localhost:8080"
echo "   🔌 API:       http://localhost:3000/api/health"
echo "   📡 API PID:   $API_PID"
echo ""
echo "   To stop: ./scripts/dev.sh --stop"
echo "   API logs: visible in this terminal"
echo "   Docker logs: docker compose -f docker-compose.dev.yml logs -f"
echo ""

# 7. Keep the script alive so API logs stream to this terminal.
#    Ctrl+C propagates to the API via the trap above.
wait $API_PID
