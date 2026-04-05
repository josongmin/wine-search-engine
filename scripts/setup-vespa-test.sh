#!/usr/bin/env bash
# setup-vespa-test.sh — Start test services, deploy Vespa schema, and seed data.
#
# Usage:
#   bash scripts/setup-vespa-test.sh
#
# Environment overrides:
#   VESPA_CONFIG_URL  — Vespa config server base URL  (default: http://localhost:19071)
#   VESPA_QUERY_URL   — Vespa query/feed base URL     (default: http://localhost:18080)
#   WAIT_TIMEOUT      — Seconds to wait for Vespa     (default: 120)

set -euo pipefail

VESPA_CONFIG_URL="${VESPA_CONFIG_URL:-http://localhost:19071}"
VESPA_QUERY_URL="${VESPA_QUERY_URL:-http://localhost:18080}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-120}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Step 1: Start services ────────────────────────────────────────────────────
echo "[setup] Starting docker-compose.test.yml services..."
docker compose -f "$REPO_ROOT/docker-compose.test.yml" up -d --wait || \
  docker compose -f "$REPO_ROOT/docker-compose.test.yml" up -d

# ── Step 2: Wait for Vespa config server ─────────────────────────────────────
echo "[setup] Waiting for Vespa config server at $VESPA_CONFIG_URL ..."
elapsed=0
until curl -sf "$VESPA_CONFIG_URL/state/v1/health" >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
    echo "[setup] ERROR: Vespa config server did not become healthy within ${WAIT_TIMEOUT}s." >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
echo "[setup] Vespa config server is up (${elapsed}s)."

# ── Step 3: Deploy Vespa application package via ZIP ─────────────────────────
echo "[setup] Deploying Vespa application package..."
(cd "$REPO_ROOT/vespa/app" && zip -r /tmp/vespa-app.zip .)

curl -X POST \
  "$VESPA_CONFIG_URL/application/v2/tenant/default/prepareandactivate" \
  -H "Content-Type: application/zip" \
  --data-binary @/tmp/vespa-app.zip \
  | tee /tmp/vespa-deploy.log
echo ""
echo "[setup] Schema deployment request sent."

# ── Step 4: Wait for Vespa content cluster (query port) ──────────────────────
echo "[setup] Waiting for Vespa query endpoint at $VESPA_QUERY_URL ..."
elapsed=0
until curl -sf "$VESPA_QUERY_URL/state/v1/health" >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$WAIT_TIMEOUT" ]; then
    echo "[setup] ERROR: Vespa query endpoint did not become healthy within ${WAIT_TIMEOUT}s." >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
echo "[setup] Vespa query endpoint is up (${elapsed}s)."

# ── Step 5: Apply Postgres migrations ────────────────────────────────────────
echo "[setup] Applying Postgres migrations..."
if ls "$REPO_ROOT/db/migrations/"*.sql >/dev/null 2>&1; then
  psql postgresql://wine:wine_test@localhost:5433/wine_engine_test \
    -f "$REPO_ROOT/db/migrations/"*.sql 2>/dev/null || true
  echo "[setup] Migrations applied."
else
  echo "[setup] No migrations found, skipping."
fi

# ── Step 6: Seed wine data ────────────────────────────────────────────────────
echo "[setup] Seeding wine data..."
if [ -f "$REPO_ROOT/scripts/seed-wines-real.ts" ]; then
  VESPA_URL="$VESPA_QUERY_URL" npx tsx "$REPO_ROOT/scripts/seed-wines-real.ts"
else
  VESPA_URL="$VESPA_QUERY_URL" npx tsx "$REPO_ROOT/scripts/seed-vespa-test-data.ts"
fi
echo "[setup] Seeding complete."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Vespa E2E environment ready"
