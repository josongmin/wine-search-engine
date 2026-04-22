import type { AgentStep } from '../../domain/agent/model/agent-step.js';
import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
import { QueryNormalizer } from '../../domain/query/service/query-normalizer.js';
import { detectDecomposition } from '../../domain/query/service/decomposition-detector.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
  hasExactEntityLookupKeyword,
  stripExactEntityLookupSuffix,
} from '../../domain/query/service/exact-entity-metadata-signals.js';
import { extractAllPairingConstraints, type PairingTag } from '../../domain/query/service/pairing-extractor.js';
import { parseSpans } from '../../domain/attribute/service/span-parser.js';
import { isDirectEntityResolution, resolveEntity } from '../../domain/attribute/service/entity-resolver.js';
import { extractSearchConstraints } from '../../domain/query/service/search-constraint-extractor.js';
import { extractVintageYear } from '../../domain/shared/utils/vintage.js';
import type { ToolOutcome } from './tool-outcome.js';

const QUERY_NORMALIZER = new QueryNormalizer();
const EXACT_METADATA_ALLOWED_SEARCH_KEYS = new Set(['query', 'limit', 'retrieval_mode']);

export interface AgentQueryExecutionContract {
  readonly requiresDrinkabilityCheck: boolean;
  readonly hasEntityMetadataSignal: boolean;
  readonly exactMetadataEntityQuery?: string | undefined;
  readonly exactMetadataTargetVintage?: number | undefined;
  readonly hasTemporalReleaseSignal?: boolean | undefined;
  readonly temporalReleaseQuery?: string | undefined;
  readonly temporalReleaseConceptQuery?: boolean | undefined;
  readonly nonExactEntityLookupQuery?: string | undefined;
  readonly requiresGroundedWineSearch?: boolean | undefined;
  readonly totalBudgetKrw?: number | undefined;
  readonly requiredTool?: 'get_food_pairings' | undefined;
  readonly foodPairing?: {
    readonly food: string;
    readonly pairingTags: readonly PairingTag[];
  } | undefined;
  readonly searchDefaults?: AgentSearchDefaults | undefined;
  readonly requiredParallelSearches?: readonly AgentSearchSlot[] | undefined;
}

export interface AgentSearchDefaults {
  readonly grape_primary?: string | undefined;
  readonly region?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly recipient_profile?: 'parents_first_time' | 'senior_colleague_gift' | 'unknown_preference_recipient' | undefined;
  readonly sweetness_min?: number | undefined;
  readonly sweetness_max?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly acidity_max?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly drinking_window?: 'now' | undefined;
  readonly drinking_window_target_year?: number | undefined;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly gift_suitability_min?: number | undefined;
  readonly beginner_suitability_min?: number | undefined;
  readonly producer_prestige_min?: number | undefined;
  readonly popularity_min?: number | undefined;
}

export interface AgentSearchSlot {
  readonly wineType: 'red' | 'white' | 'rosé' | 'sparkling' | 'fortified' | 'dessert' | 'orange' | 'natural';
  readonly limit?: number | undefined;
}

function hasCellaringIntent(normalized: string): boolean {
  return /(?:셀러|cellar(?:ing)?|지금\s*마시면\s*아까운|숙성(?:용|할|해둘|해서|가능|잠재력)?|ageworthy|aging\s+potential|long[\s-]?term\s+aging|hold\s+for|hold\b|성인\s*될\s*때)/iu.test(normalized);
}

function hasImmediateDrinkabilityIntent(normalized: string): boolean {
  return /(?:지금\s*바로\s*마셔야|바로\s*마셔야|must\s+drink\s+now|drink\s+now\s+or\s+soon|ready\s+now)/iu.test(normalized);
}

function hasCurrentDrinkabilityIntent(normalized: string): boolean {
  return hasDrinkabilityKeyword(normalized)
    && /(?:^|[^\p{L}\p{N}])(?:지금|현재|currently|now)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
}

function queryNeedsDrinkabilityCheck(query: string, normalized: string): boolean {
  const hasDrinkabilityIntent =
    hasCellaringIntent(normalized)
    || hasImmediateDrinkabilityIntent(normalized)
    || hasDrinkabilityKeyword(normalized);
  if (!hasDrinkabilityIntent) {
    return false;
  }
  if (isExactMetadataEntityLookupCandidate(query)) {
    return true;
  }
  if (detectDecomposition(query).decomposed) {
    return true;
  }
  return false;
}

function queryHasTemporalReleaseSignal(normalized: string): boolean {
  const hasTemporalCue = /(?:^|[^\p{L}\p{N}])(?:올해|올해꺼|이번\s*해|current\s+year|latest|most\s+recent)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
  const hasReleaseCue = /(?:^|[^\p{L}\p{N}])(?:출시|출시\s*여부|나왔어|나왔나|나왔는지|release(?:d)?|availability|available)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
  return hasTemporalCue && hasReleaseCue;
}

const NON_EXACT_ENTITY_LOOKUP_INTENT_RE =
  /(?:같은\s*와인|대체|스타일|느낌|비교|(?:급)(?=$|[^\p{L}\p{N}])|명작|명품|와인\s*추천|추천(?!\s*(?:해줘|해주세요|해\s*줘)))/u;

function queryHasDirectAppellationSpan(query: string): boolean {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  const candidates = [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    queryViews.transliterated,
    ...queryViews.lookupVariants,
  ];
  return candidates.some((candidate) => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return false;
    }
    return parseSpans(candidate).some((span) => {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      return isDirectEntityResolution(resolved)
        && resolved.entityType === 'appellation'
        && resolved.resolutionMode === 'direct';
    });
  });
}

function getNonExactEntityLookupQuery(query: string): string | undefined {
  if (!NON_EXACT_ENTITY_LOOKUP_INTENT_RE.test(query)) {
    return undefined;
  }
  return queryHasDirectAppellationSpan(query) ? query.trim() : undefined;
}

const TEMPORAL_RELEASE_SUFFIX_PATTERNS: readonly RegExp[] = [
  /(?:\s*(?:확실한\s*근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)|근거\s*없으면\s*(?:추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘)|추정하지\s*말고\s*말해줘|모른다고(?:만)?\s*해줘))[?？!！]*$/u,
  /(?:\s*(?:올해(?:꺼)?|이번\s*해|current\s+year|latest|most\s+recent)\s*(?:나왔(?:어|나|는지)?|출시(?:됐|했)?(?:어|나|는지)?|출시\s*여부|release(?:d)?|availability|available))[?？!！]*$/iu,
  /(?:\s*(?:나왔(?:어|나|는지)?|출시(?:됐|했)?(?:어|나|는지)?|출시\s*여부|release(?:d)?|availability|available))[?？!！]*$/iu,
  /(?:\s*(?:올해(?:꺼)?|이번\s*해|current\s+year|latest|most\s+recent))[?？!！]*$/iu,
] as const;

function stripTemporalReleaseSuffix(rawQuery: string): string {
  let stripped = rawQuery.trim();
  for (const pattern of TEMPORAL_RELEASE_SUFFIX_PATTERNS) {
    stripped = stripped.replace(pattern, '').trim();
  }
  return stripped.length > 0 ? stripped : rawQuery.trim();
}

function queryRequiresGroundedWineSearch(query: string, normalized: string): boolean {
  if (isSpecificSkuLikeQuery(query) || isExactMetadataEntityLookupCandidate(query)) {
    return false;
  }
  const hasDecantingGuidanceKeyword = /(?:디캔팅|디켄팅|decant(?:ing)?)/iu.test(normalized);
  const hasGenericWineTarget = /(?:와인|wine)/iu.test(normalized);
  return hasDecantingGuidanceKeyword && hasGenericWineTarget;
}

function hasMixedColorPairingShape(normalized: string): boolean {
  return /(?:레드\s*[\/,+&와과및]*\s*화이트|화이트\s*[\/,+&와과및]*\s*레드|red\s*(?:\/|and|&|\+|,)\s*white|white\s*(?:\/|and|&|\+|,)\s*red|반반|both\s+colors?)/iu.test(normalized);
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function buildSearchDefaults(query: string, normalized: string): AgentSearchDefaults | undefined {
  const styles: string[] = [];
  const occasion: string[] = [];
  const grapePrimary = detectExplicitGrapePrimary(query);
  const region = detectExplicitRegion(query);
  const extractedConstraints = extractSearchConstraints(query);
  let minPriceKrw = extractedConstraints.minPriceKrw;
  let maxPriceKrw = extractedConstraints.maxPriceKrw;
  let maxAlcoholPct: number | undefined;
  let giftSuitabilityMin: number | undefined;
  let beginnerSuitabilityMin: number | undefined;
  let producerPrestigeMin: number | undefined;
  let popularityMin: number | undefined;
  let recipientProfile: AgentSearchDefaults['recipient_profile'];
  let sweetnessMin: number | undefined;
  let sweetnessMax: number | undefined;
  let acidityMin: number | undefined;
  let acidityMax: number | undefined;
  let tanninMax: number | undefined;
  let drinkingWindow: 'now' | undefined;
  let drinkingWindowTargetYear: number | undefined;
  const hasBeginnerOrFirstTimeCue = /(?:입문자|초보|와인\s*잘\s*모르는|non[-\s]?expert|beginner|처음\s*마시(?:는|기|려)|처음\s*마셔보(?:기|는)?|first\s+(?:time\s+)?(?:drinking|wine))/iu.test(query);
  const hasOlderFamilyCue = /(?:부모님|어머님|아버님|parents?|older\s+family)/iu.test(normalized);

  if (/(?:스크류\s*캡|스쿠류\s*캡|screw\s*cap)/iu.test(normalized)) {
    addUnique(styles, 'screw_cap');
  }
  if (/(?:차갑게|시원하게|칠링|chill(?:ed|able)?)/iu.test(normalized)) {
    addUnique(styles, 'chillable');
  }
  if (/(?:예쁜\s*(?:라벨|병|패키지|포장)|라벨\s*예쁜|beautiful\s+label|pretty\s+label|presentation[-\s]?forward)/iu.test(normalized)) {
    addUnique(styles, 'presentation_forward');
  }
  if (/(?:캠핑|camping)/iu.test(normalized)) {
    addUnique(occasion, 'camping');
  }
  if (/(?:집들이|housewarming)/iu.test(normalized)) {
    addUnique(occasion, 'housewarming');
  }
  if (/(?:데이트|date\s*night|romantic)/iu.test(normalized)) {
    addUnique(occasion, 'date_night');
  }
  if (/(?:선물|gift)/iu.test(normalized)) {
    addUnique(occasion, 'gift');
    giftSuitabilityMin = 0.65;
  }
  if (/(?:온라인\s*와인\s*시음회|온라인\s*시음회|online\s+tasting|virtual\s+tasting|참가자\s*모두|모두가\s*살\s*수|widely\s+available|accessible\s+to\s+all)/iu.test(normalized)) {
    addUnique(styles, 'approachable');
    addUnique(styles, 'crowd_pleasing');
    beginnerSuitabilityMin = Math.max(beginnerSuitabilityMin ?? 0, 0.65);
    popularityMin = Math.max(popularityMin ?? 0, 0.5);
  }
  if (
    maxPriceKrw === undefined &&
    /(?:5\s*만\s*원\s*이하|5만원\s*이하|under\s*(?:₩|krw)?\s*50[, ]?000|under\s*50k)/iu.test(normalized)
  ) {
    maxPriceKrw = 50_000;
  }
  if (hasBeginnerOrFirstTimeCue) {
    addUnique(styles, 'approachable');
    beginnerSuitabilityMin = 0.65;
  }
  if (hasOlderFamilyCue) {
    addUnique(styles, 'crowd_pleasing');
  }
  if (hasOlderFamilyCue && hasBeginnerOrFirstTimeCue) {
    recipientProfile = 'parents_first_time';
    sweetnessMin = 0.2;
    sweetnessMax = 0.75;
    tanninMax = 0.3;
    acidityMax = 0.75;
  }
  if (/(?:상대방이\s*뭘\s*좋아하(?:는지|실지)\s*몰라|취향(?:을)?\s*몰라|don['’]t\s+know\s+(?:what\s+)?(?:they|the\s+recipient)\s+like|unknown\s+preferences?)/iu.test(normalized)) {
    addUnique(styles, 'crowd_pleasing');
    recipientProfile = 'unknown_preference_recipient';
  }
  if (/(?:실패\s*없는|무난한?|대중적인?|crowd[-\s]?pleasing|safe\s+gift)/iu.test(normalized)) {
    addUnique(styles, 'crowd_pleasing');
    giftSuitabilityMin = Math.max(giftSuitabilityMin ?? 0, 0.7);
  }
  if (/(?:달달|달콤|스위트|sweet)/iu.test(normalized)) {
    addUnique(styles, 'sweet');
  }
  if (/(?:도수\s*낮|저도수|low[-\s]?alcohol)/iu.test(normalized)) {
    maxAlcoholPct = 12;
  }
  if (/(?:격식|품격|퇴직|상사|고급스러운|prestige|formal|luxury)/iu.test(normalized)) {
    producerPrestigeMin = 0.7;
  }
  if (hasCellaringIntent(normalized)) {
    addUnique(occasion, 'cellaring');
    addUnique(styles, 'ageworthy');
  }
  if (hasCurrentDrinkabilityIntent(normalized) || hasImmediateDrinkabilityIntent(normalized)) {
    drinkingWindow = 'now';
    drinkingWindowTargetYear = new Date().getFullYear();
  }
  if (/(?:직장\s*상사|상사|승진|퇴직|senior\s+colleague|promotion|retirement)/iu.test(normalized)) {
    addUnique(occasion, 'gift');
    addUnique(styles, 'crowd_pleasing');
    recipientProfile = 'senior_colleague_gift';
    minPriceKrw = 50_000;
    maxPriceKrw = 150_000;
    giftSuitabilityMin = Math.max(giftSuitabilityMin ?? 0, 0.75);
    producerPrestigeMin = Math.max(producerPrestigeMin ?? 0, 0.7);
  }

  const defaults: AgentSearchDefaults = {
    ...(grapePrimary !== undefined ? { grape_primary: grapePrimary } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(styles.length > 0 ? { styles } : {}),
    ...(occasion.length > 0 ? { occasion } : {}),
    ...(recipientProfile !== undefined ? { recipient_profile: recipientProfile } : {}),
    ...(sweetnessMin !== undefined ? { sweetness_min: sweetnessMin } : {}),
    ...(sweetnessMax !== undefined ? { sweetness_max: sweetnessMax } : {}),
    ...(acidityMin !== undefined ? { acidity_min: acidityMin } : {}),
    ...(acidityMax !== undefined ? { acidity_max: acidityMax } : {}),
    ...(tanninMax !== undefined ? { tannin_max: tanninMax } : {}),
    ...(drinkingWindow !== undefined ? { drinking_window: drinkingWindow } : {}),
    ...(drinkingWindowTargetYear !== undefined ? { drinking_window_target_year: drinkingWindowTargetYear } : {}),
    ...(minPriceKrw !== undefined ? { min_price_krw: minPriceKrw } : {}),
    ...(maxPriceKrw !== undefined ? { max_price_krw: maxPriceKrw } : {}),
    ...(maxAlcoholPct !== undefined ? { max_alcohol_pct: maxAlcoholPct } : {}),
    ...(giftSuitabilityMin !== undefined ? { gift_suitability_min: giftSuitabilityMin } : {}),
    ...(beginnerSuitabilityMin !== undefined ? { beginner_suitability_min: beginnerSuitabilityMin } : {}),
    ...(producerPrestigeMin !== undefined ? { producer_prestige_min: producerPrestigeMin } : {}),
    ...(popularityMin !== undefined ? { popularity_min: popularityMin } : {}),
  };
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function detectExplicitGrapePrimary(query: string): string | undefined {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  const resolvedGrapes = new Set<string>();

  for (const candidate of [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    ...queryViews.lookupVariants,
  ]) {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (normalizedCandidate.length === 0) {
      continue;
    }

    for (const span of parseSpans(normalizedCandidate)) {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      if (!isDirectEntityResolution(resolved) || resolved.entityType !== 'grape_primary') {
        continue;
      }
      if (resolved.resolutionMode !== 'direct') {
        continue;
      }
      resolvedGrapes.add(resolved.canonicalValue);
    }
  }

  return resolvedGrapes.size === 1 ? [...resolvedGrapes][0] : undefined;
}

function detectExplicitRegion(query: string): string | undefined {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  const resolvedRegions = new Set<string>();

  for (const candidate of [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    ...queryViews.lookupVariants,
  ]) {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (normalizedCandidate.length === 0) {
      continue;
    }

    for (const span of parseSpans(normalizedCandidate)) {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      if (!isDirectEntityResolution(resolved) || resolved.entityType !== 'region') {
        continue;
      }
      if (resolved.resolutionMode !== 'direct') {
        continue;
      }
      resolvedRegions.add(resolved.canonicalValue);
    }
  }

  return resolvedRegions.size === 1 ? [...resolvedRegions][0] : undefined;
}

function hasDirectEntityAnchorForMetadata(query: string): boolean {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  for (const candidate of [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    queryViews.transliterated,
    ...queryViews.lookupVariants,
  ]) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      continue;
    }
    for (const span of parseSpans(candidate.trim().toLowerCase())) {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      if (!isDirectEntityResolution(resolved)) {
        continue;
      }
      if (resolved.entityType === 'wine_type') {
        continue;
      }
      return true;
    }
  }
  return false;
}

function hasDirectConceptAnchor(query: string): boolean {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  for (const candidate of [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    queryViews.transliterated,
    ...queryViews.lookupVariants,
  ]) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      continue;
    }
    for (const span of parseSpans(candidate.trim().toLowerCase())) {
      const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
      if (!isDirectEntityResolution(resolved)) {
        continue;
      }
      if (resolved.entityType === 'wine_type') {
        continue;
      }
      return true;
    }
  }
  return false;
}

function isTemporalReleaseConceptQuery(query: string): boolean {
  const stripped = stripTemporalReleaseSuffix(query);
  if (stripped.length === 0) {
    return false;
  }
  return hasDirectConceptAnchor(stripped);
}

function containsGenericWineNoun(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:와인|wine)(?=$|[^\p{L}\p{N}])/iu.test(query);
}

function extractExplicitTotalBudgetKrw(query: string, normalized: string): number | undefined {
  const candidates = [query, normalized];
  for (const candidate of candidates) {
    const koreanManWon = /(?:총|전체|예산)\s*(\d+(?:\.\d+)?)\s*만\s*원/iu.exec(candidate);
    if (koreanManWon?.[1] !== undefined) {
      const parsed = Number(koreanManWon[1]);
      if (Number.isFinite(parsed)) {
        return Math.round(parsed * 10_000);
      }
      continue;
    }

    const koreanWon = /(?:총|전체|예산)\s*₩?\s*(\d[\d,]*)\s*원/iu.exec(candidate);
    if (koreanWon?.[1] !== undefined) {
      const parsed = Number(koreanWon[1].replace(/,/gu, ''));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      continue;
    }

    const english = /\b(?:total|budget)\s*(?:₩|krw)?\s*(\d[\d,]*)\s*(?:원|krw)?\b/iu.exec(candidate);
    if (english?.[1] !== undefined) {
      const parsed = Number(english[1].replace(/,/gu, ''));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function buildRequiredParallelSearches(normalized: string): readonly AgentSearchSlot[] | undefined {
  if (!hasMixedColorPairingShape(normalized)) {
    return undefined;
  }
  const hasRed = /(?:레드|red)/iu.test(normalized);
  const hasWhite = /(?:화이트|white)/iu.test(normalized);
  if (!hasRed || !hasWhite) {
    return undefined;
  }
  const oneEach = /(?:한\s*병씩|각각\s*(?:1|한)\s*(?:병|개)|one\s+each)/iu.test(normalized);
  return [
    { wineType: 'red', ...(oneEach ? { limit: 1 } : {}) },
    { wineType: 'white', ...(oneEach ? { limit: 1 } : {}) },
  ];
}

function buildFoodPairingContract(
  query: string,
  normalized: string,
): AgentQueryExecutionContract['foodPairing'] {
  if (detectDecomposition(query).decomposed || hasMixedColorPairingShape(normalized)) {
    return undefined;
  }

  const pairingTags = [
    ...new Set<PairingTag>([
      ...extractAllPairingConstraints(query),
      ...extractAllPairingConstraints(normalized),
    ]),
  ];
  if (pairingTags.length === 0) {
    return undefined;
  }

  return {
    food: query.trim(),
    pairingTags,
  };
}

export function buildAgentQueryExecutionContract(query: string): AgentQueryExecutionContract {
  const normalized = QUERY_NORMALIZER.normalize(query).accentless;
  const hasTemporalReleaseSignal = queryHasTemporalReleaseSignal(normalized);
  const nonExactEntityLookupQuery = getNonExactEntityLookupQuery(query);
  const hasExactEntityLookupSignal =
    nonExactEntityLookupQuery === undefined && isExactMetadataEntityLookupCandidate(query);
  const strippedExactMetadataEntityQuery = hasExactEntityLookupSignal
    ? stripExactEntityLookupSuffix(query)
    : undefined;
  const exactMetadataEntityQuery =
    strippedExactMetadataEntityQuery !== undefined
      ? (
          hasTemporalReleaseSignal
            ? stripTemporalReleaseSuffix(strippedExactMetadataEntityQuery)
            : strippedExactMetadataEntityQuery
        )
      : undefined;
  const temporalReleaseConceptQuery = hasTemporalReleaseSignal && isTemporalReleaseConceptQuery(query);
  const temporalReleaseQuery = hasTemporalReleaseSignal && !isSpecificSkuLikeQuery(query)
    ? stripTemporalReleaseSuffix(query)
    : undefined;
  const exactMetadataTargetVintage =
    exactMetadataEntityQuery !== undefined
      ? extractVintageYear(exactMetadataEntityQuery) ?? undefined
      : undefined;
  const foodPairing = buildFoodPairingContract(query, normalized);
  const searchDefaults = buildSearchDefaults(query, normalized);
  const requiredParallelSearches = buildRequiredParallelSearches(normalized);
  const totalBudgetKrw = extractExplicitTotalBudgetKrw(query, normalized);
  return {
    requiresDrinkabilityCheck: queryNeedsDrinkabilityCheck(query, normalized),
    hasEntityMetadataSignal: hasEntityMetadataKeyword(normalized) || hasExactEntityLookupSignal,
    ...(exactMetadataEntityQuery !== undefined
      ? { exactMetadataEntityQuery }
      : {}),
    ...(hasTemporalReleaseSignal ? { hasTemporalReleaseSignal: true } : {}),
    ...(temporalReleaseQuery !== undefined
      ? { temporalReleaseQuery }
      : {}),
    ...(temporalReleaseConceptQuery
      ? { temporalReleaseConceptQuery: true }
      : {}),
    ...(nonExactEntityLookupQuery !== undefined
      ? { nonExactEntityLookupQuery }
      : {}),
    ...(exactMetadataTargetVintage !== undefined
      ? { exactMetadataTargetVintage }
      : {}),
    ...(queryRequiresGroundedWineSearch(query, normalized) ? { requiresGroundedWineSearch: true } : {}),
    ...(totalBudgetKrw !== undefined ? { totalBudgetKrw } : {}),
    ...(foodPairing !== undefined
      ? {
          requiredTool: 'get_food_pairings' as const,
          foodPairing,
        }
      : {}),
    ...(searchDefaults !== undefined ? { searchDefaults } : {}),
    ...(requiredParallelSearches !== undefined ? { requiredParallelSearches } : {}),
  };
}

export function isSpecificSkuLikeQuery(query: string): boolean {
  return classifyQueryBudget(query)?.classification === 'specific_sku';
}

export function isExactMetadataEntityLookupCandidate(query: string): boolean {
  const normalized = QUERY_NORMALIZER.normalize(query).accentless;
  if (!hasExactEntityLookupKeyword(normalized)) {
    return false;
  }
  const strippedEntityQuery = stripExactEntityLookupSuffix(query);
  if (
    containsGenericWineNoun(strippedEntityQuery)
    && !hasDirectEntityAnchorForMetadata(strippedEntityQuery)
  ) {
    return false;
  }
  if (isSpecificSkuLikeNormalized(query)) {
    return true;
  }
  return strippedEntityQuery !== query && isSpecificSkuLikeNormalized(strippedEntityQuery);
}

function isSpecificSkuLikeNormalized(query: string): boolean {
  if (isSpecificSkuLikeQuery(query)) {
    return true;
  }
  const queryViews = QUERY_NORMALIZER.normalize(query);
  const candidates = [
    queryViews.punctuationStripped,
    queryViews.vintageStripped,
    queryViews.transliterated,
    ...queryViews.lookupVariants,
  ];
  return candidates.some((candidate) =>
    typeof candidate === 'string'
    && candidate.trim().length > 0
    && isSpecificSkuLikeQuery(candidate),
  );
}

export function hasBareExactEntityAnchor(query: string): boolean {
  const queryViews = QUERY_NORMALIZER.normalize(query);
  const candidates = [
    queryViews.punctuationStripped,
    queryViews.transliterated,
    ...queryViews.lookupVariants,
  ];

  return candidates.some((candidate) => {
    if (typeof candidate !== 'string') {
      return false;
    }
    const trimmed = candidate.trim().toLowerCase();
    if (trimmed.length === 0 || containsGenericWineNoun(trimmed)) {
      return false;
    }
    const resolved = resolveEntity(trimmed, { preferEntityOverStyle: true });
    if (!isDirectEntityResolution(resolved) || resolved.entityType !== 'appellation') {
      return false;
    }
    const canonical = QUERY_NORMALIZER.normalize(resolved.canonicalValue).punctuationStripped.trim().toLowerCase();
    const tokenCount = trimmed.split(/\s+/u).filter((token) => token.length > 0).length;
    const canonicalLooksLabelLike = canonical.includes(' ') || canonical.includes('&');
    return tokenCount >= 2 || extractVintageYear(trimmed) !== undefined || (canonicalLooksLabelLike && canonical !== trimmed);
  });
}

function getStructuredSearchFilterKeys(input: Record<string, unknown>): readonly string[] {
  return Object.entries(input)
    .filter(([key, value]) =>
      !EXACT_METADATA_ALLOWED_SEARCH_KEYS.has(key) &&
      value !== undefined &&
      value !== null,
    )
    .map(([key]) => key);
}

export function normalizeExactMetadataSearchInput(
  input: Record<string, unknown>,
  preserveKeys: readonly string[] = [],
): { readonly effectiveInput: Record<string, unknown>; readonly strippedFilterKeys: readonly string[] } {
  const allowedKeys = new Set([...EXACT_METADATA_ALLOWED_SEARCH_KEYS, ...preserveKeys]);
  const strippedFilterKeys = getStructuredSearchFilterKeys(input);
  if (strippedFilterKeys.length === 0) {
    return { effectiveInput: input, strippedFilterKeys };
  }

  const filteredEntries = Object.entries(input).filter(
    ([key, value]) =>
      allowedKeys.has(key) &&
      value !== undefined &&
      value !== null,
  );
  return {
    effectiveInput: Object.fromEntries(filteredEntries),
    strippedFilterKeys,
  };
}

function getValueAtPath(input: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function getCompletedDrinkabilityEntityIds(
  steps: readonly AgentStep[],
): ReadonlySet<string> {
  const entityIds = new Set<string>();
  for (const step of steps) {
    if (step.action?.tool === 'check_drinking_window') {
      const entityId = step.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
    for (const pair of step.actionPairs ?? []) {
      if (pair.action.tool !== 'check_drinking_window') {
        continue;
      }
      const entityId = pair.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
  }
  return entityIds;
}

function getToolOutcomeStepGroupId(stepId: string): string {
  const lastSeparator = stepId.lastIndexOf(':');
  return lastSeparator >= 0 ? stepId.slice(0, lastSeparator) : stepId;
}

function extractPendingSearchDrinkabilityEntityIds(
  toolOutcomes: readonly ToolOutcome[],
  completed: ReadonlySet<string>,
): readonly string[] {
  let targetStepGroupId: string | undefined;
  const entityIds: string[] = [];

  for (let i = toolOutcomes.length - 1; i >= 0; i--) {
    const outcome = toolOutcomes[i]!;
    if (outcome.tool !== 'search_wines') {
      if (targetStepGroupId !== undefined) {
        break;
      }
      continue;
    }

    const stepGroupId = getToolOutcomeStepGroupId(outcome.stepId);
    if (targetStepGroupId === undefined) {
      targetStepGroupId = stepGroupId;
    }
    if (stepGroupId !== targetStepGroupId) {
      break;
    }

    const result = outcome.result;
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const record = result as Record<string, unknown>;
    if (record['queryType'] !== 'search') {
      continue;
    }
    const results = record['results'];
    if (!Array.isArray(results) || results.length === 0) {
      continue;
    }
    const [topResult] = results as readonly unknown[];
    const entityId = getValueAtPath(topResult, 'entity.entityId');
    if (
      typeof entityId === 'string'
      && entityId.length > 0
      && !completed.has(entityId)
      && !entityIds.includes(entityId)
    ) {
      entityIds.unshift(entityId);
    }
  }

  return entityIds;
}

export function extractPendingDrinkabilityEntityIds(
  contract: AgentQueryExecutionContract,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
): readonly string[] {
  if (!contract.requiresDrinkabilityCheck) {
    return [];
  }
  const completed = getCompletedDrinkabilityEntityIds(steps);
  for (let i = toolOutcomes.length - 1; i >= 0; i--) {
    const outcome = toolOutcomes[i]!;
    const result = outcome.result;
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const record = result as Record<string, unknown>;
    if (outcome.tool === 'search_wines' && record['queryType'] === 'search') {
      return extractPendingSearchDrinkabilityEntityIds(toolOutcomes, completed);
    }
    if (outcome.tool === 'compare_wines' && record['queryType'] === 'comparison') {
      const entities = record['entities'];
      if (!Array.isArray(entities)) {
        return [];
      }
      const pending = entities
        .map((entity) =>
          getValueAtPath(entity, 'topResult.entity.entityId')
          ?? getValueAtPath(entity, 'conceptAggregate.representativeResult.entity.entityId')
          ?? getValueAtPath(entity, 'allResults.0.entity.entityId'),
        )
        .filter((entityId): entityId is string => typeof entityId === 'string' && entityId.length > 0)
        .filter((entityId) => !completed.has(entityId));
      return pending;
    }
  }
  return [];
}
