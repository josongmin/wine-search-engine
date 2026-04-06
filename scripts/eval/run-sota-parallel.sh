#!/usr/bin/env bash
# SOTA++ parallel local gate — runs independent checks concurrently (Wave A / REMEDIATION-PLAN).
# Does NOT start Docker or SEARCH_API_URL; smoke eval spawns its own in-memory server.
#
# Usage: npm run eval:sota:parallel
#   or:  bash scripts/eval/run-sota-parallel.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

LOG_DIR="${TMPDIR:-/tmp}/wine-sota-parallel-$$"
mkdir -p "$LOG_DIR"
FAIL=0
pids=()

run_job() {
  local name=$1
  shift
  (
    if "$@" >"$LOG_DIR/${name}.log" 2>&1; then
      echo "[SOTA++] OK  ${name}"
    else
      echo "[SOTA++] FAIL ${name} — tail:"
      tail -20 "$LOG_DIR/${name}.log" | sed 's/^/  | /'
      exit 1
    fi
  ) &
  pids+=($!)
}

echo "[SOTA++] Parallel gate — logs: $LOG_DIR"
echo

run_job "typecheck" npm run typecheck
run_job "verify-splits" npx tsx scripts/eval/verify-splits.ts
run_job "eval-offline-smoke" npm run eval:offline:smoke
run_job "eval-noisy-validate" npm run eval:noisy:validate

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    FAIL=1
  fi
done

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "[SOTA++] All parallel jobs passed."
  exit 0
fi
echo "[SOTA++] One or more jobs failed (full logs under $LOG_DIR)."
exit 1
