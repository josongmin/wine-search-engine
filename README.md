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
- `npm run start`: run the compiled server
- `npm run typecheck`: check production TypeScript sources
- `npx tsc --noEmit -p tsconfig.tests.json`: check test helper TypeScript contracts
- `npm run test`: run Vitest
- `npm run contracts:http -- data/http-contract-manifest.json`: export the declared HTTP contract manifest
- `npm run test:watchlist:pg`: run the real-Postgres watchlist storage integration test when `PG_TEST_URL` is set

## HTTP Contract Surface

- Declared route catalog: `src/interface/http/routes/http-route-contract-catalog.ts`
- Route schema definitions: `src/interface/http/routes/route-contracts.ts`
- Export script: `scripts/export-http-contract-manifest.ts`
- Integration checks:
  - `test/integration/http/routes/route-contract-registry.test.ts`
  - `test/integration/http/routes/http-contract-manifest-script.test.ts`

This repo does not yet generate OpenAPI/Swagger. The current source of truth for
the public HTTP surface is the route contract catalog plus the exported manifest.

## Runtime / Readiness

- `GET /health`: liveness probe only
- `GET /ready`: dependency readiness probe driven by `src/config/readiness.ts`
- Readiness currently checks:
  - Postgres when a pool is configured
  - Redis when startup expects Redis
  - watchlist delivery runtime when watchlist is enabled
  - Vespa
  - embedding service unless dense retrieval is disabled
  - reranker as optional

Operational note:
- Postgres is optional for local/runtime configurations that do not enable PG-backed adapters.
- Redis is optional unless watchlist delivery or other startup-required Redis features are enabled.
- Watchlist storage may fall back to in-memory in `development` and `test`, but `production` now requires PostgreSQL-backed watchlist storage whenever watchlist delivery is enabled.

## Watchlist Verification

- Canonical real-DB watchlist storage test: `test/integration/watchlist/pg-watchlist-store.integration.test.ts`
- Enable it with `PG_TEST_URL=postgresql://... npm run test:watchlist:pg`
- Recommended local env for delivery/runtime checks:
  - `WATCHLIST_ENABLED=true`
  - `WEBHOOK_SECRET=...`
  - `REDIS_URL=redis://localhost:6379`
