#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/run-vespa-test-lane.sh" npx vitest --config vitest.e2e.vespa.config.ts --reporter=verbose
