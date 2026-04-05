#!/usr/bin/env bash
set -euo pipefail

trap 'echo "❌ E2E failed, running teardown..."; bash scripts/teardown-vespa-test.sh' ERR

echo "🚀 Starting Vespa E2E test pipeline..."

# Setup
bash scripts/setup-vespa-test.sh

# Run E2E tests
export VESPA_URL=http://localhost:18080
export TEST_DB_URL=postgresql://wine:wine_test@localhost:5433/wine_engine_test
export TEST_REDIS_URL=redis://localhost:6380

npx vitest --config vitest.e2e.vespa.config.ts --reporter=verbose

echo "✅ All Vespa E2E tests passed!"

# Teardown (on success)
bash scripts/teardown-vespa-test.sh
