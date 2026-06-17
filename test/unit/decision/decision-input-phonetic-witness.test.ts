import { describe, expect, it } from 'vitest';
import {
  allowsApproximateIdentityTrustForQuery,
  hasTrustedUniqueApproximateIdentityWitness,
  hasUniquePhoneticIdentityWitness,
  hasUniqueFuzzyIdentityWitness,
} from '../../../src/domain/decision/model/decision-input.js';
import type { EvidenceSummary } from '../../../src/domain/decision/model/decision-input.js';
import type { ResolverDecisionTrace } from '../../../src/domain/resolver/model/resolve-result.js';

function makeTrace(
  overrides: Partial<ResolverDecisionTrace> = {},
): ResolverDecisionTrace {
  return {
    queryClass: 'short_entity',
    top1CalibratedScore: 0.86,
    top2CalibratedScore: undefined,
    calibratedGap: undefined,
    decisionConfidenceC: 0.86,
    calibrationTrusted: false,
    ambiguityDetected: false,
    ambiguityTypes: [],
    appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.03 },
    outcomeReasonCodes: [],
    ...overrides,
  };
}

function makeSummary(exactnessTier: EvidenceSummary['identityEvidence'] extends infer T
  ? T extends { exactnessTier: infer E }
    ? E
    : never
  : never): EvidenceSummary {
  return {
    identityEvidencePresent: true,
    identityEvidence: {
      source: 'identity_artifact',
      resolveTopEntityPresent: true,
      winnerIdentityArtifactPresent: true,
      winnerIdentityArtifactMatchesResolveResult: true,
      exactnessTier,
      identityEvidenceRefCount: 1,
    },
  };
}

describe('hasUniquePhoneticIdentityWitness', () => {
  it('accepts a singleton alias_phonetic witness', () => {
    expect(
      hasUniquePhoneticIdentityWitness(
        makeSummary('alias_phonetic'),
        makeTrace(),
      ),
    ).toBe(true);
  });

  it('rejects alias_fuzzy exactness (must use fuzzy witness instead)', () => {
    expect(
      hasUniquePhoneticIdentityWitness(
        makeSummary('alias_fuzzy'),
        makeTrace(),
      ),
    ).toBe(false);
    expect(
      hasUniqueFuzzyIdentityWitness(
        makeSummary('alias_fuzzy'),
        makeTrace(),
      ),
    ).toBe(true);
  });

  it('rejects non-unique phonetic matches with a defined calibrated gap', () => {
    expect(
      hasUniquePhoneticIdentityWitness(
        makeSummary('alias_phonetic'),
        makeTrace({ calibratedGap: 0.04, top2CalibratedScore: 0.82 }),
      ),
    ).toBe(false);
  });
});

describe('approximate identity trust surface', () => {
  it('reserves trust waiver for specific-SKU lookup queries', () => {
    expect(allowsApproximateIdentityTrustForQuery('opuss one')).toBe(true);
    expect(allowsApproximateIdentityTrustForQuery('Chateau Margxaux 2015')).toBe(true);
    expect(allowsApproximateIdentityTrustForQuery('샤토')).toBe(false);
    expect(allowsApproximateIdentityTrustForQuery('opu')).toBe(false);
  });

  it('withholds trusted witness on ambiguous short fragments even when phonetic is unique', () => {
    const summary = makeSummary('alias_phonetic');
    const trace = makeTrace();
    expect(hasUniquePhoneticIdentityWitness(summary, trace)).toBe(true);
    expect(
      hasTrustedUniqueApproximateIdentityWitness({
        queryPlan: { rawQuery: '샤토', queryClass: 'ambiguous_short_form' },
        evidenceSummary: summary,
        resolveResult: { decisionTrace: trace },
        uncertainty: { decisionEffect: 'none', sources: [] },
      }),
    ).toBe(false);
  });
});
