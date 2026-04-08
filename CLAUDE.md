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

## Test discipline (Strict — no exceptions)

For any non-trivial code change, follow this exact order:

1. **Add a test that exercises the new behavior or the bug being fixed.** Run it, confirm it fails (or passes for the new feature) as expected.
2. **Make the code change.**
3. **Run the test, confirm it now passes.**
4. **Add at least one regression test for the most obvious adjacent case** that could break — happy-path inputs that previously worked, edge values (empty, zero, max), and the legitimate input shape closest to the bug.
5. **For any regex change**: test ASCII, Korean (한글), accented Latin (é, ñ), and emoji inputs. `\b` is ASCII-aware and silently breaks on non-ASCII boundaries.
6. **For any schema bound change** (`min`, `max`, `.refine`): justify the bound with a domain fact (RFC, real-world data). Add a test for a value JUST inside and JUST outside the bound.
7. **For any new `as` cast or `unknown` narrowing**: add a runtime guard test that exercises the rejection path.

8. **For any regex containing Korean (한글) or accented Latin (é, ñ)**: DO NOT use `\b`. Use `(?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}])` with `/u` flag. `\b` is ASCII-only and **silently fails** on non-ASCII word boundaries — this was the #1 bug class (50+ instances).
9. **For any `Math.max()` or `Math.min()` call**: NEVER use spread (`...array`). Use a loop. Spread pushes all elements onto the call stack and crashes on arrays > ~65K elements.
10. **For any Zod `z.object()`**: ALWAYS chain `.strict()` unless you have an explicit documented reason to allow extra properties.
11. **For any JSONB column read from PostgreSQL**: NEVER cast directly with `as DomainType`. Use a runtime type guard or Zod schema validation. DB data can be corrupted by migrations, ETL bugs, or manual edits.
12. **For any `JSON.parse()` result**: Cast to `unknown` first, then validate shape. NEVER `JSON.parse(x) as T`. Prefer `RedisCache.getValidated(key, schema)` over `.get<T>(key)`.
13. **For any schema bound change** (`min`, `max`): The bound MUST reference a named domain constant (not a magic number). Add a contract parity test that the HTTP schema and domain parser agree on the same bound.
14. **After applying any fix**: VERIFY the fix is actually in the file (`grep` or `Read`). Linter hooks and file watchers can revert changes silently — this happened multiple times during audit rounds 22-27.

15. **For any numeric constant used as a penalty, multiplier, threshold, or weight**: Extract it as a named `const` at module scope with a comment explaining the value. Magic numbers in scoring/penalty logic are unauditable — `score *= 0.7` tells the reader nothing; `score *= PENALTY_TOOL_DUPLICATE` tells them everything.
16. **For any `new Set()`, `new Map()`, or large literal array/object**: If the value is deterministic (same every call), define it at module scope. Allocating inside a function body wastes memory and hides the invariant.
17. **For any `for...of` loop with `break`**: Verify that breaking early is the correct semantic. If the loop should accumulate results from ALL iterations (penalties, violations, matches), removing `break` is almost certainly correct. Add a test with 2+ triggering elements to confirm.
18. **For any `Math.ceil(N/2)` or `Math.floor(N/2)` used as a threshold**: Document whether you want "≥50%" (ceil) or "strict majority >50%" (floor+1). Add boundary tests for N=1,2,3,4 — off-by-one in majority logic is the #2 bug class in voting/consensus code.

Regression tests live under `test/regression/<topic>.regression.test.ts` and are append-only — never delete a regression test.

## Self-audit pass (after multi-file refactors)

After any session that modifies more than 3 files, mentally test 3 inputs per changed function:
- **Empty input** (empty string, empty array, null, undefined where allowed)
- **Adversarial input** — what would a security researcher try? (special chars, length attacks, type confusion)
- **The obvious legitimate input** — the input the function was designed for, that previously worked

If any case is uncertain, add a regression test before declaring done. Audit-first beats fix-second.

## Schema quality bar (HTTP-facing Zod schemas)

- Every `z.number()` MUST include `.finite()` unless `.int()` is used (which already excludes NaN/Infinity).
- Every `z.array()` MUST include `.max(N)` with a domain-justified bound.
- Every JSONB/Redis deserialization MUST use Zod `.parse()` or a runtime type guard — `as DomainType` casts on external data are **prohibited**.
- Every `parseFloat()` / `Number()` on external input MUST be followed by a `Number.isFinite()` guard before use.
- Every `log.error({ err })` MUST flow through the pino `serializers.err` sanitizer — never log raw error objects from DB/HTTP clients (they carry SQL params, connection strings, user queries).
- Every HTTP error response (4xx/5xx) MUST conform to the RFC-014 error envelope shape `{ error: { request_id, code, message, failure_reason, retryable } }`. Add error-code branches to `error-handler.ts` for any new Fastify error code.
- Catch blocks in use-case code MUST NOT fabricate success-shaped (200 OK) responses from unexpected errors. Only enumerated, expected degradation paths may return degraded responses; unknown errors MUST throw to the HTTP error handler.
- `Math.random()` MUST NOT be used for ID generation — use `crypto.randomUUID()`.
- `\b` word boundary in regex MUST NOT be used with non-ASCII content — see rule 8 in test discipline.

## Private notes

Put machine-specific preferences in **`CLAUDE.local.md`** (gitignored) at the repo root.
