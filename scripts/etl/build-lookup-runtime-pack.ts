import { Transliterator } from '../../src/domain/alias/service/transliterator.js';
import { doubleMetaphoneKeys } from '../../src/domain/alias/service/double-metaphone.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { SourceRecordId } from '../../src/domain/shared/types/entity-id.js';
import { buildHangulJamoKey } from '../../src/domain/shared/utils/hangul.js';
import type {
  LookupAmbiguityRuntimeArtifact,
  LookupAmbiguityRuntimeEntry,
  LookupAliasRuntimeArtifact,
  LookupAliasBroadRecallRuntimeArtifact,
  LookupAliasRuntimeCoreArtifact,
  LookupAliasRuntimeRow,
  LookupConceptRedirectRuntimeArtifact,
  LookupConceptRedirectRuntimeEntry,
  LookupExactSafeRuntimeArtifact,
  LookupExactSafeRuntimeEntry,
  LookupIdentityCertificate,
  LookupResolverProjectionArtifact,
  LookupResolverProjectionDocument,
  LookupEntityProjectionArtifact,
  LookupEntityProjectionDocument,
} from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
  LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
  LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION,
  LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION,
  LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION,
  LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION,
  LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
  LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
} from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import { buildAliasPrefixTerms } from '../../src/domain/query/service/alias-prefix-terms.js';
import { buildNormalizedQueryViews } from '../../src/domain/query/service/query-normalizer.js';
import { buildResolverCandidateAttributeHints } from '../../src/application/search/search-usecase-entity-attribute-projection.js';
import {
  compactForLookup,
  phoneticCompactForLookup,
} from '../../src/domain/query/service/phonetic-skeleton.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { AliasSnapshotRecord, AmbiguityRegistrySnapshotRow } from './search-snapshot-schema.js';
import type { EnrichedSilverRecord } from './types.js';
import type { SourceEntityContinuityRecord } from './snapshot-entity-identity.js';
import { silverToIndexable } from './index-to-vespa.js';
import type {
  LookupExactSafeRegistryRow,
  LookupRuntimeOverlayAlias,
} from './lookup-exact-safe-registry.js';

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/u)
    .filter(Boolean);
}

function normalizeIdentitySurface(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function explicitIdentitySurfaceKeys(value: string): readonly string[] {
  const views = buildNormalizedQueryViews(value);
  const surfaces = [
    views.strict,
    views.accentless,
    views.collapsedWhitespace,
    views.punctuationStripped,
    views.compact,
    views.vintageCanonicalized,
    views.transliterated,
  ];

  return [...new Set(
    surfaces
      .filter((surface): surface is string => typeof surface === 'string' && surface.length > 0)
      .map(normalizeIdentitySurface)
      .filter((key) => key.length > 0),
  )];
}

function stripParenthetical(value: string): string {
  return value.replace(/\([^)]*\)/gu, ' ');
}

function coreIdentityKey(value: string): string {
  return normalizeIdentitySurface(buildNormalizedQueryViews(stripParenthetical(value)).vintageStripped);
}

function removeAllOccurrences(value: string, needle: string): string {
  if (needle.length === 0) {
    return value;
  }
  return value
    .split(needle)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isProducerOnlyAliasForDistinctWine(args: {
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly producer?: string | undefined;
  readonly aliasValue: string;
}): boolean {
  if (args.entityType !== 'wine' || typeof args.producer !== 'string' || args.producer.trim().length === 0) {
    return false;
  }

  const producerKey = coreIdentityKey(args.producer);
  const aliasKey = coreIdentityKey(args.aliasValue);
  if (producerKey.length === 0 || aliasKey !== producerKey) {
    return false;
  }

  const canonicalKey = coreIdentityKey(args.canonicalLabel);
  return removeAllOccurrences(canonicalKey, producerKey).length > 0;
}

function buildIdentitySafeKeys(args: {
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly producer?: string | undefined;
}): readonly string[] {
  const keys = new Set<string>();
  const surfaces = [args.canonicalLabel, ...args.aliasesIdentitySafe];
  for (const surface of surfaces) {
    if (
      isProducerOnlyAliasForDistinctWine({
        entityType: args.entityType,
        canonicalLabel: args.canonicalLabel,
        producer: args.producer,
        aliasValue: surface,
      })
    ) {
      continue;
    }
    for (const key of explicitIdentitySurfaceKeys(surface)) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function tokenizeNormalizedSurface(value: string): readonly string[] {
  return buildNormalizedQueryViews(value)
    .punctuationStripped
    .split(/\s+/u)
    .filter(Boolean);
}

function addFamilyCoreTerms(target: Set<string>, surface: string): void {
  for (const term of buildAliasPrefixTerms([surface])) {
    const trimmed = term.trim();
    if (trimmed.length > 0) {
      target.add(trimmed);
    }
  }
}

function buildDisallowedFamilyCoreTerms(grapes: readonly string[]): ReadonlySet<string> {
  const disallowed = new Set<string>();
  for (const grape of grapes) {
    for (const term of buildAliasPrefixTerms([grape])) {
      const normalized = normalizeForMatch(term);
      if (normalized.length > 0) {
        disallowed.add(normalized);
      }
    }
  }
  return disallowed;
}

function addFilteredFamilyCoreTerms(
  target: Set<string>,
  surface: string,
  disallowedNormalizedTerms: ReadonlySet<string>,
): void {
  for (const term of buildAliasPrefixTerms([surface])) {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (disallowedNormalizedTerms.has(normalizeForMatch(trimmed))) {
      continue;
    }
    target.add(trimmed);
  }
}

function buildFamilyCoreKeys(args: {
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly aliasesNoisyRecall: readonly string[];
  readonly producer?: string | undefined;
  readonly grapes?: readonly string[] | undefined;
}): readonly string[] {
  const keys = new Set<string>();
  const authoritativeAnchorTokens = new Set<string>();
  const disallowedNormalizedTerms = buildDisallowedFamilyCoreTerms(args.grapes ?? []);
  for (const surface of [
    args.canonicalLabel,
    ...(typeof args.producer === 'string' ? [args.producer] : []),
    ...args.aliasesIdentitySafe,
  ]) {
    for (const token of tokenizeNormalizedSurface(surface)) {
      authoritativeAnchorTokens.add(token);
    }
  }

  for (const noisySurface of args.aliasesNoisyRecall) {
    const noisyTokens = tokenizeNormalizedSurface(noisySurface);
    if (noisyTokens.length === 0) {
      continue;
    }
    if (noisyTokens.every((token) => authoritativeAnchorTokens.has(token))) {
      addFilteredFamilyCoreTerms(keys, noisySurface, disallowedNormalizedTerms);
    }
  }

  if (typeof args.producer === 'string' && args.producer.trim().length > 0) {
    const producerTokens = tokenizeNormalizedSurface(args.producer);
    if (producerTokens.length > 0) {
      for (const surface of [args.canonicalLabel, ...args.aliasesIdentitySafe]) {
        const normalizedSurface = buildNormalizedQueryViews(surface).vintageStripped;
        const surfaceTokens = tokenizeNormalizedSurface(normalizedSurface);
        if (surfaceTokens.length === 0) {
          continue;
        }
        let commonPrefixLength = 0;
        while (
          commonPrefixLength < surfaceTokens.length
          && commonPrefixLength < producerTokens.length
          && surfaceTokens[commonPrefixLength] === producerTokens[commonPrefixLength]
        ) {
          commonPrefixLength += 1;
        }
        if (commonPrefixLength === 0 || commonPrefixLength >= surfaceTokens.length) {
          continue;
        }
        const remainder = surfaceTokens.slice(commonPrefixLength).join(' ');
        if (remainder.length > 0) {
          addFilteredFamilyCoreTerms(keys, remainder, disallowedNormalizedTerms);
        }
      }
    }
  }

  return [...keys].sort((left, right) => left.localeCompare(right));
}

function mergeFamilyCoreKeys(args: {
  readonly derivedKeys: readonly string[];
  readonly reviewedKeys?: readonly string[] | undefined;
}): readonly string[] {
  const keys = new Set<string>(args.derivedKeys);
  for (const key of args.reviewedKeys ?? []) {
    const trimmed = key.trim();
    if (trimmed.length > 0) {
      keys.add(trimmed);
    }
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function pushIndex(
  index: Map<string, number[]>,
  key: string,
  aliasIndex: number,
): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [aliasIndex]);
    return;
  }
  existing.push(aliasIndex);
}

function mapToRecord(index: Map<string, readonly number[]>): Record<string, readonly number[]> {
  return Object.fromEntries(
    [...index.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildHangulCompletionEntries(
  alias: LookupAliasRuntimeRow,
  aliasIndex: number,
): readonly LookupAliasRuntimeArtifact['hangulCompletionRecords'] {
  const entries: LookupAliasRuntimeArtifact['hangulCompletionRecords'] = [];
  const seenJamoKeys = new Set<string>();
  for (const value of [alias.value, alias.normalizedValue]) {
    const key = buildHangulJamoKey(value);
    if (key.containsHangul && key.key.length > 0 && !seenJamoKeys.has(key.key)) {
      seenJamoKeys.add(key.key);
      entries.push({
        aliasIndex,
        jamoKey: key.key,
        syllableBoundaryOffsets: [...key.syllableBoundaryOffsets].sort((left, right) => left - right),
      });
    }

    const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(value);
    if (exceptionSurface === undefined) {
      continue;
    }
    const exceptionKey = buildHangulJamoKey(exceptionSurface);
    if (
      exceptionKey.containsHangul
      && exceptionKey.key.length > 0
      && !seenJamoKeys.has(exceptionKey.key)
    ) {
      seenJamoKeys.add(exceptionKey.key);
      entries.push({
        aliasIndex,
        jamoKey: exceptionKey.key,
        syllableBoundaryOffsets: [...exceptionKey.syllableBoundaryOffsets].sort((left, right) => left - right),
      });
    }
  }
  return entries;
}

export function buildLookupAliasRuntimeArtifacts(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly runtimeOverlayAliases?: readonly LookupRuntimeOverlayAlias[] | undefined;
}): {
  readonly coreArtifact: LookupAliasRuntimeCoreArtifact;
  readonly broadRecallArtifact: LookupAliasBroadRecallRuntimeArtifact;
} {
  const exactIndex = new Map<string, number[]>();
  const compactIndex = new Map<string, number[]>();
  const wholeTokenIndex = new Map<string, number[]>();
  const phoneticIndex = new Map<string, number[]>();
  const doubleMetaphoneIndex = new Map<string, number[]>();
  const doubleMetaphoneKeysByAliasId = new Map<string, readonly string[]>();
  const prefixCatalog = new Map<string, number[]>();
  const hangulCompletionRecords: LookupAliasRuntimeArtifact['hangulCompletionRecords'] = [];
  const seenSurfaceForms = new Set<string>();
  const surfaceForms: string[] = [];
  const overlayPromotionClassByAliasId = new Map<string, LookupRuntimeOverlayAlias['promotionClass']>();
  const exactOverrideOwnerByNormalizedValue = new Map<string, string>();
  const compactOverrideOwnerByCompactValue = new Map<string, string>();

  const aliasRows: LookupAliasRuntimeRow[] = args.aliases.map((alias) => ({
    aliasId: alias.aliasId,
    entityId: alias.entityId,
    value: alias.value,
    normalizedValue: alias.normalizedValue,
    sourceTrust: alias.sourceTrust,
    confidencePrior: alias.confidencePrior,
    ...(alias.aliasType !== undefined ? { aliasType: alias.aliasType } : {}),
  }));
  for (const overlay of args.runtimeOverlayAliases ?? []) {
    const existingExactOwner = exactOverrideOwnerByNormalizedValue.get(overlay.normalizedValue);
    if (existingExactOwner !== undefined && existingExactOwner !== overlay.entityId) {
      throw new Error(
        `lookup runtime overlay exact collision on "${overlay.normalizedValue}" between ${existingExactOwner} and ${overlay.entityId}`,
      );
    }
    exactOverrideOwnerByNormalizedValue.set(overlay.normalizedValue, overlay.entityId);
    if (overlay.promotionClass === 'compact_exact_safe') {
      const compactValue = compactForLookup(overlay.normalizedValue);
      if (compactValue.length > 0) {
        const existingCompactOwner = compactOverrideOwnerByCompactValue.get(compactValue);
        if (existingCompactOwner !== undefined && existingCompactOwner !== overlay.entityId) {
          throw new Error(
            `lookup runtime overlay compact collision on "${compactValue}" between ${existingCompactOwner} and ${overlay.entityId}`,
          );
        }
        compactOverrideOwnerByCompactValue.set(compactValue, overlay.entityId);
      }
    }
    const aliasId = `lookup-exact-safe:${overlay.entityId}:${overlay.normalizedValue}:${overlay.promotionClass}`;
    overlayPromotionClassByAliasId.set(aliasId, overlay.promotionClass);
    aliasRows.push({
      aliasId,
      entityId: overlay.entityId,
      value: overlay.value,
      normalizedValue: overlay.normalizedValue,
      sourceTrust: overlay.sourceTrust,
      confidencePrior: overlay.confidencePrior,
      aliasType: overlay.aliasType,
    });
  }

  for (const [aliasIndex, alias] of aliasRows.entries()) {
    const overlayPromotionClass = overlayPromotionClassByAliasId.get(alias.aliasId);
    const exactOverrideOwner = exactOverrideOwnerByNormalizedValue.get(alias.normalizedValue);
    if (
      exactOverrideOwner === undefined
      || exactOverrideOwner === alias.entityId
      || overlayPromotionClass !== undefined
    ) {
      pushIndex(exactIndex, alias.normalizedValue, aliasIndex);
    }
    const compactValue = compactForLookup(alias.normalizedValue);
    const compactOverrideOwner = compactOverrideOwnerByCompactValue.get(compactValue);
    if (
      compactValue.length > 0
      && (compactOverrideOwner === undefined
        || compactOverrideOwner === alias.entityId
        || overlayPromotionClass !== undefined)
      && (overlayPromotionClass === undefined || overlayPromotionClass === 'compact_exact_safe')
    ) {
      pushIndex(compactIndex, compactValue, aliasIndex);
    }
    if (overlayPromotionClass !== undefined) {
      if (!seenSurfaceForms.has(alias.value)) {
        seenSurfaceForms.add(alias.value);
        surfaceForms.push(alias.value);
      }
      continue;
    }
    for (const token of tokenizeForLookup(alias.normalizedValue)) {
      pushIndex(wholeTokenIndex, token, aliasIndex);
    }
    const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
    if (phoneticValue.length > 0) {
      pushIndex(phoneticIndex, phoneticValue, aliasIndex);
    }
    const dmKeys = [...doubleMetaphoneKeys(alias.normalizedValue)].sort();
    doubleMetaphoneKeysByAliasId.set(alias.aliasId, dmKeys);
    for (const dmKey of dmKeys) {
      pushIndex(doubleMetaphoneIndex, dmKey, aliasIndex);
    }
    for (const prefixTerm of buildAliasPrefixTerms([alias.normalizedValue])) {
      pushIndex(prefixCatalog, prefixTerm, aliasIndex);
    }
    hangulCompletionRecords.push(...buildHangulCompletionEntries(alias, aliasIndex));
    if (!seenSurfaceForms.has(alias.value)) {
      seenSurfaceForms.add(alias.value);
      surfaceForms.push(alias.value);
    }
  }

  const coreArtifact: LookupAliasRuntimeCoreArtifact = {
    schemaVersion: LOOKUP_ALIAS_CORE_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    aliasRegistryHash: args.aliasRegistryHash,
    aliases: aliasRows,
    exactIndex: mapToRecord(exactIndex),
    compactIndex: mapToRecord(compactIndex),
  };
  const broadRecallArtifact: LookupAliasBroadRecallRuntimeArtifact = {
    schemaVersion: LOOKUP_ALIAS_BROAD_RECALL_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    aliasRegistryHash: args.aliasRegistryHash,
    wholeTokenIndex: mapToRecord(wholeTokenIndex),
    phoneticIndex: mapToRecord(phoneticIndex),
    doubleMetaphoneIndex: mapToRecord(doubleMetaphoneIndex),
    doubleMetaphoneKeysByAliasId: Object.fromEntries(
      [...doubleMetaphoneKeysByAliasId.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    prefixCatalog: [...prefixCatalog.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidateTerm, aliasIndexes]) => ({
        candidateTerm,
        aliasIndexes: [...aliasIndexes],
      })),
    hangulCompletionRecords: hangulCompletionRecords
      .slice()
      .sort((left, right) =>
        left.jamoKey.localeCompare(right.jamoKey)
        || left.aliasIndex - right.aliasIndex,
      ),
  };

  return {
    coreArtifact,
    broadRecallArtifact,
  };
}

function buildLookupAliasRuntimeFullArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly runtimeOverlayAliases?: readonly LookupRuntimeOverlayAlias[] | undefined;
}): LookupAliasRuntimeArtifact {
  const exactIndex = new Map<string, number[]>();
  const compactIndex = new Map<string, number[]>();
  const wholeTokenIndex = new Map<string, number[]>();
  const phoneticIndex = new Map<string, number[]>();
  const doubleMetaphoneIndex = new Map<string, number[]>();
  const doubleMetaphoneKeysByAliasId = new Map<string, readonly string[]>();
  const prefixCatalog = new Map<string, number[]>();
  const hangulCompletionRecords: LookupAliasRuntimeArtifact['hangulCompletionRecords'] = [];
  const seenSurfaceForms = new Set<string>();
  const surfaceForms: string[] = [];
  const overlayPromotionClassByAliasId = new Map<string, LookupRuntimeOverlayAlias['promotionClass']>();
  const exactOverrideOwnerByNormalizedValue = new Map<string, string>();
  const compactOverrideOwnerByCompactValue = new Map<string, string>();

  const aliasRows: LookupAliasRuntimeRow[] = args.aliases.map((alias) => ({
    aliasId: alias.aliasId,
    entityId: alias.entityId,
    value: alias.value,
    normalizedValue: alias.normalizedValue,
    sourceTrust: alias.sourceTrust,
    confidencePrior: alias.confidencePrior,
    ...(alias.aliasType !== undefined ? { aliasType: alias.aliasType } : {}),
  }));
  for (const overlay of args.runtimeOverlayAliases ?? []) {
    const existingExactOwner = exactOverrideOwnerByNormalizedValue.get(overlay.normalizedValue);
    if (existingExactOwner !== undefined && existingExactOwner !== overlay.entityId) {
      throw new Error(
        `lookup runtime overlay exact collision on "${overlay.normalizedValue}" between ${existingExactOwner} and ${overlay.entityId}`,
      );
    }
    exactOverrideOwnerByNormalizedValue.set(overlay.normalizedValue, overlay.entityId);
    if (overlay.promotionClass === 'compact_exact_safe') {
      const compactValue = compactForLookup(overlay.normalizedValue);
      if (compactValue.length > 0) {
        const existingCompactOwner = compactOverrideOwnerByCompactValue.get(compactValue);
        if (existingCompactOwner !== undefined && existingCompactOwner !== overlay.entityId) {
          throw new Error(
            `lookup runtime overlay compact collision on "${compactValue}" between ${existingCompactOwner} and ${overlay.entityId}`,
          );
        }
        compactOverrideOwnerByCompactValue.set(compactValue, overlay.entityId);
      }
    }
    const aliasId = `lookup-exact-safe:${overlay.entityId}:${overlay.normalizedValue}:${overlay.promotionClass}`;
    overlayPromotionClassByAliasId.set(aliasId, overlay.promotionClass);
    aliasRows.push({
      aliasId,
      entityId: overlay.entityId,
      value: overlay.value,
      normalizedValue: overlay.normalizedValue,
      sourceTrust: overlay.sourceTrust,
      confidencePrior: overlay.confidencePrior,
      aliasType: overlay.aliasType,
    });
  }

  for (const [aliasIndex, alias] of aliasRows.entries()) {
    const overlayPromotionClass = overlayPromotionClassByAliasId.get(alias.aliasId);
    const exactOverrideOwner = exactOverrideOwnerByNormalizedValue.get(alias.normalizedValue);
    if (
      exactOverrideOwner === undefined
      || exactOverrideOwner === alias.entityId
      || overlayPromotionClass !== undefined
    ) {
      pushIndex(exactIndex, alias.normalizedValue, aliasIndex);
    }
    const compactValue = compactForLookup(alias.normalizedValue);
    const compactOverrideOwner = compactOverrideOwnerByCompactValue.get(compactValue);
    if (
      compactValue.length > 0
      && (compactOverrideOwner === undefined
        || compactOverrideOwner === alias.entityId
        || overlayPromotionClass !== undefined)
      && (overlayPromotionClass === undefined || overlayPromotionClass === 'compact_exact_safe')
    ) {
      pushIndex(compactIndex, compactValue, aliasIndex);
    }
    if (overlayPromotionClass !== undefined) {
      if (!seenSurfaceForms.has(alias.value)) {
        seenSurfaceForms.add(alias.value);
        surfaceForms.push(alias.value);
      }
      continue;
    }
    for (const token of tokenizeForLookup(alias.normalizedValue)) {
      pushIndex(wholeTokenIndex, token, aliasIndex);
    }
    const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
    if (phoneticValue.length > 0) {
      pushIndex(phoneticIndex, phoneticValue, aliasIndex);
    }
    const dmKeys = [...doubleMetaphoneKeys(alias.normalizedValue)].sort();
    doubleMetaphoneKeysByAliasId.set(alias.aliasId, dmKeys);
    for (const dmKey of dmKeys) {
      pushIndex(doubleMetaphoneIndex, dmKey, aliasIndex);
    }
    for (const prefixTerm of buildAliasPrefixTerms([alias.normalizedValue])) {
      pushIndex(prefixCatalog, prefixTerm, aliasIndex);
    }
    hangulCompletionRecords.push(...buildHangulCompletionEntries(alias, aliasIndex));
    if (!seenSurfaceForms.has(alias.value)) {
      seenSurfaceForms.add(alias.value);
      surfaceForms.push(alias.value);
    }
  }

  return {
    schemaVersion: LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    aliasRegistryHash: args.aliasRegistryHash,
    aliases: aliasRows,
    surfaceForms,
    exactIndex: mapToRecord(exactIndex),
    compactIndex: mapToRecord(compactIndex),
    wholeTokenIndex: mapToRecord(wholeTokenIndex),
    phoneticIndex: mapToRecord(phoneticIndex),
    doubleMetaphoneIndex: mapToRecord(doubleMetaphoneIndex),
    doubleMetaphoneKeysByAliasId: Object.fromEntries(
      [...doubleMetaphoneKeysByAliasId.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    prefixCatalog: [...prefixCatalog.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidateTerm, aliasIndexes]) => ({
        candidateTerm,
        aliasIndexes: [...aliasIndexes],
      })),
    hangulCompletionRecords: hangulCompletionRecords
      .slice()
      .sort((left, right) =>
        left.jamoKey.localeCompare(right.jamoKey)
        || left.aliasIndex - right.aliasIndex,
      ),
  };
}

export function buildLookupAliasRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly aliasRegistryHash: string;
  readonly aliases: readonly AliasSnapshotRecord[];
  readonly runtimeOverlayAliases?: readonly LookupRuntimeOverlayAlias[] | undefined;
}): LookupAliasRuntimeArtifact {
  return buildLookupAliasRuntimeFullArtifact(args);
}

export function buildLookupEntityProjectionArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly records: readonly EnrichedSilverRecord[];
  readonly entityIdBySourceId: ReadonlyMap<SourceRecordId, CanonicalEntityId>;
  readonly goldCanonicalLookup: ReadonlyMap<string, string>;
  readonly sourceContinuityLookup: ReadonlyMap<SourceRecordId, SourceEntityContinuityRecord>;
  readonly identityCertificatesByEntity?: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]> | undefined;
  readonly reviewedFamilyCoreKeysByEntity?: ReadonlyMap<CanonicalEntityId, readonly string[]> | undefined;
}): LookupEntityProjectionArtifact {
  const documents: LookupEntityProjectionDocument[] = args.records.map((record) => {
    const entityId = args.entityIdBySourceId.get(record.sourceId);
    if (entityId === undefined) {
      throw new Error(`Missing lookup entity projection id mapping for sourceId=${record.sourceId}`);
    }
    const indexable = silverToIndexable(
      record,
      args.goldCanonicalLookup,
      args.sourceContinuityLookup,
    );
    const attributeHintDoc = {
      entityId,
      entityType: indexable.entityType,
      canonicalLabel: indexable.canonicalLabel,
      aliasesIdentitySafe: indexable.aliasesIdentitySafe,
      aliasesNoisyRecall: indexable.aliasesNoisyRecall,
      producer: record.producer,
      region: indexable.region ?? record.region,
      grapes: indexable.grapes,
      searchTextKo: indexable.searchTextKo,
      searchTextEn: record.searchTextEn,
      semanticSummary: indexable.semanticSummary,
      pairing: indexable.pairing,
      availability: indexable.availability,
      popularityScore: indexable.popularityScore,
      ...(indexable.vintageYear !== undefined ? { vintageYear: indexable.vintageYear } : {}),
      ...(indexable.appellation !== undefined ? { appellation: indexable.appellation } : {}),
      ...(indexable.country !== undefined ? { country: indexable.country } : {}),
      ...(indexable.regionHierarchy !== undefined ? { regionHierarchy: indexable.regionHierarchy } : {}),
      ...(indexable.grapePrimary !== undefined ? { grapePrimary: indexable.grapePrimary } : {}),
      ...(indexable.style !== undefined ? { style: indexable.style } : {}),
      ...(indexable.closure !== undefined ? { closure: indexable.closure } : {}),
      ...(indexable.priceBand !== undefined ? { priceBand: indexable.priceBand } : {}),
      ...(indexable.occasion !== undefined ? { occasion: indexable.occasion } : {}),
      ...(indexable.body !== undefined ? { body: indexable.body } : {}),
      ...(indexable.tannin !== undefined ? { tannin: indexable.tannin } : {}),
      ...(indexable.acidity !== undefined ? { acidity: indexable.acidity } : {}),
      ...(indexable.sweetness !== undefined ? { sweetness: indexable.sweetness } : {}),
      ...(indexable.finishLength !== undefined ? { finishLength: indexable.finishLength } : {}),
      ...(indexable.wineType !== undefined ? { wineType: indexable.wineType } : {}),
      ...(indexable.classification !== undefined ? { classification: indexable.classification } : {}),
      ...(indexable.alcoholPct !== undefined ? { alcoholPct: indexable.alcoholPct } : {}),
      ...(indexable.priceUsd !== undefined ? { priceUsd: indexable.priceUsd } : {}),
      ...(indexable.producerPrestige !== undefined ? { producerPrestige: indexable.producerPrestige } : {}),
      ...(indexable.criticScoreNormalized !== undefined ? { criticScoreNormalized: indexable.criticScoreNormalized } : {}),
      ...(indexable.certifications !== undefined ? { certifications: indexable.certifications } : {}),
      ...(indexable.soilType !== undefined ? { soilType: indexable.soilType } : {}),
      ...(indexable.producerType !== undefined ? { producerType: indexable.producerType } : {}),
      ...(indexable.grapeFamily !== undefined ? { grapeFamily: indexable.grapeFamily } : {}),
      ...(indexable.flavorProfiles !== undefined ? { flavorProfiles: indexable.flavorProfiles } : {}),
      ...(indexable.drinkingWindowStart !== undefined ? { drinkingWindowStart: indexable.drinkingWindowStart } : {}),
      ...(indexable.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: indexable.drinkingWindowEnd } : {}),
      ...(indexable.drinkingWindowModelVersion !== undefined ? { drinkingWindowModelVersion: indexable.drinkingWindowModelVersion } : {}),
    };
    const attributeHints = buildResolverCandidateAttributeHints(attributeHintDoc);
    const familyCoreKeys = mergeFamilyCoreKeys({
      derivedKeys: buildFamilyCoreKeys({
        canonicalLabel: indexable.canonicalLabel,
        aliasesIdentitySafe: indexable.aliasesIdentitySafe,
        aliasesNoisyRecall: indexable.aliasesNoisyRecall,
        producer: record.producer,
        grapes: indexable.grapes,
      }),
      reviewedKeys: args.reviewedFamilyCoreKeysByEntity?.get(entityId),
    });
    return {
      entityId,
      entityType: indexable.entityType,
      canonicalLabel: indexable.canonicalLabel,
      aliasesIdentitySafe: indexable.aliasesIdentitySafe,
      identitySafeKeys: buildIdentitySafeKeys({
        entityType: indexable.entityType,
        canonicalLabel: indexable.canonicalLabel,
        aliasesIdentitySafe: indexable.aliasesIdentitySafe,
        producer: record.producer,
      }),
      ...(familyCoreKeys.length > 0 ? { familyCoreKeys } : {}),
      ...(args.identityCertificatesByEntity?.get(entityId) !== undefined
        ? { identityCertificates: args.identityCertificatesByEntity.get(entityId)! }
        : {}),
      aliasesNoisyRecall: indexable.aliasesNoisyRecall,
      ...(indexable.aliasPrefixTerms !== undefined ? { aliasPrefixTerms: indexable.aliasPrefixTerms } : {}),
      producer: record.producer,
      ...(attributeHints !== undefined ? { attributeHints } : {}),
      region: indexable.region ?? record.region,
      grapes: indexable.grapes,
      searchTextKo: indexable.searchTextKo,
      searchTextEn: record.searchTextEn,
      semanticSummary: indexable.semanticSummary,
      ...(indexable.body != null ? { body: indexable.body } : {}),
      ...(indexable.sweetness != null ? { sweetness: indexable.sweetness } : {}),
      ...(indexable.style !== undefined ? { style: indexable.style } : {}),
      ...(indexable.priceBand !== undefined ? { priceBand: indexable.priceBand } : {}),
      pairing: indexable.pairing,
      ...(indexable.occasion !== undefined ? { occasion: [...indexable.occasion] } : {}),
      availability: indexable.availability,
      popularityScore: indexable.popularityScore,
      ...(indexable.vintageYear !== undefined ? { vintageYear: indexable.vintageYear } : {}),
      ...(indexable.acidity !== undefined ? { acidity: indexable.acidity } : {}),
      ...(indexable.tannin !== undefined ? { tannin: indexable.tannin } : {}),
      ...(indexable.wineType !== undefined ? { wineType: indexable.wineType } : {}),
      ...(indexable.grapePrimary !== undefined ? { grapePrimary: indexable.grapePrimary } : {}),
      ...(indexable.country !== undefined ? { country: indexable.country } : {}),
      ...(indexable.priceUsd !== undefined ? { priceUsd: indexable.priceUsd } : {}),
      ...(indexable.ratingAvg !== undefined ? { ratingAvg: indexable.ratingAvg } : {}),
      ...(indexable.ratingsCount !== undefined ? { ratingsCount: indexable.ratingsCount } : {}),
      ...(indexable.reviewCount !== undefined ? { reviewCount: indexable.reviewCount } : {}),
      ...(indexable.ratingDistribution !== undefined ? { ratingDistribution: indexable.ratingDistribution } : {}),
      ...(indexable.wineryRatingCount !== undefined ? { wineryRatingCount: indexable.wineryRatingCount } : {}),
      ...(indexable.bottleSizeMl !== undefined ? { bottleSizeMl: indexable.bottleSizeMl } : {}),
      ...(indexable.bottleSize !== undefined ? { bottleSize: indexable.bottleSize } : {}),
      ...(indexable.closure !== undefined ? { closure: indexable.closure } : {}),
      ...(indexable.flavorProfiles !== undefined ? { flavorProfiles: indexable.flavorProfiles } : {}),
      ...(indexable.criticScoreNormalized !== undefined ? { criticScoreNormalized: indexable.criticScoreNormalized } : {}),
      ...(indexable.criticConfidenceWeight !== undefined ? { criticConfidenceWeight: indexable.criticConfidenceWeight } : {}),
      ...(indexable.syntheticQueries !== undefined && indexable.syntheticQueries.length > 0 ? { syntheticQueries: indexable.syntheticQueries } : {}),
      ...(indexable.alcoholPct !== undefined ? { alcoholPct: indexable.alcoholPct } : {}),
      ...(indexable.producerPrestige !== undefined ? { producerPrestige: indexable.producerPrestige } : {}),
      ...(indexable.avgCriticProxyScore !== undefined ? { avgCriticProxyScore: indexable.avgCriticProxyScore } : {}),
      ...(indexable.certifications !== undefined ? { certifications: [...indexable.certifications] } : {}),
      ...(indexable.drinkingWindowStart !== undefined ? { drinkingWindowStart: indexable.drinkingWindowStart } : {}),
      ...(indexable.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: indexable.drinkingWindowEnd } : {}),
      ...(indexable.drinkingWindowModelVersion !== undefined ? { drinkingWindowModelVersion: indexable.drinkingWindowModelVersion } : {}),
      ...(indexable.appellation !== undefined ? { appellation: indexable.appellation } : {}),
      ...(indexable.finishLength !== undefined ? { finishLength: indexable.finishLength } : {}),
      ...(indexable.classification !== undefined ? { classification: indexable.classification } : {}),
      ...(indexable.soilType !== undefined ? { soilType: indexable.soilType } : {}),
      ...(indexable.producerType !== undefined ? { producerType: indexable.producerType } : {}),
      ...(indexable.oakTreatment !== undefined ? { oakTreatment: indexable.oakTreatment } : {}),
      ...(indexable.grapeFamily !== undefined ? { grapeFamily: indexable.grapeFamily } : {}),
      ...(indexable.regionHierarchy !== undefined ? { regionHierarchy: [...indexable.regionHierarchy] } : {}),
      ...(indexable.priceBandNumeric !== undefined ? { priceBandNumeric: indexable.priceBandNumeric } : {}),
      ...(indexable.giftSuitabilityScore !== undefined ? { giftSuitabilityScore: indexable.giftSuitabilityScore } : {}),
      ...(indexable.beginnerSuitabilityScore !== undefined ? { beginnerSuitabilityScore: indexable.beginnerSuitabilityScore } : {}),
      ...(indexable.sourceRecordRefs !== undefined && indexable.sourceRecordRefs.length > 0
        ? { sourceRecordRefs: [...indexable.sourceRecordRefs] }
        : {}),
    };
  }).sort((left, right) => left.entityId.localeCompare(right.entityId));

  return {
    schemaVersion: LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    documents,
  };
}

export function buildLookupResolverProjectionArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly records: readonly EnrichedSilverRecord[];
  readonly entityIdBySourceId: ReadonlyMap<SourceRecordId, CanonicalEntityId>;
  readonly goldCanonicalLookup: ReadonlyMap<string, string>;
  readonly sourceContinuityLookup: ReadonlyMap<SourceRecordId, SourceEntityContinuityRecord>;
  readonly identityCertificatesByEntity?: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]> | undefined;
}): LookupResolverProjectionArtifact {
  const documents: LookupResolverProjectionDocument[] = args.records.map((record) => {
    const entityId = args.entityIdBySourceId.get(record.sourceId);
    if (entityId === undefined) {
      throw new Error(`Missing lookup resolver projection id mapping for sourceId=${record.sourceId}`);
    }
    const indexable = silverToIndexable(
      record,
      args.goldCanonicalLookup,
      args.sourceContinuityLookup,
    );
    const attributeHintDoc = {
      entityId,
      entityType: indexable.entityType,
      canonicalLabel: indexable.canonicalLabel,
      aliasesIdentitySafe: indexable.aliasesIdentitySafe,
      aliasesNoisyRecall: indexable.aliasesNoisyRecall,
      producer: record.producer,
      region: indexable.region ?? record.region,
      grapes: indexable.grapes,
      searchTextKo: indexable.searchTextKo,
      searchTextEn: record.searchTextEn,
      semanticSummary: indexable.semanticSummary,
      pairing: indexable.pairing,
      availability: indexable.availability,
      popularityScore: indexable.popularityScore,
      ...(indexable.vintageYear !== undefined ? { vintageYear: indexable.vintageYear } : {}),
      ...(indexable.appellation !== undefined ? { appellation: indexable.appellation } : {}),
      ...(indexable.country !== undefined ? { country: indexable.country } : {}),
      ...(indexable.regionHierarchy !== undefined ? { regionHierarchy: indexable.regionHierarchy } : {}),
      ...(indexable.grapePrimary !== undefined ? { grapePrimary: indexable.grapePrimary } : {}),
      ...(indexable.style !== undefined ? { style: indexable.style } : {}),
      ...(indexable.closure !== undefined ? { closure: indexable.closure } : {}),
      ...(indexable.priceBand !== undefined ? { priceBand: indexable.priceBand } : {}),
      ...(indexable.occasion !== undefined ? { occasion: indexable.occasion } : {}),
      ...(indexable.body !== undefined ? { body: indexable.body } : {}),
      ...(indexable.tannin !== undefined ? { tannin: indexable.tannin } : {}),
      ...(indexable.acidity !== undefined ? { acidity: indexable.acidity } : {}),
      ...(indexable.sweetness !== undefined ? { sweetness: indexable.sweetness } : {}),
      ...(indexable.finishLength !== undefined ? { finishLength: indexable.finishLength } : {}),
      ...(indexable.wineType !== undefined ? { wineType: indexable.wineType } : {}),
      ...(indexable.classification !== undefined ? { classification: indexable.classification } : {}),
      ...(indexable.alcoholPct !== undefined ? { alcoholPct: indexable.alcoholPct } : {}),
      ...(indexable.priceUsd !== undefined ? { priceUsd: indexable.priceUsd } : {}),
      ...(indexable.producerPrestige !== undefined ? { producerPrestige: indexable.producerPrestige } : {}),
      ...(indexable.criticScoreNormalized !== undefined ? { criticScoreNormalized: indexable.criticScoreNormalized } : {}),
      ...(indexable.certifications !== undefined ? { certifications: indexable.certifications } : {}),
      ...(indexable.soilType !== undefined ? { soilType: indexable.soilType } : {}),
      ...(indexable.producerType !== undefined ? { producerType: indexable.producerType } : {}),
      ...(indexable.grapeFamily !== undefined ? { grapeFamily: indexable.grapeFamily } : {}),
      ...(indexable.flavorProfiles !== undefined ? { flavorProfiles: indexable.flavorProfiles } : {}),
      ...(indexable.drinkingWindowStart !== undefined ? { drinkingWindowStart: indexable.drinkingWindowStart } : {}),
      ...(indexable.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: indexable.drinkingWindowEnd } : {}),
      ...(indexable.drinkingWindowModelVersion !== undefined ? { drinkingWindowModelVersion: indexable.drinkingWindowModelVersion } : {}),
    };
    const attributeHints = buildResolverCandidateAttributeHints(attributeHintDoc);
    return {
      entityId,
      entityType: indexable.entityType,
      canonicalLabel: indexable.canonicalLabel,
      aliasesIdentitySafe: indexable.aliasesIdentitySafe,
      identitySafeKeys: buildIdentitySafeKeys({
        entityType: indexable.entityType,
        canonicalLabel: indexable.canonicalLabel,
        aliasesIdentitySafe: indexable.aliasesIdentitySafe,
        producer: record.producer,
      }),
      ...(args.identityCertificatesByEntity?.get(entityId) !== undefined
        ? { identityCertificates: args.identityCertificatesByEntity.get(entityId)! }
        : {}),
      ...(record.producer.trim().length > 0 ? { producer: record.producer } : {}),
      ...(attributeHints !== undefined ? { attributeHints } : {}),
      ...(indexable.sourceRecordRefs !== undefined && indexable.sourceRecordRefs.length > 0
        ? { sourceRecordRefs: [...indexable.sourceRecordRefs] }
        : {}),
    };
  }).sort((left, right) => left.entityId.localeCompare(right.entityId));

  return {
    schemaVersion: LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    documents,
  };
}

export function buildLookupAmbiguityRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
  readonly curatedEntries?: readonly LookupAmbiguityRuntimeEntry[] | undefined;
}): LookupAmbiguityRuntimeArtifact {
  const entries: Record<string, LookupAmbiguityRuntimeEntry> = {};
  const severityRank = { low: 0, medium: 1, high: 2 } as const;
  for (const row of [...args.ambiguityRows].sort((left, right) => left.normalizedForm.localeCompare(right.normalizedForm))) {
    if (entries[row.normalizedForm] !== undefined) {
      throw new Error(`Duplicate ambiguity runtime normalizedForm=${row.normalizedForm}`);
    }
    entries[row.normalizedForm] = {
      normalizedForm: row.normalizedForm,
      types: [...row.ambiguityTypes],
      severity: row.severity,
      ...(row.entityIds.length > 0 ? { entityIds: [...row.entityIds] } : {}),
    };
  }
  for (const entry of [...(args.curatedEntries ?? [])].sort((left, right) => left.normalizedForm.localeCompare(right.normalizedForm))) {
    const existing = entries[entry.normalizedForm];
    if (existing === undefined) {
      entries[entry.normalizedForm] = {
        normalizedForm: entry.normalizedForm,
        types: [...entry.types].sort(),
        severity: entry.severity,
        ...(entry.entityIds !== undefined && entry.entityIds.length > 0 ? { entityIds: [...entry.entityIds] } : {}),
      };
      continue;
    }
    const mergedEntityIds = new Set<string>([
      ...(existing.entityIds ?? []),
      ...(entry.entityIds ?? []),
    ]);
    entries[entry.normalizedForm] = {
      normalizedForm: entry.normalizedForm,
      types: [...new Set([...existing.types, ...entry.types])].sort(),
      severity: severityRank[entry.severity] > severityRank[existing.severity] ? entry.severity : existing.severity,
      ...(mergedEntityIds.size > 0 ? { entityIds: [...mergedEntityIds].sort() } : {}),
    };
  }
  return {
    schemaVersion: LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    entries,
  };
}

export function buildLookupConceptRedirectRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly entries: readonly LookupConceptRedirectRuntimeEntry[];
}): LookupConceptRedirectRuntimeArtifact {
  const entries = Object.fromEntries(
    [...args.entries]
      .slice()
      .sort((left, right) => left.normalizedForm.localeCompare(right.normalizedForm))
      .map((entry) => [entry.normalizedForm, entry] as const),
  );
  return {
    schemaVersion: LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    entries,
  };
}

export function buildLookupExactSafeRuntimeArtifact(args: {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly rows: readonly LookupExactSafeRegistryRow[];
  readonly snapshotEntityIds: ReadonlySet<CanonicalEntityId>;
}): LookupExactSafeRuntimeArtifact {
  const exactEntries: Record<string, LookupExactSafeRuntimeEntry> = {};
  const compactEntries: Record<string, LookupExactSafeRuntimeEntry> = {};
  for (const row of [...args.rows].sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
    || left.surface.localeCompare(right.surface)
    || left.promotionClass.localeCompare(right.promotionClass),
  )) {
    if (!args.snapshotEntityIds.has(row.entityId)) {
      continue;
    }
    const normalizedSurface = normalizeForMatch(row.surface);
    if (normalizedSurface.length === 0) {
      throw new Error(`lookup exact-safe runtime surface normalizes to empty: ${row.surface}`);
    }
    const entry: LookupExactSafeRuntimeEntry = {
      entityId: row.entityId,
      locale: row.locale,
      certificate: {
        kind: row.promotionClass,
        normalizedSurface,
        ...(row.promotionClass === 'compact_exact_safe'
          ? { compactSurface: compactForLookup(normalizedSurface) }
          : {}),
        sourceTier: 'curated',
        singleton: true,
        collisionFree: true,
      },
    };
    const existingExact = exactEntries[normalizedSurface];
    if (existingExact !== undefined && existingExact.entityId !== entry.entityId) {
      throw new Error(
        `lookup exact-safe runtime exact collision on "${normalizedSurface}" between ${existingExact.entityId} and ${entry.entityId}`,
      );
    }
    exactEntries[normalizedSurface] = entry;
    if (row.promotionClass !== 'compact_exact_safe') {
      continue;
    }
    const compactSurface = compactForLookup(normalizedSurface);
    if (compactSurface.length === 0) {
      throw new Error(`lookup exact-safe runtime compact surface is empty for "${row.surface}"`);
    }
    const existingCompact = compactEntries[compactSurface];
    if (existingCompact !== undefined && existingCompact.entityId !== entry.entityId) {
      throw new Error(
        `lookup exact-safe runtime compact collision on "${compactSurface}" between ${existingCompact.entityId} and ${entry.entityId}`,
      );
    }
    compactEntries[compactSurface] = entry;
  }
  return {
    schemaVersion: LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION,
    snapshotId: args.snapshotId,
    generatedAt: args.generatedAt,
    exactEntries,
    compactEntries,
  };
}
