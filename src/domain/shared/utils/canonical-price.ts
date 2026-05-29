import { KRW_PER_USD_APPROXIMATE } from '../constants.js';

const USD_DISPLAY_PRICE_RE = /^\$(\d[\d,]*(?:\.\d+)?)$/u;
const USD_DISPLAY_RANGE_RE = /^\$(\d[\d,]*(?:\.\d+)?)\s*-\s*\$?(\d[\d,]*(?:\.\d+)?)$/u;
const KRW_DISPLAY_PRICE_RE = /^(?:₩\s*)?(\d[\d,]*)(?:\s*원)?$/u;
const KRW_DISPLAY_RANGE_RE = /^(?:₩\s*)?(\d[\d,]*)\s*-\s*(?:₩\s*)?(\d[\d,]*)(?:\s*원)?$/u;
const KRW_PRICE_CONSTRAINT_ATTRIBUTES = new Set([
  'price_krw',
  'max_price_krw',
  'min_price_krw',
]);
const USD_PRICE_CONSTRAINT_ATTRIBUTES = new Set([
  'price',
  'price_usd',
  'max_price_usd',
  'min_price_usd',
]);

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

function isFiniteNumericRange(
  value: unknown,
): value is { readonly min?: number; readonly max?: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const range = value as { readonly min?: unknown; readonly max?: unknown };
  const minValid = range.min === undefined || (typeof range.min === 'number' && Number.isFinite(range.min));
  const maxValid = range.max === undefined || (typeof range.max === 'number' && Number.isFinite(range.max));
  return minValid && maxValid;
}

export function convertKrwToConstraintUsd(priceKrw: number): number {
  return roundUsdToConstraintPrecision(priceKrw / KRW_PER_USD_APPROXIMATE);
}

export function canonicalizePriceConstraintAttribute(attribute: string): string {
  if (KRW_PRICE_CONSTRAINT_ATTRIBUTES.has(attribute) || USD_PRICE_CONSTRAINT_ATTRIBUTES.has(attribute)) {
    return 'price_usd';
  }
  return attribute;
}

export function canonicalizePriceConstraintLike<T extends {
  readonly attribute: string;
  readonly value: unknown;
}>(
  constraint: T,
): T {
  const canonicalAttribute = canonicalizePriceConstraintAttribute(constraint.attribute);
  if (canonicalAttribute === constraint.attribute && canonicalAttribute !== 'price_usd') {
    return constraint;
  }

  let canonicalValue = constraint.value;
  if (KRW_PRICE_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
    if (typeof constraint.value === 'number' && Number.isFinite(constraint.value)) {
      canonicalValue = convertKrwToConstraintUsd(constraint.value);
    } else if (isFiniteNumericRange(constraint.value)) {
      canonicalValue = {
        ...(constraint.value.min !== undefined ? { min: convertKrwToConstraintUsd(constraint.value.min) } : {}),
        ...(constraint.value.max !== undefined ? { max: convertKrwToConstraintUsd(constraint.value.max) } : {}),
      };
    }
  }

  if (canonicalAttribute === constraint.attribute && canonicalValue === constraint.value) {
    return constraint;
  }

  return {
    ...constraint,
    attribute: canonicalAttribute,
    value: canonicalValue,
  };
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

export function splitCanonicalUsdBudgetAcrossSlots(
  totalBudgetUsd: number | undefined,
  slotCount: number,
): number | undefined {
  if (totalBudgetUsd === undefined) {
    return undefined;
  }
  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0) {
    return undefined;
  }
  if (!Number.isFinite(slotCount) || slotCount <= 0) {
    return undefined;
  }
  return roundUsdToConstraintPrecision(totalBudgetUsd / slotCount);
}
