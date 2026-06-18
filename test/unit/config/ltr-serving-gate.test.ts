import { describe, expect, it } from 'vitest';
import { isLtrServingEnabled } from '../../../src/config/ltr-serving-mode.js';

/**
 * T-ELV2-05: the LTR serving master gate must read config, not a hardcoded
 * literal. (Before the fix it was `return false`, which made the learned
 * reranker dead in prod — a kill-switch the audit flagged.)
 */
describe('isLtrServingEnabled', () => {
  it('returns true when config.ltrServingEnabled is true', () => {
    expect(isLtrServingEnabled({ ltrServingEnabled: true })).toBe(true);
  });

  it('returns false when config.ltrServingEnabled is false', () => {
    expect(isLtrServingEnabled({ ltrServingEnabled: false })).toBe(false);
  });
});
