import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import {
  convertKrwBudgetToUsdBounds,
  parseCanonicalPriceRangeUsd,
  priceUsdMatchesBudget,
} from '../../domain/shared/utils/canonical-price.js';

interface SearchToolBudgetFilterResult {
  readonly response: SearchResponseV1;
  readonly mode: 'unchanged' | 'strict';
}

interface SearchToolAlcoholFilterResult {
  readonly response: SearchResponseV1;
  readonly filteredCount: number;
  readonly unknownCount: number;
}

export function applySearchToolBudgetResultPolicy(
  response: SearchResponseV1,
  budget: {
    readonly minKrw?: number | undefined;
    readonly maxKrw?: number | undefined;
  },
  options: {
    readonly krwPerUsd: number;
  },
): SearchToolBudgetFilterResult {
  if (budget.minKrw === undefined && budget.maxKrw === undefined) {
    return { response, mode: 'unchanged' };
  }
  const budgetUsd = convertKrwBudgetToUsdBounds(budget);

  const strict = response.results.filter((result) => {
    const entityPriceRange =
      result.entity.priceUsd !== undefined
        ? { minUsd: result.entity.priceUsd, maxUsd: result.entity.priceUsd }
        : parseCanonicalPriceRangeUsd(result.entity.priceRange, options.krwPerUsd);
    if (entityPriceRange === undefined || entityPriceRange === null) {
      return false;
    }
    return priceUsdMatchesBudget(entityPriceRange, budgetUsd);
  });

  if (strict.length < response.results.length) {
    return {
      response: { ...response, results: strict },
      mode: 'strict',
    };
  }

  return { response, mode: 'unchanged' };
}

export function applySearchToolAlcoholResultPolicy(
  response: SearchResponseV1,
  maxAlcoholPct: number | undefined,
): SearchToolAlcoholFilterResult {
  if (maxAlcoholPct === undefined) {
    return { response, filteredCount: 0, unknownCount: 0 };
  }

  const verifiedWithinLimit = response.results.filter((result) => {
    const alcoholPct = result.entity.alcoholPct;
    return alcoholPct !== undefined && alcoholPct <= maxAlcoholPct;
  });
  const unknownAlcohol = response.results.filter((result) => result.entity.alcoholPct === undefined);
  const filtered = response.results.filter((result) => {
    const alcoholPct = result.entity.alcoholPct;
    return alcoholPct === undefined || alcoholPct <= maxAlcoholPct;
  });

  if (filtered.length === response.results.length) {
    return {
      response:
        verifiedWithinLimit.length === response.results.length
          ? response
          : { ...response, results: filtered },
      filteredCount: 0,
      unknownCount: unknownAlcohol.length,
    };
  }

  return {
    response: { ...response, results: filtered },
    filteredCount: response.results.length - filtered.length,
    unknownCount: unknownAlcohol.length,
  };
}
