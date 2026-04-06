import { describe, expect, it } from 'vitest';
import { BatchSearchResponseSchema, BatchSearchRequestSchema } from '../batch-search.schema.js';

describe('BatchSearchResponseSchema', () => {
  it('accepts a succeeded batch summary when failed is zero', () => {
    const parsed = BatchSearchResponseSchema.safeParse({
      batch_id: 'batch-1',
      total: 1,
      succeeded: 1,
      failed: 0,
      batch_status: 'succeeded',
      has_failures: false,
      results: [
        {
          id: '1',
          status: 'succeeded',
          response: {
            query_type: 'search',
            engine_decision: {
              decision_status: 'resolved',
              next_action: 'return_result',
              route: 'hybrid',
              decision_confidence: 0.9,
              confidence_semantics: 'calibrated_decision_confidence',
              decision_trace_ref: 'trace-1',
              decision_snapshot: {
                snapshot_id: 'snap-1',
                model_versions: {},
                index_versions: {},
                policy_rule_version: '1',
                threshold_profile_id: 'default',
                planner_version: '1',
                feature_flags: {},
                response_contract_version: 'search_response_v1',
              },
            },
            results: [],
            clarification: null,
            meta: {
              request_id: 'req-1',
              query_time_ms: 10,
              route: 'hybrid',
              version: '1.0.0',
              engine_schema_version: 'search_response_v1',
              decision_snapshot: {
                snapshot_id: 'snap-1',
                model_versions: {},
                index_versions: {},
                policy_rule_version: '1',
                threshold_profile_id: 'default',
                planner_version: '1',
                feature_flags: {},
                response_contract_version: 'search_response_v1',
              },
              response_hash: 'hash',
            },
          },
        },
      ],
      processing_time_ms: 12,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects mismatched batch_status and has_failures invariants', () => {
    const parsed = BatchSearchResponseSchema.safeParse({
      batch_id: 'batch-2',
      total: 2,
      succeeded: 1,
      failed: 1,
      batch_status: 'succeeded',
      has_failures: false,
      results: [
        {
          id: '1',
          status: 'succeeded',
          response: {
            query_type: 'search',
            engine_decision: {
              decision_status: 'resolved',
              next_action: 'return_result',
              route: 'hybrid',
              decision_confidence: 0.9,
              confidence_semantics: 'calibrated_decision_confidence',
              decision_trace_ref: 'trace-1',
              decision_snapshot: {
                snapshot_id: 'snap-2',
                model_versions: {},
                index_versions: {},
                policy_rule_version: '1',
                threshold_profile_id: 'default',
                planner_version: '1',
                feature_flags: {},
                response_contract_version: 'search_response_v1',
              },
            },
            results: [],
            clarification: null,
            meta: {
              request_id: 'req-1',
              query_time_ms: 10,
              route: 'hybrid',
              version: '1.0.0',
              engine_schema_version: 'search_response_v1',
              decision_snapshot: {
                snapshot_id: 'snap-2',
                model_versions: {},
                index_versions: {},
                policy_rule_version: '1',
                threshold_profile_id: 'default',
                planner_version: '1',
                feature_flags: {},
                response_contract_version: 'search_response_v1',
              },
              response_hash: 'hash',
            },
          },
        },
        {
          id: '2',
          status: 'failed',
          error: {
            code: 'INTERNAL_ERROR',
            message: 'boom',
          },
        },
      ],
      processing_time_ms: 20,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['batch_status', 'has_failures']),
    );
  });
});

describe('BatchSearchRequestSchema', () => {
  it('accepts a valid batch request with unique ids', () => {
    const parsed = BatchSearchRequestSchema.safeParse({
      requests: [
        { id: 'a', query: 'Opus One 2018' },
        { id: 'b', query: 'Petrus 2000' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a batch request with duplicate item ids', () => {
    const parsed = BatchSearchRequestSchema.safeParse({
      requests: [
        { id: 'dup', query: 'Opus One 2018' },
        { id: 'ok', query: 'Petrus 2000' },
        { id: 'dup', query: 'Screaming Eagle' },
      ],
    });
    expect(parsed.success).toBe(false);
    const messages = parsed.error?.issues.map((i) => i.message) ?? [];
    expect(messages.some((m) => m.includes('dup'))).toBe(true);
  });

  it('accepts a single-item batch', () => {
    const parsed = BatchSearchRequestSchema.safeParse({
      requests: [{ id: '1', query: 'Bordeaux 2015' }],
    });
    expect(parsed.success).toBe(true);
  });
});
