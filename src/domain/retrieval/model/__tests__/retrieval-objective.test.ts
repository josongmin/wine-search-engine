import { describe, expect, it } from 'vitest';
import { buildRetrievalObjective } from '../retrieval-objective.js';
import type { ConstraintBundle } from '../../../shared/types/index.js';

describe('buildRetrievalObjective', () => {
  it('projects only intent-bearing constraints into typed objective signals', () => {
    const bundle: ConstraintBundle = {
      hard: [
        {
          attribute: 'region',
          operator: '=',
          value: 'Bordeaux',
          source_phrase: '보르도',
          confidence: 0.9,
          mapping_version: 'test',
        },
        {
          attribute: 'occasion',
          operator: 'in',
          value: ['gift'],
          source_phrase: '선물',
          confidence: 0.91,
          mapping_version: 'test',
        },
      ],
      soft: [
        {
          attribute: 'gift_suitability',
          operator: '>=',
          value: 0.8,
          source_phrase: '선물용',
          confidence: 0.88,
          mapping_version: 'test',
        },
        {
          attribute: 'price_band',
          operator: '=',
          value: 'value',
          source_phrase: '가성비',
          confidence: 0.83,
          mapping_version: 'test',
        },
      ],
      inferred: [
        {
          attribute: 'beginner_suitability',
          operator: '>=',
          value: 0.7,
          source_phrase: '입문자',
          confidence: 0.76,
          mapping_version: 'test',
        },
      ],
    };

    const objective = buildRetrievalObjective(bundle);

    expect(objective.objectiveVersion).toBe('retrieval-objective-v1.0');
    expect(objective.signals).toEqual([
      expect.objectContaining({ axis: 'occasion', sourceTier: 'hard', value: ['gift'] }),
      expect.objectContaining({ axis: 'gift_suitability', sourceTier: 'soft', value: 0.8 }),
      expect.objectContaining({ axis: 'value', attribute: 'price_band', sourceTier: 'soft' }),
      expect.objectContaining({ axis: 'beginner_suitability', sourceTier: 'inferred', value: 0.7 }),
    ]);
    expect(objective.signals).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'region' }),
    ]));
  });
});
