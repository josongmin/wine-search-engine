# ADR-001: Trust Boundary Inventory

## Status: Accepted

## Context

During bugbash rounds 1-15 we found 20+ instances where external data crossed into the domain layer without validation: JSONB columns cast with `as DomainType`, Redis cache entries parsed with `JSON.parse() as T`, HTTP headers trusted without charset validation, and LLM outputs flowing into tool dispatch without shape checks.

## Decision

Every point where external data enters the system is a **trust boundary** and MUST have runtime validation:

| Boundary | Validation Required |
|----------|-------------------|
| HTTP request body | Zod schema via `parseContractBody` |
| HTTP request headers | Charset + length validation (see `authenticated-subject.ts`) |
| HTTP request URL params | Format validation before passing to use cases |
| PostgreSQL JSONB columns | Zod `.parse()` or `isPlainObject` + field guards |
| Redis cache values | Structural validation before cast (see `redis-query-cache.ts`) |
| LLM API responses | Shape validation before destructuring (see `anthropic-llm-injection-classifier.ts`) |
| Vespa query responses | Per-hit structural validation (see `vespa-client.ts`) |
| File system reads | `JSON.parse` → `unknown` → validate |
| Environment variables | Zod schema in `env.ts` (already enforced) |

## Consequences

- `as DomainType` casts on data from any external source are prohibited (enforced via ESLint `warn` on pg/redis adapters)
- New adapters must include a validation layer in their code review checklist
- The `test/unit/meta/schema-quality-audit.test.ts` meta-test enforces schema completeness
