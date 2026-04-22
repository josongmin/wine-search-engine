import { describe, expect, it } from 'vitest';
import {
  InterpretResponseV2Schema,
  SearchResponseV2HumanSchema,
  SearchResponseV2MachineSchema,
} from '../search-response-v2.schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validResultItemV2Human = {
  entityId: 'wine:opus-one-2018',
  canonicalLabel: 'Opus One 2018',
  rank: 1,
  producer: 'Opus One Winery',
  region: 'Napa Valley',
  country: 'United States',
  vintage: 2018,
  grapePrimary: 'Cabernet Sauvignon',
  drinkingWindow: { start: 2024, end: 2038 },
  evidenceSummary: 'Top-rated Napa Cab matching your query.',
  confidence: 0.92,
  version: '2' as const,
  responseType: 'human' as const,
};

const validSearchResponseV2Human = {
  queryId: 'qid-abc-123',
  queryType: 'search' as const,
  results: [validResultItemV2Human],
  totalCandidates: 42,
  authorityTraceRef: 'decision:v1:known_item:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  runtimeCorrelationRef: 'qid-abc-123',
  version: '2' as const,
  responseType: 'human' as const,
};

const validSearchResponseV2HumanComparison = {
  queryId: 'qid-cmp-001',
  queryType: 'comparison' as const,
  originalQuery: 'Opus One vs Château Margaux',
  comparisonIntent: 'compare' as const,
  overallStatus: 'resolved' as const,
  entities: [
    {
      subQuery: 'Opus One',
      resolutionStatus: 'resolved' as const,
      resultCount: 1,
      topResult: validResultItemV2Human,
    },
    {
      subQuery: 'Château Margaux',
      resolutionStatus: 'resolved' as const,
      resultCount: 0,
      topResult: null,
    },
  ] as const,
  totalCandidates: 1,
  authorityTraceRef: 'decision:v1:comparison_query:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  runtimeCorrelationRef: 'qid-cmp-001',
  version: '2' as const,
  responseType: 'human' as const,
};

const validResultItemV2Machine = {
  entityId: 'wine:opus-one-2018',
  canonicalLabel: 'Opus One 2018',
  rank: 1,
  finalScore: 0.94,
  componentScores: {
    entityIntegrity: 0.98,
    semantic: 0.87,
    hardConstraintPass: true,
    softConstraint: 0.75,
    attributeAlignment: 0.82,
    popularity: 0.91,
    uncertaintyPenalty: 0.05,
  },
  evidenceItems: [
    { signal: 'semantic_match', value: 0.87, weight: 0.4 },
    { signal: 'popularity', value: 0.91, weight: 0.2 },
  ],
  version: '2' as const,
  responseType: 'machine' as const,
};

const validSearchResponseV2Machine = {
  queryId: 'qid-abc-456',
  results: [validResultItemV2Machine],
  version: '2' as const,
  responseType: 'machine' as const,
};

const validInterpretResponseV2 = {
  queryId: 'qid-interp-789',
  queryText: 'full-bodied red under $50',
  detectedIntent: 'attribute_search',
  decompositionStrategy: 'single',
  activeChannels: ['semantic', 'attribute_filter'],
  appliedConstraints: ['price_range:under_50', 'style:full_bodied', 'color:red'],
  rankingSignals: ['semantic_match', 'attribute_alignment', 'popularity'],
  confidence: 0.88,
  version: '2' as const,
  responseType: 'interpret' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchResponseV2HumanSchema', () => {
  it('parses a valid SearchResponseV2Human object', () => {
    const result = SearchResponseV2HumanSchema.safeParse(validSearchResponseV2Human);
    expect(result.success).toBe(true);
  });

  it('parses a valid comparison-branch SearchResponseV2Human object', () => {
    const result = SearchResponseV2HumanSchema.safeParse(validSearchResponseV2HumanComparison);
    expect(result.success).toBe(true);
  });

  it('parses concept aggregate evidence on V2 human comparison responses', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2HumanComparison,
      entities: [
        {
          ...validSearchResponseV2HumanComparison.entities[0],
          comparisonMode: 'concept',
          canonicalConcept: 'Opus One',
          conceptEntityType: 'appellation',
          conceptAggregate: {
            canonicalConcept: 'Opus One',
            conceptEntityType: 'appellation',
            representativeResult: validResultItemV2Human,
            prototypeAxis: [validResultItemV2Human],
            aggregateResultCount: 1,
          },
        },
        validSearchResponseV2HumanComparison.entities[1],
      ],
    });

    expect(result.success).toBe(true);
  });

  it('parses a response with an empty results array', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2Human,
      results: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects when version is the number 2 instead of the string "2"', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2Human,
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('version field is the string literal "2"', () => {
    const result = SearchResponseV2HumanSchema.safeParse(validSearchResponseV2Human);
    if (!result.success) throw new Error('Parse failed');
    expect(result.data.queryType).toBe('search');
    expect(result.data.version).toBe('2');
    expect(typeof result.data.version).toBe('string');
  });

  it('rejects a V1 search response shape (query_type / engine_decision / meta)', () => {
    const v1Shape = {
      query_type: 'search',
      engine_decision: {
        decision_status: 'resolved',
        next_action: 'return_result',
        route: 'hybrid',
        decision_confidence: 0.9,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: 'trace-1',
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        query_time_ms: 10,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
      },
    };
    const result = SearchResponseV2HumanSchema.safeParse(v1Shape);
    expect(result.success).toBe(false);
  });

  it('rejects when required field queryId is missing', () => {
    const { queryId: _omitted, ...withoutQueryId } = validSearchResponseV2Human;
    const result = SearchResponseV2HumanSchema.safeParse(withoutQueryId);
    expect(result.success).toBe(false);
  });

  it('rejects funnelMetrics because V2 human responses do not expose internal funnel data', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2Human,
      funnelMetrics: {
        coarsePrunePassRate: 0.8,
        rerankChangedTopK: false,
        meanFinalScore: 0.71,
        scoreGapRank1Rank2: 0.12,
        producerDiversity: 5,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-canonical authority traces on V2 human search responses', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2Human,
      authorityTraceRef: 'trace-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects mismatched runtimeCorrelationRef/queryId on V2 human responses', () => {
    const result = SearchResponseV2HumanSchema.safeParse({
      ...validSearchResponseV2HumanComparison,
      runtimeCorrelationRef: 'different-query-id',
    });
    expect(result.success).toBe(false);
  });
});

describe('SearchResponseV2MachineSchema', () => {
  it('parses a valid SearchResponseV2Machine object', () => {
    const result = SearchResponseV2MachineSchema.safeParse(validSearchResponseV2Machine);
    expect(result.success).toBe(true);
  });

  it('accepts omitted unsupported component scores on machine responses', () => {
    const result = SearchResponseV2MachineSchema.safeParse({
      ...validSearchResponseV2Machine,
      results: [{
        ...validResultItemV2Machine,
        componentScores: {
          entityIntegrity: 0.98,
          hardConstraintPass: true,
          softConstraint: 0.75,
          uncertaintyPenalty: 0.05,
        },
      }],
    });
    expect(result.success).toBe(true);
  });

  it('version field is the string literal "2"', () => {
    const result = SearchResponseV2MachineSchema.safeParse(validSearchResponseV2Machine);
    if (!result.success) throw new Error('Parse failed');
    expect(result.data.version).toBe('2');
    expect(typeof result.data.version).toBe('string');
  });

  it('rejects when version is the number 2 instead of the string "2"', () => {
    const result = SearchResponseV2MachineSchema.safeParse({
      ...validSearchResponseV2Machine,
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('parses a result item with optional retrievalProvenance', () => {
    const withProvenance = {
      ...validSearchResponseV2Machine,
      results: [
        { ...validResultItemV2Machine, retrievalProvenance: 'channel:semantic' },
      ],
    };
    const result = SearchResponseV2MachineSchema.safeParse(withProvenance);
    expect(result.success).toBe(true);
  });

  it('parses a result item with optional anchorSimilarity in componentScores', () => {
    const withAnchor = {
      ...validSearchResponseV2Machine,
      results: [
        {
          ...validResultItemV2Machine,
          componentScores: {
            ...validResultItemV2Machine.componentScores,
            anchorSimilarity: 0.72,
          },
        },
      ],
    };
    const result = SearchResponseV2MachineSchema.safeParse(withAnchor);
    expect(result.success).toBe(true);
  });

  it('rejects a V1 search response shape', () => {
    const v1Shape = {
      query_type: 'search',
      engine_decision: {},
      results: [],
      meta: {},
    };
    const result = SearchResponseV2MachineSchema.safeParse(v1Shape);
    expect(result.success).toBe(false);
  });
});

describe('InterpretResponseV2Schema', () => {
  it('parses a valid InterpretResponseV2 object', () => {
    const result = InterpretResponseV2Schema.safeParse(validInterpretResponseV2);
    expect(result.success).toBe(true);
  });

  it('accepts omitted confidence when explain uncertainty input is invalid', () => {
    const result = InterpretResponseV2Schema.safeParse({
      ...validInterpretResponseV2,
      confidence: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('parses without optional decompositionStrategy', () => {
    const { decompositionStrategy: _omitted, ...withoutStrategy } = validInterpretResponseV2;
    const result = InterpretResponseV2Schema.safeParse(withoutStrategy);
    expect(result.success).toBe(true);
  });

  it('version field is the string literal "2"', () => {
    const result = InterpretResponseV2Schema.safeParse(validInterpretResponseV2);
    if (!result.success) throw new Error('Parse failed');
    expect(result.data.version).toBe('2');
    expect(typeof result.data.version).toBe('string');
  });

  it('rejects when version is the number 2 instead of the string "2"', () => {
    const result = InterpretResponseV2Schema.safeParse({
      ...validInterpretResponseV2,
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when confidence is outside [0, 1]', () => {
    const result = InterpretResponseV2Schema.safeParse({
      ...validInterpretResponseV2,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a V1 InterpretResponse shape (raw_query / intent / route fields)', () => {
    const v1Shape = {
      raw_query: 'full-bodied red under $50',
      normalized_query: 'full bodied red under 50',
      intent: 'attribute_search',
      route: 'hybrid',
      retrieval_mode: 'attribute_search',
      query_class: 'attribute',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {},
      planner_version: '1',
      policy_rule_version: '1',
      threshold_profile_id: 'default',
    };
    const result = InterpretResponseV2Schema.safeParse(v1Shape);
    expect(result.success).toBe(false);
  });

  it('rejects snake_case wire-format V2 interpret payloads on the camelCase schema', () => {
    const snakeCaseWireShape = {
      query_id: 'qid-interp-789',
      query_text: 'full-bodied red under $50',
      detected_intent: 'attribute_search',
      decomposition_strategy: 'single',
      active_channels: ['dense_semantic'],
      applied_constraints: ['soft:price_band'],
      ranking_signals: ['semantic_similarity'],
      confidence: 0.88,
      version: '2',
      response_type: 'interpret',
    };

    const result = InterpretResponseV2Schema.safeParse(snakeCaseWireShape);
    expect(result.success).toBe(false);
  });

  it('rejects mixed V1/V2 interpret payloads that combine planner fields with V2 explain fields', () => {
    const mixedShape = {
      ...validInterpretResponseV2,
      raw_query: 'full-bodied red under $50',
      route: 'hybrid',
      retrieval_mode: 'attribute_search',
    };

    const result = InterpretResponseV2Schema.safeParse(mixedShape);
    expect(result.success).toBe(false);
  });
});

describe('V1/V2 schema independence', () => {
  it('SearchResponseV2Human does not accept a plain V1 response object', () => {
    // Minimal V1 response — missing queryId, version, responseType
    const v1 = {
      query_type: 'search',
      engine_decision: {
        decision_status: 'resolved',
        next_action: 'return_result',
        route: 'hybrid',
        decision_confidence: 0.9,
        confidence_semantics: 'calibrated_decision_confidence',
        decision_trace_ref: 'trace-1',
        decision_snapshot: {
          model_versions: {},
          index_versions: {},
          policy_rule_version: '1',
          threshold_profile_id: 'default',
          planner_version: '1',
          feature_flags: {},
        },
      },
      results: [],
      meta: {
        query_time_ms: 10,
        route: 'hybrid',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
      },
    };
    const result = SearchResponseV2HumanSchema.safeParse(v1);
    expect(result.success).toBe(false);
  });
});
