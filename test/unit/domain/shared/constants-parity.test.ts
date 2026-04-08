import { describe, expect, it } from 'vitest';
import { KRW_PER_USD } from '../../../../src/domain/query/service/search-constraint-extractor.js';
import {
  KRW_PER_MAN_WON,
  KRW_PER_USD_APPROXIMATE,
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
} from '../../../../src/domain/shared/constants.js';

/**
 * Contract: NL price extraction and Vespa YQL clamps must agree on the same
 * domain SSOT constants (CLAUDE.md schema / bound parity).
 */
describe('domain shared constants parity', () => {
  it('exposes KRW/USD rate identical to search-constraint-extractor export', () => {
    expect(KRW_PER_USD_APPROXIMATE).toBe(KRW_PER_USD);
  });

  it('fixes 만원 unit at 10_000 KRW for parsers and rule-based copy', () => {
    expect(KRW_PER_MAN_WON).toBe(10_000);
  });

  it('keeps produced vintage bounds aligned with HTTP / planner schemas', () => {
    expect(MIN_PRODUCED_VINTAGE_YEAR).toBe(1700);
    expect(MAX_PRODUCED_VINTAGE_YEAR).toBe(2200);
  });
});
