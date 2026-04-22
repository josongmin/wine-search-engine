#!/usr/bin/env bash
# Used by `just full`: API on :4000, Next on :3000. Loads root .env; PORT=4000 overrides.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TSX_IGNORE='./src/interface/http/routes/register-contract-route.ts'

kill_port() {
  # Same pattern as `just _kill` — kills listeners so restarts are clean.
  lsof -ti ":$1" | xargs kill -9 2>/dev/null || true
}

stop_stack() {
  echo ""
  echo "Stopping full stack (freeing 4000, 3000)…"
  kill_port 4000
  kill_port 3000
  if [[ -n "${API_PID:-}" ]]; then
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    wait "$WEB_PID" 2>/dev/null || true
  fi
}

kill_port 4000
kill_port 3000
sleep 1

export PORT=4000
npx tsx watch --ignore "$TSX_IGNORE" src/main.ts &
API_PID=$!

sleep 1

(
  cd "$REPO_ROOT/web"
  export NEXT_PUBLIC_API_URL=http://localhost:4000
  exec pnpm run dev
) &
WEB_PID=$!

echo "API  → http://127.0.0.1:4000/health"
echo "Web  → http://127.0.0.1:3000  (Ctrl+C — ports 4000/3000 cleared)"
echo ""

trap 'stop_stack; exit 130' INT TERM

set +e
wait
set -e

stop_stack
