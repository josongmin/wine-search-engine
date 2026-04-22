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

function makeLaneTrace() {
  return {
    identity: {
      participated: true,
      artifact_count: 1,
      resolve_status: 'resolved',
    },
    general: {
      participated: true,
      artifact_count: 4,
    },
    fused: {
      participated: true,
      artifact_count: 3,
      resolve_status: 'resolved',
    },
  } as const;
}

describe('SearchResponseSchema', () => {
  it('accepts the canonical V1 search payload shape', () => {
    const parsed = SearchResponseSchema.safeParse(makeValidV1SearchResponse());

    expect(parsed.success).toBe(true);
  });

  it('accepts stable execution_contract metadata on the V1 search contract', () => {
    const laneTrace = makeLaneTrace();
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      engine_decision: {
        ...makeValidV1SearchResponse().engine_decision,
        execution_topology: 'dual_lane',
        lane_trace: laneTrace,
      },
      meta: {
        ...makeValidV1SearchResponse().meta,
        execution_contract: {
          execution_topology: 'dual_lane',
          effective_retrieval_mode: 'attribute_search',
          retrieval_mode_source: 'planner',
          planner_suggested_mode: 'attribute_search',
          retrieval_kind: 'generic_hybrid',
          sparse_executed: true,
          specialized_route_executed: null,
          used_compiled_execution: true,
          budget: {
            max_candidates: 120,
            rerank_limit: 12,
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
          lane_trace: laneTrace,
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
        provenance_trace: {
          policy: {
            require_identity_seal: true,
            require_constraint_evidence: false,
            require_anchor_evidence: false,
          },
          observed: {
            top_entity_present: false,
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
          },
          missing: ['identity_evidence'],
          shortfalls: ['provenance_shortfall:identity_evidence'],
          gate_decisions: {
            admission: 'admission_gate_rejected',
            decision: 'decision_gate_failed',
            decision_status: 'failed',
            next_action: 'fail',
            failure_reason: 'HARD_CONSTRAINT_VIOLATION',
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
          option_entities: [
            {
              entity_id: 'wine:opus-one-2018',
              label: 'Opus One 2018',
              distinguishing_features: ['Napa Valley', 'Cabernet Sauvignon'],
            },
          ],
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

  it('accepts omitted unsupported preference_alignment on result score components', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      results: [
        {
          entity: {
            entity_id: 'wine:test-lineage',
            canonical_label: 'Test Wine',
            type: 'wine',
          },
          relevance_score: 0.9,
          match: {
            match_type: 'hybrid',
            score_components: {
              lexical: 0.5,
              semantic: 0.5,
              attribute: 0.5,
              popularity: 0.5,
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

  it('keeps audit_extension open at the envelope level for future debug fields', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          future_debug_field: {
            note: 'kept for forward compatibility',
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects unknown nested keys inside closed audit_extension trace objects', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          execution_trace: {
            effective_route: 'entity',
            extra_flag: true,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts sparse_zero_hits inside abstain_policy_trace.channel_degradation', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          abstain_policy_trace: {
            evaluated: true,
            decision: {
              should_abstain: true,
              reason: 'low_confidence',
              detail: 'Top-k entropy is too high to resolve safely',
            },
            channel_degradation: {
              dense_degraded: false,
              anchor_degraded: false,
              sparse_degraded: false,
              sparse_zero_hits: true,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts typed abstain_policy_trace decision and ranking_delta_trace drift inside audit_extension', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          abstain_policy_trace: {
            evaluated: true,
            decision: {
              should_abstain: true,
              reason: 'semantic_conflict',
              detail: 'Soft constraints conflict with each other',
              recoverable_by: 'clarify',
              conflicting_relations: [
                {
                  type: 'soft_tension',
                  atom_index_a: 0,
                  atom_index_b: 1,
                  explanation: 'sweetness and bone-dry preference conflict',
                },
              ],
              clarify_payload: {
                kind: 'constraint_conflict',
                question: '어느 쪽 취향을 더 우선할까요?',
                conflicting_atoms: ['sweetness', 'dryness'],
              },
            },
            top_k_entropy: 0.92,
            constraint_conflicts: [
              {
                type: 'soft_tension',
                atom_index_a: 0,
                atom_index_b: 1,
                explanation: 'sweetness and bone-dry preference conflict',
              },
            ],
            channel_degradation: {
              dense_degraded: false,
              anchor_degraded: false,
              sparse_degraded: false,
              sparse_zero_hits: false,
            },
          },
          ranking_delta_trace: {
            pre_rerank_top5: ['wine:a', 'wine:b'],
            post_rerank_top5: ['wine:b', 'wine:a'],
            safety_envelope_blocks: 1,
            drift: {
              query_class: 'semantic_preference',
              heuristic_top3_entity_ids: ['wine:a', 'wine:b'],
              ltr_top3_entity_ids: ['wine:b', 'wine:a'],
              rank_order_changes: 1,
              average_rerank_delta_normalized: 0.12,
              safety_envelope_blocks: 1,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts typed constraint_resolution_trace and execution provenance closure inside audit_extension', () => {
    const laneTrace = makeLaneTrace();
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          constraint_resolution_trace: {
            atoms: [
              {
                attribute: 'region',
                operator: '=',
                value: 'Bordeaux',
                source_phrase: '보르도',
                confidence: 0.98,
                source_tier: 'hard',
                source_kind: 'explicit_utterance',
                authority_level: 100,
                semantic_scope: 'intrinsic',
                conflict_policy: 'strict',
                constraint_role: 'must_satisfy',
              },
            ],
            relations: [
              {
                type: 'subsumption',
                atom_index_a: 0,
                atom_index_b: 1,
                explanation: 'region Bordeaux subsumes Pauillac',
              },
            ],
            policy_outcomes: [
              {
                atom_index: 0,
                outcome: 'kept',
                reason: 'highest authority hard constraint',
              },
            ],
          },
          execution_trace: {
            effective_route: 'hybrid',
            execution_topology: 'dual_lane',
            provenance_policy: {
              require_identity_seal: false,
              require_constraint_evidence: true,
              require_anchor_evidence: false,
            },
            lane_trace: laneTrace,
            provenance_closure: {
              policy: {
                require_identity_seal: false,
                require_constraint_evidence: true,
                require_anchor_evidence: false,
              },
              pre_rank: {
                candidate_count: 12,
                identity_evidence_satisfied: true,
                constraint_evidence_satisfied: true,
                anchor_evidence_satisfied: true,
                matched_constraint_attributes: ['region'],
                unmet_constraint_attributes: [],
                anchor_signal_types: [],
              },
              post_rank: {
                candidate_count: 5,
                identity_evidence_satisfied: true,
                constraint_evidence_satisfied: true,
                anchor_evidence_satisfied: true,
                matched_constraint_attributes: ['region'],
                unmet_constraint_attributes: [],
                anchor_signal_types: [],
              },
              missing: [],
              satisfied: true,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects unknown nested keys inside typed constraint_resolution_trace entries', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          constraint_resolution_trace: {
            atoms: [
              {
                attribute: 'region',
                operator: '=',
                value: 'Bordeaux',
                source_phrase: '보르도',
                confidence: 0.98,
                source_tier: 'hard',
                source_kind: 'explicit_utterance',
                authority_level: 100,
                semantic_scope: 'intrinsic',
                conflict_policy: 'strict',
                constraint_role: 'must_satisfy',
                extra_flag: true,
              },
            ],
            relations: [],
            policy_outcomes: [],
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unknown nested keys inside typed abstain decision payloads', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          abstain_policy_trace: {
            evaluated: true,
            decision: {
              should_abstain: true,
              reason: 'low_confidence',
              detail: 'Entropy too high',
              rogue_key: 'nope',
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts typed planner_policy_trace with bounded scalar input_facts and inputs_matched', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          planner_policy_trace: [
            {
              stage: 'intent_classification',
              input_facts: { normalizedQuery: '오퍼스 원', anchorCount: 1 },
              rules_evaluated: [
                {
                  rule_id: 'intent.detected',
                  description: 'detected intent from query',
                  inputs_matched: { normalizedQuery: '오퍼스 원' },
                  outcome: 'entity_exact',
                },
              ],
              rejected_branches: [],
              decision: 'entity_exact',
              confidence: 0.95,
              duration_ms: 2,
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects planner input_facts with nested object values (bounded to scalars)', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          planner_policy_trace: [
            {
              stage: 'intent_classification',
              input_facts: { nested: { deep: true } },
              rules_evaluated: [],
              rejected_branches: [],
              decision: 'entity_exact',
              confidence: 0.9,
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects planner inputs_matched with array values (bounded to scalars)', () => {
    const parsed = SearchResponseSchema.safeParse({
      ...makeValidV1SearchResponse(),
      meta: {
        ...makeValidV1SearchResponse().meta,
        audit_extension: {
          planner_policy_trace: [
            {
              stage: 'route_resolution',
              input_facts: { intent: 'entity_exact', anchorCount: 1 },
              rules_evaluated: [
                {
                  rule_id: 'route.resolved',
                  description: 'resolved route',
                  inputs_matched: { values: [1, 2, 3] },
                  outcome: 'entity',
                },
              ],
              rejected_branches: [],
              decision: 'entity',
              confidence: 0.8,
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('EntitySummarySchema accepts lineage keys after deepKeysToSnake from domain camelCase', () => {
    const entity = deepKeysToSnake({
      entityId: 'wine:test',
      canonicalLabel: 'Test',
      type: 'wine',
      country: 'United States',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'silver-99' }],
    });
    const parsed = EntitySummarySchema.safeParse(entity);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.country).toBe('United States');
      expect(parsed.data.source_record_refs).toEqual([
        { source_system: 'vivino-silver', source_record_id: 'silver-99' },
      ]);
    }
  });

  it('EntitySummarySchema accepts finishLength/flavorProfiles/semanticSummary/availability after snake conversion', () => {
    const entity = deepKeysToSnake({
      entityId: 'wine:test',
      canonicalLabel: 'Test',
      type: 'wine',
      finishLength: 0.75,
      flavorProfiles: ['cedar', 'tobacco'],
      semanticSummary: 'Bold and elegant.',
      availability: true,
    });
    const parsed = EntitySummarySchema.safeParse(entity);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.finish_length).toBe(0.75);
      expect(parsed.data.flavor_profiles).toEqual(['cedar', 'tobacco']);
      expect(parsed.data.semantic_summary).toBe('Bold and elegant.');
      expect(parsed.data.availability).toBe(true);
    }
  });

  it('EntitySummarySchema rejects finish_length out of [0,1] range', () => {
    const parsed = EntitySummarySchema.safeParse({
      entity_id: 'wine:test',
      canonical_label: 'Test',
      type: 'wine',
      finish_length: 1.5,
    });
    expect(parsed.success).toBe(false);
  });
});
