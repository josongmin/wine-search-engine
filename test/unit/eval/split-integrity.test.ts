import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import { verifyGoldenSplitIntegrity } from '../../../scripts/eval/split-integrity.js';

function makeQuery(
  qid: string,
  entityId: string,
  aliasCluster: string,
  template: string,
  runId: string,
  createdAt: string,
): GoldenQuery {
  return {
    qid,
    query: 'test',
    query_class: 'exact_entity',
    scenario: 'A',
    language: 'en',
    retrieval_labels: { relevant: [] },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: entityId,
      query_template_id: template,
      generation_run_id: runId,
      alias_cluster_id: aliasCluster,
    },
    annotation_tier: 'bronze',
    annotated_by: [],
    release_gate_eligible: false,
    created_at: createdAt,
  };
}

describe('verifyGoldenSplitIntegrity', () => {
  it('passes when train and gate are disjoint on entity_id', () => {
    const train = [makeQuery('t1', 'e-train', 'c1', 'tpl', 'run-x', '2026-01-01T00:00:00.000Z')];
    const val: GoldenQuery[] = [];
    const gate = [makeQuery('g1', 'e-gate', 'c2', 'tpl', 'run-x', '2026-01-02T00:00:00.000Z')];
    const r = verifyGoldenSplitIntegrity(train, val, gate);
    expect(r.valid).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('fails when the same entity_id appears in train and gate', () => {
    const shared = 'e-shared';
    const train = [makeQuery('t1', shared, 'c1', 'tpl', 'run-x', '2026-01-01T00:00:00.000Z')];
    const gate = [makeQuery('g1', shared, 'c2', 'tpl', 'run-x', '2026-01-02T00:00:00.000Z')];
    const r = verifyGoldenSplitIntegrity(train, [], gate);
    expect(r.valid).toBe(false);
    expect(r.violations.some((v) => v.includes('ENTITY_LEAK'))).toBe(true);
  });
});
