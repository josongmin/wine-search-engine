import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

const KOREAN_NEGATION_SUFFIX_RE = /(\S+)\s*(?:빼고|제외하고|제외|말고|아닌|없는|빼)/gu;
const KOREAN_NEGATION_PREFIX_RE = /(?:비\s+|안\s+쓴\s+|대신\s+)(\S+)/gu;
const ENGLISH_NEGATION_RE = /(?:not|without|exclude|no|skip|non-)\s+([\p{L}\p{N}][^,\n]*?)(?=\s*,|\s+and\s|\s*$)/giu;
const NEGATION_ENTITY_STRING_FIELDS: ReadonlyArray<'region' | 'producer' | 'appellation'> = [
  'region', 'producer', 'appellation',
] as const;

interface SearchToolNegationInput {
  readonly query: string;
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly exclude_wine_types?: readonly string[] | undefined;
}

interface SearchToolBudgetFilterResult {
  readonly response: SearchResponseV1;
  readonly mode: 'unchanged' | 'strict';
}

interface SearchToolAlcoholFilterResult {
  readonly response: SearchResponseV1;
  readonly filteredCount: number;
  readonly unknownCount: number;
}

interface SearchToolNegationFilterResult {
  readonly response: SearchResponseV1;
  readonly filteredCount: number;
}

function extractSearchToolNegationTerms(query: string): readonly string[] {
  const terms: string[] = [];

  for (const match of query.matchAll(KOREAN_NEGATION_SUFFIX_RE)) {
    const term = match[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }
  for (const match of query.matchAll(KOREAN_NEGATION_PREFIX_RE)) {
    const term = match[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }
  for (const match of query.matchAll(ENGLISH_NEGATION_RE)) {
    const term = match[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }

  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

export function collectSearchToolNegationTerms(
  input: SearchToolNegationInput,
): readonly string[] {
  return [
    ...new Set(
      [
        ...extractSearchToolNegationTerms(input.query),
        ...(input.exclude_grapes ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0),
        ...(input.exclude_regions ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0),
        ...(input.exclude_wine_types ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0),
      ],
    ),
  ];
}

export function applySearchToolNegationResultPolicy(
  response: SearchResponseV1,
  negTerms: readonly string[],
): SearchToolNegationFilterResult {
  if (negTerms.length === 0) {
    return { response, filteredCount: 0 };
  }

  const negRegs = negTerms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  });

  const filtered = response.results.filter((result) => {
    const entity = result.entity;
    const parts: string[] = [entity.canonicalLabel.toLowerCase()];
    for (const grape of entity.grapes ?? []) {
      parts.push(grape.toLowerCase());
    }
    for (const field of NEGATION_ENTITY_STRING_FIELDS) {
      const value = entity[field];
      if (typeof value === 'string' && value.length > 0) {
        parts.push(value.toLowerCase());
      }
    }
    if (typeof entity.wineType === 'string' && entity.wineType.length > 0) {
      parts.push(entity.wineType.toLowerCase());
    }
    const check = parts.join(' ');
    return !negRegs.some((re) => re.test(check));
  });

  if (filtered.length === response.results.length) {
    return { response, filteredCount: 0 };
  }
  if (filtered.length === 0) {
    return {
      response: { ...response, results: [] },
      filteredCount: response.results.length,
    };
  }
  return {
    response: { ...response, results: filtered },
    filteredCount: response.results.length - filtered.length,
  };
}

function parseSearchToolPriceRangeAsKrw(
  priceRange: string | undefined,
  krwPerUsd: number,
): number | null | undefined {
  if (priceRange === undefined) return undefined;
  const usdMatch = /^\$(\d[\d,]*(?:\.\d+)?)$/.exec(priceRange);
  if (usdMatch !== null) {
    const priceUsd = Number(usdMatch[1]!.replace(/,/g, ''));
    if (!Number.isFinite(priceUsd)) return null;
    return Math.round(priceUsd * krwPerUsd);
  }
  const krwMatch = /^(?:₩|)(\d[\d,]*)(?:\s*원)?$/u.exec(priceRange.trim());
  if (krwMatch !== null) {
    const priceKrw = Number(krwMatch[1]!.replace(/,/g, ''));
    if (!Number.isFinite(priceKrw)) return null;
    return priceKrw;
  }
  return null;
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

  const matchesBudget = (priceKrw: number): boolean => {
    if (budget.minKrw !== undefined && priceKrw < budget.minKrw) {
      return false;
    }
    if (budget.maxKrw !== undefined && priceKrw > budget.maxKrw) {
      return false;
    }
    return true;
  };

  const strict = response.results.filter((result) => {
    const priceKrw = parseSearchToolPriceRangeAsKrw(result.entity.priceRange, options.krwPerUsd);
    if (priceKrw === undefined || priceKrw === null) return false;
    return matchesBudget(priceKrw);
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
