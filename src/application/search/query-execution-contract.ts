import { detectDecomposition } from '../../domain/query/service/decomposition-detector.js';
import {
  hasEntityMetadataKeyword,
  hasDrinkabilityKeyword,
  stripExactEntityLookupSuffix,
} from '../../domain/query/service/exact-entity-metadata-signals.js';
import { extractAllPairingConstraints, type PairingTag } from '../../domain/query/service/pairing-extractor.js';
import { extractSearchConstraints } from '../../domain/query/service/search-constraint-extractor.js';
import { hasComparisonMarkers } from '../../domain/query/service/anchor-extractor.js';
import { extractVintageYear } from '../../domain/shared/utils/vintage.js';
import { KRW_PER_MAN_WON } from '../../domain/shared/constants.js';
import { QUERY_NORMALIZER } from './query-execution-normalizer.js';
import {
  hasCellaringIntent,
  hasCurrentDrinkabilityIntent,
  hasImmediateDrinkabilityIntent,
} from './query-execution-drinkability-signals.js';
import {
  hasDirectConceptAnchor,
  isExactMetadataEntityLookupCandidate,
  isSpecificSkuLikeQuery,
  queryHasDirectAppellationSpan,
} from './query-execution-entity-signals.js';
import { buildSearchDefaults, type AgentSearchDefaults } from './query-execution-defaults.js';

export type { AgentSearchDefaults };

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
  readonly requiredTool?: 'search_hybrid' | undefined;
  readonly foodPairing?: {
    readonly rawQuery: string;
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

interface AgentSearchSlot {
  readonly wineType: 'red' | 'white' | 'rosé' | 'sparkling' | 'fortified' | 'dessert' | 'orange' | 'natural';
  readonly limit?: number | undefined;
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

function isTemporalReleaseConceptQuery(query: string): boolean {
  const stripped = stripTemporalReleaseSuffix(query);
  if (stripped.length === 0) {
    return false;
  }
  return hasDirectConceptAnchor(stripped);
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
    rawQuery: query.trim(),
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
 *   - current-drinkability atom (when a "drink now" target year is set)
 *   - price atoms (canonical price_usd)
 *
 * @param query original user query
 * @param normalized accentless+normalized form (already computed by caller)
 * @param foodPairing already-built food pairing contract slice (re-used)
 * @param searchDefaults already-built search defaults slice (re-used)
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

  if (searchDefaults?.current_drinkability_target_year !== undefined) {
    coverage.push({
      key: 'drinking_window:current',
      matchedConstraintKey: 'drinking_window',
      description: 'currently drinkable (post-search verification only; not a retrieval filter)',
    });
  }

  if (searchDefaults?.min_price_usd !== undefined || searchConstraints.minPriceKrw !== undefined) {
    coverage.push({
      key: 'price:min',
      matchedConstraintKey: 'price_usd',
      description: 'min price floor',
    });
  }
  if (searchDefaults?.max_price_usd !== undefined || searchConstraints.maxPriceKrw !== undefined) {
    coverage.push({
      key: 'price:max',
      matchedConstraintKey: 'price_usd',
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
          requiredTool: 'search_hybrid' as const,
          foodPairing,
        }
      : {}),
    ...(searchDefaults !== undefined ? { searchDefaults } : {}),
    ...(requiredParallelSearches !== undefined ? { requiredParallelSearches } : {}),
    ...(requiresVerificationStep !== undefined ? { requiresVerificationStep } : {}),
  };
}
