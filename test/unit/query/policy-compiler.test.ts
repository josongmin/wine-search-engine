import { describe, it, expect } from 'vitest';
import { PolicyCompiler } from '../../../src/domain/query/service/policy-compiler.js';
import type { AnchorCandidate } from '../../../src/domain/query/model/anchor-candidate.js';
import type { QueryUncertainty } from '../../../src/domain/query/model/query-uncertainty.js';

const compiler = new PolicyCompiler();

function makeAnchor(confidence: number): AnchorCandidate {
  return {
    surfaceForm: 'Opus One',
    normalizedForm: 'opus one',
    candidateEntityIds: ['entity-1' as any],
    confidence,
    source: 'alias',
  };
}

function makeUncertainty(overrides?: Partial<QueryUncertainty>): QueryUncertainty {
  return {
    overall: 0.2,
    ambiguityDetected: false,
    ambiguitySeverity: 'low',
    ...overrides,
  };
}

describe('PolicyCompiler', () => {
  describe('requireExact', () => {
    it('strong anchor (confidence > 0.85) with entity_exact intent → requireExact=true', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [makeAnchor(0.90)],
        makeUncertainty(),
      );
      expect(policy.requireExact).toBe(true);
    });

    it('strong anchor with entity_fuzzy intent → requireExact=true', () => {
      const policy = compiler.compile(
        'entity_fuzzy',
        'short_entity',
        [makeAnchor(0.90)],
        makeUncertainty(),
      );
      expect(policy.requireExact).toBe(true);
    });

    it('weak anchor (confidence < 0.85) → requireExact=false', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [makeAnchor(0.70)],
        makeUncertainty(),
      );
      expect(policy.requireExact).toBe(false);
    });

    it('strong anchor but mixed_query intent → requireExact=false (overridden)', () => {
      // Rule 4 overrides rule 1 for mixed queries
      const policy = compiler.compile(
        'mixed_query',
        'short_entity',
        [makeAnchor(0.95)],
        makeUncertainty(),
      );
      expect(policy.requireExact).toBe(false);
    });
  });

  describe('requireClarification', () => {
    it('high uncertainty (overall >= 0.7) → requireClarification=true', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ overall: 0.8 }),
      );
      expect(policy.requireClarification).toBe(true);
    });

    it('ambiguity detected with high severity → requireClarification=true', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ ambiguityDetected: true, ambiguitySeverity: 'high' }),
      );
      expect(policy.requireClarification).toBe(true);
    });

    it('ambiguous_short_form class → requireClarification=true', () => {
      const policy = compiler.compile(
        'entity_fuzzy',
        'ambiguous_short_form',
        [],
        makeUncertainty(),
      );
      expect(policy.requireClarification).toBe(true);
    });

    it('low uncertainty with good anchor → requireClarification=false', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [makeAnchor(0.90)],
        makeUncertainty({ overall: 0.1 }),
      );
      expect(policy.requireClarification).toBe(false);
    });
  });

  describe('allowApproximate', () => {
    it('mixed_query intent → allowApproximate=true', () => {
      const policy = compiler.compile(
        'mixed_query',
        'anchored_similarity',
        [],
        makeUncertainty(),
      );
      expect(policy.allowApproximate).toBe(true);
    });

    it('semantic_discovery intent → allowApproximate=true', () => {
      const policy = compiler.compile(
        'semantic_discovery',
        'semantic_preference',
        [],
        makeUncertainty(),
      );
      expect(policy.allowApproximate).toBe(true);
    });

    it('pairing_search intent → allowApproximate=true', () => {
      const policy = compiler.compile(
        'pairing_search',
        'pure_constraint',
        [],
        makeUncertainty(),
      );
      expect(policy.allowApproximate).toBe(true);
    });

    it('budget_search intent → allowApproximate=true', () => {
      const policy = compiler.compile(
        'budget_search',
        'pure_constraint',
        [],
        makeUncertainty(),
      );
      expect(policy.allowApproximate).toBe(true);
    });

    it('entity_exact intent without mixed_query → allowApproximate=false', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [makeAnchor(0.5)],
        makeUncertainty(),
      );
      expect(policy.allowApproximate).toBe(false);
    });
  });

  describe('fallbackMode', () => {
    it('unknown query class → fallbackMode=fail (conservative)', () => {
      const policy = compiler.compile(
        'entity_exact',
        'unknown',
        [],
        makeUncertainty(),
      );
      expect(policy.fallbackMode).toBe('fail');
    });

    it('high uncertainty → fallbackMode=clarify', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ overall: 0.8 }),
      );
      expect(policy.fallbackMode).toBe('clarify');
    });

    it('medium uncertainty (0.4-0.7) and no clarification required → fallbackMode=hybrid', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ overall: 0.5 }),
      );
      expect(policy.fallbackMode).toBe('hybrid');
      expect(policy.requireClarification).toBe(false);
    });

    it('default case → fallbackMode=hybrid', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ overall: 0.1 }),
      );
      expect(policy.fallbackMode).toBe('hybrid');
    });
  });

  describe('policyReasonCodes', () => {
    it('includes at least one reason code', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty(),
      );
      expect(policy.policyReasonCodes.length).toBeGreaterThan(0);
    });

    it('includes "strong_anchor_entity_intent" when strong anchor with entity intent', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [makeAnchor(0.9)],
        makeUncertainty(),
      );
      expect(policy.policyReasonCodes).toContain('strong_anchor_entity_intent');
    });

    it('includes "high_overall_uncertainty" for high uncertainty', () => {
      const policy = compiler.compile(
        'entity_exact',
        'short_entity',
        [],
        makeUncertainty({ overall: 0.8 }),
      );
      expect(policy.policyReasonCodes).toContain('high_overall_uncertainty');
    });
  });
});
