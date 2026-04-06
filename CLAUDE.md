# Wine Search Engine — Claude Code

This repository is a **wine intelligence / search engine** backend: typed TypeScript on Node 22, Fastify HTTP API, PostgreSQL and Redis, with Vespa-related code under `src/infrastructure/vespa/`. Product and protocol details are in **`docs/RFC-*.md`**.

## Commands

| Command | Purpose |
|--------|---------|
| `npm run dev` | Dev server with watch |
| `npm run build` | Production `tsc` (excludes `**/*.test.ts` and `__tests__` via `tsconfig.build.json`) |
| `npm run start` | Run `dist/` entry |
| `npm run lint` / `npm run lint:fix` | ESLint (type-checked rules for `src/`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest |
| `npm run test:e2e:contract` | Contract-only HTTP surface checks |
| `npm run test:e2e:fast` | Main in-memory fast e2e lane used in CI |
| `npm run test:e2e:inmemory` | Alias for `test:e2e:fast` |
| `npm run test:e2e:runtime` | Runtime/quality-heavy e2e lane (`user-journeys`, `golden-set`, `specialized-modes-quality`) |
| `npm run test:e2e:vespa` | Vespa-backed e2e lane with setup/teardown |
| `npm run test:ingest:contract` | ETL/ingest contract checks for exported script helpers |
| `npm run test:quality:vespa` | Vespa-backed quality regression lane |
| `npm run verify:http-contracts` | OpenAPI/catalog parity (runs on `git:prepush`) |
| `npm run git:prepush` | Husky pre-push: typecheck + unit + `verify:http-contracts` |
| `npm run git:prepush:quick` | typecheck + unit only (skip HTTP contract check) |

## Architecture (short)

- **`src/domain/`** — Entities, policies, pure logic; ports (interfaces) for infrastructure.
- **`src/application/`** — Use cases orchestrating domain + ports.
- **`src/infrastructure/`** — Adapters: `pg-*`, Redis, Vespa clients, etc.
- **`src/interface/`** — Fastify routes, CLI entrypoints.
- **`src/config/`** — Environment loading and composition root / DI-style wiring.

Path aliases: `@shared`, `@domain`, `@app`, `@infra`, `@interface`, `@config` (see `tsconfig.json`).

## Quality bar

- TypeScript: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- Do not fix unrelated files in the same change set.
- For optional object properties: **omit** keys instead of setting them to `undefined` when types use exact optional semantics.
- Redis: use the **`redis`** npm package and `src/infrastructure/db/redis-client.ts` (`getRedisClient` is **async**).

## Private notes

Put machine-specific preferences in **`CLAUDE.local.md`** (gitignored) at the repo root.
