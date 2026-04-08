import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorExtractor } from './anchor-extractor.js';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
export const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
export const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Price-related keywords for budget search detection.
 *  Korean patterns use bare alternation (no \b) because \b is a word-boundary
 *  for ASCII only — Korean jamo/syllables are not delimited by \b. */
const PRICE_KEYWORDS: readonly RegExp[] = [
  /\d+\s*(?:원|만원|dollar|usd|\$|€|£)/iu,
  /(?<!\p{L}\p{N})(?:under|below|cheaper|budget|affordable)(?!\p{L}\p{N})/iu,
  /(?:저렴|싼|가성비|비싼|비싸|고급|럭셔리|프리미엄)/u,
  /만원\s*(?:이하|미만|대)/u,
] as const;

/** Pairing-related keywords. */
const PAIRING_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L}\p{N})(?:pair|pairing|goes?\s+with|match|accompany)(?!\p{L}\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:어울리|곁들|맞는|페어링)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L}\p{N})(?:steak|fish|cheese|chicken|pasta|pizza|beef|pork|seafood)(?!\p{L}\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:스테이크|생선|치즈|치킨|파스타|피자|소고기|돼지고기|해산물)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Constraint keywords indicating structured filtering. */
const CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L}\p{N})(?:red|white|rose|sparkling|natural)(?!\p{L}\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:레드|화이트|로제|스파클링|내추럴)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L}\p{N})(?:from|region|grape|variety|vintage|year)(?!\p{L}\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:지역|품종|빈티지|연도)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L}\p{N})(?:dry|sweet|tannic|fruity|oaky|light|full[\s-]?body)(?!\p{L}\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:드라이|스위트|타닌|과일|오크|라이트|풀바디)(?=$|[^\p{L}\p{N}])/u,
] as const;

export type IntentDetectionAnchorExtractor = Pick<
  AnchorExtractor,
  'hasComparisonMarkers' | 'hasKoreanMixedQueryMarkers'
>;

/**
 * Detects the primary intent based on anchors, patterns, and keywords.
 *
 * Multi-stage detection with confidence-aware fallback — see Planner class docs.
 */
export function detectQueryIntent(
  normalizedQuery: string,
  anchors: readonly AnchorCandidate[],
  anchorExtractor: IntentDetectionAnchorExtractor,
): QueryIntent {
  const hasStrongAnchor = anchors.some(
    (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
  );
  const hasWeakAnchor = anchors.some(
    (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE &&
      a.confidence < EXACT_ANCHOR_CONFIDENCE,
  );
  const hasAnyAnchor = anchors.some(
    (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
  );
  const hasComparisonMarker =
    anchorExtractor.hasComparisonMarkers(normalizedQuery);
  const hasKoreanMixed =
    anchorExtractor.hasKoreanMixedQueryMarkers(normalizedQuery);
  const hasPriceKeyword = PRICE_KEYWORDS.some((re) =>
    re.test(normalizedQuery),
  );
  const hasPairingKeyword = PAIRING_KEYWORDS.some((re) =>
    re.test(normalizedQuery),
  );
  const hasConstraintKeyword = CONSTRAINT_KEYWORDS.some((re) =>
    re.test(normalizedQuery),
  );

  if (hasComparisonMarker && hasAnyAnchor) {
    return 'comparison_search';
  }
  if (anchors.length >= 2 && hasComparisonMarker) {
    return 'comparison_search';
  }

  if (hasKoreanMixed && hasAnyAnchor) {
    return 'mixed_query';
  }

  if (hasStrongAnchor && hasConstraintKeyword) {
    return 'mixed_query';
  }

  if (hasStrongAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
    return 'entity_exact';
  }

  if (hasWeakAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
    return 'entity_fuzzy';
  }

  if (hasWeakAnchor && (hasConstraintKeyword || hasPriceKeyword)) {
    return 'mixed_query';
  }

  if (hasAnyAnchor && (hasConstraintKeyword || hasPriceKeyword)) {
    return 'mixed_query';
  }

  if (hasPairingKeyword) {
    return 'pairing_search';
  }

  if (hasPriceKeyword) {
    return 'budget_search';
  }

  if (hasConstraintKeyword) {
    return 'facet_search';
  }

  return 'semantic_discovery';
}
