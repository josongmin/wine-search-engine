import { describe, expect, it } from 'vitest';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
  stripExactEntityMetadataSuffix,
} from '../../../src/domain/query/service/exact-entity-metadata-signals.js';

describe('exact entity metadata signals', () => {
  it('detects colloquial Korean price questions as entity metadata', () => {
    expect(hasEntityMetadataKeyword('오푸스원 얼마야?')).toBe(true);
    expect(hasEntityMetadataKeyword('오푸스원 가격 얼마예요')).toBe(true);
  });

  it('detects drinkability questions as both drinkability and entity metadata', () => {
    expect(hasDrinkabilityKeyword('오푸스원 지금 마시기 좋아?')).toBe(true);
    expect(hasEntityMetadataKeyword('오푸스원 지금 마시기 좋아?')).toBe(true);
  });

  it('strips price and drinkability suffixes down to the bare entity query', () => {
    expect(stripExactEntityMetadataSuffix('오푸스원 얼마야?')).toBe('오푸스원');
    expect(stripExactEntityMetadataSuffix('오푸스원 지금 마시기 좋아?')).toBe('오푸스원');
  });

  it('preserves the raw query when no metadata suffix is present', () => {
    expect(stripExactEntityMetadataSuffix('오푸스원 추천해줘')).toBe('오푸스원 추천해줘');
  });
});
