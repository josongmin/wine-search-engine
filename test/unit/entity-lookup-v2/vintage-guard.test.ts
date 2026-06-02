import { describe, expect, it } from 'vitest';
import {
  shouldDowngradeForVintageMismatch,
  VINTAGE_MISMATCH_REASON_CODE,
} from '../../../src/domain/resolver/v2/vintage-guard.js';

/**
 * T-ELV2-08 cutover blocker: `오퍼스원 2019` must NOT wrong-resolve to
 * `Opus One 2018`. The guard downgrades that resolve to ambiguous; matching or
 * absent vintages do not downgrade (precision-first, exact year compare).
 */
describe('shouldDowngradeForVintageMismatch', () => {
  it('downgrades when the query vintage differs from the candidate vintage (the cutover blocker)', () => {
    expect(shouldDowngradeForVintageMismatch('오퍼스원 2019', 'Opus One 2018')).toBe(true);
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', 'Opus One 2018')).toBe(true);
  });

  it('does NOT downgrade when the vintages match', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2018', 'Opus One 2018')).toBe(false);
    expect(shouldDowngradeForVintageMismatch('오퍼스원 2018', 'Opus One 2018')).toBe(false);
  });

  it('does NOT downgrade when the query has no explicit vintage', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One', 'Opus One 2018')).toBe(false);
    expect(shouldDowngradeForVintageMismatch('오퍼스원', 'Opus One 2018')).toBe(false);
  });

  it('does NOT downgrade when the candidate label has no vintage (nothing to contradict)', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', 'Opus One')).toBe(false);
  });

  it('does NOT downgrade when there is no candidate label', () => {
    expect(shouldDowngradeForVintageMismatch('Opus One 2019', undefined)).toBe(false);
  });

  it('exposes a stable reason code', () => {
    expect(VINTAGE_MISMATCH_REASON_CODE).toBe('vintage_mismatch_downgrade');
  });
});
