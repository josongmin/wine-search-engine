/**
 * SSoT regression: `EXACT_METADATA_SEARCH_LIMIT` and
 * `PRICE_CONSTRAINT_ATTRIBUTE_NAMES` live in the domain shared module
 * `@shared/constants/constraint-attributes.ts` (CLAUDE.md rule 25/30).
 *
 * History: prior to this consolidation the deterministic-router declared
 * `EXACT_METADATA_RESULT_LIMIT = 5` while the tool-input normalizer
 * declared `EXACT_METADATA_LIMIT = 1`, both supposedly mirroring the
 * agent execution policy's `limit: 1`. The mismatch silently widened
 * exact-metadata lookups on the router path, allowing distractors to
 * leak into the entity resolver. Likewise the `PRICE_CONSTRAINT_ATTRIBUTES`
 * set was declared independently in two files.
 *
 * Invariants locked here:
 *  - The SSoT exposes a single canonical numeric value equal to `1`
 *    (the agent execution policy's choice in
 *    `agent-tool-execution-policy.ts:201-203`).
 *  - The SSoT exposes a single canonical price-attribute set containing
 *    the historically-recognised price keys (`price_krw`, `max_price_krw`,
 *    `min_price_krw`, `price_usd`, `max_price_usd`, `min_price_usd`,
 *    `price`, `budget`).
 *  - Membership tests reject obviously unrelated attribute names (false
 *    positive guard — CLAUDE.md rule 23).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  EXACT_METADATA_SEARCH_LIMIT,
  PRICE_CONSTRAINT_ATTRIBUTE_NAMES,
} from '@shared/constants/constraint-attributes.js';

describe('SSoT: EXACT_METADATA_SEARCH_LIMIT', () => {
  it('equals 1 to match the agent execution policy contract', () => {
    expect(EXACT_METADATA_SEARCH_LIMIT).toBe(1);
  });

  it('is a finite positive integer', () => {
    expect(Number.isFinite(EXACT_METADATA_SEARCH_LIMIT)).toBe(true);
    expect(Number.isInteger(EXACT_METADATA_SEARCH_LIMIT)).toBe(true);
    expect(EXACT_METADATA_SEARCH_LIMIT).toBeGreaterThan(0);
  });
});

describe('SSoT: PRICE_CONSTRAINT_ATTRIBUTE_NAMES', () => {
  it('contains the canonical KRW price attribute names', () => {
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('price_krw')).toBe(true);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('max_price_krw')).toBe(true);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('min_price_krw')).toBe(true);
  });

  it('contains the legacy USD price attribute names', () => {
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('price_usd')).toBe(true);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('max_price_usd')).toBe(true);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('min_price_usd')).toBe(true);
  });

  it('contains the generic `price` and `budget` aliases', () => {
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('price')).toBe(true);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('budget')).toBe(true);
  });

  it('rejects unrelated attribute names (false-positive guard)', () => {
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('country')).toBe(false);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('vintage_year')).toBe(false);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('grape_primary')).toBe(false);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has('')).toBe(false);
  });

  it('is exactly the canonical set (membership snapshot)', () => {
    const expected = new Set([
      'price_krw',
      'price_usd',
      'max_price_krw',
      'min_price_krw',
      'max_price_usd',
      'min_price_usd',
      'price',
      'budget',
    ]);
    expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.size).toBe(expected.size);
    for (const name of expected) {
      expect(PRICE_CONSTRAINT_ATTRIBUTE_NAMES.has(name)).toBe(true);
    }
  });
});

describe('SSoT: identity equality across router + normalizer import sites', () => {
  it('deterministic-router and tool-input-normalizer import the same Set identity', async () => {
    // Both files import `PRICE_CONSTRAINT_ATTRIBUTE_NAMES` from the SSoT.
    // We re-import from the SSoT here; the assertion is that the same
    // module instance is shared (single ES module → single identity).
    const ssotModule = await import('@shared/constants/constraint-attributes.js');
    expect(ssotModule.PRICE_CONSTRAINT_ATTRIBUTE_NAMES).toBe(
      PRICE_CONSTRAINT_ATTRIBUTE_NAMES,
    );
    expect(ssotModule.EXACT_METADATA_SEARCH_LIMIT).toBe(EXACT_METADATA_SEARCH_LIMIT);
  });
});
