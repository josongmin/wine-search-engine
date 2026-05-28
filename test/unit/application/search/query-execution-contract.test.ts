import { describe, expect, it } from 'vitest';

import { buildAgentQueryExecutionContract } from '../../../../src/application/search/query-execution-contract.js';
import { convertKrwToConstraintUsd } from '../../../../src/domain/shared/utils/canonical-price.js';

describe('buildAgentQueryExecutionContract', () => {
  it('canonicalizes structured price defaults to price_usd', () => {
    const contract = buildAgentQueryExecutionContract('5만원 이하 레드 와인 추천');

    expect(contract.searchDefaults?.max_price_usd).toBe(convertKrwToConstraintUsd(50_000));
    expect(contract.searchDefaults).not.toHaveProperty('max_price_krw');
  });

  it('keeps senior-gift budget defaults canonical without exposing KRW legacy keys', () => {
    const contract = buildAgentQueryExecutionContract('직장 상사 선물 와인 추천');

    expect(contract.searchDefaults?.min_price_usd).toBe(convertKrwToConstraintUsd(50_000));
    expect(contract.searchDefaults?.max_price_usd).toBe(convertKrwToConstraintUsd(150_000));
    expect(contract.searchDefaults).not.toHaveProperty('min_price_krw');
    expect(contract.searchDefaults).not.toHaveProperty('max_price_krw');
    expect(contract.requiresVerificationStep?.constraintCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matchedConstraintKey: 'price_usd',
          key: 'price:min',
        }),
        expect.objectContaining({
          matchedConstraintKey: 'price_usd',
          key: 'price:max',
        }),
      ]),
    );
  });

  it('stores current drinkability as an internal verification marker rather than tool-facing fields', () => {
    const contract = buildAgentQueryExecutionContract('보르도 2015 vs 2016 빈티지 비교, 둘 다 지금 마시기 좋은지도 알려줘');

    expect(contract.searchDefaults?.current_drinkability_target_year).toBe(new Date().getFullYear());
    expect(contract.searchDefaults).not.toHaveProperty('drinking_window');
    expect(contract.searchDefaults).not.toHaveProperty('drinking_window_target_year');
    expect(contract.requiresDrinkabilityCheck).toBe(true);
    expect(contract.requiresVerificationStep?.constraintCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matchedConstraintKey: 'drinking_window',
          key: 'drinking_window:current',
        }),
      ]),
    );
  });
});
