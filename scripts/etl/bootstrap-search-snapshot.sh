#!/usr/bin/env bash
#
# bootstrap-search-snapshot.sh — bring a fresh PG + Vespa up to a SERVING state.
#
# `etl:full` stops at `etl:index` (documents are in Vespa) but the runtime
# never serves search until a snapshot pointer is published to PG and the
# readiness probe (`GET /ready`) can verify pointer↔runtime↔Vespa parity.
# This script runs the WHOLE chain — silver transform → Vespa feed → snapshot
# build → canonical-graph ingest → publish → verify — so a clean deploy reaches
# `/ready == 200` in one command.
#
# PRECONDITIONS (this script does NOT do these):
#   - Bronze source rows present in PG: run `pnpm run vivino:bronze` first
#     (etl:silver reads Vivino `wine_pdp_snapshot` rows from PG, not a file).
#   - PG migrations applied: they auto-run on server boot, or run a migrate step.
#   - Vespa cluster reachable with the `wine_content` schema deployed
#     (the `vespa/app/` schema deploy is a separate, Vespa-side step).
#
# REQUIRED ENV:
#   DATABASE_URL (or PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD)
#   VESPA_URL                         e.g. https://<endpoint>:443
#   OPENAI_API_KEY (or OPENAI_API_KEYS)  — etl:doc-queries embeds doc2query text
#
# OPTIONAL ENV (operator acknowledgements — see docs/runbook-etl-operator-acks.md):
#   ETL_INDEX_PARTIAL_FAILURE_ACK=YES — proceed when some docs fail to index
#   ETL_PUBLISH_LTR_BYPASS_ACK=YES    — publish a snapshot with no LTR model
#   WINE_DATA_DIR                     — overrides artifact dir (default:
#                                       ~/.wine-search-engine/data if present,
#                                       else ./data)
#
# FLAGS:
#   --skip-doc-queries   skip etl:doc-queries (no OpenAI key / faster smoke run;
#                        dense doc2query field will be empty)
#   --skip-index         skip etl:index (Vespa already fed for this snapshot)
#
# Idempotent: re-running rebuilds + republishes a fresh snapshot pointer.

set -euo pipefail

SKIP_DOC_QUERIES=0
SKIP_INDEX=0
for arg in "$@"; do
  case "$arg" in
    --skip-doc-queries) SKIP_DOC_QUERIES=1 ;;
    --skip-index)       SKIP_INDEX=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── Preflight ──────────────────────────────────────────────────────────────
if [[ -z "${DATABASE_URL:-}" && -z "${PG_HOST:-}" ]]; then
  echo "FATAL: set DATABASE_URL (or PG_HOST/...) — ETL writes to and reads from PG." >&2
  exit 1
fi
if [[ -z "${VESPA_URL:-}" ]]; then
  echo "FATAL: set VESPA_URL — etl:index feeds documents and publish verifies the index." >&2
  exit 1
fi
if [[ "$SKIP_DOC_QUERIES" -eq 0 && -z "${OPENAI_API_KEY:-}" && -z "${OPENAI_API_KEYS:-}" ]]; then
  echo "FATAL: etl:doc-queries needs OPENAI_API_KEY (or OPENAI_API_KEYS)." >&2
  echo "       Re-run with --skip-doc-queries to bootstrap without dense doc2query." >&2
  exit 1
fi

# Resolve the artifact data dir the same way src/domain/shared/utils/data-paths.ts does,
# so we can read the runtime-state pointer the snapshot build writes.
DATA_DIR="${WINE_DATA_DIR:-}"
if [[ -z "$DATA_DIR" ]]; then
  if [[ -d "$HOME/.wine-search-engine/data" ]]; then
    DATA_DIR="$HOME/.wine-search-engine/data"
  else
    DATA_DIR="$PWD/data"
  fi
fi
RUNTIME_STATE_PATH="$DATA_DIR/runtime-search-snapshot.json"

stage() { echo ""; echo "▶▶▶ $* "; }

# ── Stage 1: source → silver artifacts ──────────────────────────────────────
stage "etl:silver (bronze PG rows → silver NDJSON)"
pnpm run etl:silver
stage "etl:aliases"
pnpm run etl:aliases
stage "etl:korean-aliases"
pnpm run etl:korean-aliases
if [[ "$SKIP_DOC_QUERIES" -eq 0 ]]; then
  stage "etl:doc-queries (OpenAI doc2query)"
  pnpm run etl:doc-queries
else
  echo "⏭  skipping etl:doc-queries (--skip-doc-queries)"
fi
stage "etl:track-c (contextual suitability scores)"
pnpm run etl:track-c
stage "etl:validate (silver schema consistency)"
pnpm run etl:validate

# ── Stage 2: feed Vespa ──────────────────────────────────────────────────────
if [[ "$SKIP_INDEX" -eq 0 ]]; then
  stage "etl:index (feed documents to Vespa)"
  pnpm run etl:index
else
  echo "⏭  skipping etl:index (--skip-index)"
fi

# ── Stage 3: build registry + snapshot manifest ──────────────────────────────
stage "etl:build-ambiguity-registry"
pnpm run etl:build-ambiguity-registry
stage "etl:build-search-snapshot (manifest + hashes + runtime-state pointer)"
pnpm run etl:build-search-snapshot

# Resolve the manifest path the build just wrote (runtime-state holds the pointer).
if [[ ! -f "$RUNTIME_STATE_PATH" ]]; then
  echo "FATAL: expected runtime-state at $RUNTIME_STATE_PATH after build-search-snapshot." >&2
  echo "       (set WINE_DATA_DIR if your data dir differs.)" >&2
  exit 1
fi
MANIFEST_PATH="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).manifestPath ?? '')" "$RUNTIME_STATE_PATH")"
if [[ -z "$MANIFEST_PATH" || ! -f "$MANIFEST_PATH" ]]; then
  echo "FATAL: could not resolve manifest path from $RUNTIME_STATE_PATH (got '$MANIFEST_PATH')." >&2
  exit 1
fi
echo "   manifest=$MANIFEST_PATH"

# ── Stage 4: canonical graph ingest + publish + verify ───────────────────────
stage "etl:ingest-canonical-entity-graph"
pnpm run etl:ingest-canonical-entity-graph -- --manifest "$MANIFEST_PATH"
stage "etl:publish-search-snapshot (write pointer to PG + substrates, verify parity)"
pnpm run etl:publish-search-snapshot
stage "etl:verify-search-snapshot (final gate — pointer↔runtime↔Vespa parity)"
pnpm run etl:verify-search-snapshot

echo ""
echo "✅ Bootstrap complete. The active search snapshot is published and verified."
echo "   Start the server and confirm: curl -fsS localhost:\${PORT:-3000}/ready"
