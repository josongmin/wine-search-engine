/**
 * Regression: MAX_QUERY_LENGTH bound raised 500 → 2000.
 *
 * Why this changed: the agent CLI / multi-turn flows compose prior conversation
 * context into a single STATELESS query string. The old 500-char cap ("legitimate
 * single-shot queries never approach 500") rejected those context-rich queries.
 * 2000 is the regex-screening ceiling (`MAX_QUERY_LENGTH_FOR_REDOS_GUARD` in
 * query-sanitizer.ts): the largest input at which injection patterns are still
 * evaluated. It is therefore the principled upper bound — never raise above it
 * without re-auditing the injection regexes for catastrophic backtracking.
 *
 * Guards (CLAUDE.md test-discipline rule 6 & 13):
 *  - value JUST inside the bound is accepted
 *  - value JUST outside the bound is rejected
 *  - HTTP schema (QueryStringSchema) and the sanitizer agree on the same bound
 *    (parity — no drift between transport validation and the security gate)
 */
import { describe, it, expect } from 'vitest';
import { QuerySanitizer } from '../../src/domain/security/service/query-sanitizer.js';
import { QueryStringSchema } from '../../src/interface/http/schemas/search-shared.schema.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';

describe('MAX_QUERY_LENGTH bound (500 → 2000)', () => {
  const sanitizer = new QuerySanitizer();

  it('pins the bound at the regex-screening ceiling (2000)', () => {
    // If this fails, someone changed the constant. Re-read the rationale above:
    // raising past 2000 bypasses injection screening; lowering re-breaks
    // multi-turn context queries. Either way it is a deliberate decision.
    expect(MAX_QUERY_LENGTH).toBe(2_000);
  });

  it('accepts an ASCII query exactly AT the bound', () => {
    // NFKC normalization does not change plain ASCII length, so length is stable.
    const atBound = 'a'.repeat(MAX_QUERY_LENGTH);
    const result = sanitizer.sanitize(atBound);
    expect(result.safe).toBe(true);
  });

  it('rejects an ASCII query JUST over the bound', () => {
    const overBound = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    const result = sanitizer.sanitize(overBound);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toBe('LENGTH_EXCEEDED');
    }
  });

  it('now accepts a context-rich query in the old 501–2000 dead zone', () => {
    // This is exactly the multi-turn CLI case: a legitimate query that the old
    // 500 cap would have rejected. Use a realistic wine sentence repeated.
    const ctx = '이전 질문: 피자에 어울리는 와인 추천. 후속: 그중에 5만원 이하만. ';
    let query = '';
    while (query.length < 1_500) query += ctx;
    query = query.slice(0, 1_500);
    expect(query.length).toBeGreaterThan(500);
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    const result = sanitizer.sanitize(query);
    expect(result.safe).toBe(true);
  });

  // ── parity: HTTP transport schema must agree with the domain/security bound ──
  it('HTTP QueryStringSchema accepts AT the bound and rejects over it (parity)', () => {
    const atBound = 'a'.repeat(MAX_QUERY_LENGTH);
    const overBound = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    expect(QueryStringSchema.safeParse(atBound).success).toBe(true);
    expect(QueryStringSchema.safeParse(overBound).success).toBe(false);
  });
});
