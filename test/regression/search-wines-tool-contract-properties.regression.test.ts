/**
 * Property-based input contract for the `search_wines` agent tool.
 *
 * The tool handler validates raw LLM tool input with
 * `SearchInputSchema.safeParse(sanitizeOptionalToolNulls(input))`. That Zod
 * schema is the deterministic, testable seam — independent of the LLM. These
 * properties fuzz the schema (fast-check, numRuns:100) to lock the contract:
 *   - valid inputs within all bounds parse
 *   - out-of-bound price / limit / vintage are rejected
 *   - non-enum wine_type / retrieval_mode are rejected
 *   - oversized and empty/whitespace queries are rejected
 *   - Korean queries parse and are preserved NFC-identical
 *
 * Bounds are imported from their SSoT modules where exported; the
 * agent-tools-private price bound is mirrored with a comment so drift is caught
 * by the in-bound/out-of-bound boundary properties below.
 *
 * Append-only regression test: never delete.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SearchInputSchema } from '../../src/application/agent/agent-tools.js';
import {
  SEARCH_TOOL_RETRIEVAL_MODES,
  SEARCH_TOOL_WINE_TYPES,
  SEARCH_TOOL_VINTAGE_MIN,
  SEARCH_TOOL_VINTAGE_MAX,
} from '../../src/application/search/search-tool-contract.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';

const NUM_RUNS = 100;

// Mirrors the private bounds in agent-tools.ts (SEARCH_LIMIT_MAX = 20,
// MAX_PRICE_KRW_BOUND = 100_000_000). The in-bound / out-of-bound boundary
// properties below fail loudly if either source constant drifts.
const SEARCH_LIMIT_MAX = 20;
const MAX_PRICE_KRW_BOUND = 100_000_000;

const isAccepted = (input: unknown): boolean => SearchInputSchema.safeParse(input).success;

describe('search_wines tool input contract (property-based)', () => {
  it('property: a fully in-bounds input is always accepted', () => {
    fc.assert(
      fc.property(
        fc.record({
          query: fc.string({ minLength: 1, maxLength: 80 }).filter((q) => q.trim().length > 0),
          wine_type: fc.constantFrom(...SEARCH_TOOL_WINE_TYPES),
          retrieval_mode: fc.constantFrom(...SEARCH_TOOL_RETRIEVAL_MODES),
          limit: fc.integer({ min: 1, max: SEARCH_LIMIT_MAX }),
          min_price_krw: fc.integer({ min: 1, max: MAX_PRICE_KRW_BOUND }),
        }),
        (raw) => {
          // Avoid the placeholder-pattern refinement (e.g. "tbd", "<x>") and the
          // min<=max price refinement by clamping to a single price field.
          const input = { query: raw.query.replace(/[<>{}_]/gu, 'x'), wine_type: raw.wine_type, retrieval_mode: raw.retrieval_mode, limit: raw.limit, min_price_krw: raw.min_price_krw };
          return isAccepted(input);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: out-of-bound price (<=0 or > MAX) is rejected', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 0 }),
          fc.integer({ min: MAX_PRICE_KRW_BOUND + 1, max: Number.MAX_SAFE_INTEGER }),
        ),
        (price) => {
          expect(isAccepted({ query: 'red wine', max_price_krw: price })).toBe(false);
          expect(isAccepted({ query: 'red wine', min_price_krw: price })).toBe(false);
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: wine_type outside the enum is rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => !(SEARCH_TOOL_WINE_TYPES as readonly string[]).includes(s),
        ),
        (wineType) => !isAccepted({ query: 'pinot', wine_type: wineType }),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: retrieval_mode outside the enum is rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => !(SEARCH_TOOL_RETRIEVAL_MODES as readonly string[]).includes(s),
        ),
        (mode) => !isAccepted({ query: 'pinot', retrieval_mode: mode }),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: a query longer than MAX_QUERY_LENGTH is rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_QUERY_LENGTH + 1, max: MAX_QUERY_LENGTH + 500 }),
        (len) => !isAccepted({ query: 'a'.repeat(len) }),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: limit must be within [1, SEARCH_LIMIT_MAX]; out-of-range rejected', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: SEARCH_LIMIT_MAX }), (limit) =>
        isAccepted({ query: 'merlot', limit }),
      ),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000, max: 0 }),
          fc.integer({ min: SEARCH_LIMIT_MAX + 1, max: 100_000 }),
        ),
        (limit) => !isAccepted({ query: 'merlot', limit }),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: vintage years outside [MIN, MAX] are rejected', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: SEARCH_TOOL_VINTAGE_MIN - 1 }),
          fc.integer({ min: SEARCH_TOOL_VINTAGE_MAX + 1, max: SEARCH_TOOL_VINTAGE_MAX + 5_000 }),
        ),
        (year) => {
          expect(isAccepted({ query: 'bordeaux', vintage_min: year })).toBe(false);
          expect(isAccepted({ query: 'bordeaux', vintage_max: year })).toBe(false);
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: Korean query is accepted and preserved NFC-identical', () => {
    // 한글 syllable blocks plus common wine surfaces, kept short and non-empty.
    const koreanArb = fc
      .stringMatching(/^[가-힣]{1,20}$/u)
      .filter((q) => q.trim().length > 0 && q.length <= MAX_QUERY_LENGTH);
    fc.assert(
      fc.property(koreanArb, (query) => {
        const parsed = SearchInputSchema.safeParse({ query });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          const out = (parsed.data as { query: string }).query;
          // NFC-preserving: trimmed input round-trips byte-identical after NFC.
          expect(out).toBe(query.normalize('NFC'));
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('property: empty / whitespace-only query is rejected', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ \t\n\r\u3000]*$/u),
        (blank) => !isAccepted({ query: blank }),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('regression: concrete in-bounds and rejection anchors', () => {
    // Adjacent legitimate happy-path that previously worked.
    expect(isAccepted({ query: '보르도 레드', wine_type: 'red', limit: 10 })).toBe(true);
    expect(isAccepted({ query: 'Pinot Noir 2020', vintage_min: SEARCH_TOOL_VINTAGE_MIN, vintage_max: SEARCH_TOOL_VINTAGE_MAX })).toBe(true);
    // Boundary: exactly at MAX_QUERY_LENGTH accepted, one over rejected.
    expect(isAccepted({ query: 'a'.repeat(MAX_QUERY_LENGTH) })).toBe(true);
    expect(isAccepted({ query: 'a'.repeat(MAX_QUERY_LENGTH + 1) })).toBe(false);
    // Boundary: limit 20 accepted, 21 rejected; price 1 accepted, 0 rejected.
    expect(isAccepted({ query: 'x', limit: SEARCH_LIMIT_MAX })).toBe(true);
    expect(isAccepted({ query: 'x', limit: SEARCH_LIMIT_MAX + 1 })).toBe(false);
    expect(isAccepted({ query: 'x', max_price_krw: 1 })).toBe(true);
    expect(isAccepted({ query: 'x', max_price_krw: 0 })).toBe(false);
    // Cross-field: min_price_krw > max_price_krw rejected by superRefine.
    expect(isAccepted({ query: 'x', min_price_krw: 50_000, max_price_krw: 10_000 })).toBe(false);
    // Placeholder query refinement.
    expect(isAccepted({ query: 'tbd' })).toBe(false);
    // Missing required query rejected.
    expect(isAccepted({ wine_type: 'red' })).toBe(false);
  });
});
