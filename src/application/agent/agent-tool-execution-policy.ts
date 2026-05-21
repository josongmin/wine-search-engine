import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import {
  hasBareExactEntityAnchor,
  isExactMetadataEntityLookupCandidate,
  isSpecificSkuLikeQuery,
  normalizeExactMetadataSearchInput,
} from './agent-query-execution-contract.js';
import { isAccessibleOnlineTastingQuery } from './agent-situational-query-policy.js';
import { extractAllPairingConstraints } from '../../domain/query/service/pairing-extractor.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';
import { SEARCH_TOOL_WANTS_DIVERSITY_RE } from '../search/search-tool-diversity.js';
import { extractVintageYear } from '../../domain/shared/utils/vintage.js';
import { CURATED_ENTITY_ALIAS_CATALOG } from '../../domain/attribute/service/entity-alias-catalog.js';
import { MAX_TOOLS_PER_BATCH } from './agent-tool-execution-support.js';

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
const EXACT_LOOKUP_GENERIC_OBJECT_SUFFIX_RE = /(?:\s*(?:와인|wine))(?:\s*)$/iu;
const NON_EXACT_LOOKUP_INTENT_RE =
  /(?:같은\s*와인|대체|스타일|느낌|비교|(?:급)(?=$|[^\p{L}\p{N}])|명작|명품|와인\s*추천|추천(?!\s*(?:해줘|해주세요|해\s*줘)))/u;
const EXACT_LOOKUP_OVERCONSTRAINT_KEYS = [
  'country',
  'region',
  'appellation',
  'grape_primary',
  'wine_type',
  'style',
  'styles',
  'occasion',
  'gift_suitability_min',
  'beginner_suitability_min',
  'producer_prestige_min',
  'popularity_min',
  'recipient_profile',
  'sweetness_min',
  'sweetness_max',
  'acidity_min',
  'acidity_max',
  'tannin_max',
] as const;

function shouldInjectRefinementHint(observation: string): boolean {
  return observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:');
}

interface ResolveSingleToolInput {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly queryExecutionContract: AgentQueryExecutionContract;
  /**
   * S5 pre-fetch fanout: entity ids that are grounded in state and still
   * pending a drinkability check. When the planner emits a single
   * `check_drinking_window` but 2+ ids are grounded, the expansion fans out
   * to a parallel `check_drinking_window` batch (deterministic from state).
   */
  readonly groundedDrinkabilityEntityIds?: readonly string[] | undefined;
}

/** S5: cap on the auto-expanded check_drinking_window fanout batch. Sourced
 *  from `MAX_TOOLS_PER_BATCH` (SSoT — CLAUDE.md rule 30) so the fanout can
 *  never exceed the parallel batch-policy ceiling. */
const MAX_DRINKABILITY_FANOUT = MAX_TOOLS_PER_BATCH;

/** S5: placeholder/unresolved `entity_id` surfaces a planner may emit when it
 *  defers id resolution. Mirrors the forbidden-placeholder detection in
 *  agent-tool-execution-phase (the phase rejects these in BATCHES; here we use
 *  them to decide a SINGLE under-specified check is safe to fan out). The two
 *  lists are intentionally narrow and stable; if either grows, keep them in
 *  sync (CLAUDE.md rule 25). */
const FANOUT_PLACEHOLDER_ENTITY_IDS = new Set([
  '__to_be_filled__',
  '<top_result_entity_id>',
  '{{id}}',
  'tbd',
  'placeholder',
]);

function isFanoutPlaceholderEntityId(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/gu, '_');
  return (
    FANOUT_PLACEHOLDER_ENTITY_IDS.has(trimmed.toLowerCase())
    || (/^<[^>]+>$/u.test(trimmed)
      && /(?:to_be_filled|fill(?:ed)?_later|top_result|placeholder|entity_id|tbd)/u.test(normalized))
    || /^(?:to_be_filled|fill(?:ed)?_later|top_result_entity_id|placeholder|tbd)$/u.test(normalized)
  );
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

interface NormalizeSearchExecutionOptions {
  readonly preservePlannerQuery?: boolean;
}

function omitRecordKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !omitted.has(key)),
  );
}

function normalizeSearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
  options?: NormalizeSearchExecutionOptions,
): Record<string, unknown> {
  let next: Record<string, unknown> = { ...input };
  if (options?.preservePlannerQuery !== true) {
    if (
      typeof queryExecutionContract.nonExactEntityLookupQuery === 'string'
      && queryExecutionContract.nonExactEntityLookupQuery.trim().length > 0
    ) {
      next['query'] = queryExecutionContract.nonExactEntityLookupQuery.trim();
    } else if (
      queryExecutionContract.hasEntityMetadataSignal
      && typeof queryExecutionContract.exactMetadataEntityQuery === 'string'
      && queryExecutionContract.exactMetadataEntityQuery.trim().length > 0
    ) {
      next['query'] = queryExecutionContract.exactMetadataEntityQuery.trim();
    }
  }
  let query = typeof next['query'] === 'string' ? next['query'] : undefined;

  if (next['retrieval_mode'] === 'entity') {
    next = normalizeExactLookupEntitySearchInput(next, queryExecutionContract);
    query = typeof next['query'] === 'string' ? next['query'] : undefined;
  }

  if (
    next['retrieval_mode'] === 'entity'
    && typeof query === 'string'
    && (
      queryExecutionContract.temporalReleaseConceptQuery === true
      || (
        !isSpecificSkuLikeQuery(query)
        && !isExactMetadataEntityLookupCandidate(query)
        && !hasBareExactEntityAnchor(query)
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
    delete next['popularity_min'];
    delete next['recipient_profile'];
    delete next['sweetness_min'];
    delete next['sweetness_max'];
    delete next['acidity_min'];
    delete next['acidity_max'];
    delete next['tannin_max'];
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

function normalizeExactLookupAliasSurface(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .normalize('NFKC')
    .replace(/&/gu, 'and')
    .replace(/[^a-z0-9가-힣]+/gu, '');
}

function isAsciiSafeExactLookupSearchSurface(value: string): boolean {
  return /^[\x20-\x7E]+$/u.test(value) && !/[&]/u.test(value);
}

function canonicalValueToAsciiExactLookupSearchSurface(canonicalValue: string): string | undefined {
  if (canonicalValue.includes('&')) {
    return undefined;
  }
  const surface = canonicalValue
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .normalize('NFKC')
    .replace(/&/gu, 'and');
  return surface.length > 0 && isAsciiSafeExactLookupSearchSurface(surface)
    ? surface
    : undefined;
}

function chooseCuratedExactLookupSearchSurface(canonicalValue: string): string {
  const canonicalSurface = canonicalValueToAsciiExactLookupSearchSurface(canonicalValue);
  if (canonicalSurface !== undefined) {
    return canonicalSurface;
  }

  const aliases = CURATED_ENTITY_ALIAS_CATALOG
    .filter((alias) =>
      alias.mappedAttribute === 'appellation'
      && alias.resolutionMode === 'direct'
      && alias.canonicalValue === canonicalValue,
    )
    .map((alias) => alias.surface.trim())
    .filter((surface) => surface.length > 0)
    .sort((a, b) => {
      const aSafe = isAsciiSafeExactLookupSearchSurface(a) ? 1 : 0;
      const bSafe = isAsciiSafeExactLookupSearchSurface(b) ? 1 : 0;
      if (aSafe !== bSafe) return bSafe - aSafe;
      const aLatin = /[a-z]/iu.test(a) ? 1 : 0;
      const bLatin = /[a-z]/iu.test(b) ? 1 : 0;
      if (aLatin !== bLatin) return bLatin - aLatin;
      return a.length - b.length;
    });
  return aliases[0] ?? canonicalValue;
}

function extractCuratedExactLookupAnchor(query: string): string | undefined {
  const normalizedQuery = normalizeExactLookupAliasSurface(query);
  if (normalizedQuery.length === 0) {
    return undefined;
  }
  const matches = CURATED_ENTITY_ALIAS_CATALOG
    .filter((alias) =>
      alias.mappedAttribute === 'appellation'
      && alias.resolutionMode === 'direct',
    )
    .map((alias) => ({
      surface: alias.surface,
      canonicalValue: alias.canonicalValue,
      normalizedSurface: normalizeExactLookupAliasSurface(alias.surface),
    }))
    .filter((alias) =>
      alias.normalizedSurface.length > 0
      && normalizedQuery.includes(alias.normalizedSurface),
    )
    .sort((a, b) => b.normalizedSurface.length - a.normalizedSurface.length);
  const match = matches[0];
  return match === undefined ? undefined : chooseCuratedExactLookupSearchSurface(match.canonicalValue);
}

function normalizeExactLookupEntitySearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (input['retrieval_mode'] !== 'entity') {
    return input;
  }
  if (
    queryExecutionContract.exactMetadataTargetVintage !== undefined
    && typeof queryExecutionContract.exactMetadataEntityQuery === 'string'
  ) {
    return input;
  }
  const query = input['query'];
  if (typeof query !== 'string' || query.trim().length === 0 || NON_EXACT_LOOKUP_INTENT_RE.test(query)) {
    return input;
  }
  const anchor = extractCuratedExactLookupAnchor(query);
  if (anchor === undefined) {
    return input;
  }
  return omitRecordKeys(
    { ...input, query: anchor },
    EXACT_LOOKUP_OVERCONSTRAINT_KEYS,
  );
}

function shouldForceEntityRetrievalMode(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): boolean {
  if (input['retrieval_mode'] !== undefined) {
    return false;
  }
  if (queryExecutionContract.temporalReleaseConceptQuery === true) {
    return false;
  }
  const query = input['query'];
  if (typeof query !== 'string' || query.trim().length === 0) {
    return false;
  }
  if (
    queryExecutionContract.hasEntityMetadataSignal
    && (
      typeof queryExecutionContract.exactMetadataEntityQuery === 'string'
      || isExactMetadataEntityLookupCandidate(query)
    )
  ) {
    return true;
  }
  if (NON_EXACT_LOOKUP_INTENT_RE.test(query)) {
    return false;
  }
  if (isSpecificSkuLikeQuery(query) || hasBareExactEntityAnchor(query)) {
    return true;
  }
  const genericSuffixStripped = query.replace(EXACT_LOOKUP_GENERIC_OBJECT_SUFFIX_RE, '').trim();
  return genericSuffixStripped.length > 0
    && genericSuffixStripped !== query
    && hasBareExactEntityAnchor(genericSuffixStripped);
}

function enforceExactLookupRetrievalMode(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  return shouldForceEntityRetrievalMode(input, queryExecutionContract)
    ? { ...input, retrieval_mode: 'entity' }
    : input;
}

function addDrinkabilityRetrievalObjective(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const objective = queryExecutionContract.searchDefaults?.drinking_window;
  if (!queryExecutionContract.requiresDrinkabilityCheck || objective === undefined) {
    return input;
  }
  if (input['drinking_window'] !== undefined) {
    return input;
  }
  return {
    ...input,
    drinking_window: objective,
    ...(queryExecutionContract.searchDefaults?.drinking_window_target_year !== undefined
      ? { drinking_window_target_year: queryExecutionContract.searchDefaults.drinking_window_target_year }
      : {}),
  };
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
  const searchDefaults = queryExecutionContract.searchDefaults;
  const hasSearchLevelDrinkabilityObjective =
    searchDefaults?.drinking_window !== undefined
    || searchDefaults?.occasion?.includes('cellaring') === true;
  if (!queryExecutionContract.requiresDrinkabilityCheck && !hasSearchLevelDrinkabilityObjective) {
    return input;
  }
  const query = input['query'];
  if (typeof query !== 'string') {
    return input;
  }
  const normalized = query
    .replace(/(?:지금|현재)\s*(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu, ' ')
    .replace(/(?:마실\s*수\s*있는|마시기\s*좋은|마셔도\s*되는)\s*(?:와인|거|것)?/giu, ' ')
    .replace(/(?:지금\s*바로\s*마셔야\s*하(?:는|나|나요)?|바로\s*마셔야\s*하(?:는|나|나요)?)(?:\s*(?:와인|거|것))?/giu, ' ')
    .replace(/(?:지금\s*마시면\s*아까운|셀러(?:에)?\s*넣어둘\s*만한|셀러(?:에)?\s*넣어둘|장기\s*숙성(?:용|할|해둘|하려는)?)(?:\s*(?:와인|거|것))?/giu, ' ')
    .replace(/(?:아이\s*태어난\s*해\s*와인\s*사서|성인\s*될\s*때\s*(?:같이\s*)?마시(?:려고|려는|려면)|birth[\s-]?year\s+wine|for\s+when\s+(?:my\s+)?child\s+turns\s+adult)/giu, ' ')
    .replace(/(?:currently\s+drinkable|drink\s+now|ready\s+to\s+drink|drinking\s+well\s+now)/giu, ' ')
    .replace(/(?:cellar(?:ing)?(?:\s+worthy)?|ageworthy|aging\s+potential|long[\s-]?term\s+aging|hold(?:\s+for)?)/giu, ' ')
    .replace(/(?:있(?:어|나요|나|을까|을까요)|추천(?:해줘|해주세요|해\s*줘)|tell\s+me|show\s+me)[?？!！]*$/giu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ' ')
    .replace(/^\s*(?:중에|중|and)\s*/giu, '')
    .replace(/\s*(?:중에|and|,)\s*$/giu, '')
    .trim();
  const vintageMin = input['vintage_min'];
  const vintageMax = input['vintage_max'];
  const exactVintageQuery =
    typeof vintageMin === 'number'
    && typeof vintageMax === 'number'
    && vintageMin === vintageMax
      ? `${vintageMin}년산 와인`
      : undefined;
  const normalizedVintageOnly = /^(?:18|19|20)\d{2}(?:\s*년산?)?$/u.test(normalized);
  const finalQuery =
    normalized.length === 0
      ? exactVintageQuery ?? (/와인/u.test(query) ? '와인' : /wine/iu.test(query) ? 'wine' : undefined)
      : normalizedVintageOnly
        ? exactVintageQuery ?? normalized
        : normalized;
  return finalQuery !== undefined && finalQuery !== query ? { ...input, query: finalQuery } : input;
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
    'drinking_window',
    'drinking_window_target_year',
    'min_price_krw',
    'max_price_krw',
    'max_alcohol_pct',
    'gift_suitability_min',
    'beginner_suitability_min',
    'producer_prestige_min',
    'popularity_min',
    'recipient_profile',
    'sweetness_min',
    'sweetness_max',
    'acidity_min',
    'acidity_max',
    'tannin_max',
  ] as const) {
    if (next[key] === undefined && defaults[key] !== undefined) {
      next = { ...next, [key]: defaults[key] };
    }
  }
  return next;
}

function applySemanticResultLimit(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (queryExecutionContract.resultLimit === undefined || input['limit'] !== undefined) {
    return input;
  }
  return { ...input, limit: queryExecutionContract.resultLimit };
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
  const existingExclusions = collectStringArray(input['exclude_wine_types']);
  const hasRedNegation =
    /(?:레드\s*(?:말고|빼고|제외하고)|red\s*(?:excluded?|except|not|no)|not\s+red|no\s+red)/iu.test(query);
  const hasWhiteNegation =
    /(?:화이트\s*(?:말고|빼고|제외하고)|white\s*(?:excluded?|except|not|no)|not\s+white|no\s+white)/iu.test(query);
  const excludeWineTypes = wineType === 'white' && hasRedNegation
    ? uniqueStrings([...existingExclusions, 'red'])
    : wineType === 'red' && hasWhiteNegation
      ? uniqueStrings([...existingExclusions, 'white'])
      : existingExclusions;
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
  const withExclusions = excludeWineTypes.length > 0
    ? { ...input, exclude_wine_types: excludeWineTypes }
    : input;
  return compact.length > 0 && compact !== query ? { ...withExclusions, query: compact } : withExclusions;
}

function normalizeAccessibleOnlineTastingSearch(input: Record<string, unknown>): Record<string, unknown> {
  const query = input['query'];
  if (typeof query !== 'string' || !isAccessibleOnlineTastingQuery(query)) {
    return input;
  }

  let next = mergeStringArrayInput(input, 'styles', ['approachable', 'crowd_pleasing']);
  const { occasion: _occasion, ...withoutOccasion } = next;
  next = withoutOccasion;
  if (next['max_price_krw'] === undefined && /(?:5\s*만\s*원\s*이하|5만원\s*이하|under\s*(?:₩|krw)?\s*50[, ]?000|under\s*50k)/iu.test(query)) {
    next = { ...next, max_price_krw: 50_000 };
  }
  if (next['popularity_min'] === undefined) {
    next = { ...next, popularity_min: 0.5 };
  }
  return next;
}

function normalizeSupportedSituationOverrides(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const defaults = queryExecutionContract.searchDefaults;
  if (defaults === undefined) {
    return input;
  }

  let next = { ...input };
  const supportedStyles = defaults.styles;
  const styleValues = uniqueStrings([
    ...collectStringArray(next['styles']),
    ...(typeof next['style'] === 'string' ? [next['style']] : []),
  ]);
  if (styleValues.length > 0 && supportedStyles !== undefined && supportedStyles.length > 0) {
    const allowed = new Set(supportedStyles);
    const normalizedStyles = uniqueStrings(styleValues.filter((value) => allowed.has(value)));
    if (normalizedStyles.length > 0) {
      next['styles'] = normalizedStyles;
    } else {
      delete next['styles'];
    }
    if (typeof next['style'] === 'string' && !allowed.has(next['style'])) {
      delete next['style'];
    }
  }

  const supportedOccasion = defaults.occasion;
  const inputOccasion = collectStringArray(next['occasion']);
  if (inputOccasion.length > 0) {
    if (supportedOccasion === undefined || supportedOccasion.length === 0) {
      delete next['occasion'];
    } else {
      const allowed = new Set(supportedOccasion);
      const normalizedOccasion = uniqueStrings(inputOccasion.filter((value) => allowed.has(value)));
      if (normalizedOccasion.length > 0) {
        next['occasion'] = normalizedOccasion;
      } else {
        delete next['occasion'];
      }
    }
  }

  for (const key of [
    'gift_suitability_min',
    'beginner_suitability_min',
    'producer_prestige_min',
    'popularity_min',
    'recipient_profile',
    'sweetness_min',
    'sweetness_max',
    'acidity_min',
    'acidity_max',
    'tannin_max',
  ] as const) {
    if (defaults[key] === undefined) {
      next = omitRecordKeys(next, [key]);
      continue;
    }
    next[key] = defaults[key];
  }

  if (next['want_diversity'] === true) {
    const query = typeof next['query'] === 'string' ? next['query'] : '';
    if (!SEARCH_TOOL_WANTS_DIVERSITY_RE.test(query)) {
      delete next['want_diversity'];
    }
  }

  return next;
}

function normalizeCellaringSearchSemantics(input: Record<string, unknown>): Record<string, unknown> {
  const occasion = collectStringArray(input['occasion']);
  if (!occasion.includes('cellaring')) {
    return input;
  }

  const normalizedStyles = collectStringArray(input['styles'])
    .map((value) => value.trim())
    .filter((value) => !['cellaring', 'approachable', 'crowd_pleasing'].includes(value));
  const uniqueStyles = uniqueStrings(normalizedStyles);
  const next: Record<string, unknown> = { ...input };
  if (uniqueStyles.length > 0) {
    next['styles'] = uniqueStyles;
  } else {
    delete next['styles'];
  }
  if (typeof next['style'] === 'string' && ['cellaring', 'approachable', 'crowd_pleasing'].includes(next['style'].trim())) {
    delete next['style'];
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
    .replace(/[/,+&]+/gu, ' ')
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
  const normalizedBaseInput = (() => {
    const occasion = collectStringArray(baseInput['occasion']);
    if (occasion.length === 0) {
      return baseInput;
    }
    const preserved = occasion.filter((value) => value === 'gift');
    if (preserved.length > 0) {
      return { ...baseInput, occasion: preserved };
    }
    const { occasion: _occasion, ...withoutOccasion } = baseInput;
    return withoutOccasion;
  })();
  const next: Record<string, unknown> = {
    ...normalizedBaseInput,
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

function normalizeParallelSlotOccasion(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  if (queryExecutionContract.requiredParallelSearches === undefined) {
    return input;
  }
  const occasion = collectStringArray(input['occasion']);
  if (occasion.length === 0) {
    return input;
  }
  const preserved = occasion.filter((value) => value === 'gift');
  if (preserved.length > 0) {
    return { ...input, occasion: preserved };
  }
  const { occasion: _occasion, ...withoutOccasion } = input;
  return withoutOccasion;
}

function normalizeParallelSlotSearchInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
): Record<string, unknown> {
  const slots = queryExecutionContract.requiredParallelSearches;
  const wineType = input['wine_type'];
  const query = input['query'];
  if (
    slots === undefined
    || typeof wineType !== 'string'
    || !slots.some((slot) => slot.wineType === wineType)
  ) {
    return input;
  }

  let next = normalizeParallelSlotOccasion(input, queryExecutionContract);
  if (typeof query === 'string') {
    const normalizedQuery = buildSlotQueryAnchor(query, wineType);
    if (normalizedQuery !== query) {
      next = { ...next, query: normalizedQuery };
    }
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

/**
 * S5 pre-fetch fanout. When the planner emits a SINGLE
 * `check_drinking_window` and 2+ entity ids are grounded in state and still
 * pending a drinkability check, expand to a parallel `check_drinking_window`
 * batch — one call per grounded id — so the loop checks all entities in one
 * RTT instead of N sequential steps. Deterministic from state; capped at
 * `MAX_DRINKABILITY_FANOUT`.
 *
 * Returns `undefined` (no expansion) when:
 *  - the tool is not `check_drinking_window`,
 *  - fewer than 2 distinct grounded ids are pending, or
 *  - the planner ALREADY named a concrete grounded `entity_id` — in that case
 *    we respect the planner's deliberate single-entity target and do NOT
 *    fan out to its siblings. We only auto-expand the under-specified case
 *    (entity_id absent or a forbidden placeholder) so a planner that wants
 *    one entity keeps getting one, while a planner that defers id resolution
 *    gets the full deterministic batch.
 *
 * Non-id fields of the planner input (e.g. `target_year`) are carried onto
 * every fanned-out call so the check semantics are identical across the batch.
 */
function buildDrinkabilityFanoutExpansion(
  input: ResolveSingleToolInput,
): readonly ResolvedToolCall[] | undefined {
  if (input.tool !== 'check_drinking_window') {
    return undefined;
  }
  const groundedIds = input.groundedDrinkabilityEntityIds;
  if (groundedIds === undefined || groundedIds.length < 2) {
    return undefined;
  }
  // Respect a planner that pinned a concrete, real (non-placeholder) entity_id
  // to one of the grounded ids — do not auto-expand to siblings.
  const plannerEntityId = input.input['entity_id'];
  if (
    typeof plannerEntityId === 'string'
    && plannerEntityId.trim().length > 0
    && !isFanoutPlaceholderEntityId(plannerEntityId)
  ) {
    return undefined;
  }
  const distinctIds: string[] = [];
  for (const id of groundedIds) {
    if (typeof id === 'string' && id.trim().length > 0 && !distinctIds.includes(id)) {
      distinctIds.push(id);
    }
    if (distinctIds.length >= MAX_DRINKABILITY_FANOUT) {
      break;
    }
  }
  if (distinctIds.length < 2) {
    return undefined;
  }
  // Carry every non-entity_id field of the planner input onto each call so
  // semantics (e.g. target_year) are uniform across the batch.
  const { entity_id: _plannerEntityId, ...sharedInput } = input.input;
  return distinctIds.map((entityId) => ({
    tool: 'check_drinking_window',
    input: { ...sharedInput, entity_id: entityId },
  }));
}

function normalizeSearchExecutionInput(
  input: Record<string, unknown>,
  queryExecutionContract: AgentQueryExecutionContract,
  options?: NormalizeSearchExecutionOptions,
): Record<string, unknown> {
  const normalizedInput = normalizeSearchInput(input, queryExecutionContract, options);
  const withoutVerificationFields = stripSearchDrinkabilityVerificationFields(
    normalizedInput,
    queryExecutionContract,
  );
  const withoutDrinkabilityQueryObjective = stripSearchDrinkabilityObjectiveFromQuery(
    withoutVerificationFields,
    queryExecutionContract,
  );
  const withSearchDefaults = applySearchDefaults(
    withoutDrinkabilityQueryObjective,
    queryExecutionContract,
  );
  const withSemanticLimit = applySemanticResultLimit(
    withSearchDefaults,
    queryExecutionContract,
  );
  const withNormalizedAppellation = normalizeTopLevelRegionAppellation(withSemanticLimit);
  const withoutNegatedWineTypeNoise = normalizeNegatedWineTypeSearchAnchor(withNormalizedAppellation);
  const withCellaringSemanticsNormalized = normalizeCellaringSearchSemantics(withoutNegatedWineTypeNoise);
  const withSupportedSituationOverrides = normalizeSupportedSituationOverrides(
    withCellaringSemanticsNormalized,
    queryExecutionContract,
  );
  const withAccessibilityNormalization = normalizeAccessibleOnlineTastingSearch(withSupportedSituationOverrides);
  const withParallelSlotNormalization = normalizeParallelSlotSearchInput(
    withAccessibilityNormalization,
    queryExecutionContract,
  );
  const withExactLookupRetrievalMode = enforceExactLookupRetrievalMode(
    withParallelSlotNormalization,
    queryExecutionContract,
  );
  const withExactLookupEntitySearch = normalizeExactLookupEntitySearchInput(
    withExactLookupRetrievalMode,
    queryExecutionContract,
  );
  return applyExplicitTotalBudgetParallelSlot(
    withExactLookupEntitySearch,
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
  const rewrittenTokens: string[] = [];
  for (const token of tokens) {
    const romanized = Transliterator.romanizeWineTerm(token);
    if (romanized === undefined || romanized.trim().length === 0) {
      rewrittenTokens.push(token);
      continue;
    }
    changed = true;
    rewrittenTokens.push(romanized.trim());
  }
  const rewritten = rewrittenTokens.join(' ').trim();

  return changed ? rewritten : undefined;
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

  const keysToStrip: string[] = [];
  for (const key of [
    side === 'a' ? 'country_a' : 'country_b',
    side === 'a' ? 'region_a' : 'region_b',
    side === 'a' ? 'appellation_a' : 'appellation_b',
    side === 'a' ? 'grape_primary_a' : 'grape_primary_b',
    side === 'a' ? 'wine_type_a' : 'wine_type_b',
  ] as const) {
    const value = input[key];
    if (typeof value !== 'string') {
      continue;
    }
    if (!sideFieldLexicallyMentioned(query, value)) {
      keysToStrip.push(key);
    }
  }
  return keysToStrip.length > 0 ? omitRecordKeys(input, keysToStrip) : input;
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
    const drinkabilityFanout = buildDrinkabilityFanoutExpansion(input);
    if (drinkabilityFanout !== undefined) {
      return drinkabilityFanout;
    }

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
          input: normalizeSearchExecutionInput(
            call.input,
            input.queryExecutionContract,
            { preservePlannerQuery: typeof call.input['query'] === 'string' && call.input['query'].trim().length > 0 },
          ),
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
