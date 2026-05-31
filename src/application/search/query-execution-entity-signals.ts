import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
import { parseSpans } from '../../domain/attribute/service/span-parser.js';
import { isDirectEntityResolution, resolveEntity } from '../../domain/attribute/service/entity-resolver.js';
import {
  hasExactEntityLookupKeyword,
  stripExactEntityLookupSuffix,
} from '../../domain/query/service/exact-entity-metadata-signals.js';
import { QUERY_NORMALIZER } from './query-execution-normalizer.js';

/**
 * Entity / SKU signal detectors for the agent query-execution contract.
 *
 * These functions inspect a query through the {@link QUERY_NORMALIZER} views and
 * the domain entity resolver to decide whether the query carries a direct entity
 * anchor (grape, region, appellation, generic concept) or looks like a specific
 * SKU lookup. They are pure (no LLM, no I/O) and form a single dependency cluster:
 * none of them references the contract builder, default builder, or temporal
 * helpers — keeping the module a one-directional leaf of the contract package.
 */

export function queryHasDirectAppellationSpan(query: string): boolean {
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

export function detectExplicitGrapePrimary(query: string): string | undefined {
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

export function detectExplicitRegion(query: string): string | undefined {
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

export function hasDirectEntityAnchorForMetadata(query: string): boolean {
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

export function hasDirectConceptAnchor(query: string): boolean {
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

export function containsGenericWineNoun(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:와인|wine)(?=$|[^\p{L}\p{N}])/iu.test(query);
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
