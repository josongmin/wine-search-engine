import type {
  ResultItem,
  SearchResponseV1,
  ComparisonSearchResponse,
  EntitySummary,
  EngineDecision,
  ClarificationPayload,
  EntityResolveResponse,
} from '@/shared/api';

const mockEntity: EntitySummary = {
  entity_id: 'wine:abc123',
  canonical_label: 'Château Margaux 2018',
  type: 'wine',
  producer: 'Château Margaux',
  region: 'Margaux, Bordeaux',
  grapes: ['Cabernet Sauvignon', 'Merlot'],
  vintage: 2018,
  price_range: 'luxury',
};

export const mockResultItem: ResultItem = {
  entity: mockEntity,
  relevance_score: 0.92,
  match: {
    match_type: 'hybrid',
    score_components: {
      lexical: 0.8,
      semantic: 0.7,
      attribute: 0.6,
      popularity: 0.5,
      preference_alignment: 0.4,
    },
  },
  constraints: {
    matched: ['red wine', 'full body'],
    unmet: ['under 50000'],
    inferred: ['premium'],
  },
  uncertainty: {
    uncertainty_confidence: 0.08,
    missing_info: [],
    approximation_used: false,
  },
  evidence_items: [
    {
      type: 'lexical_match',
      source: 'vespa_retrieval',
      contribution: '+0.42',
      strength: 'high',
      provenance: 'Matched canonical label',
    },
    {
      type: 'constraint_pass',
      source: 'reranker',
      contribution: '+0.20',
      strength: 'medium',
      provenance: 'Red wine constraint satisfied',
    },
    {
      type: 'semantic_similarity',
      source: 'embedding',
      contribution: '+0.10',
      strength: 'low',
      provenance: 'Semantic similarity match',
    },
  ],
  drinking_window: {
    drinking_window_start: 2024,
    drinking_window_end: 2040,
    peak_year: 2030,
    currently_drinkable: true,
    confidence: 'high',
    evidence_level: 'learned',
  },
};

const mockEngineDecision: EngineDecision = {
  decision_status: 'resolved',
  next_action: 'return_result',
  route: 'hybrid',
  decision_confidence: 0.92,
  confidence_semantics: 'calibrated_decision_confidence',
  decision_trace_ref: 'trace-001',
  execution_mode: 'authoritative',
  decision_snapshot: {
    model_versions: { planner: '1.0' },
    index_versions: { vespa: '2024-04-01' },
    policy_rule_version: '1.0',
    threshold_profile_id: 'default',
    planner_version: '1.0',
    feature_flags: {},
  },
};

export const mockSearchResponse: SearchResponseV1 = {
  query_type: 'search',
  engine_decision: mockEngineDecision,
  results: [mockResultItem],
  meta: {
    query_time_ms: 320,
    route: 'hybrid',
    version: '1.0',
    engine_schema_version: 'search_response_v1',
    request_id: 'req-001',
  },
  result_type: 'wine_set',
};

export const mockComparisonResponse: SearchResponseV1 = {
  ...mockSearchResponse,
  result_type: 'comparison',
  results: [
    mockResultItem,
    {
      ...mockResultItem,
      entity: {
        ...mockEntity,
        entity_id: 'wine:def456',
        canonical_label: 'Opus One 2019',
        producer: 'Opus One',
        region: 'Napa Valley',
      },
    },
  ],
};

export const mockComparisonEnvelope: ComparisonSearchResponse = {
  query_type: 'comparison',
  original_query: 'Château Margaux vs Opus One',
  comparison_intent: 'compare',
  entities: [
    {
      sub_query: 'Château Margaux 2018',
      top_result: mockResultItem,
      result_count: 1,
      resolution_status: 'resolved',
      all_results: [mockResultItem],
    },
    {
      sub_query: 'Opus One 2019',
      top_result: {
        ...mockResultItem,
        entity: {
          ...mockEntity,
          entity_id: 'wine:def456',
          canonical_label: 'Opus One 2019',
          producer: 'Opus One',
          region: 'Napa Valley',
        },
      },
      result_count: 1,
      resolution_status: 'resolved',
      all_results: [
        {
          ...mockResultItem,
          entity: {
            ...mockEntity,
            entity_id: 'wine:def456',
            canonical_label: 'Opus One 2019',
            producer: 'Opus One',
            region: 'Napa Valley',
          },
        },
      ],
    },
  ],
  overall_status: 'resolved',
  request_id: 'req-compare-001',
  execution_time_ms: 412,
  authority_trace_ref: 'trace-compare-001',
  runtime_correlation_ref: 'req-compare-001',
};

export const mockClarification: ClarificationPayload = {
  reason: '여러 와인이 일치합니다',
  candidates: [
    {
      entity_id: 'wine:abc123',
      label: 'Château Margaux 2018',
      distinguishing_features: ['1er Grand Cru Classé', 'Bordeaux'],
    },
    {
      entity_id: 'wine:abc456',
      label: 'Margaux AOC 와인 전체',
      distinguishing_features: ['Appellation', '다수 생산자'],
    },
  ],
  suggestion_type: 'disambiguation',
};

const mockEntityResolveResponse: EntityResolveResponse = {
  entity: mockEntity,
  confidence: 0.95,
};
