import { describe, expect, it } from 'vitest';
import {
  CalibratedAbstainDecider,
  LOOKUP_EXACT_EVIDENCE_CEILING,
} from '../../../src/domain/resolver/v2/calibrated-abstain-decider.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { EntityResolveResult } from '../../../src/domain/resolver/model/resolve-result.js';

function makeResult(opts: {
  status: 'resolved' | 'ambiguous' | 'failed';
  candidateCount: number;
  top1: number;
  gap?: number | undefined;
  trusted: boolean;
  resolveThreshold?: number;
  gapThreshold?: number;
  reasonCodes?: readonly string[];
}): EntityResolveResult {
  const candidates = Array.from({ length: opts.candidateCount }, (_, i) => ({
    entityId: createEntityId(`e-${i}`),
    canonicalLabel: `E${i}`,
    calibratedScore: i === 0 ? opts.top1 : opts.top1 - (opts.gap ?? 0),
    rank: i + 1,
    evidenceRefs: [],
  }));
  return {
    status: opts.status,
    candidates,
    topEntity:
      candidates[0] !== undefined
        ? { entityId: candidates[0].entityId, canonicalLabel: candidates[0].canonicalLabel, calibratedScore: candidates[0].calibratedScore }
        : undefined,
    decisionTrace: {
      queryClass: 'known-item',
      top1CalibratedScore: opts.top1,
      top2CalibratedScore: opts.gap !== undefined ? opts.top1 - opts.gap : undefined,
      calibratedGap: opts.gap,
      decisionConfidenceC: opts.top1,
      calibrationTrusted: opts.trusted,
      ambiguityDetected: opts.status === 'ambiguous',
      ambiguityTypes: [],
      appliedThresholds: {
        resolveThreshold: opts.resolveThreshold ?? 0.5,
        gapThreshold: opts.gapThreshold ?? 0.1,
      },
      outcomeReasonCodes: opts.reasonCodes ?? [],
    },
    conformalSetSize: opts.status === 'resolved' ? 1 : opts.candidateCount,
  };
}

const decider = new CalibratedAbstainDecider();

describe('CalibratedAbstainDecider (T-ELV2-05) — precision-first, downgrade-only', () => {
  it('resolves a high-confidence, clear-margin, trusted result', () => {
    const d = decider.decide(makeResult({ status: 'resolved', candidateCount: 1, top1: 0.9, trusted: true }), 'known-item');
    expect(d.status).toBe('resolved');
  });

  it('downgrades resolved → failed when confidence is below the resolve threshold', () => {
    const d = decider.decide(makeResult({ status: 'resolved', candidateCount: 2, top1: 0.4, gap: 0.3, trusted: true }), 'known-item');
    expect(d.status).toBe('failed');
    expect(d.reasonCode).toBe('below_resolve_threshold');
  });

  it('downgrades resolved → ambiguous when the top1-top2 margin is too narrow', () => {
    const d = decider.decide(makeResult({ status: 'resolved', candidateCount: 2, top1: 0.85, gap: 0.02, trusted: true }), 'known-item');
    expect(d.status).toBe('ambiguous');
    expect(d.reasonCode).toBe('narrow_margin');
  });

  it('abstains (ambiguous) on a resolved result when calibration is UNtrusted and evidence is not exact', () => {
    const d = decider.decide(makeResult({ status: 'resolved', candidateCount: 1, top1: 0.7, trusted: false }), 'known-item');
    expect(d.status).toBe('ambiguous');
    expect(d.reasonCode).toBe('uncalibrated_low_trust');
  });

  it('resolves under untrusted calibration ONLY at the exact-evidence ceiling', () => {
    const d = decider.decide(makeResult({ status: 'resolved', candidateCount: 1, top1: LOOKUP_EXACT_EVIDENCE_CEILING, trusted: false }), 'known-item');
    expect(d.status).toBe('resolved');
    expect(d.reasonCode).toBe('exact_identity_uncalibrated');
  });

  it('returns failed/no_match for an empty candidate set', () => {
    const d = decider.decide(makeResult({ status: 'failed', candidateCount: 0, top1: 0, trusted: false }), 'known-item');
    expect(d.status).toBe('failed');
    expect(d.reasonCode).toBe('no_match');
  });

  it('never upgrades: a resolver "failed"/"ambiguous" stays at least as conservative', () => {
    expect(decider.decide(makeResult({ status: 'failed', candidateCount: 2, top1: 0.95, gap: 0.5, trusted: true }), 'known-item').status).toBe('failed');
    expect(decider.decide(makeResult({ status: 'ambiguous', candidateCount: 2, top1: 0.95, gap: 0.5, trusted: true }), 'known-item').status).toBe('ambiguous');
  });
});
