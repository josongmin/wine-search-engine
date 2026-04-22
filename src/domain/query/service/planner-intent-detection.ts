import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import { WINE_TYPE_DETECTION_PATTERNS } from '../model/wine-type-patterns.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import { isDirectEntityResolution, resolveEntity } from '../../attribute/service/entity-resolver.js';
import type { AnchorExtractor } from './anchor-extractor.js';
import {
  hasEntityMetadataKeyword,
  stripExactEntityMetadataSuffix,
} from './exact-entity-metadata-signals.js';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
export const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
export const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Price-related keywords for budget search detection.
 *  Korean patterns use bare alternation (no \b) because \b is a word-boundary
 *  for ASCII only — Korean jamo/syllables are not delimited by \b. */
const PRICE_KEYWORDS: readonly RegExp[] = [
  /\d+\s*(?:원|만원|dollar|usd|\$|€|£)/iu,
  /(?<!\p{L})(?<!\p{N})(?:under|below|cheaper|budget|affordable)(?!\p{L})(?!\p{N})/iu,
  /(?:저렴|싼|가성비|비싼|비싸|고급|럭셔리|프리미엄)/u,
  /만원\s*(?:이하|미만|대)/u,
] as const;

/** Pairing-related keywords — lightweight intent signals only.
 *  For detailed food tag extraction, see pairing-extractor.ts (PAIRING_PATTERNS).
 *  This list covers pairing verbs + the most common food nouns to detect
 *  "pairing_search" intent quickly, while pairing-extractor maps to specific
 *  taxonomy tags (beef, shellfish, etc.) for Vespa filtering. */
const PAIRING_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:pair|pairing|goes?\s+with|match|accompany)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:어울리|곁들|맞는|페어링)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L})(?<!\p{N})(?:steak|fish|cheese|chicken|pasta|pizza|beef|pork|seafood)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:스테이크|생선|치즈|치킨|파스타|피자|소고기|돼지고기|해산물)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L})(?<!\p{N})(?:gift|anniversary|date\s+night|birthday|celebration|party|housewarming|dinner|camping)(?!\p{L})(?!\p{N})/iu,
  /(?:선물(?:용|할|하려|하고)?|(?:결혼)?기념일|데이트|생일|축하|파티|집들이|디너|캠핑)/u,
] as const;

const OCCASION_SUBSTRINGS: readonly string[] = [
  '선물',
  '기념일',
  '생일',
  '축하',
  '파티',
  '집들이',
  '소개팅',
  '데이트',
  '디너',
  '힐링',
  '캠핑',
] as const;

/** Constraint keywords indicating structured filtering.
 *  Wine type patterns are sourced from the shared WINE_TYPE_DETECTION_PATTERNS
 *  (wine-type-patterns.ts) to avoid duplication. Non-wine-type constraint
 *  keywords (region, grape, body, sweetness) remain here because they have
 *  no other consumer. */
const NON_WINE_TYPE_CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:from|region|grape|variety|vintage|year)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:지역|품종|빈티지|연도)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L})(?<!\p{N})(?:dry|sweet|tannic|fruity|oaky|light|full[\s-]?body)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:드라이|스위트|타닌|과일|오크|라이트|풀바디)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Combined constraint keyword patterns: wine type (shared) + non-wine-type (local). */
const CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  ...WINE_TYPE_DETECTION_PATTERNS,
  ...NON_WINE_TYPE_CONSTRAINT_KEYWORDS,
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
  relativeQuery: AnchorConditionedQuery | null = null,
): QueryIntent {
  const hasEntityMetadataSignal = hasEntityMetadataKeyword(normalizedQuery);
  const intentQuerySurface = hasEntityMetadataSignal
    ? stripExactEntityMetadataSuffix(normalizedQuery)
    : normalizedQuery;
  const hasDirectAttributeEntity = parseSpans(intentQuerySurface).some((span) => {
    const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
    return isDirectEntityResolution(resolved) && resolved.entityType !== 'wine_type';
  });
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
    anchorExtractor.hasComparisonMarkers(intentQuerySurface);
  const hasKoreanMixed =
    anchorExtractor.hasKoreanMixedQueryMarkers(intentQuerySurface);
  const hasRelativeAnchorQuery =
    relativeQuery !== null &&
    relativeQuery.relativeExpressions.length > 0 &&
    anchors.length > 0;
  const hasPriceKeyword = PRICE_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  );
  const hasPairingKeyword = PAIRING_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  ) || OCCASION_SUBSTRINGS.some((token) => intentQuerySurface.includes(token));
  const hasConstraintKeyword = CONSTRAINT_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  );
  const strongAnchorEntityCount = new Set(
    anchors
      .filter((a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE)
      .flatMap((a) => a.candidateEntityIds),
  ).size;

  if (hasComparisonMarker && hasAnyAnchor) {
    return 'comparison_search';
  }
  if (anchors.length >= 2 && hasComparisonMarker) {
    return 'comparison_search';
  }

  if (hasKoreanMixed && hasAnyAnchor) {
    return 'mixed_query';
  }

  if (hasRelativeAnchorQuery) {
    return 'mixed_query';
  }

  if (hasStrongAnchor && hasPairingKeyword) {
    return 'mixed_query';
  }

  if (hasPairingKeyword && !hasStrongAnchor) {
    return 'pairing_search';
  }

  if (hasStrongAnchor && hasEntityMetadataSignal) {
    return hasDirectAttributeEntity || strongAnchorEntityCount <= 1 ? 'entity_exact' : 'facet_search';
  }

  if (hasStrongAnchor && hasConstraintKeyword) {
    return 'mixed_query';
  }

  if (hasStrongAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
    if (hasDirectAttributeEntity) {
      return 'entity_exact';
    }
    // A single strong anchor pointing to exactly ONE entity → genuine
    // entity lookup. But if anchors span MULTIPLE distinct entities (e.g.
    // "Barolo" matching 2+ wines from different producers), the query is a
    // category/region/grape term, not a specific wine — route via hybrid
    // search instead of the entity route which applies hard constraints
    // and drops everything.
    const uniqueAnchorEntities = new Set(
      anchors
        .filter((a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE)
        .flatMap((a) => a.candidateEntityIds),
    );
    if (uniqueAnchorEntities.size > 1) {
      return 'facet_search';
    }
    return 'entity_exact';
  }

  if (hasWeakAnchor && !hasConstraintKeyword && !hasPriceKeyword) {
    return 'entity_fuzzy';
  }

  if (hasWeakAnchor && hasEntityMetadataSignal) {
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
