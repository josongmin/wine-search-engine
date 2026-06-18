import { describe, expect, it } from 'vitest';
import { combineDecisions } from '../../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import type { LookupDecision } from '../../../src/domain/resolver/v2/lookup-v2-types.js';

/**
 * T-ELV2-05: combineDecisions — most-conservative-status-wins, downgrade-only,
 * with a tie that surfaces the learned reason BUT never downgrades calibration
 * trust. The audit found the original tie returned `learned` verbatim, silently
 * flipping a calibrated trusted resolve to calibrationTrusted=false.
 */
function dec(
  status: LookupDecision['status'],
  calibrationTrusted: boolean,
  reasonCode = `${status}_reason`,
): LookupDecision {
  return { status, reasonCode, detail: `${status} detail`, topConfidence: 0.7, calibrationTrusted };
}

const STATUSES: LookupDecision['status'][] = ['failed', 'ambiguous', 'resolved'];
const RANK: Record<LookupDecision['status'], number> = { failed: 0, ambiguous: 1, resolved: 2 };

describe('combineDecisions — most-conservative-wins over all 9 status pairs', () => {
  it('always yields min(rank) status; learned can only tighten, never relax', () => {
    for (const cal of STATUSES) {
      for (const learned of STATUSES) {
        const out = combineDecisions(dec(cal, true), dec(learned, false));
        const expected = RANK[cal] <= RANK[learned] ? cal : learned;
        // min-rank status wins
        expect(out.status).toBe(RANK[cal] < RANK[learned] ? cal : RANK[learned] < RANK[cal] ? learned : cal);
        expect(RANK[out.status]).toBe(Math.min(RANK[cal], RANK[learned]));
        void expected;
      }
    }
  });

  it('a learned downgrade tightens a calibrated resolved (resolved+ambiguous → ambiguous)', () => {
    const out = combineDecisions(dec('resolved', true), dec('ambiguous', false));
    expect(out.status).toBe('ambiguous');
    expect(out.calibrationTrusted).toBe(false); // strictly-more-conservative learned carries its own trust
    expect(out.reasonCode).toBe('ambiguous_reason');
  });

  it('a learned resolve can NEVER relax a calibrated failed (failed+resolved → failed)', () => {
    const out = combineDecisions(dec('failed', true), dec('resolved', false));
    expect(out.status).toBe('failed');
    expect(out.calibrationTrusted).toBe(true); // calibrated wins, its trust preserved
  });

  it('TIE preserves the stronger trust: cal=resolved(trusted) + learned=resolved(untrusted) → resolved & trusted', () => {
    const out = combineDecisions(dec('resolved', true), dec('resolved', false, 'learned_rerank'));
    expect(out.status).toBe('resolved');
    expect(out.calibrationTrusted).toBe(true); // the fix — tie must not downgrade trust
    expect(out.reasonCode).toBe('learned_rerank'); // learned reason still surfaced
  });

  it('TIE with both untrusted stays untrusted', () => {
    const out = combineDecisions(dec('ambiguous', false), dec('ambiguous', false));
    expect(out.status).toBe('ambiguous');
    expect(out.calibrationTrusted).toBe(false);
  });
});
