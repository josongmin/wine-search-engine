#!/usr/bin/env bash
set -euo pipefail
VESPA_URL="${VESPA_URL:-http://localhost:19071}"
echo "Deploying Vespa application..."
curl -s --retry 10 --retry-delay 5 --retry-connrefused \
  -X POST "$VESPA_URL/application/v2/tenant/default/prepareandactivate" \
  --data-binary @<(cd vespa/app && zip -r - .) \
  -H "Content-Type: application/zip"
echo "Vespa deployment complete"
