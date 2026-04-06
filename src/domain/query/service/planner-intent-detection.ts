import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorExtractor } from './anchor-extractor.js';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
export const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
export const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Price-related keywords for budget search detection. */
const PRICE_KEYWORDS: readonly RegExp[] = [
  /\d+\s*(?:원|만원|dollar|usd|\$|€|£)/i,
  /\b(?:under|below|cheaper|budget|affordable)\b|(?:저렴|싼|가성비)/i,
  /만원\s*(?:이하|미만|대)/,
] as const;

/** Pairing-related keywords. */
const PAIRING_KEYWORDS: readonly RegExp[] = [
  /\b(?:pair|pairing|goes?\s+with|match|accompany)\b/i,
  /\b(?:어울리|곁들|맞는|페어링)\b/,
  /\b(?:steak|fish|cheese|chicken|pasta|pizza|beef|pork|seafood)\b/i,
  /\b(?:스테이크|생선|치즈|치킨|파스타|피자|소고기|돼지고기|해산물)\b/,
] as const;

/** Constraint keywords indicating structured filtering. */
const CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  /\b(?:red|white|rose|sparkling|natural)\b/i,
  /\b(?:레드|화이트|로제|스파클링|내추럴)\b/,
  /\b(?:from|region|grape|variety|vintage|year)\b/i,
  /\b(?:지역|품종|빈티지|연도)\b/,
  /\b(?:dry|sweet|tannic|fruity|oaky|light|full[\s-]?body)\b/i,
  /\b(?:드라이|스위트|타닌|과일|오크|라이트|풀바디)\b/,
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
