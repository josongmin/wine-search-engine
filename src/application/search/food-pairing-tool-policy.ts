export interface FoodPairingBudgetInput {
  readonly max_price?: number | undefined;
  readonly max_price_krw?: number | undefined;
}

export interface FoodPairingColorInput {
  readonly color?: 'red' | 'white' | 'rosé' | 'sparkling' | 'both' | undefined;
}

export function resolveFoodPairingBudgetKrw(
  input: FoodPairingBudgetInput,
  options: {
    readonly krwPerUsd: number;
    readonly maxPriceKrwCap: number;
  },
): number | undefined {
  if (input.max_price_krw !== undefined) {
    return input.max_price_krw;
  }
  if (input.max_price === undefined) {
    return undefined;
  }

  const converted = input.max_price * options.krwPerUsd;
  if (!Number.isFinite(converted)) {
    return undefined;
  }
  return Math.min(Math.round(converted), options.maxPriceKrwCap);
}

export function buildFoodPairingColorClause(input: FoodPairingColorInput): string {
  if (input.color === undefined || input.color === 'both') {
    return '';
  }
  return ` ${input.color} wine`;
}
