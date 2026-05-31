import { extractSearchConstraints } from '../../domain/query/service/search-constraint-extractor.js';
import { convertKrwToConstraintUsd } from '../../domain/shared/utils/canonical-price.js';
import {
  hasCellaringIntent,
  hasCurrentDrinkabilityIntent,
  hasImmediateDrinkabilityIntent,
} from './query-execution-drinkability-signals.js';
import { detectExplicitGrapePrimary, detectExplicitRegion } from './query-execution-entity-signals.js';

/**
 * Search-defaults builder: maps intent/recipient/occasion cues in a query to the
 * {@link AgentSearchDefaults} numeric/categorical defaults applied to the agent
 * search slot. Extracted from the query-execution contract so the scenario
 * classification (gift / beginner / parents-first-time / senior-colleague / …)
 * lives in one cohesive module.
 *
 * Numeric defaults applied to {@link AgentSearchDefaults} when the query
 * carries an intent cue (gift, beginner, recipient-profile, prestige, …).
 *
 * All thresholds are in normalized [0..1] space (matching domain attribute
 * scoring), canonical USD for price, or natural alcohol/year units. Each constant documents
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
/** Max price (KRW) inferred from "5만 원 이하 / under 50k" cues. */
const MAX_PRICE_KRW_UNDER_FIVE_MAN_WON = 50_000;
/** Min price (KRW) baseline for senior-colleague / promotion / retirement gifts. */
const SENIOR_GIFT_MIN_PRICE_KRW = 50_000;
/** Max price (KRW) ceiling for senior-colleague / promotion / retirement gifts. */
const SENIOR_GIFT_MAX_PRICE_KRW = 150_000;

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
  readonly current_drinkability_target_year?: number | undefined;
  readonly min_price_usd?: number | undefined;
  readonly max_price_usd?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly gift_suitability_min?: number | undefined;
  readonly beginner_suitability_min?: number | undefined;
  readonly producer_prestige_min?: number | undefined;
  readonly popularity_min?: number | undefined;
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

export function buildSearchDefaults(query: string, normalized: string): AgentSearchDefaults | undefined {
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
  let currentDrinkabilityTargetYear: number | undefined;
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
    currentDrinkabilityTargetYear = new Date().getFullYear();
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

  const minPriceUsd = minPriceKrw !== undefined
    ? convertKrwToConstraintUsd(minPriceKrw)
    : undefined;
  const maxPriceUsd = maxPriceKrw !== undefined
    ? convertKrwToConstraintUsd(maxPriceKrw)
    : undefined;

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
    ...(currentDrinkabilityTargetYear !== undefined
      ? { current_drinkability_target_year: currentDrinkabilityTargetYear }
      : {}),
    ...(minPriceUsd !== undefined ? { min_price_usd: minPriceUsd } : {}),
    ...(maxPriceUsd !== undefined ? { max_price_usd: maxPriceUsd } : {}),
    ...(maxAlcoholPct !== undefined ? { max_alcohol_pct: maxAlcoholPct } : {}),
    ...(giftSuitabilityMin !== undefined ? { gift_suitability_min: giftSuitabilityMin } : {}),
    ...(beginnerSuitabilityMin !== undefined ? { beginner_suitability_min: beginnerSuitabilityMin } : {}),
    ...(producerPrestigeMin !== undefined ? { producer_prestige_min: producerPrestigeMin } : {}),
    ...(popularityMin !== undefined ? { popularity_min: popularityMin } : {}),
  };
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}
