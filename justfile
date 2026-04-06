# Wine Search Engine — task runner (https://just.systems)
# Run `just` or `just --list` to see recipes. Full scripts: package.json, CLAUDE.md

# Default: show available recipes
default:
    @just --list

# Docker test stack overrides (wine-search-test: PG 5433, Redis 6380, Vespa 18080)
_test_env := "PORT=4000 PG_HOST=localhost PG_PORT=5433 PG_DATABASE=wine_engine_test PG_USER=wine PG_PASSWORD=wine_test REDIS_URL=redis://localhost:6380 VESPA_URL=http://localhost:18080 KILL_SWITCH_LEARNING=true"

# Fastify API — tsx watch against Docker test stack
# --ignore prevents tsx from restarting on register-contract-route.ts changes (ESM path issue)
alias d := api
api:
    env {{_test_env}} npx tsx watch --ignore './src/interface/http/routes/register-contract-route.ts' src/main.ts

# Legacy alias: plain dev (uses whatever .env says)
dev:
    npm run dev

# Next.js frontend — points at local API
web:
    cd web && NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev

# Kill any process listening on a given port
_kill port:
    @lsof -ti :{{port}} | xargs kill -9 2>/dev/null || true

# Backend + frontend together (kills existing processes on 3000/4000 first)
full:
    @echo "Clearing ports 4000 and 3000..."
    @just _kill 4000
    @just _kill 3000
    @sleep 1
    @echo "Starting backend (4000) + frontend (3000)..."
    @env {{_test_env}} npx tsx watch --ignore './src/interface/http/routes/register-contract-route.ts' src/main.ts & cd web && NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev

# ── Docker infra ─────────────────────────────────────────────────────────────

# Start test infra (PG 5433 / Redis 6380 / Vespa 18080)
up:
    docker compose -f docker-compose.test.yml up -d

# Stop test infra
down:
    docker compose -f docker-compose.test.yml down

# ── Health / smoke ────────────────────────────────────────────────────────────

# Check backend health
health:
    curl -s http://localhost:4000/health | python3 -m json.tool

# Quick search smoke-test (override query: just smoke "피노 누아")
smoke query="보르도 레드 와인":
    curl -s -X POST http://localhost:4000/v1/search \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"{{query}}\"}" | python3 -m json.tool

build:
    npm run build

start:
    npm run start

typecheck:
    npm run typecheck

lint:
    npm run lint

lint-fix:
    npm run lint:fix

test:
    npm run test

test-watch:
    npm run test:watch

test-integration:
    npm run test:integration

test-e2e-contract:
    npm run test:e2e:contract

test-e2e-runtime:
    npm run test:e2e:runtime

verify-http-contracts:
    npm run verify:http-contracts

# Husky pre-push gate (typecheck + unit + HTTP contract parity)
prepush:
    npm run git:prepush

prepush-quick:
    npm run git:prepush:quick

migrate:
    npm run migrate
