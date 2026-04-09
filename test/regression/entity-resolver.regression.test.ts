import { describe, it, expect } from 'vitest';
import { resolveEntity } from '../../src/domain/attribute/service/entity-resolver.js';

describe('RFC-019 regression: entity resolver', () => {
  it.each([
    ['보르도', 'region', 'Bordeaux'],
    ['샤르도네', 'grape_primary', 'Chardonnay'],
    ['프랑스', 'country', 'France'],
    ['부르고뉴', 'region', 'Burgundy'],
    ['샴페인', 'region', 'Champagne'],
  ])('resolves %s → %s:%s', (span, expectedType, expectedValue) => {
    const result = resolveEntity(span);
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe(expectedType);
    expect(result!.canonicalValue).toBe(expectedValue);
    expect(result!.matchedSurface).toBe(span);
  });

  it('returns null for unknown terms', () => {
    expect(resolveEntity('알수없는지역')).toBeNull();
    expect(resolveEntity('')).toBeNull();
    expect(resolveEntity('   ')).toBeNull();
  });

  it('preferEntityOverStyle promotes region over wine_type for 샴페인', () => {
    const result = resolveEntity('샴페인', { preferEntityOverStyle: true });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('region');
    expect(result!.canonicalValue).toBe('Champagne');
  });

  it('default priority returns wine_type for 샴페인', () => {
    const result = resolveEntity('champagne');
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('wine_type');
  });
});
