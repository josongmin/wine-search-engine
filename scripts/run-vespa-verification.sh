#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 Starting full Vespa verification lane..."

bash "$SCRIPT_DIR/run-vespa-test-lane.sh" bash -lc "
  cd '$REPO_ROOT'
  echo '▶ [1/3] Vespa E2E lane'
  npx vitest --config vitest.e2e.vespa.config.ts --reporter=verbose
  echo '▶ [2/3] Vespa network-services lane'
  npx vitest run test/e2e/vespa/search-network-services.test.ts --config vitest.e2e.vespa.config.ts --reporter=verbose
  echo '▶ [3/3] Vespa quality lane'
  npx vitest run --config vitest.quality.vespa.config.ts
"
