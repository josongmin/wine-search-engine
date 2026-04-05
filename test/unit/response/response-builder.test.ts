import { describe, it, expect } from 'vitest';
import { ResponseBuilder } from '../../../src/domain/response/service/response-builder.js';
import type { ResponseBuildParams } from '../../../src/domain/response/service/response-builder.js';
import type { DecisionOutput } from '../../../src/domain/decision/model/decision-output.js';
import type { ResultItem } from '../../../src/domain/response/model/result-item.js';
import type { ClarificationPayload } from '../../../src/domain/response/model/clarification.js';
import type {
  EvidenceItem,
  DecisionSnapshot,
} from '../../../src/domain/shared/types/index.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDecisionSnapshot(): DecisionSnapshot {
  return {
    model_versions: { embedding: 'bge-m3-v1' },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default-v1',
    planner_version: '1.0.0',
    feature_flags: {},
  };
}

function makeDecisionOutput(overrides?: Partial<DecisionOutput>): DecisionOutput {
  const snapshot = makeDecisionSnapshot();
  return {
    decisionStatus: 'resolved',
    nextAction: 'return_result',
    decisionConfidence: 0.9,
    confidenceSemantics: 'calibrated_decision_confidence',
    signalSet: {
      entity_integrity_score: 0.9,
      hard_constraint_pass: 1,
      soft_constraint_score: 0.8,
      semantic_relevance_score: 0.7,
      preference_alignment_score: 0.6,
      popularity_score: 0.5,
      availability_score: 1.0,
      uncertainty_penalty: 0.1,
    },
    evidenceItems: [],
    decisionTraceRef: 'trace-ref-001',
    decisionSnapshot: snapshot,
    decisionTrace: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      inputs: {
        queryClass: 'short_entity',
        policy: {},
      },
      signals: {
        decisionConfidence: 0.9,
        calibratedGap: 0.2,
        ambiguity: false,
      },
      thresholds: {
        resolveThreshold: 0.75,
        gapThreshold: 0.15,
      },
      versions: {
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default-v1',
      },
      rulesApplied: [],
      finalReason: 'Resolved with high confidence.',
    },
    ...overrides,
  };
}

function makeEvidenceItem(overrides?: Partial<EvidenceItem>): EvidenceItem {
  return {
    type: 'semantic_relevance',
    source: 'ranking_signal_computer',
    contribution: '+0.50',
    strength: 'medium',
    provenance: 'Stub evidence for testing',
    ...overrides,
  };
}

function makeResultItem(evidenceItems: readonly EvidenceItem[]): ResultItem {
  return {
    entity: {
      entityId: createEntityId('wine-001'),
      canonicalLabel: 'Opus One 2018',
      type: 'wine',
    },
    relevanceScore: 0.9,
    match: {
      matchType: 'hybrid',
      scoreComponents: {
        lexical: 0.8,
        semantic: 0.9,
        attribute: 0.7,
        popularity: 0.5,
        preferenceAlignment: 0.5,
      },
    },
    constraints: {
      matched: [],
      unmet: [],
      inferred: [],
    },
    uncertainty: {
      uncertaintyConfidence: 0.9,
      missingInfo: [],
      approximationUsed: false,
    },
    evidenceItems,
  };
}

function makeBaseParams(
  overrides?: Partial<ResponseBuildParams>,
): ResponseBuildParams {
  return {
    decisionOutput: makeDecisionOutput(),
    results: [],
    queryTimeMs: 42,
    route: 'hybrid',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const builder = new ResponseBuilder();

describe('ResponseBuilder', () => {
  describe('meta.engine_schema_version', () => {
    it('is always "search_response_v1" regardless of other params', () => {
      const response = builder.build(makeBaseParams());

      expect(response.meta.engine_schema_version).toBe('search_response_v1');
    });
  });

  describe('evidence enforcement', () => {
    it('result with non-empty evidenceItems → returned unchanged (no synthetic item added)', () => {
      const existingEvidence = makeEvidenceItem();
      const result = makeResultItem([existingEvidence]);
      const params = makeBaseParams({ results: [result] });

      const response = builder.build(params);

      expect(response.results[0]!.evidenceItems).toHaveLength(1);
      expect(response.results[0]!.evidenceItems[0]).toEqual(existingEvidence);
    });

    it('result with empty evidenceItems [] → gets synthetic item with type="no_evidence_available"', () => {
      const result = makeResultItem([]);
      const params = makeBaseParams({ results: [result] });

      const response = builder.build(params);

      expect(response.results[0]!.evidenceItems).toHaveLength(1);
      expect(response.results[0]!.evidenceItems[0]!.type).toBe('no_evidence_available');
    });

    it('synthetic item has source="response_builder" and strength="low"', () => {
      const result = makeResultItem([]);
      const params = makeBaseParams({ results: [result] });

      const response = builder.build(params);

      const synthetic = response.results[0]!.evidenceItems[0]!;
      expect(synthetic.source).toBe('response_builder');
      expect(synthetic.strength).toBe('low');
    });

    it('mix of 2 results: one with evidence, one without → each handled independently', () => {
      const withEvidence = makeResultItem([makeEvidenceItem()]);
      const withoutEvidence = makeResultItem([]);
      const params = makeBaseParams({ results: [withEvidence, withoutEvidence] });

      const response = builder.build(params);

      // First result keeps its original evidence
      expect(response.results[0]!.evidenceItems).toHaveLength(1);
      expect(response.results[0]!.evidenceItems[0]!.type).toBe('semantic_relevance');

      // Second result gets the synthetic item
      expect(response.results[1]!.evidenceItems).toHaveLength(1);
      expect(response.results[1]!.evidenceItems[0]!.type).toBe('no_evidence_available');
    });
  });

  describe('clarification', () => {
    it('clarification is null when not provided in params', () => {
      const params = makeBaseParams(); // no clarification field

      const response = builder.build(params);

      expect(response.clarification).toBeNull();
    });

    it('clarification key is always present in response (null or object, never missing)', () => {
      const params = makeBaseParams();

      const response = builder.build(params);

      expect('clarification' in response).toBe(true);
    });

    it('clarification is passed through when provided as ClarificationPayload', () => {
      const clarification: ClarificationPayload = {
        reason: 'Multiple wines matched',
        candidates: [
          {
            entityId: createEntityId('wine-001'),
            label: 'Opus One 2018',
            distinguishingFeatures: ['Napa Valley', 'Cabernet Sauvignon'],
          },
        ],
        suggestionType: 'disambiguation',
      };

      const params = makeBaseParams({ clarification });

      const response = builder.build(params);

      expect(response.clarification).toEqual(clarification);
    });
  });

  describe('meta.version', () => {
    it('meta.version defaults to "1.0.0" when not specified', () => {
      const params = makeBaseParams(); // no version field

      const response = builder.build(params);

      expect(response.meta.version).toBe('1.0.0');
    });

    it('meta.version uses custom value when specified', () => {
      const params = makeBaseParams({ version: '2.3.1' });

      const response = builder.build(params);

      expect(response.meta.version).toBe('2.3.1');
    });
  });

  describe('meta fields', () => {
    it('meta.requestId = params.requestId', () => {
      const params = makeBaseParams({ requestId: 'req-abc-123' });

      const response = builder.build(params);

      expect(response.meta.requestId).toBe('req-abc-123');
    });

    it('meta.queryTimeMs = params.queryTimeMs', () => {
      const params = makeBaseParams({ queryTimeMs: 123 });

      const response = builder.build(params);

      expect(response.meta.queryTimeMs).toBe(123);
    });

    it('meta.route = params.route', () => {
      const params = makeBaseParams({ route: 'exact' });

      const response = builder.build(params);

      expect(response.meta.route).toBe('exact');
    });

    it('meta.decisionSnapshot = decisionOutput.decisionSnapshot', () => {
      const snapshot = makeDecisionSnapshot();
      const decisionOutput = makeDecisionOutput({ decisionSnapshot: snapshot });
      const params = makeBaseParams({ decisionOutput });

      const response = builder.build(params);

      expect(response.meta.decisionSnapshot).toEqual(snapshot);
    });
  });

  describe('engineDecision', () => {
    it('engineDecision.decisionStatus comes from decisionOutput.decisionStatus', () => {
      const decisionOutput = makeDecisionOutput({ decisionStatus: 'ambiguous' });
      const params = makeBaseParams({ decisionOutput });

      const response = builder.build(params);

      expect(response.engineDecision.decisionStatus).toBe('ambiguous');
    });

    it('engineDecision.route comes from params.route (not from decisionOutput)', () => {
      // DecisionOutput does not have a route field; route is set from params
      const params = makeBaseParams({ route: 'semantic' });

      const response = builder.build(params);

      expect(response.engineDecision.route).toBe('semantic');
    });
  });

  describe('results array', () => {
    it('results array is always present in response', () => {
      const params = makeBaseParams({ results: [] });

      const response = builder.build(params);

      expect(Array.isArray(response.results)).toBe(true);
    });

    it('results array contains all provided result items', () => {
      const items = [
        makeResultItem([makeEvidenceItem()]),
        makeResultItem([makeEvidenceItem()]),
      ];
      const params = makeBaseParams({ results: items });

      const response = builder.build(params);

      expect(response.results).toHaveLength(2);
    });
  });
});
