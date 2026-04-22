import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import {
  isExactMetadataEntityLookupCandidate,
  isSpecificSkuLikeQuery,
  normalizeExactMetadataSearchInput,
} from './agent-query-execution-contract.js';
import { isAccessibleOnlineTastingQuery } from './agent-situational-query-policy.js';
import { extractAllPairingConstraints } from '../../domain/query/service/pairing-extractor.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';
import { extractVintageYear } from '../../domain/shared/utils/vintage.js';

const TOP_LEVEL_REGION_VALUES = new Set([
  'alsace',
  'barossa valley',
  'bordeaux',
  'burgundy',
  'loire',
  'marlborough',
  'mendoza',
  'mosel',
  'napa valley',
  'piemonte',
  'rioja',
  'rhône',
  'rhone',
  'tuscany',
]);

function shouldInjectRefinementHint(observation: string): boolean {
  return observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:');
}

interface ResolveSingleToolInput {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly queryExecutionContract: AgentQueryExecutionContract;
}

interface ResolvedToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface ResolveParallelBatchInput {
  readonly calls: readonly {
    readonly tool: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly queryExecutionContract: AgentQueryExecutionContract;
}

function normalizeSearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const next = { ...input };
  if (
    queryExecutionContract.hasEntityMetadataSignal
    && typeof queryExecutionContract.exactMetadataEntityQuery === 'string'
    && queryExecutionContract.exactMetadataEntityQuery.trim().length > 0
  ) {
    next['query'] = queryExecutionContract.exactMetadataEntityQuery.trim();
  }
  const query = typeof next['query'] === 'string' ? next['query'] : undefined;

  if (
    next['retrieval_mode'] === 'entity'
    && typeof query === 'string'
    && (
      queryExecutionContract.temporalReleaseConceptQuery === true
      || (
        !isSpecificSkuLikeQuery(query)
        && !isExactMetadataEntityLookupCandidate(query)
      )
    )
  ) {
    delete next['retrieval_mode'];
  }

  if (
    queryExecutionContract.hasEntityMetadataSignal
    && typeof query === 'string'
    && !isSpecificSkuLikeQuery(query)
    && !isExactMetadataEntityLookupCandidate(query)
  ) {
    delete next['style'];
    delete next['styles'];
    delete next['occasion'];
    delete next['gift_suitability_min'];
    delete next['beginner_suitability_min'];
    delete next['producer_prestige_min'];
  }

  if (
    queryExecutionContract.temporalReleaseConceptQuery === true
    && typeof query === 'string'
  ) {
    if (
      typeof queryExecutionContract.temporalReleaseQuery === 'string'
      && queryExecutionContract.temporalReleaseQuery.trim().length > 0
    ) {
      next['query'] = queryExecutionContract.temporalReleaseQuery.trim();
    }
    delete next['country'];
    delete next['region'];
    delete next['appellation'];
    delete next['grape_primary'];
    delete next['wine_type'];
    delete next['vintage_min'];
    delete next['vintage_max'];
    delete next['drinking_window'];
    delete next['drinking_window_target_year'];
  }

  if (!queryExecutionContract.hasEntityMetadataSignal) {
    return next;
  }
  const searchQuery = next['query'];
  const preserveStructuredKeys =
    queryExecutionContract.exactMetadataTargetVintage !== undefined
      ? ['vintage_min', 'vintage_max']
      : [];
  const shouldNormalizeExactMetadataSearch =
    typeof queryExecutionContract.exactMetadataEntityQuery === 'string'
    || (typeof searchQuery === 'string' && isExactMetadataEntityLookupCandidate(searchQuery));
  if (!shouldNormalizeExactMetadataSearch) {
    return next;
  }
  const normalized = normalizeExactMetadataSearchInput(next, preserveStructuredKeys).effectiveInput;
  const withExactVintage =
    queryExecutionContract.exactMetadataTargetVintage !== undefined
      ? {
          ...normalized,
          vintage_min: queryExecutionContract.exactMetadataTargetVintage,
          vintage_max: queryExecutionContract.exactMetadataTargetVintage,
        }
      : normalized;
  return withExactVintage['limit'] === 1
    ? withExactVintage
    : { ...withExactVintage, limit: 1 };
}

function addDrinkabilityRetrievalObjective(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (!queryExecutionContract.requiresDrinkabilityCheck) {
    return input;
  }
  if (input['drinking_window'] !== undefined) {
    return input;
  }
  return { ...input, drinking_window: 'now' };
}

function stripSearchDrinkabilityVerificationFields(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (!queryExecutionContract.requiresDrinkabilityCheck) {
    return input;
  }
  if (input['drinking_window'] === undefined && input['drinking_window_target_year'] === undefined) {
    return input;
  }
  const next = { ...input };
  delete next['drinking_window'];
  delete next['drinking_window_target_year'];
  return next;
}

function stripSearchDrinkabilityObjectiveFromQuery(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (!queryExecutionContract.requiresDrinkabilityCheck) {
    return input;
  }
  const query = input['query'];
  if (typeof query !== 'string') {
    return input;
  }
  const normalized = query
    .replace(/(?:지금|현재)\s*(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu, ' ')
    .replace(/(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu, ' ')
    .replace(/(?:currently\s+drinkable|drink\s+now|ready\s+to\s+drink|drinking\s+well\s+now)/giu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s*(?:중에|and|,)\s*$/giu, '')
    .trim();
  return normalized.length > 0 && normalized !== query ? { ...input, query: normalized } : input;
}

function wineTypeToFoodPairingColor(value: unknown): string | undefined {
  return typeof value === 'string' && ['red', 'white', 'rosé', 'sparkling'].includes(value)
    ? value
    : undefined;
}

function collectFoodPairingStyles(input: Record<string, unknown>): readonly string[] | undefined {
  const styles = input['styles'];
  if (Array.isArray(styles)) {
    const normalized = styles
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());
    return normalized.length > 0 ? [...new Set(normalized)] : undefined;
  }
  const style = input['style'];
  return typeof style === 'string' && style.trim().length > 0 ? [style.trim()] : undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function collectStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

function mergeStringArrayInput(
  input: Record<string, unknown>,
  key: string,
  defaults: readonly string[] | undefined,
): Record<string, unknown> {
  if (defaults === undefined || defaults.length === 0) {
    return input;
  }
  const merged = uniqueStrings([...collectStringArray(input[key]), ...defaults]);
  return merged.length > 0 ? { ...input, [key]: merged } : input;
}

function shouldSuppressSearchDefaults(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): boolean {
  const query = input['query'];
  if (
    queryExecutionContract.hasEntityMetadataSignal
    && typeof query === 'string'
    && isExactMetadataEntityLookupCandidate(query)
  ) {
    return true;
  }
  return queryExecutionContract.hasTemporalReleaseSignal === true
    && queryExecutionContract.temporalReleaseConceptQuery === true
    && typeof query === 'string';
}

function applySearchDefaults(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const defaults = queryExecutionContract.searchDefaults;
  if (defaults === undefined || shouldSuppressSearchDefaults(input, queryExecutionContract)) {
    return input;
  }
  let next = input;
  next = mergeStringArrayInput(next, 'styles', defaults.styles);
  next = mergeStringArrayInput(next, 'occasion', defaults.occasion);
  if (next['grape_primary'] === undefined && defaults.grape_primary !== undefined) {
    next = { ...next, grape_primary: defaults.grape_primary };
  }
  if (next['region'] === undefined && defaults.region !== undefined) {
    next = { ...next, region: defaults.region };
  }
  for (const key of [
    'min_price_krw',
    'max_price_krw',
    'max_alcohol_pct',
    'gift_suitability_min',
    'beginner_suitability_min',
    'producer_prestige_min',
  ] as const) {
    if (next[key] === undefined && defaults[key] !== undefined) {
      next = { ...next, [key]: defaults[key] };
    }
  }
  return next;
}

function normalizeTopLevelRegionAppellation(input: Record<string, unknown>): Record<string, unknown> {
  const appellation = input['appellation'];
  if (typeof appellation !== 'string') {
    return input;
  }
  const canonical = appellation.trim().toLowerCase();
  if (!TOP_LEVEL_REGION_VALUES.has(canonical)) {
    return input;
  }
  const { appellation: _appellation, ...withoutAppellation } = input;
  const query = withoutAppellation['query'];
  if (typeof query !== 'string' || !query.toLowerCase().includes(canonical)) {
    return {
      ...withoutAppellation,
      query: [query, appellation].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ').trim(),
    };
  }
  return withoutAppellation;
}

function normalizeNegatedWineTypeSearchAnchor(input: Record<string, unknown>): Record<string, unknown> {
  const query = input['query'];
  const wineType = input['wine_type'];
  if (typeof query !== 'string' || typeof wineType !== 'string') {
    return input;
  }
  const normalizedQuery = wineType === 'white'
    ? query
        .replace(/(?:레드\s*(?:말고|빼고|제외하고)|red\s*(?:excluded?|except|not|no))/giu, ' ')
        .replace(/(?:not\s+red|no\s+red)/giu, ' ')
    : wineType === 'red'
      ? query
          .replace(/(?:화이트\s*(?:말고|빼고|제외하고)|white\s*(?:excluded?|except|not|no))/giu, ' ')
          .replace(/(?:not\s+white|no\s+white)/giu, ' ')
      : query;
  const compact = normalizedQuery.replace(/\s+/gu, ' ').trim();
  return compact.length > 0 && compact !== query ? { ...input, query: compact } : input;
}

function normalizeAccessibleOnlineTastingSearch(input: Record<string, unknown>): Record<string, unknown> {
  const query = input['query'];
  if (typeof query !== 'string' || !isAccessibleOnlineTastingQuery(query)) {
    return input;
  }

  let next = mergeStringArrayInput(input, 'styles', ['approachable', 'crowd_pleasing']);
  const occasion = collectStringArray(next['occasion']).filter((value) => value !== 'party');
  next = occasion.length > 0
    ? { ...next, occasion }
    : (() => {
        const { occasion: _occasion, ...withoutOccasion } = next;
        return withoutOccasion;
      })();
  if (next['max_price_krw'] === undefined && /(?:5\s*만\s*원\s*이하|5만원\s*이하|under\s*(?:₩|krw)?\s*50[, ]?000|under\s*50k)/iu.test(query)) {
    next = { ...next, max_price_krw: 50_000 };
  }
  return next;
}

function applyExplicitTotalBudgetParallelSlot(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const slots = queryExecutionContract.requiredParallelSearches;
  if (
    queryExecutionContract.totalBudgetKrw === undefined ||
    slots === undefined ||
    slots.length < 2
  ) {
    return input;
  }

  const wineType = input['wine_type'];
  if (typeof wineType !== 'string' || !slots.some((slot) => slot.wineType === wineType)) {
    return input;
  }

  const next: Record<string, unknown> = {
    ...input,
    max_price_krw: Math.floor(queryExecutionContract.totalBudgetKrw / slots.length),
  };
  delete next['min_price_krw'];
  return next;
}

function buildSlotQueryAnchor(query: string, wineType: string): string {
  const withoutOppositeColor = wineType === 'red'
    ? query.replace(/(?:화이트|white)/giu, ' ')
    : wineType === 'white'
      ? query.replace(/(?:레드|red)/giu, ' ')
      : query;
  const compact = withoutOppositeColor
    .replace(/(?:반반|both\s+colors?)/giu, ' ')
    .replace(/[\/,+&]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return compact.length > 0 ? compact : query;
}

function buildSlotSearchInput(
  baseInput: Record<string, unknown>,
  slotCount: number,
  slot: NonNullable<AgentQueryExecutionContract['requiredParallelSearches']>[number],
  explicitTotalBudgetKrw?: number,
): Record<string, unknown> {
  const query = typeof baseInput['query'] === 'string'
    ? buildSlotQueryAnchor(baseInput['query'], slot.wineType)
    : baseInput['query'];
  const maxPriceKrw = baseInput['max_price_krw'];
  const totalBudgetKrw = explicitTotalBudgetKrw ?? (typeof maxPriceKrw === 'number'
    && typeof baseInput['query'] === 'string'
    && /(?:총|total)/iu.test(baseInput['query'])
    ? maxPriceKrw
    : undefined);
  const totalBudgetSplit = totalBudgetKrw !== undefined;
  const next: Record<string, unknown> = {
    ...baseInput,
    ...(typeof query === 'string' ? { query } : {}),
    wine_type: slot.wineType,
    ...(totalBudgetSplit ? { max_price_krw: Math.floor(totalBudgetKrw / slotCount) } : {}),
    ...(slot.limit !== undefined ? { limit: slot.limit } : {}),
  };
  if (totalBudgetSplit) {
    delete next['min_price_krw'];
  }
  return next;
}

function inferFoodPairingStyles(pairingTags: readonly string[] | undefined): readonly string[] {
  if (pairingTags === undefined || !pairingTags.includes('spicy_food')) {
    return [];
  }
  return ['off_dry', 'sweet'];
}

function suppressConflictingSpicyFoodColor(
  color: string | undefined,
  queryExecutionContract: AgentQueryExecutionContract,
): string | undefined {
  if (color !== 'red' || queryExecutionContract.foodPairing?.pairingTags.includes('spicy_food') !== true) {
    return color;
  }
  return undefined;
}

function enrichFoodPairingInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (queryExecutionContract.requiredTool !== 'get_food_pairings') {
    return input;
  }
  const pairingTags = queryExecutionContract.foodPairing?.pairingTags;
  let next = input;
  if (pairingTags !== undefined && pairingTags.length > 0) {
    next = {
      ...next,
      pairing_tags: uniqueStrings([...collectStringArray(input['pairing_tags']), ...pairingTags]),
    };
  }
  if (suppressConflictingSpicyFoodColor(wineTypeToFoodPairingColor(next['color']), queryExecutionContract) === undefined) {
    delete next['color'];
  }
  const existingStyles = collectStringArray(next['styles']);
  const inferredStyles = inferFoodPairingStyles(pairingTags);
  const mergedStyles = uniqueStrings([...existingStyles, ...inferredStyles]);
  return mergedStyles.length > 0 ? { ...next, styles: mergedStyles } : next;
}

function resolveFoodPairingToolCall(
  tool: string,
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): ResolvedToolCall {
  if (tool === 'get_food_pairings') {
    return { tool, input: enrichFoodPairingInput(input, queryExecutionContract) };
  }
  if (tool !== 'search_wines' || queryExecutionContract.requiredTool !== 'get_food_pairings') {
    return { tool, input };
  }
  const inputQuery = input['query'];
  const food = typeof inputQuery === 'string' && inputQuery.trim().length > 0
    ? inputQuery.trim()
    : queryExecutionContract.foodPairing?.food;
  if (food === undefined || food.trim().length === 0) {
    return { tool, input };
  }
  const contractFood = queryExecutionContract.foodPairing?.food.trim();
  const inputHasPairingSignal = extractAllPairingConstraints(food).length > 0;
  if (food !== contractFood && !inputHasPairingSignal) {
    return { tool, input };
  }
  if (input['max_price_krw'] !== undefined || input['max_price'] !== undefined) {
    return { tool, input: enrichFoodPairingSearchInput(input, queryExecutionContract) };
  }

  const color = suppressConflictingSpicyFoodColor(
    wineTypeToFoodPairingColor(input['wine_type']),
    queryExecutionContract,
  );
  const pairingTags = queryExecutionContract.foodPairing?.pairingTags;
  const styles = uniqueStrings([
    ...(collectFoodPairingStyles(input) ?? []),
    ...inferFoodPairingStyles(pairingTags),
  ]);
  return {
    tool: 'get_food_pairings',
    input: {
      food,
      ...(input['max_price_krw'] !== undefined ? { max_price_krw: input['max_price_krw'] } : {}),
      ...(input['max_price'] !== undefined ? { max_price: input['max_price'] } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(styles.length > 0 ? { styles } : {}),
      ...(pairingTags !== undefined && pairingTags.length > 0 ? { pairing_tags: [...pairingTags] } : {}),
    },
  };
}

function enrichFoodPairingSearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (queryExecutionContract.requiredTool !== 'get_food_pairings') {
    return input;
  }
  const pairingTags = queryExecutionContract.foodPairing?.pairingTags;
  const styles = uniqueStrings([
    ...collectStringArray(input['styles']),
    ...inferFoodPairingStyles(pairingTags),
  ]);
  return {
    ...input,
    ...(input['query'] === undefined && queryExecutionContract.foodPairing?.food !== undefined
      ? { query: queryExecutionContract.foodPairing.food }
      : {}),
    ...(pairingTags !== undefined && pairingTags.length > 0
      ? { styles: uniqueStrings([...styles, ...pairingTags]) }
      : styles.length > 0
        ? { styles }
        : {}),
  };
}

function hasExplicitFoodPairingBudget(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): boolean {
  return queryExecutionContract.requiredTool === 'get_food_pairings'
    && (
      input['max_price_krw'] !== undefined
      || input['max_price'] !== undefined
      || queryExecutionContract.searchDefaults?.max_price_krw !== undefined
    );
}

function buildBudgetPairingExpansion(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): readonly ResolvedToolCall[] | undefined {
  if (!hasExplicitFoodPairingBudget(input, queryExecutionContract)) {
    return undefined;
  }

  const normalizedSearchInput = normalizeSearchExecutionInput(input, queryExecutionContract);
  const resolvedSearch = resolveFoodPairingToolCall(
    'search_wines',
    normalizedSearchInput,
    queryExecutionContract,
  );
  if (resolvedSearch.tool !== 'search_wines') {
    return undefined;
  }

  const inputQuery = resolvedSearch.input['query'];
  const food = typeof inputQuery === 'string' && inputQuery.trim().length > 0
    ? inputQuery.trim()
    : queryExecutionContract.foodPairing?.food;
  if (food === undefined || food.length === 0) {
    return undefined;
  }

  const pairingCall = resolveFoodPairingToolCall(
    'get_food_pairings',
    {
      food,
      ...(resolvedSearch.input['max_price_krw'] !== undefined
        ? { max_price_krw: resolvedSearch.input['max_price_krw'] }
        : {}),
      ...(resolvedSearch.input['max_price'] !== undefined
        ? { max_price: resolvedSearch.input['max_price'] }
        : {}),
      ...(suppressConflictingSpicyFoodColor(
        wineTypeToFoodPairingColor(resolvedSearch.input['wine_type']),
        queryExecutionContract,
      ) !== undefined
        ? {
            color: suppressConflictingSpicyFoodColor(
              wineTypeToFoodPairingColor(resolvedSearch.input['wine_type']),
              queryExecutionContract,
            ),
          }
        : {}),
      ...(collectFoodPairingStyles(normalizedSearchInput) !== undefined
        ? { styles: collectFoodPairingStyles(normalizedSearchInput) }
        : {}),
    },
    queryExecutionContract,
  );

  return [pairingCall, resolvedSearch];
}

function normalizeSearchExecutionInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  return applyExplicitTotalBudgetParallelSlot(
    normalizeAccessibleOnlineTastingSearch(
      normalizeNegatedWineTypeSearchAnchor(
        normalizeTopLevelRegionAppellation(
          applySearchDefaults(
            stripSearchDrinkabilityObjectiveFromQuery(
              stripSearchDrinkabilityVerificationFields(
                normalizeSearchInput(input, queryExecutionContract),
                queryExecutionContract,
              ),
              queryExecutionContract,
            ),
            queryExecutionContract,
          ),
        ),
      ),
    ),
    queryExecutionContract,
  );
}

function stripRedundantCompareSideGeography(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };

  if (typeof normalized['appellation_a'] === 'string' && normalized['appellation_a'].trim().length > 0) {
    delete normalized['region_a'];
    delete normalized['country_a'];
  }
  if (typeof normalized['appellation_b'] === 'string' && normalized['appellation_b'].trim().length > 0) {
    delete normalized['region_b'];
    delete normalized['country_b'];
  }

  return normalized;
}

function canonicalizeCompareSideQuery(rawQuery: unknown): string | undefined {
  if (typeof rawQuery !== 'string') {
    return undefined;
  }
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const transliterated = buildNormalizedQueryViews(trimmed).transliterated?.trim();
  if (typeof transliterated === 'string' && transliterated.length > 0 && transliterated !== trimmed) {
    const inferredVintage = inferExactSideVintage(trimmed);
    if (
      inferredVintage !== undefined &&
      !new RegExp(`(?<![\\p{L}\\p{N}])${inferredVintage}(?![\\p{L}\\p{N}])`, 'u').test(transliterated)
    ) {
      return `${transliterated} ${inferredVintage}`.trim();
    }
    return transliterated;
  }

  const tokens = trimmed.split(/\s+/u);
  let changed = false;
  const rewritten = tokens.map((token) => {
    const romanized = Transliterator.romanizeWineTerm(token);
    if (romanized === undefined || romanized.trim().length === 0) {
      return token;
    }
    changed = true;
    return romanized.trim();
  }).join(' ').trim();

  return changed && rewritten.length > 0 ? rewritten : undefined;
}

function inferExactSideVintage(query: unknown): number | undefined {
  if (typeof query !== 'string') {
    return undefined;
  }
  const normalized = query.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const matches = [...normalized.matchAll(/(?<![\p{L}\p{N}])((?:19|20)\d{2})(?:년산?|년대)?(?![\p{L}\p{N}])/gu)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    return undefined;
  }
  const year = extractVintageYear(matches[0][1]);
  return year ?? undefined;
}

function normalizeCompareSide(
  input: Record<string, unknown>,
  side: 'a' | 'b',
): Record<string, unknown> {
  const queryKey = side === 'a' ? 'query_a' : 'query_b';
  const minKey = side === 'a' ? 'vintage_min_a' : 'vintage_min_b';
  const maxKey = side === 'a' ? 'vintage_max_a' : 'vintage_max_b';
  const next = { ...input };

  const canonicalQuery = canonicalizeCompareSideQuery(next[queryKey]);
  if (canonicalQuery !== undefined) {
    next[queryKey] = canonicalQuery;
  }

  const inferredVintage = inferExactSideVintage(next[queryKey]);
  if (inferredVintage !== undefined) {
    if (next[minKey] === undefined) {
      next[minKey] = inferredVintage;
    }
    if (next[maxKey] === undefined) {
      next[maxKey] = inferredVintage;
    }
  }

  return next;
}

function sideFieldLexicallyMentioned(query: string, value: string): boolean {
  const views = buildNormalizedQueryViews(query);
  const candidates = [
    query,
    views.punctuationStripped,
    views.transliterated ?? '',
  ]
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0);
  const normalizedValue = value.trim().toLowerCase();
  return candidates.some((candidate) => candidate.includes(normalizedValue));
}

function stripOverconstrainedExactCompareSide(
  input: Record<string, unknown>,
  side: 'a' | 'b',
): Record<string, unknown> {
  const queryKey = side === 'a' ? 'query_a' : 'query_b';
  const query = input[queryKey];
  if (typeof query !== 'string' || inferExactSideVintage(query) === undefined) {
    return input;
  }

  const next = { ...input };
  for (const key of [
    side === 'a' ? 'country_a' : 'country_b',
    side === 'a' ? 'region_a' : 'region_b',
    side === 'a' ? 'appellation_a' : 'appellation_b',
    side === 'a' ? 'grape_primary_a' : 'grape_primary_b',
    side === 'a' ? 'wine_type_a' : 'wine_type_b',
  ] as const) {
    const value = next[key];
    if (typeof value !== 'string') {
      continue;
    }
    if (!sideFieldLexicallyMentioned(query, value)) {
      delete next[key];
    }
  }
  return next;
}

function normalizeCompareExecutionInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  return addDrinkabilityRetrievalObjective(
    stripOverconstrainedExactCompareSide(
      stripOverconstrainedExactCompareSide(
        normalizeCompareSide(
          normalizeCompareSide(
            stripRedundantCompareSideGeography(input),
            'a',
          ),
          'b',
        ),
        'a',
      ),
      'b',
    ),
    queryExecutionContract,
  );
}

export class AgentToolExecutionPolicy {
  resolveSingleCall(input: ResolveSingleToolInput): ResolvedToolCall {
    const normalizedInput = input.tool === 'compare_wines'
      ? normalizeCompareExecutionInput(input.input, input.queryExecutionContract)
      : input.tool === 'search_wines'
        ? normalizeSearchExecutionInput(input.input, input.queryExecutionContract)
        : input.input;
    return resolveFoodPairingToolCall(input.tool, normalizedInput, input.queryExecutionContract);
  }

  resolveSingleCallExpansion(input: ResolveSingleToolInput): readonly ResolvedToolCall[] | undefined {
    const budgetPairingExpansion = buildBudgetPairingExpansion(
      input.input,
      input.queryExecutionContract,
    );
    if (input.tool === 'search_wines' && budgetPairingExpansion !== undefined) {
      return budgetPairingExpansion;
    }

    const slots = input.queryExecutionContract.requiredParallelSearches;
    if (input.tool !== 'search_wines' || slots === undefined || slots.length < 2) {
      return undefined;
    }
    const baseInput = normalizeSearchExecutionInput(input.input, input.queryExecutionContract);
    const sharedInput = { ...baseInput };
    delete sharedInput['wine_type'];
    return slots.map((slot) => ({
      tool: 'search_wines',
      input: buildSlotSearchInput(sharedInput, slots.length, slot, input.queryExecutionContract.totalBudgetKrw),
    }));
  }

  resolveSingleTool(input: ResolveSingleToolInput): Record<string, unknown> {
    if (
      input.tool === 'search_wines' &&
      input.queryExecutionContract.requiredTool === 'get_food_pairings'
    ) {
      return this.resolveSingleCall(input).input;
    }
    if (input.tool === 'compare_wines') {
      return normalizeCompareExecutionInput(input.input, input.queryExecutionContract);
    }
    if (input.tool === 'search_wines') {
      return normalizeSearchExecutionInput(input.input, input.queryExecutionContract);
    }
    if (input.tool === 'get_food_pairings') {
      return enrichFoodPairingInput(input.input, input.queryExecutionContract);
    }
    return input.input;
  }

  resolveParallelBatch(input: ResolveParallelBatchInput): readonly {
    readonly tool: string;
    readonly input: Record<string, unknown>;
  }[] {
    return input.calls.map((call) => {
      if (call.tool === 'compare_wines') {
        return {
          ...call,
          input: normalizeCompareExecutionInput(call.input, input.queryExecutionContract),
        };
      }
      if (call.tool === 'get_food_pairings') {
        return this.resolveSingleCall({
          tool: call.tool,
          input: call.input,
          queryExecutionContract: input.queryExecutionContract,
        });
      }
      if (call.tool === 'search_wines') {
        return {
          ...call,
          input: normalizeSearchExecutionInput(call.input, input.queryExecutionContract),
        };
      }
      return call;
    });
  }

  maybeInjectRefinementHint(
    state: AgentExecutionState,
    observations: readonly string[],
    remainingSteps: number,
  ): void {
    if (
      state.hasInjectedRefinementHint ||
      remainingSteps < 2 ||
      !observations.some((observation) => shouldInjectRefinementHint(observation))
    ) {
      return;
    }
    state.hasInjectedRefinementHint = true;
    state.pendingRefinementRetry = true;
    state.pendingPlannerDirective = { kind: 'relax_constraints_retry' };
  }
}
