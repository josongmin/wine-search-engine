import { describe, expect, it } from 'vitest';
import { ComparisonSearchResponseSchema } from '../search-response.schema.js';

function makeValidComparisonResponse() {
  return {
    query_type: 'comparison',
    original_query: 'Opus One vs Screaming Eagle',
    comparison_intent: 'compare',
    entities: [
      {
        sub_query: 'Opus One',
        top_result: null,
        result_count: 1,
        resolution_status: 'resolved',
        all_results: [],
      },
      {
        sub_query: 'Screaming Eagle',
        top_result: null,
        result_count: 1,
        resolution_status: 'resolved',
        all_results: [],
      },
    ],
    overall_status: 'resolved',
    request_id: 'req-123',
    authority_trace_ref: 'decision:v1:comparison_query:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    runtime_correlation_ref: 'req-123',
    execution_time_ms: 42,
  };
}

describe('ComparisonSearchResponseSchema', () => {
  it('accepts the canonical V1 comparison payload shape', () => {
    const parsed = ComparisonSearchResponseSchema.safeParse(makeValidComparisonResponse());

    expect(parsed.success).toBe(true);
  });

  it('rejects V2 envelope fields on the V1 comparison contract', () => {
    const parsed = ComparisonSearchResponseSchema.safeParse({
      ...makeValidComparisonResponse(),
      version: '2',
      response_type: 'human',
      query_id: 'q-123',
      queryType: 'comparison',
      responseType: 'human',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects mixed V1/V2 comparison payloads with V2 result cards', () => {
    const parsed = ComparisonSearchResponseSchema.safeParse({
      ...makeValidComparisonResponse(),
      entities: [
        {
          sub_query: 'Opus One',
          top_result: {
            entityId: 'wine:opus-one-2018',
            canonicalLabel: 'Opus One 2018',
            rank: 1,
            evidenceSummary: 'Top result',
            confidence: 0.95,
            version: '2',
            responseType: 'human',
          },
          result_count: 1,
          resolution_status: 'resolved',
          all_results: [],
        },
        {
          sub_query: 'Screaming Eagle',
          top_result: null,
          result_count: 1,
          resolution_status: 'resolved',
          all_results: [],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-canonical authority trace identifiers when surfaced on comparison responses', () => {
    const parsed = ComparisonSearchResponseSchema.safeParse({
      ...makeValidComparisonResponse(),
      authority_trace_ref: 'comparison:req-123',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects mismatched request_id/runtime_correlation_ref on comparison responses', () => {
    const parsed = ComparisonSearchResponseSchema.safeParse({
      ...makeValidComparisonResponse(),
      runtime_correlation_ref: 'different-request-id',
    });

    expect(parsed.success).toBe(false);
  });
});
