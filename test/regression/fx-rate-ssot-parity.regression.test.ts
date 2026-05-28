/**
 * FX rate single-source-of-truth parity.
 *
 * Locks the invariant that the QUERY side (NL price extraction via
 * `DEFAULT_FX_RATE_PORT` + `KRW_PER_USD_APPROXIMATE`) and the INDEX side
 * (ETL `extractPriceUsd` → `loadFxRatesCatalog`) resolve the SAME real-world
 * price to the SAME USD value.
 *
 * History: the ETL FX catalog hard-coded KRW=0.00075 (≈1333 KRW/USD) while the
 * domain constant was 1350. A "5만원 이하" query and a 50,000-KRW-priced wine
 * landed on different USD values (37.04 vs 37.50), so boundary wines were
 * silently dropped/admitted inconsistently. constants.ts is now the sole FX
 * SSoT and the ETL catalog injects the domain-owned rates.
 */
import { describe, expect, it } from 'vitest';
import { extractPriceUsd } from '../../scripts/etl/vivino-to-silver.js';
import { DEFAULT_FX_RATE_PORT } from '../../src/domain/query/port/fx-rate.port.js';
import {
  KRW_PER_USD_APPROXIMATE,
  USD_PER_EUR_APPROXIMATE,
  USD_PER_GBP_APPROXIMATE,
  KRW_PER_EUR_APPROXIMATE,
  KRW_PER_GBP_APPROXIMATE,
} from '../../src/domain/shared/constants.js';

/** Query-side: foreign amount → KRW (port) → USD (KRW_PER_USD). */
function queryUsd(amount: number, currency: 'USD' | 'EUR' | 'GBP'): number {
  const krw = amount * DEFAULT_FX_RATE_PORT.getKrwPerUnit(currency);
  return krw / KRW_PER_USD_APPROXIMATE;
}

describe('FX rate SSoT — cross-rate derivation', () => {
  it('KRW_PER_EUR is derived as KRW_PER_USD × USD_PER_EUR (not hand-written)', () => {
    expect(KRW_PER_EUR_APPROXIMATE).toBeCloseTo(
      KRW_PER_USD_APPROXIMATE * USD_PER_EUR_APPROXIMATE,
      10,
    );
  });

  it('KRW_PER_GBP is derived as KRW_PER_USD × USD_PER_GBP (not hand-written)', () => {
    expect(KRW_PER_GBP_APPROXIMATE).toBeCloseTo(
      KRW_PER_USD_APPROXIMATE * USD_PER_GBP_APPROXIMATE,
      10,
    );
  });
});

describe('FX rate SSoT — query/index agreement', () => {
  it('a 50,000 KRW wine and a "5만원" budget resolve to the same USD', () => {
    const indexUsd = extractPriceUsd(50_000, 'KRW', undefined, undefined);
    const budgetUsd = 50_000 / KRW_PER_USD_APPROXIMATE;
    expect(indexUsd).not.toBeNull();
    expect(indexUsd!).toBeCloseTo(budgetUsd, 2);
  });

  it('a €50 wine and a "€50" budget resolve to the same USD', () => {
    const indexUsd = extractPriceUsd(50, 'EUR', undefined, undefined);
    expect(indexUsd).not.toBeNull();
    expect(indexUsd!).toBeCloseTo(queryUsd(50, 'EUR'), 2);
  });

  it('a £30 wine and a "£30" budget resolve to the same USD', () => {
    const indexUsd = extractPriceUsd(30, 'GBP', undefined, undefined);
    expect(indexUsd).not.toBeNull();
    expect(indexUsd!).toBeCloseTo(queryUsd(30, 'GBP'), 2);
  });

  it('index catalog rates equal the domain anchors', () => {
    // 1 EUR → USD_PER_EUR, 1 GBP → USD_PER_GBP, KRW_PER_USD KRW → 1 USD.
    expect(extractPriceUsd(1, 'EUR', undefined, undefined)).toBeCloseTo(USD_PER_EUR_APPROXIMATE, 2);
    expect(extractPriceUsd(1, 'GBP', undefined, undefined)).toBeCloseTo(USD_PER_GBP_APPROXIMATE, 2);
    expect(
      extractPriceUsd(KRW_PER_USD_APPROXIMATE, 'KRW', undefined, undefined),
    ).toBeCloseTo(1, 2);
  });
});
