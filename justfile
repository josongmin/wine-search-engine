# Wine Search Engine — task runner (https://just.systems)
# Run `just` or `just --list` to see recipes. Full scripts: package.json, CLAUDE.md

# Default: show available recipes
default:
    @just --list

# Docker test stack overrides (wine-search-test: PG 5433, Redis 6380, Vespa 18080)
_test_env := "PORT=4000 PG_HOST=localhost PG_PORT=5433 PG_DATABASE=wine_engine_test PG_USER=wine PG_PASSWORD=wine_test REDIS_URL=redis://localhost:6380 VESPA_URL=http://localhost:18080 KILL_SWITCH_LEARNING=true"

# Dedicated app host deploy defaults
dedicated_region := "ap-northeast-2"
dedicated_app_instance_id := "i-0e28f63452c548a9f"
dedicated_app_repo := "527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine"
dedicated_app_container := "wine-search-engine"
dedicated_app_host_port := "4000"
dedicated_app_app_port := "3000"
dedicated_app_host_bind_ip := "0.0.0.0"
dedicated_app_env_file := "/etc/wine-search-engine.env"
dedicated_app_health_path := "/ready"
dedicated_app_base_url := "https://asommguide.shop:9011"

# Fastify API — tsx watch against Docker test stack
# --ignore prevents tsx from restarting on register-contract-route.ts changes (ESM path issue)
alias d := api
api:
    env {{_test_env}} npx tsx watch --ignore './src/interface/http/routes/register-contract-route.ts' src/main.ts

# Legacy alias: plain dev (uses whatever .env says)
dev:
    pnpm run dev

# Next.js frontend — points at local API
web:
    cd web && NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm run dev

# Kill any process listening on a given port
_kill port:
    @lsof -ti :{{port}} | xargs kill -9 2>/dev/null || true

# Backend + web: free :4000 and :3000, then start API (PORT=4000, rest from root `.env`) + Next (`NEXT_PUBLIC_API_URL=http://localhost:4000`). Ctrl+C clears both ports. For the Docker *test* stack (PG 5433, …) use `just up` + `just api` instead.
full:
    @bash scripts/dev/run-fullstack.sh

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
    curl -s -X POST http://localhost:4000/v1/search/hybrid \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"{{query}}\"}" | python3 -m json.tool

# Direct deploy from local workspace: build/push/rollout/verify
deploy-manual image_tag="":
    bash scripts/deploy/direct-deploy-dedicated-app.sh \
      --region "{{dedicated_region}}" \
      --instance-id "{{dedicated_app_instance_id}}" \
      --repository-uri "{{dedicated_app_repo}}" \
      --image-tag "{{image_tag}}" \
      --container-name "{{dedicated_app_container}}" \
      --host-port {{dedicated_app_host_port}} \
      --app-port {{dedicated_app_app_port}} \
      --host-bind-ip "{{dedicated_app_host_bind_ip}}" \
      --env-file "{{dedicated_app_env_file}}" \
      --health-path "{{dedicated_app_health_path}}" \
      --base-url "{{dedicated_app_base_url}}"

# Post-deploy endpoint verification on external path
verify-app-endpoints query="opus one" lookup_query="opus one" base_url="{{dedicated_app_base_url}}":
    @query='{{query}}'; lookup_query='{{lookup_query}}'; base_url='{{base_url}}'; \
    base_url="$${base_url%/}"; \
    for path in /health /ready /v1/search/hybrid /v1/search/semantic /v1/search/lexical /v1/lookup/wine /v1/agent; do \
      if [ "$$path" = "/health" ] || [ "$$path" = "/ready" ]; then \
        curl -fsS "$$base_url$$path" | python3 -m json.tool; \
      elif [ "$$path" = "/v1/lookup/wine" ]; then \
        curl -fsS -X POST "$$base_url$$path" -H "Content-Type: application/json" -d "{\"query\":\"$$lookup_query\"}" | python3 -m json.tool; \
      elif [ "$$path" = "/v1/agent" ]; then \
        curl -fsS -X POST "$$base_url$$path" -H "Content-Type: application/json" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$$query\"}]}" | python3 -m json.tool; \
      else \
        curl -fsS -X POST "$$base_url$$path" -H "Content-Type: application/json" -d "{\"query\":\"$$query\"}" | python3 -m json.tool; \
      fi; \
    done

# Map pre-commit/pre-push execution names to manual deploy flow
precommit image_tag="":
    just deploy-manual "{{image_tag}}"

prepush image_tag="":
    just deploy-manual "{{image_tag}}"

build:
    pnpm run build

start:
    pnpm run start

typecheck:
    pnpm run typecheck

lint:
    pnpm run lint

lint-fix:
    pnpm run lint:fix

test:
    pnpm run test

test-watch:
    pnpm run test:watch

test-integration:
    pnpm run test:integration

test-e2e-contract:
    pnpm run test:e2e:contract

test-e2e-runtime:
    pnpm run test:e2e:runtime

verify-http-contracts:
    pnpm run verify:http-contracts

# Husky pre-push gate (typecheck + unit + HTTP contract parity)
prepush-smart:
    pnpm run git:prepush:smart

prepush-quick:
    pnpm run git:prepush:quick

migrate:
    pnpm run migrate
