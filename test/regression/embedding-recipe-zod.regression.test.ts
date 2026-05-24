/**
 * Wave 2 SOTA++ regression: embedding recipe Zod validation.
 *
 * The recipe file is the single source of truth for the dense-embedding input
 * shape. A typo / missing field / unknown field MUST fail loud at ETL startup
 * — silent fallback would mean a corpus-wide embedding regression with no
 * operator alarm.
 */

import { describe, expect, it } from 'vitest';
import { parseEmbeddingRecipe, getEmbeddingRecipe } from '../../scripts/etl/embedding-recipe.js';

const VALID_BASELINE = getEmbeddingRecipe();

describe('parseEmbeddingRecipe — happy path', () => {
  it('accepts the production recipe verbatim', () => {
    expect(() => parseEmbeddingRecipe(VALID_BASELINE)).not.toThrow();
  });
});

describe('parseEmbeddingRecipe — malformed input', () => {
  it('throws when a top-level required field is missing', () => {
    const { model_id: _omit, ...withoutModelId } = VALID_BASELINE;
    expect(() => parseEmbeddingRecipe(withoutModelId)).toThrow(/model_id/);
  });

  it('throws when version is not a positive integer', () => {
    expect(() =>
      parseEmbeddingRecipe({ ...VALID_BASELINE, version: 0 }),
    ).toThrow(/version/);
    expect(() =>
      parseEmbeddingRecipe({ ...VALID_BASELINE, version: 1.5 }),
    ).toThrow(/version/);
  });

  it('throws when fields[] is empty', () => {
    expect(() =>
      parseEmbeddingRecipe({ ...VALID_BASELINE, fields: [] }),
    ).toThrow(/fields/);
  });

  it('throws when a field weight is negative', () => {
    expect(() =>
      parseEmbeddingRecipe({
        ...VALID_BASELINE,
        fields: [
          {
            name: 'canonical_label',
            weight: -1,
            rationale: 'should fail',
          },
        ],
      }),
    ).toThrow(/weight/);
  });

  it('throws when a field weight is non-finite', () => {
    expect(() =>
      parseEmbeddingRecipe({
        ...VALID_BASELINE,
        fields: [
          {
            name: 'canonical_label',
            weight: Number.NaN,
            rationale: 'should fail',
          },
        ],
      }),
    ).toThrow();
  });

  it('throws when field_weight_strategy is an unknown literal', () => {
    expect(() =>
      parseEmbeddingRecipe({
        ...VALID_BASELINE,
        field_weight_strategy: 'totally_made_up',
      }),
    ).toThrow(/field_weight_strategy/);
  });

  it('strict mode rejects unknown top-level fields', () => {
    expect(() =>
      parseEmbeddingRecipe({ ...VALID_BASELINE, sneaky_extra: true }),
    ).toThrow(/sneaky_extra|unrecognized/i);
  });

  it('strict mode rejects unknown per-field keys', () => {
    expect(() =>
      parseEmbeddingRecipe({
        ...VALID_BASELINE,
        fields: [
          {
            name: 'canonical_label',
            weight: 1.0,
            rationale: 'fine',
            unexpected_extra: 'x',
          },
        ],
      }),
    ).toThrow(/unexpected_extra|unrecognized/i);
  });

  it('throws when input is not an object', () => {
    expect(() => parseEmbeddingRecipe(null)).toThrow();
    expect(() => parseEmbeddingRecipe('not-json')).toThrow();
    expect(() => parseEmbeddingRecipe(42)).toThrow();
  });
});
