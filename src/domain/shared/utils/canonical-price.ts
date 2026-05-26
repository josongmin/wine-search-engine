import { KRW_PER_USD_APPROXIMATE } from '../constants.js';

const USD_DISPLAY_PRICE_RE = /^\$(\d[\d,]*(?:\.\d+)?)$/u;
const USD_DISPLAY_RANGE_RE = /^\$(\d[\d,]*(?:\.\d+)?)\s*-\s*\$?(\d[\d,]*(?:\.\d+)?)$/u;
const KRW_DISPLAY_PRICE_RE = /^(?:₩\s*)?(\d[\d,]*)(?:\s*원)?$/u;
const KRW_DISPLAY_RANGE_RE = /^(?:₩\s*)?(\d[\d,]*)\s*-\s*(?:₩\s*)?(\d[\d,]*)(?:\s*원)?$/u;

export interface CanonicalPriceRangeUsd {
  readonly minUsd: number;
  readonly maxUsd: number;
}

function roundUsdToConstraintPrecision(priceUsd: number): number {
  return Math.round(priceUsd * 100) / 100;
}

function parseFiniteNumber(raw: string): number | null {
  const parsed = Number(raw.replace(/,/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function convertKrwToConstraintUsd(priceKrw: number): number {
  return roundUsdToConstraintPrecision(priceKrw / KRW_PER_USD_APPROXIMATE);
}

export function convertConstraintUsdToApproxKrw(priceUsd: number): number {
  return Math.round(priceUsd * KRW_PER_USD_APPROXIMATE);
}

export function convertKrwBudgetToUsdBounds(budget: {
  readonly minKrw?: number | undefined;
  readonly maxKrw?: number | undefined;
}): {
  readonly minUsd?: number | undefined;
  readonly maxUsd?: number | undefined;
} {
  return {
    ...(budget.minKrw !== undefined ? { minUsd: convertKrwToConstraintUsd(budget.minKrw) } : {}),
    ...(budget.maxKrw !== undefined ? { maxUsd: convertKrwToConstraintUsd(budget.maxKrw) } : {}),
  };
}

export function parseCanonicalPriceRangeUsd(
  priceRange: string | undefined,
  krwPerUsd: number = KRW_PER_USD_APPROXIMATE,
): CanonicalPriceRangeUsd | null | undefined {
  if (priceRange === undefined) {
    return undefined;
  }
  const normalized = priceRange.trim();
  const usdScalar = USD_DISPLAY_PRICE_RE.exec(normalized);
  if (usdScalar?.[1] !== undefined) {
    const priceUsd = parseFiniteNumber(usdScalar[1]);
    return priceUsd === null ? null : { minUsd: priceUsd, maxUsd: priceUsd };
  }
  const usdRange = USD_DISPLAY_RANGE_RE.exec(normalized);
  if (usdRange?.[1] !== undefined && usdRange[2] !== undefined) {
    const minUsd = parseFiniteNumber(usdRange[1]);
    const maxUsd = parseFiniteNumber(usdRange[2]);
    if (minUsd === null || maxUsd === null) {
      return null;
    }
    return minUsd <= maxUsd ? { minUsd, maxUsd } : null;
  }
  const krwScalar = KRW_DISPLAY_PRICE_RE.exec(normalized);
  if (krwScalar?.[1] !== undefined) {
    const priceKrw = parseFiniteNumber(krwScalar[1]);
    return priceKrw === null
      ? null
      : {
          minUsd: roundUsdToConstraintPrecision(priceKrw / krwPerUsd),
          maxUsd: roundUsdToConstraintPrecision(priceKrw / krwPerUsd),
        };
  }
  const krwRange = KRW_DISPLAY_RANGE_RE.exec(normalized);
  if (krwRange?.[1] !== undefined && krwRange[2] !== undefined) {
    const minKrw = parseFiniteNumber(krwRange[1]);
    const maxKrw = parseFiniteNumber(krwRange[2]);
    if (minKrw === null || maxKrw === null || minKrw > maxKrw) {
      return null;
    }
    return {
      minUsd: roundUsdToConstraintPrecision(minKrw / krwPerUsd),
      maxUsd: roundUsdToConstraintPrecision(maxKrw / krwPerUsd),
    };
  }
  return null;
}

export function priceUsdMatchesBudget(
  price: {
    readonly minUsd: number;
    readonly maxUsd: number;
  },
  budget: {
    readonly minUsd?: number | undefined;
    readonly maxUsd?: number | undefined;
  },
): boolean {
  if (budget.minUsd !== undefined && price.minUsd < budget.minUsd) {
    return false;
  }
  if (budget.maxUsd !== undefined && price.maxUsd > budget.maxUsd) {
    return false;
  }
  return true;
}
