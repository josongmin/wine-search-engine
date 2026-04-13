import { describe, expect, it } from 'vitest';
import { deepKeysToSnake } from '../../middleware/snake-case-hook.js';
import { EntitySummarySchema, SearchResponseSchema } from '../search-response.schema.js';

function makeValidV1SearchResponse() {
  return {
    query_type: 'search',
    engine_decision: {
      decision_status: 'resolved',
      next_action: 'return_result',
      route: 'entity',
      decision_confidence: 0.92,
      confidence_semantics: 'calibrated_decision_confidence',
      decision_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      authority_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      runtime_correlation_ref: 'req-123',
      decision_snapshot: {
        snapshot_id: 'snap-123',
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1.0.0',
        threshold_profile_id: 'default',
        planner_version: '1.0.0',
        feature_flags: {},
        response_contract_version: 'search_response_v1',
      },
    },
    results: [],
    meta: {
      request_id: 'req-123',
      query_time_ms: 12,
      route: 'entity',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      authority_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      runtime_correlation_ref: 'req-123',
    },
  };
}

describe('SearchResponseSchema', () => {
  it('accepts the canonical V1 search payload shape', () => {
    const parsed = SearchResponseSchema.safeParse(makeValidV1SearchResponse());

    expect(parsed.success).toBe(true);
  });

  it('accepts stable execution_contract metadata on the V1 search contract', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        execution_contract: {
          effective_retrieval_mode: 'attribute_search',
          retrieval_mode_source: 'planner',
          planner_suggested_mode: 'attribute_search',
          retrieval_kind: 'generic_hybrid',
          sparse_executed: true,
          specialized_route_executed: null,
          used_compiled_execution: true,
          budget: {
            max_candidates: 120,
            enable_precision_rerank: true,
          },
          provenance_policy: {
            require_identity_seal: true,
            require_constraint_evidence: false,
            require_anchor_evidence: false,
          },
          provenance_closure: {
            policy: {
              require_identity_seal: true,
              require_constraint_evidence: false,
              require_anchor_evidence: false,
            },
            pre_rank: {
              candidate_count: 20,
              identity_evidence_satisfied: false,
              constraint_evidence_satisfied: true,
              anchor_evidence_satisfied: true,
              matched_constraint_attributes: ['grape_primary'],
              unmet_constraint_attributes: [],
              anchor_signal_types: [],
            },
            post_rank: {
              candidate_count: 5,
              identity_evidence_satisfied: false,
              constraint_evidence_satisfied: true,
              anchor_evidence_satisfied: true,
              matched_constraint_attributes: ['grape_primary'],
              unmet_constraint_attributes: [],
              anchor_signal_types: [],
            },
            missing: ['identity_evidence'],
            satisfied: false,
          },
          admission_closure: {
            required: {
              identity_seal: true,
              constraint_evidence: false,
              anchor_evidence: false,
            },
            satisfied: {
              identity_seal: true,
              constraint_evidence: true,
              anchor_evidence: true,
            },
            all_satisfied: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects V2 human top-level fields on the V1 search contract', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      version: '2',
      response_type: 'human',
      query_id: 'q-123',
      queryType: 'search',
      responseType: 'human',
      queryId: 'q-123',
      totalCandidates: 10,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects mixed V1/V2 search payloads that combine engine_decision with V2 result cards', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      results: [
        {
          entityId: 'wine:opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          rank: 1,
          evidenceSummary: 'Top result',
          confidence: 0.95,
          version: '2',
          responseType: 'human',
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-canonical authority trace identifiers on the V1 search contract', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      engine_decision: {
        ...makeValidV1SearchResponse().engine_decision,
        decision_trace_ref: 'trace-1',
        authority_trace_ref: 'trace-1',
      },
      meta: {
        ...makeValidV1SearchResponse().meta,
        authority_trace_ref: 'trace-1',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects mismatched authority/runtime correlation fields on the V1 search contract', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      engine_decision: {
        ...makeValidV1SearchResponse().engine_decision,
        authority_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
        runtime_correlation_ref: 'req-engine',
      },
      meta: {
        ...makeValidV1SearchResponse().meta,
        authority_trace_ref: 'decision:v1:short_entity:2222222222222222222222222222222222222222222222222222222222222222',
        runtime_correlation_ref: 'req-meta',
        request_id: 'req-body',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts structured clarification payloads on the V1 search contract', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      clarification: {
        reason: 'Query is ambiguous (entropy=0.998). Please refine your search.',
        candidates: [
          {
            entity_id: 'wine:opus-one-2018',
            label: 'Opus One 2018',
            distinguishing_features: ['Napa Valley', 'Cabernet Sauvignon'],
          },
        ],
        suggestion_type: 'disambiguation',
        structured_payload: {
          kind: 'anchor_disambiguation',
          question: '어떤 후보를 찾으시나요?',
          options: ['Opus One 2018', 'Château Margaux 2015'],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts source_record_refs on entity summaries (ADR-007 lineage)', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      results: [
        {
          entity: {
            entity_id: 'wine:test-lineage',
            canonical_label: 'Test Wine',
            type: 'wine',
            source_record_refs: [
              { source_system: 'vivino-silver', source_record_id: 'vivino:fixture-1' },
            ],
          },
          relevance_score: 0.9,
          match: {
            match_type: 'hybrid',
            score_components: {
              lexical: 0.5,
              semantic: 0.5,
              attribute: 0.5,
              popularity: 0.5,
              preference_alignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: {
            uncertainty_confidence: 0.9,
            missing_info: [],
            approximation_used: false,
          },
          evidence_items: [
            {
              type: 'retrieval',
              source: 'hybrid',
              contribution: 'ranked candidate',
              strength: 'high',
              provenance: 'unit-test',
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('EntitySummarySchema accepts lineage keys after deepKeysToSnake from domain camelCase', () => {
    const entity = deepKeysToSnake({
      entityId: 'wine:test',
      canonicalLabel: 'Test',
      type: 'wine',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'silver-99' }],
    });
    const parsed = EntitySummarySchema.safeParse(entity);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source_record_refs).toEqual([
        { source_system: 'vivino-silver', source_record_id: 'silver-99' },
      ]);
    }
  });
});
