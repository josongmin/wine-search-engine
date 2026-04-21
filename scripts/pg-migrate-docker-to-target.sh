#!/usr/bin/env bash
# Copy PostgreSQL data from local Docker Compose Postgres (default) to a target URL (e.g. RDS).
# Uses custom-format pg_dump + pg_restore with --clean so the target matches the source schema+data.
#
# Prerequisites:
#   - `psql` / `pg_restore` on PATH (Homebrew `libpq`) for the RDS side.
#   - **pg_dump** must match the *server* major version (Docker runs PG 16). If host `pg_dump` is newer
#     (e.g. libpq 18), it embeds session vars the RDS PG 16 rejects (`transaction_timeout`). This script
#     therefore prefers `docker compose exec postgres pg_dump` when the Compose service is up.
#
# Usage:
#   pnpm run db:copy:local-to-rds
#   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... ./scripts/pg-migrate-docker-to-target.sh
#   SKIP_CONFIRM=1 ./scripts/pg-migrate-docker-to-target.sh   # non-interactive
#
# RDS: security group must allow your current public IP on TCP 5432 (office/home IP changes).
# If restore dies mid-way with SSL EOF on a db.t4g.micro, re-run (uses --clean); keepalives + statement_timeout are enabled for long index/FK phases.
#
# Target resolution order: TARGET_DATABASE_URL → `.local/rds-wine-engine.credentials` (DATABASE_URL) → DATABASE_URL env.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -x /opt/homebrew/opt/libpq/bin/pg_dump ]]; then
  export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
fi

for cmd in pg_restore psql; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found. Install: brew install libpq && echo 'export PATH=\"/opt/homebrew/opt/libpq/bin:\$PATH\"' >> ~/.zshrc" >&2
    exit 1
  fi
done

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

# Alpine `pg_dump` custom format to stdout (`-f -`) can yield empty output; dump to a temp file and `docker compose cp` out.
IN_CONTAINER_DUMP="/tmp/wine_engine.pgdump"

compose_pg_dump_to_file() {
  local host_file="$1"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    sh -c "export PGPASSWORD=wine_dev && pg_dump -U wine -d wine_engine -Fc --no-owner --no-privileges -f ${IN_CONTAINER_DUMP}"
  docker compose -f "$COMPOSE_FILE" cp "postgres:${IN_CONTAINER_DUMP}" "$host_file"
  docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f "$IN_CONTAINER_DUMP" >/dev/null 2>&1 || true
}

can_use_compose_dump() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres true >/dev/null 2>&1
}

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-postgresql://wine:wine_dev@127.0.0.1:5432/wine_engine}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-}"

# Only use `docker compose exec ... pg_dump` when the source is the default Compose DB (PG 16 client in container).
DEFAULT_DOCKER_SRC='postgresql://wine:wine_dev@127.0.0.1:5432/wine_engine'
DEFAULT_DOCKER_SRC_LOCALHOST='postgresql://wine:wine_dev@localhost:5432/wine_engine'
source_is_compose_default() {
  [[ "$SOURCE_DATABASE_URL" == "$DEFAULT_DOCKER_SRC" || "$SOURCE_DATABASE_URL" == "$DEFAULT_DOCKER_SRC_LOCALHOST" ]]
}

CRED_FILE="${TARGET_CREDENTIALS_FILE:-.local/rds-wine-engine.credentials}"
if [[ -z "$TARGET_DATABASE_URL" && -f "$CRED_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CRED_FILE"
  set +a
  TARGET_DATABASE_URL="${TARGET_DATABASE_URL:-$DATABASE_URL}"
fi
if [[ -z "$TARGET_DATABASE_URL" && -n "${DATABASE_URL:-}" ]]; then
  TARGET_DATABASE_URL="$DATABASE_URL"
fi

if [[ -z "$TARGET_DATABASE_URL" ]]; then
  echo "error: set TARGET_DATABASE_URL or DATABASE_URL, or create $CRED_FILE with DATABASE_URL=..." >&2
  exit 1
fi

if [[ "$SOURCE_DATABASE_URL" == "$TARGET_DATABASE_URL" ]]; then
  echo "error: SOURCE_DATABASE_URL and target URL must differ." >&2
  exit 1
fi

DRY_RUN="${DRY_RUN:-0}"
SKIP_CONFIRM="${SKIP_CONFIRM:-0}"

is_rds_url() {
  [[ "$1" == *".rds.amazonaws.com"* ]]
}

dump_file="$(mktemp "${TMPDIR:-/tmp}/wine_engine_dump.XXXXXX")"
cleanup() {
  rm -f "$dump_file"
}
trap cleanup EXIT

pg_url_host() {
  U="$1" python3 -c 'import os; from urllib.parse import urlparse; print(urlparse(os.environ["U"]).hostname or "?")' 2>/dev/null || echo "?"
}
echo "==> Source host: $(pg_url_host "$SOURCE_DATABASE_URL")"
echo "==> Target host: $(pg_url_host "$TARGET_DATABASE_URL")"

echo "==> Checking source connectivity..."
PGSSLMODE=disable psql "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT 1 AS source_ok;" >/dev/null

echo "==> Checking target connectivity..."
if is_rds_url "$TARGET_DATABASE_URL"; then
  export PGSSLMODE=require
else
  export PGSSLMODE="${PGSSLMODE:-prefer}"
fi
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT 1 AS target_ok;" >/dev/null

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — would dump then restore. Exiting."
  exit 0
fi

if [[ "$SKIP_CONFIRM" != "1" ]]; then
  read -r -p "Target DB will be replaced (pg_restore --clean). Continue? [y/N] " ans
  ans_lc="$(echo "$ans" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ans_lc" != "y" && "$ans_lc" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "==> pg_dump (custom format, server-major matched)..."
if source_is_compose_default && can_use_compose_dump; then
  echo "    using: docker compose exec postgres pg_dump (same major as container — avoids PG17+ dump options)"
  compose_pg_dump_to_file "$dump_file"
else
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "error: pg_dump not found, and Docker Compose postgres is not running." >&2
    echo "  Start: pnpm run docker:db:up   OR install libpq: brew install libpq" >&2
    exit 1
  fi
  echo "    using: host pg_dump — if restore fails on RDS, start Docker PG and re-run (see script header)."
  PGSSLMODE=disable pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file="$dump_file" \
    "$SOURCE_DATABASE_URL"
fi

echo "==> pg_restore to target..."
# libpq 17+ clients may emit SET transaction_timeout, which PostgreSQL 16 rejects. Use PG 16 image for RDS.
PG_RESTORE_IMAGE="${PG_RESTORE_IMAGE:-postgres:16-alpine}"

# Long restores to RDS (many indexes + FK replay) can hit idle SSL disconnects on small instances; keepalives + no statement cap help.
rds_restore_dburl() {
  local url="$1"
  local extra='sslmode=require&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=6&connect_timeout=600'
  if [[ "$url" == *"?"* ]]; then
    echo "${url}&${extra}"
  else
    echo "${url}?${extra}"
  fi
}

pg_restore_to_target() {
  if is_rds_url "$TARGET_DATABASE_URL"; then
    echo "    using: docker $PG_RESTORE_IMAGE pg_restore (client major matches RDS PostgreSQL 16)"
    local restore_url
    restore_url="$(rds_restore_dburl "$TARGET_DATABASE_URL")"
    docker run --rm \
      -v "$dump_file:/dump:ro" \
      -e RESTORE_URL="$restore_url" \
      "$PG_RESTORE_IMAGE" \
      sh -c 'export PGSSLMODE=require PGOPTIONS="-c statement_timeout=0" && pg_restore --dbname="$RESTORE_URL" --no-owner --no-acl --clean --if-exists --exit-on-error --verbose /dump'
  else
    export PGSSLMODE="${PGSSLMODE:-prefer}"
    pg_restore \
      --dbname="$TARGET_DATABASE_URL" \
      --no-owner \
      --no-acl \
      --clean \
      --if-exists \
      --exit-on-error \
      --verbose \
      "$dump_file"
  fi
}

pg_restore_to_target

echo "==> Verifying row counts (entities / aliases)..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT 'entities' AS t, COUNT(*)::text AS n FROM entities
UNION ALL SELECT 'aliases', COUNT(*)::text FROM aliases
UNION ALL SELECT 'eval_cases', COUNT(*)::text FROM eval_cases;
"

echo "Done. Next: point app at TARGET DATABASE_URL + PG_SSL=true for RDS (see .env.example)."
