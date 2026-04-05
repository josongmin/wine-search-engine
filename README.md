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
