# Wine Search Engine — Claude Code

This repository is a **wine intelligence / search engine** backend: typed TypeScript on Node 22, Fastify HTTP API, PostgreSQL and Redis, with Vespa-related code under `src/infrastructure/vespa/`. Product and protocol details are in **`docs/RFC-*.md`**.

**HTTP debug & tracing requests:** agents read **`.ai/llm-debugging-playbook.md`** first; setup and limits: **`.ai/debug-mode.md`**. Canonical `step` strings: **`src/observability/pipeline-debug-steps.ts`**. Index: **`.ai/README.md`**.

**Assistant ↔ developer:** Use **Korean (한국어)** for natural-language explanations unless the user asks otherwise; keep code and identifiers consistent with existing English-heavy repo style.

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
10. **For any Zod `z.object()`**: ALWAYS chain `.strict()` unless you have an explicit documented reason to allow extra properties. **Exception**: Schemas that validate LLM-generated tool call input MUST NOT use `.strict()` — LLMs routinely emit extra fields (reasoning, confidence, metadata) and `.strict()` fails the entire validation on unrecognized keys, breaking the tool call.
11. **For any JSONB column read from PostgreSQL**: NEVER cast directly with `as DomainType`. Use a runtime type guard or Zod schema validation. DB data can be corrupted by migrations, ETL bugs, or manual edits.
12. **For any `JSON.parse()` result**: Cast to `unknown` first, then validate shape. NEVER `JSON.parse(x) as T`. Prefer `RedisCache.getValidated(key, schema)` over `.get<T>(key)`.
13. **For any schema bound change** (`min`, `max`): The bound MUST reference a named domain constant (not a magic number). Add a contract parity test that the HTTP schema and domain parser agree on the same bound.
14. **After applying any fix**: VERIFY the fix is actually in the file (`grep` or `Read`). Linter hooks and file watchers can revert changes silently — this happened multiple times during audit rounds 22-27.

15. **For any numeric constant used as a penalty, multiplier, threshold, or weight**: Extract it as a named `const` at module scope with a comment explaining the value. Magic numbers in scoring/penalty logic are unauditable — `score *= 0.7` tells the reader nothing; `score *= PENALTY_TOOL_DUPLICATE` tells them everything.
16. **For any `new Set()`, `new Map()`, or large literal array/object**: If the value is deterministic (same every call), define it at module scope. Allocating inside a function body wastes memory and hides the invariant.
17. **For any `for...of` loop with `break`**: Verify that breaking early is the correct semantic. If the loop should accumulate results from ALL iterations (penalties, violations, matches), removing `break` is almost certainly correct. Add a test with 2+ triggering elements to confirm.
18. **For any `Math.ceil(N/2)` or `Math.floor(N/2)` used as a threshold**: Document whether you want "≥50%" (ceil) or "strict majority >50%" (floor+1). Add boundary tests for N=1,2,3,4 — off-by-one in majority logic is the #2 bug class in voting/consensus code.
19. **For any `catch` block that sets a flag or state**: If the flag means "stop processing" (e.g. `policyBlocked`, `terminated`, `aborted`), add `break`/`return` immediately after. A flag without control flow is a silent bug — the loop continues executing with corrupted state. This was the #3 bug class (policy-blocked queries continued calling tools).
20. **For any budget/guard check in a loop**: Place the check BEFORE the expensive operation (LLM call, DB query, HTTP request), not after. A post-hoc check always allows one extra operation beyond the limit. Pre-flight checks prevent the waste entirely.
21. **For any `Number.toLocaleString()`**: NEVER use in code that generates machine-parseable output (queries, API calls, serialization). `toLocaleString()` is locale-dependent — produces `"70,000"` in en-US but `"70.000"` in de-DE. Use `.toString()` or template literal `${n}` for deterministic output.
22. **For any config with multiple related limits** (e.g. `maxSteps` + `maxTotalTokens` + `perStepTimeoutMs`): Verify the limits are **mutually consistent** — a maxSteps of 5 with maxTotalTokens of 20K means ~4K tokens/step, which may be less than the system prompt alone. Add a comment showing the arithmetic.
23. **For any security pattern (regex) that blocks queries**: Always add at least one false-positive test — a legitimate domain query that contains a substring of the blocked pattern. Example: blocking "other user" must NOT block "other wines". Without false-positive tests, overzealous patterns silently degrade user experience.
24. **For any Unicode regex boundary assertion**: Use `[\p{L}\p{N}]` (character class — letter OR digit), NOT `\p{L}\p{N}` (sequence — letter THEN digit). The latter requires a two-character match and silently fails as a word boundary. This was the #1 ingestion audit bug — vintage years were parsed as million-ml volumes.
25. **For any noise/keyword vocabulary shared across modules**: Maintain a single source-of-truth module. If two files have independent word lists for the same purpose (e.g. contamination detection vs noise stripping), differences WILL cause inconsistent behavior. Extract to a shared constant.
26. **For any `or`/`||`/`??` default on a value that can be legitimately zero**: Use explicit `None`/`undefined`/`null` check, not truthiness. `0 or default` / `value || default` silently replaces valid zero values. Python: `x if x is not None else default`. TypeScript: `x ?? default` (only for null/undefined, not 0).
27. **For any grape/wine-domain string splitting** (e.g. grape family from variety name): Use a lookup table for known multi-word terms before falling back to `split()[0]`. "Nero d'Avola" → "Nero" and "Sauvignon Blanc" → "Sauvignon" are wrong. Keep lookup tables in sync across Python and TypeScript ETL layers.
28. **For any `new Date(input).getTime()` on external data**: Guard with `Number.isFinite()` before comparison. Invalid date strings produce `NaN`, and NaN comparisons are always `false`, silently dropping records or bypassing sort logic.
29. **For any Python regex matching wine classification/producer terms**: Use `re.search(r'\b' + re.escape(term) + r'\b', text, re.IGNORECASE)` instead of `term in text`. Substring matching causes false positives: "Reserva" matches "Reservado", "Cave" matches "Excavation". Latin-only terms are safe with `\b`.

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
- When enriching/extending a validated string (e.g. appending query params to a search query), the **result** must be length-checked against downstream limits. Validation on the original input does NOT cover appended content.
- When parsing LLM JSON output, accept both `number` and `string` for numeric fields — LLMs routinely emit `"0.75"` instead of `0.75`. Use `typeof x === 'string' ? parseFloat(x) : x` with `Number.isFinite()` guard.
- Korean regex patterns in classifiers MUST avoid matching common syllables in isolation. `/원/` matches "원래" (originally); use `/\d+\s*원/` or `/만\s*원/` to require numeric context. Always test against 3+ common Korean words that contain the target syllable.

## Private notes

Put machine-specific preferences in **`CLAUDE.local.md`** (gitignored) at the repo root.
