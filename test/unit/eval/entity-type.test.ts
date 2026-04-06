import { describe, expect, it } from 'vitest';
import {
  inferEntityTargetType,
  inferResolvedEntityType,
} from '../../../scripts/eval/entity-type.js';

describe('entity type inference', () => {
  it('infers browse target types from retrieval mode metadata', () => {
    expect(
      inferEntityTargetType({
        retrieval_mode: 'producer_browse',
        query_class: 'catalog_browse',
        scenario: 'G',
      }),
    ).toBe('producer');

    expect(
      inferEntityTargetType({
        retrieval_mode: 'region_browse',
        query_class: 'catalog_browse',
        scenario: 'G',
      }),
    ).toBe('region');
  });

  it('falls back to wine for entity and recommendation classes', () => {
    expect(
      inferEntityTargetType({
        retrieval_mode: 'entity_lookup',
        query_class: 'exact_entity',
        scenario: 'A',
      }),
    ).toBe('wine');

    expect(
      inferEntityTargetType({
        query_class: 'noisy_recall',
        scenario: 'H',
      }),
    ).toBe('wine');
  });

  it('returns unknown when neither retrieval mode nor query class maps to an entity type', () => {
    expect(
      inferEntityTargetType({
        query_class: 'unknown' as import('../../../scripts/etl/types.js').GoldenQuery['query_class'],
        scenario: 'legacy_only' as import('../../../scripts/etl/types.js').GoldenQuery['scenario'],
      }),
    ).toBe('unknown');
  });

  it('falls back to Epic 2 scenario letter when query_class is not in the map', () => {
    expect(
      inferEntityTargetType({
        query_class: 'future_class' as import('../../../scripts/etl/types.js').GoldenQuery['query_class'],
        scenario: 'F',
      }),
    ).toBe('wine');
  });

  it('reads resolved entity type from response metadata rather than decision status', () => {
    expect(inferResolvedEntityType({ entity_type: 'wine' })).toBe('wine');
    expect(inferResolvedEntityType({ entity_type: 'producer' })).toBe('producer');
    expect(inferResolvedEntityType({ entity_type: 'region' })).toBe('region');
    expect(inferResolvedEntityType({ entity_type: 'mystery' })).toBe('unknown');
    expect(inferResolvedEntityType(undefined)).toBe('unknown');
  });
});
