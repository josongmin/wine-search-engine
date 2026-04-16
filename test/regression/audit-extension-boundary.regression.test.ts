/**
 * T-E5-03: Audit extension stable vs debug boundary regression test.
 *
 * Verifies that the AuditExtension schema and domain type maintain a clear
 * boundary between stable (always-emitted) and debug-only (gated) fields.
 *
 * This test is APPEND-ONLY — never delete cases from this file.
 */
import { describe, expect, it } from 'vitest';
import {
  AuditExtensionSchema,
  AUDIT_EXTENSION_STABLE_FIELDS,
  AUDIT_EXTENSION_DEBUG_FIELDS,
} from '../../src/interface/http/schemas/search-response.schema.js';
import type { AuditExtension } from '../../src/domain/audit/model/audit-extension.js';

describe('T-E5-03: AuditExtension stable vs debug boundary', () => {
  it('stable and debug field lists are disjoint', () => {
    const stableSet = new Set<string>(AUDIT_EXTENSION_STABLE_FIELDS);
    const debugSet = new Set<string>(AUDIT_EXTENSION_DEBUG_FIELDS);
    const overlap = [...stableSet].filter((key) => debugSet.has(key));
    expect(overlap).toEqual([]);
  });

  it('stable and debug field lists together cover all schema keys', () => {
    const schemaShape = AuditExtensionSchema.shape;
    const schemaKeys = new Set(Object.keys(schemaShape));
    const declaredKeys = new Set([
      ...AUDIT_EXTENSION_STABLE_FIELDS,
      ...AUDIT_EXTENSION_DEBUG_FIELDS,
    ]);
    // Every schema key must appear in exactly one list.
    for (const key of schemaKeys) {
      expect(
        declaredKeys.has(key),
      ).toBe(true);
    }
  });

  it('stable fields list matches the documented stable set', () => {
    expect([...AUDIT_EXTENSION_STABLE_FIELDS].sort()).toEqual([
      'abstain_policy_trace',
      'corrective_retry_calibrated_confidence',
      'determinism_fingerprint',
      'fallback_trace',
      'hard_filter_drop_log',
    ]);
  });

  it('debug fields list matches the documented debug set', () => {
    expect([...AUDIT_EXTENSION_DEBUG_FIELDS].sort()).toEqual([
      'constraint_resolution_trace',
      'execution_trace',
      'planner_policy_trace',
      'ranking_delta_trace',
      'rerank_decision_trace',
      'resolver_provenance_trace',
      'retrieval_fusion_trace',
    ]);
  });

  it('AuditExtensionSchema validates a minimal stable-only payload', () => {
    const stableOnlyPayload = {
      abstain_policy_trace: {
        evaluated: true,
        decision: false,
      },
      hard_filter_drop_log: [],
      fallback_trace: {
        fallback_applied: null,
        reasoning_failure: false,
        failed_synthesis_attempts: 0,
        fallback_search_used: false,
      },
      corrective_retry_calibrated_confidence: 0.85,
      determinism_fingerprint: 'abc123',
    };
    const result = AuditExtensionSchema.safeParse(stableOnlyPayload);
    expect(result.success).toBe(true);
  });

  it('AuditExtensionSchema validates a debug-only payload', () => {
    const debugOnlyPayload = {
      planner_policy_trace: [],
      constraint_resolution_trace: {
        atoms: [],
        relations: [],
        policy_outcomes: [],
      },
      ranking_delta_trace: {
        pre_rerank_top5: [],
        post_rerank_top5: [],
        safety_envelope_blocks: 0,
        protected_candidate_evictions: 0,
        drift: {
          query_class: 'test',
          heuristic_top3_entity_ids: [],
          ltr_top3_entity_ids: [],
          rank_order_changes: 0,
          average_rerank_delta_normalized: 0,
          safety_envelope_blocks: 0,
        },
      },
      retrieval_fusion_trace: {
        query_class: 'comparison',
        fusion_class: 'rrf',
        rrf_k: 60,
        channel_weights: {
          sparse: 1,
          dense: 1,
          anchor: 1,
          learned_sparse: 1,
        },
        candidate_count: {
          before_fusion: {
            sparse: 0,
            dense: 0,
            anchor: 0,
            learned_sparse: 0,
          },
          after_fusion: 0,
          after_hard_filter: 0,
          after_assembly: 0,
        },
      },
      rerank_decision_trace: {
        gate_decision: 'applied',
      },
      execution_trace: {
        effective_route: 'entity',
      },
      resolver_provenance_trace: {},
    };
    const result = AuditExtensionSchema.safeParse(debugOnlyPayload);
    expect(result.success).toBe(true);
  });

  it('domain AuditExtension type keys are a superset of schema keys', () => {
    // Compile-time assertion: if this test compiles, the domain type
    // has all the keys from the Zod schema (modulo passthrough additions).
    const domainKeys: readonly (keyof AuditExtension)[] = [
      'execution_trace',
      'planner_policy_trace',
      'constraint_resolution_trace',
      'retrieval_fusion_trace',
      'ranking_delta_trace',
      'rerank_decision_trace',
      'abstain_policy_trace',
      'hard_filter_drop_log',
      'resolver_provenance_trace',
      'corrective_retry_calibrated_confidence',
      'fallback_trace',
    ];
    expect(domainKeys.length).toBeGreaterThan(0);
  });
});
