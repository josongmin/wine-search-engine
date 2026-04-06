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
if [ "${SKIP_MIGRATE:-}" = "1" ]; then
  echo "SKIP_MIGRATE=1 — skipping npm run migrate (set PG_* in .env for local full smoke)"
else
  npm run migrate
fi
