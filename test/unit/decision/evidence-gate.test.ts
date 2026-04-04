import { describe, it, expect } from 'vitest';
import { EvidenceGate } from '../../../src/domain/decision/service/evidence-gate.js';
import type { EvidenceSummary } from '../../../src/domain/decision/model/decision-input.js';

describe('EvidenceGate', () => {
  const gate = new EvidenceGate();

  describe('resolved + identity evidence present → passes', () => {
    it('returns passed=true when identity evidence is present', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: true };
      const result = gate.check('resolved', evidence, false, false);
      expect(result.passed).toBe(true);
    });

    it('does not set downgradeTo when passed', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: true };
      const result = gate.check('resolved', evidence);
      expect(result.downgradeTo).toBeUndefined();
    });
  });

  describe('resolved + NO identity evidence → downgrade to ambiguous', () => {
    it('fails when identityEvidencePresent is false', () => {
      const evidence: EvidenceSummary = { identityEvidencePresent: false };
      const result = gate.check('resolved', evidence);
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
      expect(result.reason).toContain('identity');
    });
  });

  describe('resolved + constraint evidence for constrained query → passes', () => {
    it('passes when constraints present and constraint evidence present', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: true,
      };
      const result = gate.check('resolved', evidence, true, false);
      expect(result.passed).toBe(true);
    });

    it('fails when constraints present but constraint evidence is missing', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: false,
      };
      const result = gate.check('resolved', evidence, true, false);
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('fails when constraints present but constraintEvidencePresent is undefined', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        // constraintEvidencePresent: not set
      };
      const result = gate.check('resolved', evidence, true, false);
      expect(result.passed).toBe(false);
    });

    it('passes when no constraints (hasConstraints=false) regardless of constraint evidence', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        constraintEvidencePresent: false,
      };
      const result = gate.check('resolved', evidence, false, false);
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
      const result = gate.check('ambiguous', evidence, true, true);
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
      const result = gate.check('resolved', evidence, false, true);
      expect(result.passed).toBe(false);
      expect(result.downgradeTo).toBe('ambiguous');
    });

    it('passes when anchor present and anchor evidence present', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: true,
      };
      const result = gate.check('resolved', evidence, false, true);
      expect(result.passed).toBe(true);
    });

    it('passes when no anchor (hasAnchor=false) regardless of anchor evidence', () => {
      const evidence: EvidenceSummary = {
        identityEvidencePresent: true,
        anchorEvidencePresent: false,
      };
      const result = gate.check('resolved', evidence, false, false);
      expect(result.passed).toBe(true);
    });
  });
});
