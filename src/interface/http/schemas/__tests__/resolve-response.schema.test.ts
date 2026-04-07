import { describe, expect, it } from 'vitest';
import { ResolveResponseSchema } from '../search-response.schema.js';

function makeValidResolveResponse() {
  return {
    status: 'resolved',
    candidates: [
      {
        entity_id: 'wine:opus-one-2018',
        canonical_label: 'Opus One 2018',
        rank: 1,
        calibrated_score: 0.97,
        evidence_refs: ['resolver:alias_exact:opus-one-2018'],
      },
    ],
    top_entity: {
      entity_id: 'wine:opus-one-2018',
      canonical_label: 'Opus One 2018',
      calibrated_score: 0.97,
    },
    decision_trace_ref: 'decision:v1:short_entity:abc123',
    request_id: 'req-123',
  };
}

describe('ResolveResponseSchema', () => {
  it('accepts the canonical V1 resolve payload shape', () => {
    const parsed = ResolveResponseSchema.safeParse(makeValidResolveResponse());

    expect(parsed.success).toBe(true);
  });

  it('accepts canonical resolver evidence_refs on V1 candidates', () => {
    const parsed = ResolveResponseSchema.safeParse(makeValidResolveResponse());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.candidates[0]?.evidence_refs).toEqual([
        'resolver:alias_exact:opus-one-2018',
      ]);
    }
  });

  it('rejects V2 envelope fields on the V1 resolve contract', () => {
    const parsed = ResolveResponseSchema.safeParse({
      ...makeValidResolveResponse(),
      version: '2',
      response_type: 'human',
      query_id: 'q-123',
      queryId: 'q-123',
      responseType: 'human',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects mixed V1/V2 resolve payloads that replace snake_case entity fields with camelCase card fields', () => {
    const parsed = ResolveResponseSchema.safeParse({
      ...makeValidResolveResponse(),
      candidates: [
        {
          entityId: 'wine:opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          rank: 1,
          confidence: 0.97,
          version: '2',
          responseType: 'human',
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects candidate objects that keep valid V1 fields but also leak V2 card fields', () => {
    const parsed = ResolveResponseSchema.safeParse({
      ...makeValidResolveResponse(),
      candidates: [
        {
          entity_id: 'wine:opus-one-2018',
          canonical_label: 'Opus One 2018',
          rank: 1,
          calibrated_score: 0.97,
          entityId: 'wine:opus-one-2018',
          responseType: 'human',
          version: '2',
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
