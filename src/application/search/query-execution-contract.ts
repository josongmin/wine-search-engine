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
import { hasComparisonMarkers } from '../../domain/query/service/anchor-extractor.js';
import { extractVintageYear } from '../../domain/shared/utils/vintage.js';

/**
 * Reason taxonomy for "this query MUST execute a second verify/synthesize step
 * before the planner is allowed to commit a final answer". Derived deterministically
 * from existing detectors — see {@link buildVerificationStepRequirement}.
 */
type AgentVerificationReason =
  | 'negation_constraint'
  | 'comparison_search'
  | 'multi_constraint'
  | 'situation_based'
  | 'nested_condition';

/**
 * Constraint coverage atom for the verification guard. Each atom names a hard
 * obligation (e.g. excluded grape, pairing tag, recipient profile) plus the
 * canonical field that downstream GROUNDING_JSON.wines[].matched_constraints
 * would reference if a returned wine satisfies it.
 */
interface AgentConstraintCoverageAtom {
  /** Stable identifier for the obligation; used in directive observations. */
  readonly key: string;
  /** Field name on GROUNDING_JSON.wines[] (matched_constraints entry) that marks coverage. */
  readonly matchedConstraintKey: string;
  /** Human-readable description for planner directive rendering. */
  readonly description: string;
}

interface AgentVerificationRequirement {
  readonly reason: AgentVerificationReason;
  readonly constraintCoverage: readonly AgentConstraintCoverageAtom[];
}

const QUERY_NORMALIZER = new QueryNormalizer();

/**
 * Numeric defaults applied to {@link AgentSearchDefaults} when the query
 * carries an intent cue (gift, beginner, recipient-profile, prestige, …).
 *
 * All thresholds are in normalized [0..1] space (matching domain attribute
 * scoring), or KRW for price/alcohol/year limits. Each constant documents
 * which keyword family triggers it and the downstream filter it tightens —
 * magic numbers in scoring/gating logic are unauditable (CLAUDE.md rule 15).
 */
/** Baseline gift-suitability floor when the query contains "선물 / gift". */
const GIFT_SUITABILITY_MIN_DEFAULT = 0.65;
/** Stronger gift-suitability floor when the query also asks for a safe / crowd-pleasing pick. */
const GIFT_SUITABILITY_MIN_SAFE_PICK = 0.7;
/** Premium gift-suitability floor for senior-colleague / promotion / retirement gifts. */
const GIFT_SUITABILITY_MIN_SENIOR = 0.75;
/** Beginner-suitability floor for healing / approachable / first-time-drinker cues. */
const BEGINNER_SUITABILITY_MIN_DEFAULT = 0.65;
/** Popularity floor for "무난한 / crowd-pleasing / online tasting" cues. */
const POPULARITY_MIN_CROWD_PLEASING = 0.5;
/** Producer-prestige floor for "격식 / 퇴직 / 상사 / luxury" cues. */
const PRODUCER_PRESTIGE_MIN_FORMAL = 0.7;
/** Sweetness floor for the parents-first-time recipient profile (avoid bone-dry). */
const PARENTS_FIRST_TIME_SWEETNESS_MIN = 0.2;
/** Sweetness ceiling for the parents-first-time recipient profile (avoid dessert-sweet). */
const PARENTS_FIRST_TIME_SWEETNESS_MAX = 0.75;
/** Tannin ceiling for the parents-first-time recipient profile (avoid harsh tannin). */
const PARENTS_FIRST_TIME_TANNIN_MAX = 0.3;
/** Acidity ceiling for the parents-first-time recipient profile (avoid sharp acidity). */
const PARENTS_FIRST_TIME_ACIDITY_MAX = 0.75;
/** Max ABV (%) for "저도수 / low-alcohol" cues. */
const LOW_ALCOHOL_MAX_PCT = 12;
/** KRW conversion factor for the Korean "만 원" unit (10,000 KRW). */
const KRW_PER_MAN_WON = 10_000;
/** Max price (KRW) inferred from "5만 원 이하 / under 50k" cues. */
const MAX_PRICE_KRW_UNDER_FIVE_MAN_WON = 50_000;
/** Min price (KRW) baseline for senior-colleague / promotion / retirement gifts. */
const SENIOR_GIFT_MIN_PRICE_KRW = 50_000;
/** Max price (KRW) ceiling for senior-colleague / promotion / retirement gifts. */
const SENIOR_GIFT_MAX_PRICE_KRW = 150_000;

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
  readonly resultLimit?: number | undefined;
  /**
   * P0: when present, the agent loop MUST execute a second verify/synthesize
   * step before committing a final answer. Populated deterministically from
   * existing query detectors — see {@link buildVerificationStepRequirement}.
   */
  readonly requiresVerificationStep?: AgentVerificationRequirement | undefined;
}

interface AgentSearchDefaults {
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

interface AgentSearchSlot {
  readonly wineType: 'red' | 'white' | 'rosé' | 'sparkling' | 'fortified' | 'dessert' | 'orange' | 'natural';
  readonly limit?: number | undefined;
}

function hasCellaringIntent(normalized: string): boolean {
  return /(?:셀러|cellar(?:ing)?|지금\s*마시면\s*아까운|숙성(?:용|할|해둘|해서|가능|잠재력)?|ageworthy|aging\s+potential|long[\s-]?term\s+aging|hold\s+for|hold(?=$|[^\p{L}\p{N}])|성인\s*될\s*때)/iu.test(normalized);
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
  return hasCurrentDrinkabilityIntent(normalized) || hasImmediateDrinkabilityIntent(normalized);
}

function queryHasTemporalReleaseSignal(normalized: string): boolean {
  const hasTemporalCue = /(?:^|[^\p{L}\p{N}])(?:올해|올해꺼|이번\s*해|current\s+year|latest|most\s+recent)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
  const hasReleaseCue = /(?:^|[^\p{L}\p{N}])(?:출시|출시\s*여부|나왔어|나왔나|나왔냐|나왔는지|release(?:d)?|availability|available)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
  const hasSeasonalReleaseConcept = /(?:^|[^\p{L}\p{N}])(?:beaujolais\s+nouveau|보졸레\s*누보)(?=$|[^\p{L}\p{N}])/iu.test(normalized);
  return hasReleaseCue && (hasTemporalCue || hasSeasonalReleaseConcept);
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
  /(?:\s*(?:올해(?:꺼)?|이번\s*해|current\s+year|latest|most\s+recent)\s*(?:나왔(?:어|나|냐|는지)?|출시(?:됐|했)?(?:어|나|냐|는지)?|출시\s*여부|release(?:d)?|availability|available))[?？!！]*$/iu,
  /(?:\s*(?:나왔(?:어|나|냐|는지)?|출시(?:됐|했)?(?:어|나|냐|는지)?|출시\s*여부|release(?:d)?|availability|available))[?？!！]*$/iu,
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
  if (queryHasDirectAppellationSpan(query)) {
    return true;
  }
  const hasDecantingGuidanceKeyword = /(?:디캔팅|디켄팅|decant(?:ing)?)/iu.test(normalized);
  const hasGenericWineTarget = /(?:와인|wine)/iu.test(normalized);
  return hasDecantingGuidanceKeyword && hasGenericWineTarget;
}

function hasMixedColorPairingShape(normalized: string): boolean {
  return /(?:레드\s*[/,+&와과및]*\s*화이트|화이트\s*[/,+&와과및]*\s*레드|red\s*(?:\/|and|&|\+|,)\s*white|white\s*(?:\/|and|&|\+|,)\s*red|반반|both\s+colors?)/iu.test(normalized);
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
    giftSuitabilityMin = GIFT_SUITABILITY_MIN_DEFAULT;
  }
  if (/(?:힐링|위로|편안|휴식|relax(?:ing|ation)?|comfort(?:ing)?|healing)/iu.test(normalized)) {
    addUnique(occasion, 'healing');
    addUnique(styles, 'approachable');
    beginnerSuitabilityMin = Math.max(beginnerSuitabilityMin ?? 0, BEGINNER_SUITABILITY_MIN_DEFAULT);
  }
  if (/(?:괜찮은?|무난한?|실패\s*없는|대중적인?|decent|crowd[-\s]?pleasing|safe\s+pick)/iu.test(normalized)) {
    addUnique(styles, 'crowd_pleasing');
    popularityMin = Math.max(popularityMin ?? 0, POPULARITY_MIN_CROWD_PLEASING);
  }
  if (/(?:온라인\s*와인\s*시음회|온라인\s*시음회|online\s+tasting|virtual\s+tasting|참가자\s*모두|모두가\s*살\s*수|widely\s+available|accessible\s+to\s+all)/iu.test(normalized)) {
    addUnique(styles, 'approachable');
    addUnique(styles, 'crowd_pleasing');
    beginnerSuitabilityMin = Math.max(beginnerSuitabilityMin ?? 0, BEGINNER_SUITABILITY_MIN_DEFAULT);
    popularityMin = Math.max(popularityMin ?? 0, POPULARITY_MIN_CROWD_PLEASING);
  }
  if (
    maxPriceKrw === undefined &&
    /(?:5\s*만\s*원\s*이하|5만원\s*이하|under\s*(?:₩|krw)?\s*50[, ]?000|under\s*50k)/iu.test(normalized)
  ) {
    maxPriceKrw = MAX_PRICE_KRW_UNDER_FIVE_MAN_WON;
  }
  if (hasBeginnerOrFirstTimeCue) {
    addUnique(styles, 'approachable');
    beginnerSuitabilityMin = BEGINNER_SUITABILITY_MIN_DEFAULT;
  }
  if (hasOlderFamilyCue) {
    addUnique(styles, 'crowd_pleasing');
  }
  if (hasOlderFamilyCue && hasBeginnerOrFirstTimeCue) {
    recipientProfile = 'parents_first_time';
    sweetnessMin = PARENTS_FIRST_TIME_SWEETNESS_MIN;
    sweetnessMax = PARENTS_FIRST_TIME_SWEETNESS_MAX;
    tanninMax = PARENTS_FIRST_TIME_TANNIN_MAX;
    acidityMax = PARENTS_FIRST_TIME_ACIDITY_MAX;
  }
  if (/(?:상대방이\s*뭘\s*좋아하(?:는지|실지)\s*몰라|취향(?:을)?\s*몰라|don['’]t\s+know\s+(?:what\s+)?(?:they|the\s+recipient)\s+like|unknown\s+preferences?)/iu.test(normalized)) {
    addUnique(styles, 'crowd_pleasing');
    recipientProfile = 'unknown_preference_recipient';
  }
  if (/(?:실패\s*없는|무난한?|대중적인?|crowd[-\s]?pleasing|safe\s+gift)/iu.test(normalized)) {
    addUnique(styles, 'crowd_pleasing');
    giftSuitabilityMin = Math.max(giftSuitabilityMin ?? 0, GIFT_SUITABILITY_MIN_SAFE_PICK);
  }
  if (/(?:달달|달콤|스위트|sweet)/iu.test(normalized)) {
    addUnique(styles, 'sweet');
  }
  if (/(?:도수\s*낮|저도수|low[-\s]?alcohol)/iu.test(normalized)) {
    maxAlcoholPct = LOW_ALCOHOL_MAX_PCT;
  }
  if (/(?:격식|품격|퇴직|상사|고급스러운|prestige|formal|luxury)/iu.test(normalized)) {
    producerPrestigeMin = PRODUCER_PRESTIGE_MIN_FORMAL;
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
    minPriceKrw = SENIOR_GIFT_MIN_PRICE_KRW;
    maxPriceKrw = SENIOR_GIFT_MAX_PRICE_KRW;
    giftSuitabilityMin = Math.max(giftSuitabilityMin ?? 0, GIFT_SUITABILITY_MIN_SENIOR);
    producerPrestigeMin = Math.max(producerPrestigeMin ?? 0, PRODUCER_PRESTIGE_MIN_FORMAL);
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
        return Math.round(parsed * KRW_PER_MAN_WON);
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

    const english = /(?:^|[^\p{L}\p{N}])(?:total|budget)\s*(?:₩|krw)?\s*(\d[\d,]*)\s*(?:원|krw)?(?=$|[^\p{L}\p{N}])/iu.exec(candidate);
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

/**
 * P0: deterministic verification-step requirement builder.
 *
 * Walks the query against existing detectors and decides whether the agent loop
 * must execute a second verify/synthesize step before answering. Pure function:
 * no LLM calls, no heuristics — every signal comes from a named detector that
 * already participates in the contract.
 *
 * Reasons priority order (first match wins):
 *   1. negation_constraint  — at least one `exclude*` constraint present
 *   2. comparison_search    — comparison markers detected in the query
 *   3. nested_condition     — decomposition detector flags AND/OR composition
 *   4. multi_constraint     — ≥3 hard signals across pairing/defaults/exclusions
 *   5. situation_based      — situation occasion + recipient profile present
 *
 * Constraint coverage atoms are the union of:
 *   - exclude_* atoms (one per excluded grape/region/style/wine_type/country)
 *   - pairing tag atoms (food_pairing.pairingTags)
 *   - recipient_profile atom (when present)
 *   - drinking_window atom (when set to "now")
 *   - price atoms (min/max KRW)
 *
 * @param query original user query
 * @param normalized accentless+normalized form (already computed by caller)
 * @param foodPairing already-built food pairing contract slice (re-used)
 * @param searchDefaults already-built search defaults slice (re-used)
 * @param searchConstraints already-extracted SearchConstraints (re-used)
 */
function buildVerificationStepRequirement(
  query: string,
  normalized: string,
  foodPairing: AgentQueryExecutionContract['foodPairing'],
  searchDefaults: AgentSearchDefaults | undefined,
): AgentVerificationRequirement | undefined {
  const searchConstraints = extractSearchConstraints(query);
  const coverage: AgentConstraintCoverageAtom[] = [];

  const addExclusionAtoms = (
    values: readonly string[] | undefined,
    matchedConstraintKey: string,
    keyPrefix: string,
  ): void => {
    if (values === undefined) {
      return;
    }
    for (const value of values) {
      coverage.push({
        key: `${keyPrefix}:${value.toLowerCase()}`,
        matchedConstraintKey,
        description: `${keyPrefix} excludes "${value}"`,
      });
    }
  };

  addExclusionAtoms(searchConstraints.excludeGrapes, 'exclude_grapes', 'exclude_grape');
  addExclusionAtoms(searchConstraints.excludeRegions, 'exclude_regions', 'exclude_region');
  addExclusionAtoms(searchConstraints.excludeStyles, 'exclude_styles', 'exclude_style');
  addExclusionAtoms(searchConstraints.excludeWineTypes, 'exclude_wine_types', 'exclude_wine_type');
  addExclusionAtoms(searchConstraints.excludeCountries, 'exclude_countries', 'exclude_country');

  const negationConstraintCount = coverage.length;

  if (foodPairing !== undefined) {
    for (const tag of foodPairing.pairingTags) {
      coverage.push({
        key: `pairing_tag:${tag}`,
        matchedConstraintKey: 'pairing_tags',
        description: `pairing tag "${tag}"`,
      });
    }
  }

  if (searchDefaults?.recipient_profile !== undefined) {
    coverage.push({
      key: `recipient_profile:${searchDefaults.recipient_profile}`,
      matchedConstraintKey: 'recipient_profile',
      description: `recipient profile "${searchDefaults.recipient_profile}"`,
    });
  }

  if (searchDefaults?.drinking_window === 'now') {
    coverage.push({
      key: 'drinking_window:now',
      matchedConstraintKey: 'drinking_window',
      description: 'currently drinkable',
    });
  }

  if (searchDefaults?.min_price_krw !== undefined || searchConstraints.minPriceKrw !== undefined) {
    coverage.push({
      key: 'price:min',
      matchedConstraintKey: 'min_price_krw',
      description: 'min price floor',
    });
  }
  if (searchDefaults?.max_price_krw !== undefined || searchConstraints.maxPriceKrw !== undefined) {
    coverage.push({
      key: 'price:max',
      matchedConstraintKey: 'max_price_krw',
      description: 'max price ceiling',
    });
  }

  if (searchDefaults?.sweetness_max !== undefined || searchDefaults?.sweetness_min !== undefined) {
    coverage.push({
      key: 'sweetness',
      matchedConstraintKey: 'sweetness',
      description: 'sweetness bound',
    });
  }
  if (searchDefaults?.acidity_max !== undefined || searchDefaults?.acidity_min !== undefined) {
    coverage.push({
      key: 'acidity',
      matchedConstraintKey: 'acidity',
      description: 'acidity bound',
    });
  }
  if (searchDefaults?.tannin_max !== undefined) {
    coverage.push({
      key: 'tannin_max',
      matchedConstraintKey: 'tannin',
      description: 'tannin ceiling',
    });
  }

  const hasComparison = hasComparisonMarkers(normalized);
  const decomposition = detectDecomposition(query);
  const occasionCount = searchDefaults?.occasion?.length ?? 0;
  const hasRecipient = searchDefaults?.recipient_profile !== undefined;
  const hasSituationContext =
    (occasionCount > 0 && hasRecipient)
    || (occasionCount > 0 && (searchDefaults?.producer_prestige_min !== undefined
      || searchDefaults?.gift_suitability_min !== undefined));

  let reason: AgentVerificationReason | undefined;
  if (negationConstraintCount > 0) {
    reason = 'negation_constraint';
  } else if (hasComparison) {
    reason = 'comparison_search';
  } else if (decomposition.decomposed) {
    reason = 'nested_condition';
  } else if (coverage.length >= 3) {
    reason = 'multi_constraint';
  } else if (hasSituationContext) {
    reason = 'situation_based';
  }

  if (reason === undefined) {
    return undefined;
  }

  return {
    reason,
    constraintCoverage: coverage,
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
  const requiresGroundedWineSearch =
    queryRequiresGroundedWineSearch(query, normalized)
    || hasTemporalReleaseSignal
    || hasExactEntityLookupSignal;
  const requiresVerificationStep = buildVerificationStepRequirement(
    query,
    normalized,
    foodPairing,
    searchDefaults,
  );
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
    ...(requiresGroundedWineSearch ? { requiresGroundedWineSearch: true } : {}),
    ...(totalBudgetKrw !== undefined ? { totalBudgetKrw } : {}),
    ...(foodPairing !== undefined
      ? {
          requiredTool: 'get_food_pairings' as const,
          foodPairing,
        }
      : {}),
    ...(searchDefaults !== undefined ? { searchDefaults } : {}),
    ...(requiredParallelSearches !== undefined ? { requiredParallelSearches } : {}),
    ...(requiresVerificationStep !== undefined ? { requiresVerificationStep } : {}),
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




