import { describe, expect, it } from 'vitest';
import { InterpretResponseSchema } from '../search-response.schema.js';

function makeValidV1InterpretResponse() {
  return {
    raw_query: 'Opus One 2018',
    normalized_query: 'opus one 2018',
    intent: 'entity_exact',
    route: 'entity',
    retrieval_mode: 'entity_lookup',
    query_class: 'short_entity',
    anchors: [],
    constraints: {
      hard: [],
      soft: [],
      inferred: [],
    },
    expansions: {
      lexical: [],
      semantic: [],
    },
    policy: {},
    uncertainty: {},
    planner_version: '1.0.0',
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
  };
}

describe('InterpretResponseSchema', () => {
  it('accepts the canonical V1 interpret payload shape', () => {
    const parsed = InterpretResponseSchema.safeParse(makeValidV1InterpretResponse());

    expect(parsed.success).toBe(true);
  });

  it('rejects V2 explain-only fields on the V1 interpret contract', () => {
    const parsed = InterpretResponseSchema.safeParse({
      ...makeValidV1InterpretResponse(),
      version: '2',
      response_type: 'interpret',
      query_id: 'q-123',
      query_text: 'Opus One 2018',
      detected_intent: 'entity_exact',
      active_channels: ['sparse_bm25'],
      applied_constraints: [],
      ranking_signals: ['semantic_similarity'],
      confidence: 0.9,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects camelCase V2 projection fields even when snake_case V1 fields are present', () => {
    const parsed = InterpretResponseSchema.safeParse({
      ...makeValidV1InterpretResponse(),
      queryId: 'q-123',
      queryText: 'Opus One 2018',
      detectedIntent: 'entity_exact',
      activeChannels: ['sparse_bm25'],
      appliedConstraints: [],
      rankingSignals: ['semantic_similarity'],
      responseType: 'interpret',
    });

    expect(parsed.success).toBe(false);
  });
});
