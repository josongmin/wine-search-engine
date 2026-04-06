import { describe, expect, it } from 'vitest';
import { buildInterpretResponseV2 } from '../interpret-explain-adapter-v2.js';
import type { ExplainAdapterV2Input } from '../interpret-explain-adapter-v2.js';
import type { QueryObservabilitySlice } from '../../../domain/query/model/query-observability-vocab.js';
import type { QueryDecompositionHint } from '../../../domain/query/model/query-decomposition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlice(overrides: Partial<QueryObservabilitySlice> = {}): QueryObservabilitySlice {
  return {
    queryId: 'q-test-001',
    rawQuery: 'test query',
    queryFamily: 'entity_exact',
    intent: 'entity_exact',
    queryClass: 'exact',
    suggestedRetrievalMode: 'entity_lookup',
    suggestedRoute: 'entity',
    anchorCount: 0,
    hardConstraintCount: 0,
    softConstraintCount: 0,
    overallUncertainty: 0.2,
    ambiguityDetected: false,
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ExplainAdapterV2Input> = {}): ExplainAdapterV2Input {
  return {
    queryId: 'q-test-001',
    queryText: 'Chateau Margaux 2018',
    observabilitySlice: makeSlice(),
    activeChannels: ['sparse_bm25', 'dense_semantic'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildInterpretResponseV2', () => {
  it('maps detectedIntent from queryFamily', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ queryFamily: 'attribute_constrained' }),
    }));
    expect(result.detectedIntent).toBe('attribute_constrained');
  });

  it('maps detectedIntent correctly for entity_exact family', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ queryFamily: 'entity_exact' }),
    }));
    expect(result.detectedIntent).toBe('entity_exact');
  });

  it('omits decompositionStrategy when hint is absent', () => {
    const result = buildInterpretResponseV2(makeInput({ decompositionHint: undefined }));
    expect('decompositionStrategy' in result).toBe(false);
  });

  it('omits decompositionStrategy when strategy is none', () => {
    const hint: QueryDecompositionHint = { strategy: 'none', subQueryCount: 0, confidence: 0 };
    const result = buildInterpretResponseV2(makeInput({ decompositionHint: hint }));
    expect('decompositionStrategy' in result).toBe(false);
  });

  it('includes decompositionStrategy when strategy is comparison', () => {
    const hint: QueryDecompositionHint = {
      strategy: 'comparison',
      subQueryCount: 2,
      confidence: 0.9,
    };
    const result = buildInterpretResponseV2(makeInput({ decompositionHint: hint }));
    expect(result.decompositionStrategy).toBe('comparison');
  });

  it('includes decompositionStrategy when strategy is multi_intent', () => {
    const hint: QueryDecompositionHint = {
      strategy: 'multi_intent',
      subQueryCount: 2,
      confidence: 0.7,
    };
    const result = buildInterpretResponseV2(makeInput({ decompositionHint: hint }));
    expect(result.decompositionStrategy).toBe('multi_intent');
  });

  it('passes through activeChannels unchanged', () => {
    const channels = ['sparse_bm25', 'dense_semantic', 'relative_filter'] as const;
    const result = buildInterpretResponseV2(makeInput({ activeChannels: channels }));
    expect(result.activeChannels).toEqual(['sparse_bm25', 'dense_semantic', 'relative_filter']);
  });

  it('passes through empty activeChannels', () => {
    const result = buildInterpretResponseV2(makeInput({ activeChannels: [] }));
    expect(result.activeChannels).toEqual([]);
  });

  it('includes anchor_similarity in rankingSignals when anchor channel is active', () => {
    const result = buildInterpretResponseV2(makeInput({
      activeChannels: ['sparse_bm25', 'anchor_similarity'],
    }));
    expect(result.rankingSignals).toContain('anchor_similarity');
  });

  it('includes anchor_similarity when dense_anchor channel is active', () => {
    const result = buildInterpretResponseV2(makeInput({
      activeChannels: ['dense_semantic', 'dense_anchor'],
    }));
    expect(result.rankingSignals).toContain('anchor_similarity');
  });

  it('includes anchor_similarity when compare_anchor channel is active', () => {
    const result = buildInterpretResponseV2(makeInput({
      activeChannels: ['compare_anchor'],
    }));
    expect(result.rankingSignals).toContain('anchor_similarity');
  });

  it('does not include anchor_similarity when no anchor channel is active', () => {
    const result = buildInterpretResponseV2(makeInput({
      activeChannels: ['sparse_bm25', 'dense_semantic'],
    }));
    expect(result.rankingSignals).not.toContain('anchor_similarity');
  });

  it('always includes base ranking signals', () => {
    const result = buildInterpretResponseV2(makeInput({ activeChannels: [] }));
    expect(result.rankingSignals).toContain('semantic_similarity');
    expect(result.rankingSignals).toContain('attribute_alignment');
    expect(result.rankingSignals).toContain('popularity');
  });

  it('sets version to "2"', () => {
    const result = buildInterpretResponseV2(makeInput());
    expect(result.version).toBe('2');
  });

  it('sets responseType to "interpret"', () => {
    const result = buildInterpretResponseV2(makeInput());
    expect(result.responseType).toBe('interpret');
  });

  it('derives confidence from 1 - overallUncertainty', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ overallUncertainty: 0.3 }),
    }));
    expect(result.confidence).toBeCloseTo(0.7);
  });

  it('clamps confidence to [0, 1] when uncertainty > 1', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ overallUncertainty: 1.2 }),
    }));
    expect(result.confidence).toBe(0);
  });

  it('surfaces hard constraint count label when hard constraints are present', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ hardConstraintCount: 2, softConstraintCount: 0 }),
    }));
    expect(result.appliedConstraints).toEqual(['hard_constraints: 2']);
  });

  it('surfaces both hard and soft constraint labels when both are present', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ hardConstraintCount: 1, softConstraintCount: 3 }),
    }));
    expect(result.appliedConstraints).toEqual([
      'hard_constraints: 1',
      'soft_constraints: 3',
    ]);
  });

  it('returns empty appliedConstraints when no constraints present', () => {
    const result = buildInterpretResponseV2(makeInput({
      observabilitySlice: makeSlice({ hardConstraintCount: 0, softConstraintCount: 0 }),
    }));
    expect(result.appliedConstraints).toEqual([]);
  });

  it('passes through queryId and queryText', () => {
    const result = buildInterpretResponseV2(makeInput({
      queryId: 'my-query-id',
      queryText: 'Pomerol under $100',
    }));
    expect(result.queryId).toBe('my-query-id');
    expect(result.queryText).toBe('Pomerol under $100');
  });
});
