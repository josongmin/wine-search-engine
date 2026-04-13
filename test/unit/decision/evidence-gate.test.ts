import { describe, it, expect } from 'vitest';
import { EvidenceGate } from '../../../src/domain/decision/service/evidence-gate.js';
import type {
  DecisionProvenanceContract,
  EvidenceSummary,
} from '../../../src/domain/decision/model/decision-input.js';
import {
  hasAnchorEvidence,
  hasConstraintEvidence,
  hasIdentityEvidence,
} from '../../../src/domain/decision/model/decision-input.js';

describe('EvidenceGate', () => {
  const gate = new EvidenceGate();

  function makeContract(
    evidence: EvidenceSummary | undefined,
    overrides: Partial<DecisionProvenanceContract['policy']> = {},
  ): DecisionProvenanceContract {
    return {
      policy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
        ...overrides,
      },
      observed: {
        identityEvidenceSatisfied: hasIdentityEvidence(evidence),
        constraintEvidenceSatisfied: hasConstraintEvidence(evidence),
        anchorEvidenceSatisfied: hasAnchorEvidence(evidence),
        topEntityPresent: false,
        rankedTopResultPresent: false,
        matchedConstraintAttributes: [],
        unmetConstraintAttributes: [],
        anchorSignalTypes: [],
      },
      missing: [
        ...(hasIdentityEvidence(evidence) ? [] : ['identity_evidence' as const]),
        ...((overrides.requireConstraintEvidence ?? false) &&
          !hasConstraintEvidence(evidence)
          ? ['constraint_evidence' as const]
          : []),
        ...((overrides.requireAnchorEvidence ?? false) &&
          !hasAnchorEvidence(evidence)
          ? ['anchor_evidence' as const]
          : []),
      ],
    };
  }

  describe('resolved + identity evidence present → passes', () => {
    it('returns passed=true when identity evidence is present', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: true };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(true);
    });

    it('does not set downgradeTo when passed', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: true };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.downgradeTo).toBeUndefined();
    });

    it('passes when ranked evidence agrees with resolver identity even without ranked evidence items', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        identityEvidence: {
          topEntityPresent: true,
          resolverTopCandidateMatchesTopEntity: true,
          resolverEvidenceRefCount: 1,
          rankedTopResultPresent: true,
          rankedTopResultMatchesTopEntity: true,
          rankedEvidenceItemCount: 0,
        },
      };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(true);
    });
  });

  describe('resolved + NO identity evidence → downgrade to ambiguous', () => {
    it('fails when identityEvidencePresent is false', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: false };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
      expect(result.downgradeAction).toBe('clarify');
    });

    it('fails when evidenceSummary is undefined', () => {
      const result = gate.check('resolved', undefined);
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('provides a human-readable reason', () => {
      const result = gate.check('resolved', undefined);
      expect(result.reason).toBeDefined();
      expect(result.reason?.toLowerCase()).toContain('identity');
    });

    it('fails when richer identity evidence shows ranked/resolver mismatch', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        identityEvidence: {
          topEntityPresent: true,
          resolverTopCandidateMatchesTopEntity: true,
          resolverEvidenceRefCount: 1,
          rankedTopResultPresent: true,
          rankedTopResultMatchesTopEntity: false,
          rankedEvidenceItemCount: 2,
        },
      };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });
  });

  describe('resolved + constraint evidence for constrained query → passes', () => {
    it('passes when constraints present and constraint evidence present', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: true,
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireConstraintEvidence: true }),
      );
      expect(result.passed).toBe(true);
    });

    it('fails when constraints present but constraint evidence is missing', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: false,
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireConstraintEvidence: true }),
      );
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('fails when constraints present but constraintEvidencePresent is undefined', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        // constraintEvidencePresent: not set
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireConstraintEvidence: true }),
      );
      expect(result.passed).toBe(false);
    });

    it('passes when constraint evidence is not required regardless of constraint evidence', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: false,
      };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(true);
    });
  });

  describe('ambiguous decision → no change by evidence gate', () => {
    it('always passes for ambiguous status', () => {
      // Even with no evidence at all
      const result = gate.check('ambiguous', undefined);
      expect(result.passed).toBe(true);
    });

    it('passes for ambiguous with no identity evidence', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: false };
      const result = gate.check(
        'ambiguous',
        makeContract(evidence, {
          requireConstraintEvidence: true,
          requireAnchorEvidence: true,
        }),
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('failed decision → no change by evidence gate', () => {
    it('always passes for failed status', () => {
      const result = gate.check('failed', undefined);
      expect(result.passed).toBe(true);
    });
  });

  describe('anchor evidence checks', () => {
    it('fails when anchor present but no anchor evidence', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: false,
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireAnchorEvidence: true }),
      );
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('passes when anchor present and anchor evidence present', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: true,
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireAnchorEvidence: true }),
      );
      expect(result.passed).toBe(true);
    });

    it('fails when richer anchor evidence shows no ranked anchor signal', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: true,
        anchorEvidence: {
          topEntityPresent: true,
          rankedTopResultPresent: true,
          rankedTopResultMatchesTopEntity: true,
          rankedSignalPresent: false,
        },
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireAnchorEvidence: true }),
      );
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('fails when mixed-route anchor resolution is missing even if ranked anchor signal exists', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: true,
        anchorResolution: {
          anchorEntityPresent: false,
        },
        anchorEvidence: {
          topEntityPresent: true,
          rankedTopResultPresent: true,
          rankedTopResultMatchesTopEntity: true,
          rankedSignalPresent: true,
        },
      };
      const result = gate.check(
        'resolved',
        makeContract(evidence, { requireAnchorEvidence: true }),
      );
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('passes when anchor evidence is not required regardless of anchor evidence', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: false,
      };
      const result = gate.check('resolved', makeContract(evidence));
      expect(result.passed).toBe(true);
    });
  });
});
