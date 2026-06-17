/**
 * Stateless planner decision logic extracted from {@link Planner}.
 *
 * Every function in this module is **pure**: it depends only on its arguments
 * (no `this`, no instance collaborators such as the query normalizer, anchor
 * extractor, or constraint compiler). The logic is moved byte-identically from
 * `planner.ts`; `Planner` re-invokes these functions so existing behavior and
 * the public class contract stay unchanged.
 */
import type {
  QueryClass,
  ConstraintBundle,
  ConstraintAtom,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import { hasExactEntityLookupKeyword } from './exact-entity-metadata-signals.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { AnchorConditionedQuery } from '../model/relative-query.js';
import type { AmbiguousEntityHint } from '../../attribute/model/ambiguous-entity-hint.js';
import type { AmbiguityIntentInterpretation } from '../model/ambiguity-intent-interpretation.js';
import type { AliasMatchResult } from './anchor-extractor.js';
import { extractAllPairingConstraints } from './pairing-extractor.js';
import { isShortEntityLikeSurface } from './short-entity-surface.js';
import { isExactLikeLookupStrategy } from './lookup-strategy-taxonomy.js';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import {
  FUZZY_ANCHOR_CONFIDENCE_FLOOR,
  FUZZY_ANCHOR_EDIT_DISTANCE_PENALTY,
  EXPLICIT_NO_MATCH_PATTERNS,
  PAIRING_SOFT_CONSTRAINT_CONFIDENCE,
  PAIRING_SOFT_CONSTRAINT_MAPPING_VERSION,
} from './planner-constants.js';
import {
  hasOntologyOnlySoftConstraintEvidence,
  hasSensoryPreferenceConstraint,
  hasOnlySemanticDiscoveryCompatibleHardConstraints,
} from './planner-helpers.js';

export function anchorUsesExactLikeLookup(anchor: AnchorCandidate): boolean {
  return (anchor.lookupStrategies ?? [])
    .some((strategy) => isExactLikeLookupStrategy(strategy));
}

export function promoteQueryClassFromConstraintEvidence(
  classifiedQueryClass: QueryClass,
  ambiguousEntityHints: readonly AmbiguousEntityHint[],
  interpretation?: AmbiguityIntentInterpretation,
): QueryClass {
  const queryClassOverride = interpretation?.branchSelections
    .map((selection) => selection.resolvedQueryClass)
    .find((queryClass): queryClass is QueryClass => queryClass !== undefined);
  if (queryClassOverride !== undefined) {
    return queryClassOverride;
  }

  if (classifiedQueryClass === 'ambiguous_short_form') {
    return classifiedQueryClass;
  }

  return ambiguousEntityHints.some((hint) => hint.explorationBranches.length > 1)
    ? 'ambiguous_short_form'
    : classifiedQueryClass;
}

/**
 * Adds soft `pairing` constraints from the pairing taxonomy when the query
 * mentions foods or occasions (e.g. salmon → pairing tag for retrieval).
 */
export function mergePairingIntoBundle(
  bundle: ConstraintBundle,
  normalizedQuery: string,
): ConstraintBundle {
  const tags = extractAllPairingConstraints(normalizedQuery);
  if (tags.length === 0) {
    return bundle;
  }
  const extraSoft: NormalizedConstraint[] = [{
    attribute: 'pairing',
    operator: 'in',
    value: [...tags],
    source_phrase: normalizedQuery,
    confidence: PAIRING_SOFT_CONSTRAINT_CONFIDENCE,
    mapping_version: PAIRING_SOFT_CONSTRAINT_MAPPING_VERSION,
  }];
  return {
    hard: bundle.hard,
    soft: [...bundle.soft, ...extraSoft],
    inferred: bundle.inferred,
  };
}

export function promoteIntentFromParsedConstraints(
  intent: QueryIntent,
  constraints: ConstraintBundle,
  anchors: readonly AnchorCandidate[],
): QueryIntent {
  const hasMeaningfulAnchor = anchors.some(
    (anchor) => anchor.confidence >= ANCHOR_PRESENT_CONFIDENCE,
  );
  if (hasMeaningfulAnchor) {
    return intent;
  }
  if (
    intent !== 'facet_search'
    && intent !== 'budget_search'
    && intent !== 'semantic_discovery'
  ) {
    return intent;
  }
  if (!hasSensoryPreferenceConstraint(constraints)) {
    return intent;
  }
  if (!hasOnlySemanticDiscoveryCompatibleHardConstraints(constraints)) {
    return intent;
  }
  return 'semantic_discovery';
}

export function shouldApplyFuzzyAnchorFallback(
  normalizedQuery: string,
  initialClassifiedQueryClass: QueryClass,
  parsedIntent: QueryIntent,
  constraints: ConstraintBundle,
  relativeQuery: AnchorConditionedQuery | null,
): boolean {
  if (relativeQuery !== null && relativeQuery.relativeExpressions.length > 0) {
    return true;
  }

  if (
    parsedIntent === 'entity_exact'
    || parsedIntent === 'entity_fuzzy'
    || parsedIntent === 'comparison_search'
    || parsedIntent === 'mixed_query'
  ) {
    return true;
  }

  if (constraints.hard.length > 0 || constraints.inferred.length > 0) {
    return false;
  }

  if (
    constraints.soft.length > 0
    && !(
      isShortEntityLikeSurface(normalizedQuery)
      && hasOntologyOnlySoftConstraintEvidence(constraints)
    )
  ) {
    return false;
  }

  if (
    initialClassifiedQueryClass === 'short_entity'
    || initialClassifiedQueryClass === 'ambiguous_short_form'
  ) {
    return true;
  }

  return isShortEntityLikeSurface(normalizedQuery);
}

/**
 * Two-token identity-shaped surfaces (`Barolo Giacomo`) are partial producer-label
 * lookups, not category discovery (`Barolo` alone). Keep entity posture even
 * before fuzzy anchor recovery runs.
 */
export function shouldTreatSemanticDiscoveryAsShortEntitySurface(
  normalizedQuery: string,
  intent: QueryIntent,
  anchors: readonly AnchorCandidate[],
): boolean {
  if (intent !== 'semantic_discovery' || anchors.length > 0) {
    return false;
  }
  if (hasExactEntityLookupKeyword(normalizedQuery)) {
    return false;
  }
  if (!isShortEntityLikeSurface(normalizedQuery)) {
    return false;
  }
  const tokenCount = normalizedQuery
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .length;
  return tokenCount >= 2;
}

export function computeFuzzyFallbackConfidence(
  aliasMatch: AliasMatchResult,
  editDistance: number,
  combinedScore: number,
): number {
  const editPenaltyFactor = Math.max(
    FUZZY_ANCHOR_CONFIDENCE_FLOOR,
    1 - (editDistance * FUZZY_ANCHOR_EDIT_DISTANCE_PENALTY),
  );
  const baseConfidence = Math.min(aliasMatch.matchConfidence, combinedScore);
  return Math.max(
    FUZZY_ANCHOR_CONFIDENCE_FLOOR,
    Math.min(1, baseConfidence * editPenaltyFactor),
  );
}

export function deriveExplicitNoMatchOverride(
  normalizedQuery: string,
  constraints: ConstraintBundle,
  anchors: readonly AnchorCandidate[],
): {
  readonly route: QueryRoute;
  readonly retrievalMode: RetrievalMode;
  readonly queryClass: QueryClass;
} | undefined {
  if (anchors.length > 0) {
    return undefined;
  }
  if (
    constraints.hard.length > 0
    || constraints.soft.length > 0
    || constraints.inferred.length > 0
  ) {
    return undefined;
  }
  if (!EXPLICIT_NO_MATCH_PATTERNS.some((pattern) => pattern.test(normalizedQuery))) {
    return undefined;
  }
  return {
    route: 'entity',
    retrievalMode: 'no_match_detection',
    queryClass: 'unknown',
  };
}

export function contextualizeConstraintAtoms(
  atoms: readonly ConstraintAtom[],
  intent: QueryIntent,
): readonly ConstraintAtom[] {
  const allowsSemanticVarietalPromotion =
    intent === 'semantic_discovery' || intent === 'pairing_search';
  const allowsPairingPromotion = intent === 'pairing_search';
  if (!allowsSemanticVarietalPromotion && !allowsPairingPromotion) {
    return atoms;
  }

  return atoms.map((atom) => {
    const isPositiveVarietalPrior =
      atom.attribute === 'grape_primary'
      && (atom.operator === '=' || atom.operator === 'in');
    const isPositivePairingPrior =
      atom.attribute === 'pairing'
      && atom.source_tier === 'soft'
      && (atom.operator === '=' || atom.operator === 'in');
    const shouldAllowPromotion =
      (allowsSemanticVarietalPromotion && isPositiveVarietalPrior)
      || (allowsPairingPromotion && isPositivePairingPrior);
    if (!shouldAllowPromotion) {
      return atom;
    }
    return {
      ...atom,
      soft_promotion_authority: 'allow',
      source_tier: 'soft',
      conflict_policy: 'prefer',
      constraint_role: 'prefer',
    };
  });
}

export function shouldStripStrongEntityAnchorFromConstraintParsing(
  intent: QueryIntent,
  anchors: readonly AnchorCandidate[],
): boolean {
  if (intent !== 'entity_exact' && intent !== 'mixed_query') {
    return false;
  }

  const strongAnchors = anchors.filter((anchor) => anchor.confidence >= EXACT_ANCHOR_CONFIDENCE);
  if (strongAnchors.length === 0) {
    return false;
  }

  const uniqueStrongEntityCount = new Set(
    strongAnchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
  ).size;
  return uniqueStrongEntityCount === 1;
}

export function stripDominantAnchorTokens(
  normalizedQuery: string,
  anchorForms: ReadonlySet<string>,
  intent: QueryIntent,
): string {
  const queryTokens = normalizedQuery
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (queryTokens.length === 0) {
    return normalizedQuery;
  }

  const dominantAnchorTokens = selectDominantAnchorTokenSequence(queryTokens, anchorForms);
  if (dominantAnchorTokens.length === 0) {
    return normalizedQuery;
  }

  if (
    intent === 'mixed_query'
    && dominantAnchorTokens.length === queryTokens.length
  ) {
    return normalizedQuery;
  }

  const remainingCounts = new Map<string, number>();
  for (const token of dominantAnchorTokens) {
    remainingCounts.set(token, (remainingCounts.get(token) ?? 0) + 1);
  }

  const retainedTokens: string[] = [];
  for (const token of queryTokens) {
    const count = remainingCounts.get(token) ?? 0;
    if (count > 0) {
      remainingCounts.set(token, count - 1);
      continue;
    }
    retainedTokens.push(token);
  }

  return retainedTokens.join(' ');
}

function selectDominantAnchorTokenSequence(
  queryTokens: readonly string[],
  anchorForms: ReadonlySet<string>,
): readonly string[] {
  const queryCounts = new Map<string, number>();
  for (const token of queryTokens) {
    queryCounts.set(token, (queryCounts.get(token) ?? 0) + 1);
  }

  let bestTokens: readonly string[] = [];
  for (const form of anchorForms) {
    const tokens = form
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0 || !isTokenMultisetCovered(tokens, queryCounts)) {
      continue;
    }

    if (
      tokens.length > bestTokens.length ||
      (tokens.length === bestTokens.length && form.length > bestTokens.join(' ').length)
    ) {
      bestTokens = tokens;
    }
  }

  return bestTokens;
}

function isTokenMultisetCovered(
  candidateTokens: readonly string[],
  queryCounts: ReadonlyMap<string, number>,
): boolean {
  const requiredCounts = new Map<string, number>();
  for (const token of candidateTokens) {
    requiredCounts.set(token, (requiredCounts.get(token) ?? 0) + 1);
  }

  for (const [token, requiredCount] of requiredCounts) {
    if ((queryCounts.get(token) ?? 0) < requiredCount) {
      return false;
    }
  }

  return true;
}
