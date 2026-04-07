# Wine Search Engine — Claude Code

This repository is a **wine intelligence / search engine** backend: typed TypeScript on Node 22, Fastify HTTP API, PostgreSQL and Redis, with Vespa-related code under `src/infrastructure/vespa/`. Product and protocol details are in **`docs/RFC-*.md`**.

**HTTP debug & tracing requests:** agents read **`.ai/llm-debugging-playbook.md`** first; setup and limits: **`.ai/debug-mode.md`**. Canonical `step` strings: **`src/observability/pipeline-debug-steps.ts`**. Index: **`.ai/README.md`**.

## Commands

| Command | Purpose |
|--------|---------|
| `npm run dev` | Dev server with watch |
| `npm run build` | Production `tsc` (excludes `**/*.test.ts` and `__tests__` via `tsconfig.build.json`) |
| `npm run start` | Run `dist/` entry |
| `npm run lint` / `npm run lint:fix` | ESLint (type-checked rules for `src/`) |
| `npm run check:quick` | Fastest local check: lightweight test lane only |
| `npm run check:smart [changed-file...]` | Smart local check that skips docs-only changes, skips typecheck for test-only changes, and runs typecheck before the narrowest useful lane for source/config changes |
| `npm run lint:file -- <file...>` | ESLint only the given files, with a small cache for repeated local runs |
| `npm run lint:smart [changed-file...]` | Lint only changed lintable files; skip docs-only changes; fall back to full lint for large changed sets |
| `npm run check:related -- <changed-file...>` | Fastest changed-scope local check using Vitest `related` on the lightweight lane |
| `npm run check:dev` | Everyday local check: typecheck + lightweight test lane |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Lightweight everyday Vitest lane |
| `npm run test:file -- <test-file...>` | Run one or more explicit files in the lightweight lane; also forwards extra Vitest args like `--testNamePattern` |
| `npm run test:related -- <changed-file...>` | Run only tests related to the changed files in the lightweight lane |
| `npm run test:eval` | Eval/reporting-focused unit lane |
| `npm run test:meta` | Meta/parity lane for fixture/workflow/route consistency checks plus response/schema contract tests |
| `npm run test:unit` | Fuller unit regression lane |
| `npm run test:unit:file -- <test-file...>` | Explicit-file run inside the fuller unit lane; also forwards extra Vitest args |
| `npm run test:unit:related -- <changed-file...>` | Related-test run inside the fuller unit lane |
| `npm run test:integration:file -- <test-file...>` | Explicit-file run inside the integration lane; also forwards extra Vitest args |
| `npm run test:integration:related -- <changed-file...>` | Related-test run inside the integration lane |
| `npm run test:watchlist` | Watchlist-only lane |
| `npm run test:heavy` | Expensive search regression lane |
| `npm run test:e2e:contract` | Contract-only HTTP surface checks |
| `npm run test:e2e` | Default lightweight e2e entrypoint |
| `npm run test:e2e:fast` | In-memory fast e2e lane |
| `npm run test:e2e:inmemory` | Alias for the fast in-memory e2e lane |
| `npm run test:e2e:file -- <test-file...>` | Explicit-file run inside the in-memory e2e lane; also forwards extra Vitest args |
| `npm run test:e2e:related -- <changed-file...>` | Related-test run inside the in-memory e2e lane |
| `npm run test:e2e:runtime` | Runtime/quality-heavy e2e lane (`user-journeys`, `golden-set`, `specialized-modes-quality`) |
| `npm run test:e2e:vespa` | Vespa-backed e2e lane with setup/teardown |
| `npm run test:ingest:contract` | ETL/ingest contract checks for exported script helpers |
| `npm run test:quality:vespa` | Vespa-backed quality regression lane |
| `npm run verify:http-contracts` | OpenAPI/catalog parity (runs on `git:prepush`) |
| `npm run git:prepush` | Husky pre-push: typecheck + unit + `verify:http-contracts` |
| `npm run git:prepush:quick` | typecheck + unit only (skip HTTP contract check) |
| `npm run git:prepush:heavy` | Extended pre-push: `git:prepush` + heavy test lane |

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
