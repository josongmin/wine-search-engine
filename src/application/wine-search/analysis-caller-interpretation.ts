import type { QueryIntent as SearchQueryIntent } from '@domain/query/model/query-intent.js';
import type { QueryClass } from '@domain/shared/types/query-class.js';
import { stripExactEntityLookupSuffix } from '@domain/query/service/exact-entity-metadata-signals.js';
import { buildNormalizedQueryViews } from '@domain/query/service/query-normalizer.js';
import { isShortEntityLikeSurface } from '@domain/query/service/short-entity-surface.js';
import { stripVintageYearsBounded } from '@domain/shared/utils/vintage.js';
import { normalizeHangulLexical } from '@shared/utils/hangul.js';
import type { WineSearchAnalysis, WineSearchCallerInterpretation } from './wine-search-schemas.js';
import { getCanonicalConstraintTierBundle } from './wine-search-schemas.js';

interface ProjectionFacts {
  readonly hasHardConstraints: boolean;
  readonly hasAnySoftConstraints: boolean;
  readonly hasAnyAnchor: boolean;
  readonly hasEntityLikeLookupSignal: boolean;
}

function buildProjectionFacts(analysis: WineSearchAnalysis): ProjectionFacts {
  const constraintBundle = getCanonicalConstraintTierBundle(analysis);
  const hasHardConstraints = constraintBundle.hard.length > 0;
  const hasAnySoftConstraints =
    constraintBundle.soft.length > 0 || constraintBundle.inferred.length > 0;
  const hasAnyAnchor = analysis.anchors.length > 0;
  const hasOnlyVintageHardConstraint =
    constraintBundle.hard.length > 0
    && constraintBundle.hard.every((constraint) => constraint.attribute === 'vintage_year')
    && constraintBundle.soft.length === 0
    && constraintBundle.inferred.length === 0;
  let hasVintageEntityFallbackSignal = false;
  let hasAnchorDrivenShortEntitySignal = false;
  if (
    analysis.contract.exactMetadataTargetVintage !== undefined
    && !analysis.contract.hasEntityMetadataSignal
    && !hasAnySoftConstraints
    && analysis.anchors.length <= 1
  ) {
    const normalizedLookupSurface = buildNormalizedQueryViews(
      normalizeHangulLexical(
        stripExactEntityLookupSuffix(analysis.preservedSurface.trim().normalize('NFKC')),
      ),
    ).collapsedWhitespace;
    const vintageStrippedLookupSurface = stripVintageYearsBounded(normalizedLookupSurface)
      .replace(/\s+/gu, ' ')
      .trim();
    const hasShortEntitySurfaceSignal =
      vintageStrippedLookupSurface.length > 0
      && isShortEntityLikeSurface(vintageStrippedLookupSurface);
    hasAnchorDrivenShortEntitySignal =
      analysis.anchors.length === 1
      && hasShortEntitySurfaceSignal
      && (!hasHardConstraints || hasOnlyVintageHardConstraint);
    hasVintageEntityFallbackSignal =
      !hasAnyAnchor
      && hasOnlyVintageHardConstraint
      && hasShortEntitySurfaceSignal;
  }

  return {
    hasHardConstraints,
    hasAnySoftConstraints,
    hasAnyAnchor,
    hasEntityLikeLookupSignal:
      analysis.contract.hasEntityMetadataSignal
      || hasAnchorDrivenShortEntitySignal
      || hasVintageEntityFallbackSignal,
  };
}

function resolveProjectedIntent(
  analysis: WineSearchAnalysis,
): SearchQueryIntent {
  const {
    hasHardConstraints,
    hasAnySoftConstraints,
    hasAnyAnchor,
    hasEntityLikeLookupSignal,
  } = buildProjectionFacts(analysis);

  switch (analysis.intent) {
    case 'compare':
      return 'comparison_search';
    case 'pair':
      return 'pairing_search';
    case 'drinkability':
      return 'entity_exact';
    case 'search':
      if (hasEntityLikeLookupSignal) {
        return 'entity_exact';
      }
      if (hasAnyAnchor && (hasHardConstraints || hasAnySoftConstraints)) {
        return 'mixed_query';
      }
      if (hasAnyAnchor) {
        return 'semantic_discovery';
      }
      if (hasHardConstraints) {
        return 'facet_search';
      }
      return 'semantic_discovery';
    case 'unknown':
      if (hasAnyAnchor && (hasHardConstraints || hasAnySoftConstraints)) {
        return 'mixed_query';
      }
      if (hasHardConstraints) {
        return 'facet_search';
      }
      return 'semantic_discovery';
    default: {
      const _exhaustive: never = analysis.intent;
      throw new Error(`Unhandled wine-search analysis intent: ${String(_exhaustive)}`);
    }
  }
}

function resolveProjectedQueryClass(
  analysis: WineSearchAnalysis,
): QueryClass {
  const {
    hasHardConstraints,
    hasAnySoftConstraints,
    hasAnyAnchor,
    hasEntityLikeLookupSignal,
  } = buildProjectionFacts(analysis);

  switch (analysis.intent) {
    case 'compare':
      return 'comparison_query';
    case 'pair':
      return 'semantic_preference';
    case 'drinkability':
      return 'short_entity';
    case 'search':
      if (hasEntityLikeLookupSignal) {
        return 'short_entity';
      }
      if (hasAnyAnchor && (hasHardConstraints || hasAnySoftConstraints)) {
        return 'anchored_similarity';
      }
      if (hasAnyAnchor) {
        return 'semantic_preference';
      }
      if (hasHardConstraints) {
        return 'pure_constraint';
      }
      if (hasAnySoftConstraints) {
        return 'semantic_preference';
      }
      return 'unknown';
    case 'unknown':
      if (hasAnyAnchor && (hasHardConstraints || hasAnySoftConstraints)) {
        return 'anchored_similarity';
      }
      if (hasHardConstraints) {
        return 'pure_constraint';
      }
      if (hasAnySoftConstraints || hasAnyAnchor) {
        return 'semantic_preference';
      }
      return 'unknown';
    default: {
      const _exhaustive: never = analysis.intent;
      throw new Error(`Unhandled wine-search analysis intent for queryClass: ${String(_exhaustive)}`);
    }
  }
}

export function buildCallerSearchInterpretation(
  analysis: WineSearchAnalysis,
): WineSearchCallerInterpretation {
  return {
    authority: 'caller',
    intent: resolveProjectedIntent(analysis),
    queryClass: resolveProjectedQueryClass(analysis),
  };
}
