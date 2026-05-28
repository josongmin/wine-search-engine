import { describe, expect, it, vi } from 'vitest';
import { PgEvalResultStore } from '../pg-eval-result-store.js';

const VALID_SNAPSHOT = {
  snapshot_id: 'snap-test-001',
  policy_rule_version: 'v1.0',
  threshold_profile_id: 'default',
  planner_version: 'v1.0',
  response_contract_version: 'search_response_v1',
  model_versions: { embedding: 'test-v1' },
  index_versions: { wine_content: '2026-01-01' },
  feature_flags: { test: true },
};

const VALID_EVIDENCE = [{
  type: 'identity',
  source: 'test',
  contribution: '+1',
  strength: 'high' as const,
  provenance: 'test',
}];

const VALID_SCORE_COMPONENTS = {
  semantic: 0.82,
  popularity: 0.14,
  attributeAlignment: 0.33,
  preferenceAlignment: 0.28,
  entityPosterior: 0.97,
  identityExactnessTier: 'exact' as const,
  lanePresence: 'corroborated' as const,
};

describe('PgEvalResultStore.getResults', () => {
  it('drops legacy source-record predicted_entity_id rows instead of throwing ADR-007', async () => {
    const query = vi.fn().mockResolvedValue({
        rows: [{
          result_id: 'r1',
          case_id: 'case-1',
          predicted_entity_id: 'vivino-deadbeef',
          predicted_status: 'resolved',
          decision_confidence: 0.91,
          top1_raw_score: 0.88,
          utility_score: 1,
          is_correct_resolve: true,
          is_wrong_resolve: false,
          is_safe_abstain: false,
          is_avoidable_abstain: false,
          evidence_items: VALID_EVIDENCE,
          top_result_score_components: VALID_SCORE_COMPONENTS,
          runtime_query_class: 'pure_constraint',
          runtime_intent: 'facet_search',
          runtime_route: 'hybrid',
          runtime_retrieval_mode: 'constraint_filter',
          gold_runtime_query_class_mismatch: true,
          latency_ms: 12,
          decision_snapshot: VALID_SNAPSHOT,
          created_at: new Date('2026-05-27T00:00:00Z'),
        }],
      });
    const pool = { query } as never;

    const store = new PgEvalResultStore(pool);
    const results = await store.getResults({ snapshotId: VALID_SNAPSHOT.snapshot_id });

    expect(results).toHaveLength(1);
    expect(results[0]?.predictedEntityId).toBeUndefined();
    expect(results[0]?.predictedStatus).toBe('resolved');
    expect(results[0]?.top1RawScore).toBe(0.88);
    expect(results[0]?.topResultScoreComponents).toEqual(VALID_SCORE_COMPONENTS);
    expect(results[0]?.runtimeQueryClass).toBe('pure_constraint');
    expect(results[0]?.runtimeIntent).toBe('facet_search');
    expect(results[0]?.runtimeRoute).toBe('hybrid');
    expect(results[0]?.runtimeRetrievalMode).toBe('constraint_filter');
    expect(results[0]?.goldRuntimeQueryClassMismatch).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(`er.decision_snapshot->>'snapshot_id' = $1`),
      [VALID_SNAPSHOT.snapshot_id],
    );
  });

  it('preserves canonical predicted_entity_id rows', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          result_id: 'r2',
          case_id: 'case-2',
          predicted_entity_id: 'wine-ce-opus-one',
          predicted_status: 'resolved',
          decision_confidence: 0.97,
          top1_raw_score: 0.94,
          utility_score: 1,
          is_correct_resolve: true,
          is_wrong_resolve: false,
          is_safe_abstain: false,
          is_avoidable_abstain: false,
          evidence_items: VALID_EVIDENCE,
          latency_ms: 11,
          decision_snapshot: VALID_SNAPSHOT,
          created_at: new Date('2026-05-27T00:00:00Z'),
        }],
      }),
    } as never;

    const store = new PgEvalResultStore(pool);
    const results = await store.getResults();

    expect(results).toHaveLength(1);
    expect(results[0]?.predictedEntityId).toBe('wine-ce-opus-one');
  });
});

describe('PgEvalResultStore.saveResult', () => {
  it('persists canonical top-result score components when the column exists', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query } as never;

    const store = new PgEvalResultStore(pool);
    await store.saveResult({
      caseId: 'case-save-1',
      predictedEntityId: 'wine-ce-opus-one',
      predictedStatus: 'resolved',
      decisionConfidence: 0.98,
      top1RawScore: 0.95,
      utilityScore: 1,
      isCorrectResolve: true,
      isWrongResolve: false,
      isSafeAbstain: false,
      isAvoidableAbstain: false,
      evidenceItems: VALID_EVIDENCE,
      topResultScoreComponents: VALID_SCORE_COMPONENTS,
      latencyMs: 9,
      decisionSnapshot: VALID_SNAPSHOT,
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM information_schema.columns'),
      ['eval_results', 'top_result_score_components'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM information_schema.columns'),
      ['eval_results', 'runtime_query_class'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('runtime_query_class'),
      expect.arrayContaining([
        'case-save-1',
        'wine-ce-opus-one',
        'resolved',
        0.98,
        0.95,
        JSON.stringify(VALID_SCORE_COMPONENTS),
      ]),
    );
  });
});
