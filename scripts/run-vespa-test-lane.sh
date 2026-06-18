#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/run-vespa-test-lane.sh <command...>" >&2
  exit 1
fi

cleanup() {
  local status=$?
  echo "🧹 Tearing down Vespa test environment..."
  bash "$SCRIPT_DIR/teardown-vespa-test.sh" || true
  return "$status"
}

trap cleanup EXIT

echo "🚀 Starting Vespa test lane..."
bash "$SCRIPT_DIR/setup-vespa-test.sh"

export VESPA_URL="http://localhost:18080"
export TEST_DB_URL="postgresql://wine:wine_test@localhost:5433/wine_engine_test"
export TEST_MODE="vespa"

echo "▶ Running: $*"
"$@"
