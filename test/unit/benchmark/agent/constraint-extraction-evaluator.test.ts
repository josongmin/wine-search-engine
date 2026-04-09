import { describe, expect, it } from 'vitest';
import {
  scoreEntityLinkingAccuracy,
  scoreSemanticConstraintRecall,
  type ExtractedEntityMention,
} from '../../../../test/benchmark/agent/constraint-extraction-evaluator.js';

describe('scoreSemanticConstraintRecall', () => {
  it('scores hard/soft/inferred buckets separately and computes weighted overall', () => {
    const result = scoreSemanticConstraintRecall(
      {
        hard: [
          { attribute: 'region', operator: '=', value: 'Bordeaux', source_phrase: '보르도', confidence: 1 },
          { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: '레드', confidence: 1 },
        ],
        soft: [
          { attribute: 'country', operator: '=', value: 'France', source_phrase: 'ontology', confidence: 0.8 },
        ],
        inferred: [
          { attribute: 'tannin', operator: '>=', value: 0.55, source_phrase: 'composition', confidence: 0.7 },
        ],
      },
      {
        hard: [
          { attribute: 'region', operator: '=', value: 'Bordeaux' },
          { attribute: 'wine_type', operator: '=', value: 'red' },
          { attribute: 'vintage_year', operator: '>=', value: 2018 },
        ],
        soft: [{ attribute: 'country', operator: '=', value: 'France' }],
        inferred: [{ attribute: 'tannin', operator: '>=', value: 0.55 }],
      },
    );

    expect(result.hard).toBeCloseTo(2 / 3, 5);
    expect(result.soft).toBe(1);
    expect(result.inferred).toBe(1);
    expect(result.overall).toBeCloseTo(0.8, 5);
  });

  it('treats overlapping numeric ranges as a match', () => {
    const result = scoreSemanticConstraintRecall(
      {
        hard: [],
        soft: [],
        inferred: [
          {
            attribute: 'price_krw',
            operator: 'range',
            value: { min: 20_000, max: 50_000 },
            source_phrase: 'budget',
            confidence: 0.8,
          },
        ],
      },
      {
        inferred: [
          { attribute: 'price_krw', operator: 'range', value: { min: 30_000, max: 50_000 } },
        ],
      },
    );

    expect(result.inferred).toBe(1);
  });
});

describe('scoreEntityLinkingAccuracy', () => {
  it('computes precision/recall from extracted entity mentions', () => {
    const extracted: ExtractedEntityMention[] = [
      { surface: '보르도', canonical: 'Bordeaux', type: 'region' },
      { surface: '카베르네', canonical: 'Cabernet Sauvignon', type: 'grape_primary' },
    ];

    const result = scoreEntityLinkingAccuracy(extracted, [
      { surface: '보르도', canonical: 'Bordeaux', type: 'region' },
      { surface: '카베르네', canonical: 'Cabernet Sauvignon', type: 'grape_primary' },
      { surface: '프랑스', canonical: 'France', type: 'country' },
    ]);

    expect(result.precision).toBe(1);
    expect(result.recall).toBeCloseTo(2 / 3, 5);
    expect(result.elaAt1).toBeCloseTo(2 / 3, 5);
  });
});
