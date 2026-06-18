import { describe, it, expect } from 'vitest';
import { LOG_FACTOR } from '@domain/retrieval/service/cascade-router.js';

/**
 * Drift-lock for the cascade-router LOG_FACTOR heuristic prior.
 *
 * LOG_FACTOR (0.7) is an honestly-documented heuristic prior pending an offline
 * difficulty-sweep calibration (cascade-router.ts block comment). Until that
 * sweep runs, the value MUST NOT change silently — a quiet edit would shift
 * AND/OR route difficulty across the whole retrieval layer with no signal.
 * This test pins it: changing the value requires an explicit, intentional edit
 * to this assertion, which forces the author to acknowledge the heuristic and
 * (ideally) cite the calibration that justified the new value.
 *
 * APPEND-ONLY regression test — do not delete.
 */
describe('cascade-router LOG_FACTOR drift-lock (regression)', () => {
  it('LOG_FACTOR stays at its documented heuristic-prior value until calibrated', () => {
    // Changing this number? Cite the difficulty-sweep / RFC that justifies it.
    expect(LOG_FACTOR).toBe(0.7);
  });
});
