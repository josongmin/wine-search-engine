#!/usr/bin/env bash
set -euo pipefail

test -f .env.example

cleanup() {
  if [ -f .env.bootstrap-smoke.bak ]; then
    mv .env.bootstrap-smoke.bak .env
  else
    rm -f .env
  fi
}

if [ -f .env ]; then
  cp .env .env.bootstrap-smoke.bak
fi
trap cleanup EXIT

cp -f .env.example .env

npm ci
npm run typecheck
npm run build
npm run verify:http-contracts
# Replay lane contract:
# - executable subset is selected by execution_lane='self_contained'
# - self-contained fixtures must not declare requires_runtime_capability
# - runtime-required fixtures execute in the dedicated capability-aware lane
npm run test:e2e:replay:fixtures:self-contained
npm run test:e2e:replay:fixtures:runtime-required
if [ "${SKIP_MIGRATE:-}" = "1" ]; then
  echo "SKIP_MIGRATE=1 — skipping npm run migrate (CI / no Docker Postgres)"
else
  npm run migrate
fi
