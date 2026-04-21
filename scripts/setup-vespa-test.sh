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
MIGRATIONS_DIR="$REPO_ROOT/src/infrastructure/db/migrations"
docker exec -i wine-search-test-postgres-1 \
  psql postgresql://wine:wine_test@localhost:5432/wine_engine_test \
  -v ON_ERROR_STOP=1 \
  -c "ALTER USER wine WITH PASSWORD 'wine_test';"
if ls "$MIGRATIONS_DIR/"*.sql >/dev/null 2>&1; then
  for migration in "$MIGRATIONS_DIR/"*.sql; do
    docker exec -i wine-search-test-postgres-1 \
      psql postgresql://wine:wine_test@localhost:5432/wine_engine_test \
      -v ON_ERROR_STOP=1 < "$migration"
  done
  echo "[setup] Migrations applied."
else
  echo "[setup] No migrations found, skipping."
fi

# ── Step 6: Seed wine data ────────────────────────────────────────────────────
echo "[setup] Seeding wine data..."
if [ -f "$REPO_ROOT/scripts/seed-wines-real.ts" ]; then
  # Force deterministic embeddings in the Vespa test lane so seeding stays
  # self-contained even when .env points at a local embedding service.
  USE_REAL_EMBEDDINGS="false" VESPA_URL="$VESPA_QUERY_URL" \
    npx tsx "$REPO_ROOT/scripts/seed-wines-real.ts"
else
  VESPA_URL="$VESPA_QUERY_URL" npx tsx "$REPO_ROOT/scripts/seed-vespa-test-data.ts"
fi
echo "[setup] Seeding complete."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Vespa E2E environment ready"
