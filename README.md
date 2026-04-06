# wine-search-engine

Wine search backend built with Node 22, TypeScript, Fastify, PostgreSQL, Redis, and Vespa.

## Entry Points

- App bootstrap: `src/main.ts`
- Composition root: `src/config/container.ts`
- HTTP server: `src/interface/http/server.ts`
- Main search orchestration: `src/application/search/search.usecase.ts`

## Architecture

- `src/domain/`: core models, policies, ports, and pure decision logic
- `src/application/`: use cases that orchestrate domain services
- `src/infrastructure/`: adapters for Postgres, Redis, Vespa, ML, and webhooks
- `src/interface/`: HTTP routes, middleware, and Claude tool endpoints
- `src/config/`: environment loading and dependency wiring

RFCs under `docs/` remain the source of truth for behavior and terminology.

## Commands

- `npm run dev`: start the dev server with watch mode
- `npm run build`: compile production output
- `npm run start`: run the compiled app bootstrap (`dist/main.js`)
- `npm run typecheck`: check production TypeScript sources
- `npx tsc --noEmit -p tsconfig.tests.json`: check test helper TypeScript contracts
- `npm run test`: run Vitest
- `npm run test:watchlist`: run the watchlist-focused regression suite
- `npm run test:all`: run the main unit/integration/watchlist/e2e/quality regression stack
- `npm run contracts:http -- data/http-contract-manifest.json`: export the declared HTTP contract manifest
- `npm run contracts:http:openapi-bridge -- data/http-openapi-bridge.json`: export the OpenAPI bridge generated from route contracts
- `npm run verify:drinking-window-model -- models/drinking-window`: verify a drinking-window ONNX bundle contains the required files
- `npm run test:watchlist:pg`: run the real-Postgres watchlist storage integration test when `PG_TEST_URL` is set

## Test Lanes

- `npm run test:e2e:contract`: tiny HTTP-contract lane for route/schema surface checks
- `npm run test:e2e:fast`: main in-memory fast lane used by PR CI
- `npm run test:e2e:inmemory`: alias for the full in-memory e2e lane
- `npm run test:e2e:vespa`: Vespa-backed e2e lane with setup and teardown included
- `npm run test:e2e:vespa:only`: same Vespa lane wrapper, but emits verbose Vitest output
- `npm run test:e2e:vespa:network`: semi-full-stack Vespa lane that also verifies external ML HTTP adapters (`/embeddings`, `/rerank`)
- `npm run test:quality:vespa`: Vespa-backed quality regression lane, also wrapped
- `npm run test:verification:core`: core release gate (`typecheck + fast e2e + noisy quality gate + noisy baseline assert`)
- `npm run test:verification:vespa`: full Vespa verification lane (`vespa e2e + network-services + quality`)
- GitHub Actions mirrors this split:
  - PR / push CI runs the explicit `verification-core` gate
  - nightly runs `verification-core` first, then `verification:vespa`
- All Vespa-backed test lanes go through `scripts/run-vespa-test-lane.sh`, so setup, env, and teardown stay consistent.
- Vespa-backed suites now self-gate on `GET {VESPA_URL}/state/v1/health`, so a stray `VESPA_URL` value does not create false-red local runs.

Practical rule:
- use `contract` for fast protocol debugging
- use `fast` or `inmemory` for normal local regression work
- use `vespa` lanes only when validating live retrieval/ranking behavior
- use `vespa:network` when you specifically want `real Vespa + fake external ML services over HTTP`
- use `test:verification:core` when you want the current repo-level quality gate, not just raw test execution
- use `test:verification:vespa` for the closest thing to a nightly full-stack search verification pass in this repo

## HTTP Contract Surface

- Declared route catalog: `src/interface/http/routes/http-route-contract-catalog.ts`
- Route schema definitions: `src/interface/http/routes/route-contracts.ts`
- Export script: `scripts/export-http-contract-manifest.ts`
- OpenAPI bridge script: `scripts/export-http-openapi-bridge.ts`
- Integration checks:
  - `test/integration/http/routes/route-contract-registry.test.ts`
  - `test/integration/http/routes/http-contract-manifest-script.test.ts`
  - `test/integration/http/routes/http-contract-openapi-bridge.test.ts`

This repo now exports a generated OpenAPI bridge from the declared route contracts.
It is intentionally lightweight, but it is machine-readable and diffable. The
runtime source of truth remains the route contract catalog plus the exported artifacts.

## Runtime / Readiness

- `GET /health`: liveness probe only
- `GET /ready`: dependency readiness probe driven by `src/config/readiness.ts`
- Readiness currently checks:
  - Postgres when a pool is configured
  - Redis when startup expects Redis
  - watchlist delivery runtime when watchlist is enabled
  - Vespa
  - embedding service unless dense retrieval is disabled
  - learned matcher when configured
  - drinking-window model state as a non-required degradation check
  - reranker as optional

Operational note:
- Postgres is optional for local/runtime configurations that do not enable PG-backed adapters.
- Redis is optional unless watchlist delivery or other startup-required Redis features are enabled.
- Watchlist storage may fall back to in-memory in `development` and `test`, but `production` now requires PostgreSQL-backed watchlist storage whenever watchlist delivery is enabled.
- Query-entry security defaults to fail-closed if the LLM injection judge errors; set `INJECTION_JUDGE_FAIL_OPEN=true` only with explicit approval.
- Production resolver wiring requires trained calibration params; missing params now fail instead of silently passing raw scores through.
- Production startup refuses heuristic-only drinking-window prediction unless `ALLOW_HEURISTIC_DRINKING_WINDOW=true` is explicitly set.
- When `DRINKING_WINDOW_MODEL_DIR` points to a directory containing `window_start.onnx` and `window_end.onnx`, startup now attempts to load a real ONNX-backed drinking-window predictor. If that explicit model directory cannot be loaded, startup fails instead of silently falling back.
- Cached or heuristic drinking-window data is surfaced conservatively; heuristic or unknown model versions are not reported as high-confidence.
- Model bundle contract:
  [`docs/drinking-window-model-bundle.md`](/Users/songmin/wine-search-engine/docs/drinking-window-model-bundle.md)

## Watchlist Verification

- Canonical real-DB watchlist storage test: `test/integration/watchlist/pg-watchlist-store.integration.test.ts`
- Enable it with `PG_TEST_URL=postgresql://... npm run test:watchlist:pg`
- Recommended local env for delivery/runtime checks:
  - `WATCHLIST_ENABLED=true`
  - `WEBHOOK_SECRET=...`
  - `REDIS_URL=redis://localhost:6379`
