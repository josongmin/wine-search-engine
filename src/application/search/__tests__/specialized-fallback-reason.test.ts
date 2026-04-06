import { describe, expect, it } from 'vitest';
import { SPECIALIZED_FALLBACK_REASONS } from '../specialized-fallback-reason.js';

describe('SPECIALIZED_FALLBACK_REASONS', () => {
  it('keeps the specialized fallback taxonomy stable', () => {
    expect(SPECIALIZED_FALLBACK_REASONS).toMatchInlineSnapshot(`
      [
        "producer_browse_unavailable",
        "producer_browse_fallback",
        "region_browse_unavailable",
        "region_browse_fallback",
        "compare_retriever_unavailable",
        "compare_anchor_resolution_failed",
        "compare_candidates_fallback",
      ]
    `);
  });
});
