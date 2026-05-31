import type { QueryIntent } from '../model/query-intent.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import { WINE_TYPE_DETECTION_PATTERNS } from '../model/wine-type-patterns.js';
import { extractAllPairingConstraints } from './pairing-extractor.js';
import type { AnchorExtractor } from './anchor-extractor.js';
import {
  hasEntityMetadataKeyword,
  hasExactEntityLookupKeyword,
  stripExactEntityLookupSuffix,
} from './exact-entity-metadata-signals.js';

/** Minimum anchor confidence to consider an anchor "present" for intent detection. */
export const ANCHOR_PRESENT_CONFIDENCE = 0.5;

/** Anchor confidence above which entity_exact intent is assigned. */
export const EXACT_ANCHOR_CONFIDENCE = 0.85;

/** Explicit budget-boundary keywords only.
 *  Prestige / luxury positioning is modeled separately so "premium wine"
 *  does not collapse into `budget_search`. Korean patterns use bare
 *  alternation (no \b) because \b is ASCII-only. */
const BUDGET_BOUNDARY_KEYWORDS: readonly RegExp[] = [
  /\d+\s*(?:원|만원|dollar|usd|\$|€|£)/iu,
  /(?<!\p{L})(?<!\p{N})(?:under|below|cheaper|budget|affordable)(?!\p{L})(?!\p{N})/iu,
  /(?:저렴|싼|가성비)/u,
  /만원\s*(?:이하|미만|대)/u,
] as const;

/** Prestige / positioning signals. These shape recommendation semantics but
 *  MUST NOT promote a query into `budget_search`.
 *
 *  The English alternation intentionally excludes bare `fine` — too many
 *  benign sentences contain it (`that is fine`, `fine print`, `pay a fine`)
 *  for it to be a reliable prestige cue. The Korean alternation uses Unicode
 *  word-boundary lookarounds (CLAUDE.md rule 8/24) so `최고급차`,
 *  `고급스러운 음악` and other inline substrings do NOT match. */
const PRESTIGE_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:premium|luxury|high[\s-]?end)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:비싼|비싸|고급|럭셔리|프리미엄)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Pairing verbs only.
 *  Food noun detection MUST come from pairing-extractor.ts so intent routing
 *  and retrieval taxonomy share one authority surface. */
const PAIRING_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:pair|pairing|goes?\s+with|match|accompany)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:어울리|곁들|맞는|페어링)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Occasion / gifting cues are recommendation context, not food pairing. */
const OCCASION_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:gift|anniversary|date\s+night|birthday|celebration|party|housewarming|dinner|camping|romantic|healing)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:선물(?:용|할|하려|하고)?|(?:결혼)?기념일|데이트|생일|축하|파티|집들이|소개팅|디너|힐링|캠핑)(?=$|[^\p{L}\p{N}])/u,
] as const;

/** Constraint keywords indicating structured filtering.
 *  Wine type patterns are sourced from the shared WINE_TYPE_DETECTION_PATTERNS
 *  (wine-type-patterns.ts) to avoid duplication. Non-wine-type constraint
 *  keywords (region, grape, body, sweetness) remain here because they have
 *  no other consumer. */
const NON_WINE_TYPE_CONSTRAINT_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:from|region|grape|variety|vintage|year)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:지역|품종|빈티지|연도)(?=$|[^\p{L}\p{N}])/u,
  /(?<!\p{L})(?<!\p{N})(?:dry|sweet|tannic|fruity|oaky|light(?:[\s-]?body|[\s-]?bodied)?|full(?:[\s-]?body|[\s-]?bodied)?)(?!\p{L})(?!\p{N})/iu,
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
  const hasAnyAnchor = anchors.some(
    (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
  );
  const hasExactEntityLookupSignal =
    hasEntityMetadataSignal
    || (hasExactEntityLookupKeyword(normalizedQuery) && hasAnyAnchor);
  const intentQuerySurface = hasExactEntityLookupSignal
    ? stripExactEntityLookupSuffix(normalizedQuery)
    : normalizedQuery;
  const hasStrongAnchor = anchors.some(
    (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
  );
  const hasWeakAnchor = anchors.some(
    (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE &&
      a.confidence < EXACT_ANCHOR_CONFIDENCE,
  );
  const hasComparisonMarker =
    anchorExtractor.hasComparisonMarkers(intentQuerySurface);
  const hasKoreanMixed =
    anchorExtractor.hasKoreanMixedQueryMarkers(intentQuerySurface);
  const hasRelativeAnchorQuery =
    relativeQuery !== null &&
    relativeQuery.relativeExpressions.length > 0 &&
    anchors.length > 0;
  const hasBudgetBoundaryKeyword = BUDGET_BOUNDARY_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  );
  const hasPrestigeKeyword = PRESTIGE_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  );
  const pairingTags = extractAllPairingConstraints(intentQuerySurface);
  const hasFoodPairingSignal = PAIRING_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  ) || pairingTags.length > 0;
  const hasOccasionKeyword = OCCASION_KEYWORDS.some((re) =>
    re.test(intentQuerySurface),
  );
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

  if (hasFoodPairingSignal) {
    return 'pairing_search';
  }

  if (hasOccasionKeyword) {
    return hasStrongAnchor ? 'mixed_query' : 'semantic_discovery';
  }

  if (hasStrongAnchor && hasExactEntityLookupSignal) {
    return strongAnchorEntityCount <= 1 ? 'entity_exact' : 'facet_search';
  }

  if (hasStrongAnchor && (hasConstraintKeyword || hasPrestigeKeyword)) {
    return 'mixed_query';
  }

  if (hasStrongAnchor && !hasConstraintKeyword && !hasBudgetBoundaryKeyword && !hasPrestigeKeyword) {
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

  if (hasWeakAnchor && !hasConstraintKeyword && !hasBudgetBoundaryKeyword && !hasPrestigeKeyword) {
    return 'entity_fuzzy';
  }

  if (hasWeakAnchor && hasExactEntityLookupSignal) {
    return 'entity_fuzzy';
  }

  if (hasWeakAnchor && (hasConstraintKeyword || hasBudgetBoundaryKeyword || hasPrestigeKeyword)) {
    return 'mixed_query';
  }

  if (hasAnyAnchor && (hasConstraintKeyword || hasBudgetBoundaryKeyword || hasPrestigeKeyword)) {
    return 'mixed_query';
  }

  // NOTE: a `hasFoodPairingSignal` branch used to live here, but the early
  // `if (hasFoodPairingSignal) { return 'pairing_search'; }` above already
  // dominates every reachable path — the duplicate was statically dead.

  if (hasBudgetBoundaryKeyword) {
    return 'budget_search';
  }

  if (hasConstraintKeyword) {
    return 'facet_search';
  }

  return 'semantic_discovery';
}
