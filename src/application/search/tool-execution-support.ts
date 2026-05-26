import type {
  ComparisonDecompositionLegs,
  ComparisonIntent,
} from '../../domain/query/model/query-decomposition.js';
import { buildEntityComparisonLegs } from '../../domain/query/model/query-decomposition.js';
import { detectDecomposition } from '../../domain/query/service/decomposition-detector.js';
import {
  DRINKING_WINDOW_SENSORY_ORDINAL_SCALE,
} from '../../domain/drinking-window/port/drinking-window-predictor.port.js';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import {
  appendStructuredQueryClauses,
  buildSearchToolSoftClauses,
} from './search-tool-query-policy.js';
import { buildSearchToolRetrievalCoreQuery } from './search-tool-retrieval-core.js';
import {
  buildSearchToolStructuredFilters as buildContractSearchToolStructuredFilters,
  buildSearchToolStructuredPreferences as buildContractSearchToolStructuredPreferences,
} from './search-tool-contract.js';
import type { DrinkingWindowCheckRequest } from '../drinking-window/port/drinking-window-usecase.port.js';

type StructuredFilterInput = Parameters<typeof buildContractSearchToolStructuredFilters>[0];
type StructuredPreferenceInput = Parameters<typeof buildContractSearchToolStructuredPreferences>[0];
type SearchToolQueryInput = Parameters<typeof buildSearchToolRetrievalCoreQuery>[0];

type ComparisonIdentityField =
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary'
  | 'wine_type';

type ComparisonConceptEntityType = ComparisonIdentityField;

type SearchToolRetrievalMode = 'auto' | 'entity' | 'hybrid' | 'mixed';

const DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE = 85;
const COMPARE_DELIMITER = ' vs ';

export interface FoodPairingToolInputLike {
  readonly food: string;
  readonly max_price?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly color?: 'red' | 'white' | 'rosé' | 'sparkling' | 'both' | undefined;
  readonly sweetness_target?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly pairing_tags?: readonly string[] | undefined;
}

export interface CompareSharedInput extends StructuredFilterInput, StructuredPreferenceInput {
  readonly query: string;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly certification?: string | undefined;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly preserveRepresentativeSearch?: boolean | undefined;
}

export interface CompareWinesToolInputLike extends StructuredFilterInput, StructuredPreferenceInput {
  readonly query_a: string;
  readonly query_b: string;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly certification?: string | undefined;
  readonly country_a?: string | undefined;
  readonly country_b?: string | undefined;
  readonly region_a?: string | undefined;
  readonly region_b?: string | undefined;
  readonly appellation_a?: string | undefined;
  readonly appellation_b?: string | undefined;
  readonly grape_primary_a?: string | undefined;
  readonly grape_primary_b?: string | undefined;
  readonly wine_type_a?:
    | 'red'
    | 'white'
    | 'rosé'
    | 'sparkling'
    | 'fortified'
    | 'dessert'
    | 'orange'
    | 'natural'
    | undefined;
  readonly wine_type_b?:
    | 'red'
    | 'white'
    | 'rosé'
    | 'sparkling'
    | 'fortified'
    | 'dessert'
    | 'orange'
    | 'natural'
    | undefined;
  readonly vintage_min_a?: number | undefined;
  readonly vintage_min_b?: number | undefined;
  readonly vintage_max_a?: number | undefined;
  readonly vintage_max_b?: number | undefined;
  readonly retrieval_mode?: SearchToolRetrievalMode | undefined;
}

export interface CompareWinesExecutionRequest {
  readonly subQueries: [string, string];
  readonly comparisonLegs: ComparisonDecompositionLegs;
  readonly comparisonIntent: ComparisonIntent;
  readonly originalQuery: string;
  readonly parentContext: {
    readonly filters?: readonly NormalizedConstraint[] | undefined;
    readonly preferences?: readonly NormalizedConstraint[] | undefined;
    readonly perSideFilters?: readonly [
      readonly NormalizedConstraint[] | undefined,
      readonly NormalizedConstraint[] | undefined,
    ] | undefined;
    readonly retrievalMode?: SearchToolRetrievalMode | undefined;
  };
}

function buildSearchToolStructuredFilters(
  input: StructuredFilterInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredFilters(input, mappingVersion);
}

function buildSearchToolStructuredPreferences(
  input: StructuredPreferenceInput,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  return buildContractSearchToolStructuredPreferences(input, mappingVersion);
}

export function resolveFoodPairingBudgetKrw(
  input: Pick<FoodPairingToolInputLike, 'max_price' | 'max_price_krw'>,
): number | undefined {
  return input.max_price_krw
    ?? (input.max_price !== undefined ? Math.round(input.max_price * KRW_PER_USD_APPROXIMATE) : undefined);
}

export function buildFoodPairingQuery(input: FoodPairingToolInputLike): string {
  const clauses = [`wine pairing for ${input.food}`];
  const budgetKrw = resolveFoodPairingBudgetKrw(input);
  if (budgetKrw !== undefined) {
    clauses.push(`${budgetKrw}원 이하`);
  }
  for (const style of input.styles ?? []) {
    clauses.push(style);
  }
  for (const tag of input.pairing_tags ?? []) {
    clauses.push(tag);
  }
  return clauses.join(', ');
}

export function buildFoodPairingFilters(
  input: FoodPairingToolInputLike,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  if (input.color === undefined || input.color === 'both') {
    return [];
  }
  return buildSearchToolStructuredFilters({
    wine_type: input.color,
  }, mappingVersion);
}

export function buildFoodPairingPreferences(
  input: FoodPairingToolInputLike,
  mappingVersion: string,
): readonly NormalizedConstraint[] {
  const maxPriceKrw = resolveFoodPairingBudgetKrw(input);
  const preferences: NormalizedConstraint[] = [
    ...buildSearchToolStructuredPreferences({
      ...(maxPriceKrw !== undefined ? { max_price_krw: maxPriceKrw } : {}),
      styles: input.styles,
    }, mappingVersion),
  ];
  if (input.sweetness_target !== undefined) {
    preferences.push({
      attribute: 'sweetness',
      operator: '=',
      value: input.sweetness_target,
      source_phrase: `sweetness_target=${input.sweetness_target}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.acidity_min !== undefined) {
    preferences.push({
      attribute: 'acidity',
      operator: '>=',
      value: input.acidity_min,
      source_phrase: `acidity_min=${input.acidity_min}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.tannin_max !== undefined) {
    preferences.push({
      attribute: 'tannin',
      operator: '<=',
      value: input.tannin_max,
      source_phrase: `tannin_max=${input.tannin_max}`,
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  if (input.pairing_tags !== undefined && input.pairing_tags.length > 0) {
    preferences.push({
      attribute: 'pairing',
      operator: 'in',
      value: [...input.pairing_tags],
      source_phrase: input.pairing_tags.join(', '),
      confidence: 1.0,
      soft_promotion_authority: 'allow',
      mapping_version: mappingVersion,
    });
  }
  return preferences;
}

function normalizeComparisonValue(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim().toLowerCase();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function omitComparisonIdentityField(
  input: CompareSharedInput,
  field: ComparisonIdentityField,
): CompareSharedInput {
  switch (field) {
    case 'country': {
      const { country: _country, ...rest } = input;
      return rest;
    }
    case 'region': {
      const { region: _region, ...rest } = input;
      return rest;
    }
    case 'appellation': {
      const { appellation: _appellation, ...rest } = input;
      return rest;
    }
    case 'grape_primary': {
      const { grape_primary: _grapePrimary, ...rest } = input;
      return rest;
    }
    case 'wine_type': {
      const { wine_type: _wineType, ...rest } = input;
      return rest;
    }
  }
}

function buildComparisonSharedInput(input: CompareWinesToolInputLike): CompareSharedInput {
  return {
    query: `${input.query_a}${COMPARE_DELIMITER}${input.query_b}`,
    ...(input.exclude_grapes !== undefined ? { exclude_grapes: input.exclude_grapes } : {}),
    ...(input.exclude_regions !== undefined ? { exclude_regions: input.exclude_regions } : {}),
    ...(input.exclude_wine_types !== undefined ? { exclude_wine_types: input.exclude_wine_types } : {}),
    ...(input.min_price_krw !== undefined ? { min_price_krw: input.min_price_krw } : {}),
    ...(input.max_price_krw !== undefined ? { max_price_krw: input.max_price_krw } : {}),
    ...(input.max_alcohol_pct !== undefined ? { max_alcohol_pct: input.max_alcohol_pct } : {}),
    ...(input.grape_primary !== undefined ? { grape_primary: input.grape_primary } : {}),
    ...(input.wine_type !== undefined ? { wine_type: input.wine_type } : {}),
    ...(input.country !== undefined ? { country: input.country } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.vintage_min !== undefined ? { vintage_min: input.vintage_min } : {}),
    ...(input.vintage_max !== undefined ? { vintage_max: input.vintage_max } : {}),
    ...(input.appellation !== undefined ? { appellation: input.appellation } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.styles !== undefined ? { styles: input.styles } : {}),
    ...(input.certification !== undefined ? { certification: input.certification } : {}),
    ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
    ...(input.gift_suitability_min !== undefined ? { gift_suitability_min: input.gift_suitability_min } : {}),
    ...(input.beginner_suitability_min !== undefined ? { beginner_suitability_min: input.beginner_suitability_min } : {}),
    ...(input.producer_prestige_min !== undefined ? { producer_prestige_min: input.producer_prestige_min } : {}),
    ...(input.popularity_min !== undefined ? { popularity_min: input.popularity_min } : {}),
    ...(input.recipient_profile !== undefined ? { recipient_profile: input.recipient_profile } : {}),
    ...(input.sweetness_min !== undefined ? { sweetness_min: input.sweetness_min } : {}),
    ...(input.sweetness_max !== undefined ? { sweetness_max: input.sweetness_max } : {}),
    ...(input.acidity_min !== undefined ? { acidity_min: input.acidity_min } : {}),
    ...(input.acidity_max !== undefined ? { acidity_max: input.acidity_max } : {}),
    ...(input.tannin_max !== undefined ? { tannin_max: input.tannin_max } : {}),
  };
}

function buildComparisonSideInput(
  input: CompareWinesToolInputLike,
  side: 'a' | 'b',
): StructuredFilterInput {
  const suffix = `_${side}` as const;
  const country = input[`country${suffix}`];
  const region = input[`region${suffix}`];
  const appellation = input[`appellation${suffix}`];
  const grapePrimary = input[`grape_primary${suffix}`];
  const wineType = input[`wine_type${suffix}`];
  const vintageMin = input[`vintage_min${suffix}`];
  const vintageMax = input[`vintage_max${suffix}`];
  return {
    ...(country !== undefined ? { country } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(appellation !== undefined ? { appellation } : {}),
    ...(grapePrimary !== undefined ? { grape_primary: grapePrimary } : {}),
    ...(wineType !== undefined ? { wine_type: wineType } : {}),
    ...(vintageMin !== undefined ? { vintage_min: vintageMin } : {}),
    ...(vintageMax !== undefined ? { vintage_max: vintageMax } : {}),
  };
}

function pruneSharedConceptIdentityFields(
  input: CompareSharedInput,
  comparisonLegs: readonly {
    readonly mode: 'entity' | 'concept';
    readonly conceptEntityType?: ComparisonConceptEntityType | undefined;
    readonly canonicalConcept?: string | undefined;
  }[],
): CompareSharedInput {
  let next: CompareSharedInput = { ...input };
  const fieldPairs: readonly [
    field: ComparisonIdentityField,
    conceptField: ComparisonConceptEntityType,
  ][] = [
    ['country', 'country'],
    ['region', 'region'],
    ['appellation', 'appellation'],
    ['grape_primary', 'grape_primary'],
    ['wine_type', 'wine_type'],
  ];
  for (const [field, conceptField] of fieldPairs) {
    const value = next[field];
    if (value === undefined) {
      continue;
    }
    const normalizedValue = normalizeComparisonValue(value);
    const matches = comparisonLegs.filter((leg) =>
      leg.mode === 'concept'
      && leg.conceptEntityType === conceptField
      && normalizeComparisonValue(leg.canonicalConcept) === normalizedValue,
    ).length;
    if (matches === 1) {
      next = omitComparisonIdentityField(next, field);
    }
  }
  return next;
}

function buildComparisonQuery(input: SearchToolQueryInput): string {
  const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(input);
  const clauses = buildSearchToolSoftClauses(input);
  if (clauses.length === 0) {
    return retrievalCoreQuery;
  }
  return appendStructuredQueryClauses(retrievalCoreQuery, clauses);
}

function buildComparisonOriginalQuery(input: CompareSharedInput): string {
  return buildComparisonQuery(input);
}

function toReadonlyTuple<T>(
  left: readonly T[],
  right: readonly T[],
): readonly [readonly T[] | undefined, readonly T[] | undefined] {
  return [
    left.length > 0 ? left : undefined,
    right.length > 0 ? right : undefined,
  ];
}

export function buildCompareWinesExecutionRequest(
  input: CompareWinesToolInputLike,
  mappingVersion: string,
): CompareWinesExecutionRequest {
  const comparison = detectDecomposition(`${input.query_a}${COMPARE_DELIMITER}${input.query_b}`);
  const subQueries =
    comparison.decomposed
      ? comparison.subQueries
      : [input.query_a, input.query_b] as [string, string];
  const baseLegs =
    comparison.decomposed
      ? comparison.comparisonLegs
      : buildEntityComparisonLegs(subQueries);
  const prunedSharedInput = pruneSharedConceptIdentityFields(
    buildComparisonSharedInput(input),
    baseLegs,
  );
  const leftSideInput = buildComparisonSideInput(input, 'a');
  const rightSideInput = buildComparisonSideInput(input, 'b');
  const sharedFilters = buildSearchToolStructuredFilters(prunedSharedInput, mappingVersion);
  const sharedPreferences = buildSearchToolStructuredPreferences(prunedSharedInput, mappingVersion);
  const leftSideFilters = buildSearchToolStructuredFilters(leftSideInput, mappingVersion);
  const rightSideFilters = buildSearchToolStructuredFilters(rightSideInput, mappingVersion);
  const comparisonLegs: ComparisonDecompositionLegs = [
    {
      ...baseLegs[0],
      retrievalQuery: buildComparisonQuery({
        ...prunedSharedInput,
        ...leftSideInput,
        query: baseLegs[0].rawQuery,
        preserveRepresentativeSearch: baseLegs[0].mode === 'concept',
      }),
    },
    {
      ...baseLegs[1],
      retrievalQuery: buildComparisonQuery({
        ...prunedSharedInput,
        ...rightSideInput,
        query: baseLegs[1].rawQuery,
        preserveRepresentativeSearch: baseLegs[1].mode === 'concept',
      }),
    },
  ];

  return {
    subQueries,
    comparisonLegs,
    comparisonIntent: 'compare',
    originalQuery: buildComparisonOriginalQuery(prunedSharedInput),
    parentContext: {
      ...(sharedFilters.length > 0 ? { filters: sharedFilters } : {}),
      ...(sharedPreferences.length > 0 ? { preferences: sharedPreferences } : {}),
      ...(leftSideFilters.length > 0 || rightSideFilters.length > 0
        ? { perSideFilters: toReadonlyTuple(leftSideFilters, rightSideFilters) }
        : {}),
      ...(input.retrieval_mode !== undefined ? { retrievalMode: input.retrieval_mode } : {}),
    },
  };
}

function scaleSensoryToOrdinal(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE
    : undefined;
}

function readCriticProxyScore(record: Record<string, unknown>): number {
  const raw = record['avgCriticProxyScore'];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  const normalized = record['criticScoreNormalized'];
  if (typeof normalized === 'number' && Number.isFinite(normalized)) {
    return normalized * 100;
  }
  return DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE;
}

export function buildDrinkingWindowRequest(
  record: Record<string, unknown>,
  targetYear: number,
): DrinkingWindowCheckRequest | null {
  const vintage = record['vintageYear'];
  const grapePrimaryEnc = record['grapePrimaryEnc'];
  const regionEnc = record['regionEnc'];
  const countryEnc = record['countryEnc'];
  const tannin = scaleSensoryToOrdinal(record['tannin']);
  const acidity = scaleSensoryToOrdinal(record['acidity']);
  if (
    typeof vintage !== 'number'
    || typeof grapePrimaryEnc !== 'number'
    || typeof regionEnc !== 'number'
    || typeof countryEnc !== 'number'
    || tannin === undefined
    || acidity === undefined
  ) {
    return null;
  }
  const body = scaleSensoryToOrdinal(record['body']);
  const sweetness = scaleSensoryToOrdinal(record['sweetness']);
  return {
    vintage,
    grapePrimaryEnc,
    regionEnc,
    countryEnc,
    ...(body !== undefined ? { body } : {}),
    tannin,
    acidity,
    ...(sweetness !== undefined ? { sweetness } : {}),
    avgCriticProxyScore: readCriticProxyScore(record),
    ...(typeof record['drinkingWindowStart'] === 'number'
      ? { priorDrinkingWindowStart: record['drinkingWindowStart'] }
      : {}),
    ...(typeof record['drinkingWindowEnd'] === 'number'
      ? { priorDrinkingWindowEnd: record['drinkingWindowEnd'] }
      : {}),
    ...(typeof record['drinkingWindowModelVersion'] === 'string'
      ? { priorDrinkingWindowModelVersion: record['drinkingWindowModelVersion'] }
      : {}),
    ...(typeof record['grapePrimary'] === 'string' ? { grapePrimary: record['grapePrimary'] } : {}),
    ...(Array.isArray(record['grapes']) ? { grapes: record['grapes'] as readonly string[] } : {}),
    ...(typeof record['grapeFamily'] === 'string' ? { grapeFamily: record['grapeFamily'] } : {}),
    ...(typeof record['producer'] === 'string' ? { producer: record['producer'] } : {}),
    ...(typeof record['country'] === 'string' ? { country: record['country'] } : {}),
    ...(typeof record['region'] === 'string' ? { region: record['region'] } : {}),
    ...(typeof record['appellation'] === 'string' ? { appellation: record['appellation'] } : {}),
    ...(Array.isArray(record['regionHierarchy'])
      ? { regionHierarchy: record['regionHierarchy'] as readonly string[] }
      : {}),
    ...(typeof record['wineType'] === 'string' ? { wineType: record['wineType'] } : {}),
    ...(typeof record['style'] === 'string' ? { style: record['style'] } : {}),
    ...(typeof record['classification'] === 'string' ? { classification: record['classification'] } : {}),
    ...(typeof record['oakTreatment'] === 'string' ? { oakTreatment: record['oakTreatment'] } : {}),
    ...(typeof record['producerPrestige'] === 'number' ? { producerPrestige: record['producerPrestige'] } : {}),
    ...(typeof record['ratingAvg'] === 'number' ? { ratingAvg: record['ratingAvg'] } : {}),
    ...(typeof record['ratingsCount'] === 'number' ? { ratingsCount: record['ratingsCount'] } : {}),
    ...(typeof record['reviewCount'] === 'number' ? { reviewCount: record['reviewCount'] } : {}),
    ...(typeof record['ratingDistribution'] === 'object' && record['ratingDistribution'] !== null
      ? { ratingDistribution: record['ratingDistribution'] as Record<string, number> }
      : {}),
    ...(typeof record['wineryRatingCount'] === 'number' ? { wineryRatingCount: record['wineryRatingCount'] } : {}),
    ...(typeof record['priceUsd'] === 'number' ? { priceUsd: record['priceUsd'] } : {}),
    ...(typeof record['bottleSizeMl'] === 'number' ? { bottleSizeMl: record['bottleSizeMl'] } : {}),
    ...(typeof record['bottleSize'] === 'string' ? { bottleSize: record['bottleSize'] } : {}),
    ...(typeof record['closure'] === 'string' ? { closure: record['closure'] } : {}),
    ...(Array.isArray(record['certifications']) ? { certifications: record['certifications'] as readonly string[] } : {}),
    ...(typeof record['producerType'] === 'string' ? { producerType: record['producerType'] } : {}),
    ...(typeof record['soilType'] === 'string' ? { soilType: record['soilType'] } : {}),
    ...(typeof record['finishLength'] === 'number' ? { finishLength: record['finishLength'] } : {}),
    ...(typeof record['alcoholPct'] === 'number' ? { alcoholPct: record['alcoholPct'] } : {}),
    targetYear,
  };
}
