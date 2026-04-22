import { describe, expect, it } from 'vitest';
import { AutocompleteResponseSchema } from '../search-response.schema.js';

function makeValidAutocompleteResponse() {
  return {
    status: 'resolved',
    suggestions: [
      {
        entity: {
          entity_id: 'wine:opus-one-2018',
          canonical_label: 'Opus One 2018',
          entity_type: 'wine',
          producer: 'Opus One',
          region: 'Napa Valley',
          country: 'United States',
          vintage: 2018,
          wine_type: 'red',
          grapes: ['Cabernet Sauvignon'],
          availability: true,
        },
        rank: 1,
        calibrated_score: 0.97,
        source: 'alias',
        evidence_refs: ['resolver:alias_exact:opus-one-2018'],
      },
    ],
    decision_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    authority_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    request_id: 'req-123',
  };
}

describe('AutocompleteResponseSchema', () => {
  it('accepts the canonical autocomplete payload shape', () => {
    const parsed = AutocompleteResponseSchema.safeParse(makeValidAutocompleteResponse());
    expect(parsed.success).toBe(true);
  });

  it('accepts fallback suggestion cards with only entity id and canonical label', () => {
    const parsed = AutocompleteResponseSchema.safeParse({
      ...makeValidAutocompleteResponse(),
      suggestions: [
        {
          entity: {
            entity_id: 'wine:mystery',
            canonical_label: 'Mystery Wine',
          },
          rank: 1,
          calibrated_score: 0.61,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects response payloads whose authority trace diverges from decision trace', () => {
    const parsed = AutocompleteResponseSchema.safeParse({
      ...makeValidAutocompleteResponse(),
      authority_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
    });

    expect(parsed.success).toBe(false);
  });
});
