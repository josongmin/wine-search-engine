import { describe, expect, it } from 'vitest';
import {
  buildFoodPairingColorClause,
  resolveFoodPairingBudgetKrw,
} from '../../../../src/application/search/food-pairing-tool-policy.js';

describe('food-pairing-tool-policy', () => {
  it('treats both as a legacy no-op color clause', () => {
    expect(buildFoodPairingColorClause({ color: 'both' })).toBe('');
    expect(buildFoodPairingColorClause({ color: undefined })).toBe('');
    expect(buildFoodPairingColorClause({ color: 'red' })).toBe(' red wine');
  });

  it('prefers explicit KRW budgets over USD legacy input', () => {
    expect(resolveFoodPairingBudgetKrw(
      { max_price_krw: 30000, max_price: 50 },
      { krwPerUsd: 1350, maxPriceKrwCap: 100_000_000 },
    )).toBe(30000);
  });

  it('converts legacy USD budgets into approximate KRW', () => {
    expect(resolveFoodPairingBudgetKrw(
      { max_price: 50 },
      { krwPerUsd: 1350, maxPriceKrwCap: 100_000_000 },
    )).toBe(67500);
  });

  it('clamps oversized USD conversions to the configured KRW cap', () => {
    expect(resolveFoodPairingBudgetKrw(
      { max_price: 1_000_000 },
      { krwPerUsd: 1350, maxPriceKrwCap: 100_000 },
    )).toBe(100000);
  });

  it('drops non-finite USD conversions instead of emitting Infinity', () => {
    expect(resolveFoodPairingBudgetKrw(
      { max_price: Number.POSITIVE_INFINITY },
      { krwPerUsd: 1350, maxPriceKrwCap: 100_000_000 },
    )).toBeUndefined();
  });
});
