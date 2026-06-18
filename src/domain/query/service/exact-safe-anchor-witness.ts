import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';
import { isExactLikeLookupStrategy } from './lookup-strategy-taxonomy.js';
import { EXACT_IDENTITY_MIN_CONFIDENCE } from '../../resolver/v2/channel-provenance.js';
import { normalizeForMatch } from '../../alias/service/normalize.js';
import { compactForLookup } from './phonetic-skeleton.js';

export interface ExactSafeAnchorWitness {
  readonly entityId: CanonicalEntityId;
  readonly anchor: AnchorCandidate;
}

function collectNormalizedSurfaceKeys(
  value: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (value.trim().length === 0) {
    return keys;
  }
  const normalized = normalizeForMatch(value);
  if (normalized.length > 0) {
    keys.add(normalized);
  }
  const compact = compactForLookup(value);
  if (compact.length > 0) {
    keys.add(compact);
  }
  return keys;
}

function collectQuerySurfaceKeys(
  rawQuery: string,
  normalizedQuery: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of [rawQuery, normalizedQuery]) {
    for (const key of collectNormalizedSurfaceKeys(value)) {
      keys.add(key);
    }
  }
  return keys;
}

function collectAnchorSurfaceKeys(
  anchor: AnchorCandidate,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of [anchor.surfaceForm, anchor.normalizedForm, ...(anchor.lookupVariants ?? [])]) {
    for (const key of collectNormalizedSurfaceKeys(value)) {
      keys.add(key);
    }
  }
  return keys;
}

function hasNonPrefixExactLikeStrategy(
  anchor: AnchorCandidate,
): boolean {
  return anchor.lookupStrategies?.some((strategy) =>
    strategy !== 'prefix_exact'
    && strategy !== 'transliterated_prefix'
    && strategy !== 'hangul_ime_completion'
    && isExactLikeLookupStrategy(strategy),
  ) ?? false;
}

function uniqueAnchorEntityIds(
  anchors: readonly AnchorCandidate[],
): ReadonlySet<string> {
  return new Set(anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)));
}

export function hasDeterministicSingletonAliasWitness(
  anchors: readonly AnchorCandidate[],
): boolean {
  if (uniqueAnchorEntityIds(anchors).size !== 1) {
    return false;
  }

  return anchors.some((anchor) =>
    anchor.source === 'alias'
    && anchor.confidence === 1
    && anchor.candidateEntityIds.length === 1
    && (anchor.lookupStrategies?.some((strategy) => isExactLikeLookupStrategy(strategy)) ?? false),
  );
}

export function findRawQueryExactSafeSingletonAliasWitness(
  rawQuery: string,
  normalizedQuery: string,
  anchors: readonly AnchorCandidate[],
): ExactSafeAnchorWitness | undefined {
  if (normalizedQuery.trim().length === 0) {
    return undefined;
  }
  const queryKeys = collectQuerySurfaceKeys(rawQuery, normalizedQuery);

  for (const anchor of anchors) {
    if (anchor.source !== 'alias') {
      continue;
    }
    if (anchor.aliasType !== 'observed_query_alias' && anchor.aliasType !== 'translation') {
      continue;
    }
    if (anchor.candidateEntityIds.length !== 1) {
      continue;
    }
    if (anchor.confidence < EXACT_IDENTITY_MIN_CONFIDENCE) {
      continue;
    }
    if (!hasNonPrefixExactLikeStrategy(anchor)) {
      continue;
    }
    const anchorKeys = collectAnchorSurfaceKeys(anchor);
    const hasRawQuerySurfaceWitness = [...queryKeys].some((key) => anchorKeys.has(key));
    if (!hasRawQuerySurfaceWitness) {
      continue;
    }
    return {
      entityId: anchor.candidateEntityIds[0]!,
      anchor,
    };
  }

  return undefined;
}

export function hasRawQueryExactSafeSingletonAliasWitness(
  rawQuery: string,
  normalizedQuery: string,
  anchors: readonly AnchorCandidate[],
): boolean {
  return findRawQueryExactSafeSingletonAliasWitness(rawQuery, normalizedQuery, anchors) !== undefined;
}
