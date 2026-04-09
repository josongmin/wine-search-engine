# Bugbash prevention checklist (auto-applied to all code changes)

## Before submitting any code change, verify:

### Score/comparison patterns
- [ ] Every `.sort()` call has an explicit comparator function — JS default sort is lexicographic
- [ ] Every score comparison uses `Number.isFinite()` guard before `>` / `<` — NaN comparisons silently return false
- [ ] Equal-score ties are broken by a deterministic key (entityId, channel name) — not iteration order
- [ ] Use `pickMaxByScore` from `@shared/utils/stable-comparator.js` for "find best by score" loops

### Nullish safety
- [ ] Use `??` not `||` for defaults — `||` replaces valid `0` and `''`
- [ ] Use `!= null` not truthiness for "is present" checks on values that can be 0 or empty array
- [ ] `getOrEmbedBatch` pattern: check `.length > 0`, not just truthiness (empty arrays are truthy)

### SSoT discipline
- [ ] New channel-related code imports from `retrieval-channel.ts` — no private duplicates
- [ ] New RRF scoring code imports from `@shared/utils/rrf.ts`
- [ ] Circuit breakers registered via `globalCircuitBreakerRegistry.register()`

### External data boundaries
- [ ] JSONB from PG → Zod safeParse, not `as DomainType`
- [ ] Redis cache reads → validate shape before use
- [ ] Vespa responses → VespaQueryResponseSchema safeParse
- [ ] LLM JSON output → accept both `number` and `string` for numeric fields