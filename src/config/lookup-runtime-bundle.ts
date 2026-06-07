import fs from 'node:fs/promises';
import { z } from 'zod';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotEntityScopeGraph } from '../infrastructure/adapter/search-snapshot-entity-scope-graph.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { SearchSnapshotReviewedFamilyRecallRegistry } from '../infrastructure/adapter/search-snapshot-reviewed-family-recall.js';
import { SearchSnapshotSemanticScopeRegistry } from '../infrastructure/adapter/search-snapshot-semantic-scope-registry.js';
import { SearchSnapshotResolverProjectionLookup } from '../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';
import { buildAliasRegistryVersion } from '../domain/alias/model/alias-registry-version.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../domain/shared/constants/search-snapshot.js';
import {
  parseTrustedLookupAliasBroadRecallRuntimeArtifact,
  parseTrustedLookupAliasRuntimeArtifact,
  parseTrustedLookupAliasRuntimeCoreArtifact,
  parseTrustedLookupAmbiguityRuntimeArtifact,
  parseTrustedLookupConceptRedirectRuntimeArtifact,
  parseTrustedLookupEntityProjectionArtifact,
  parseTrustedLookupExactSafeRuntimeArtifact,
  parseTrustedLookupResolverProjectionArtifact,
} from '../domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  buildLookupSemanticDescriptorMapFromProjectionDocuments,
  type LookupSemanticEntityDescriptor,
} from '../domain/resolver/v2/lookup-semantic-scope.js';
import {
  parseTrustedLookupReviewedFamilyRecallRuntimeArtifact,
  parseTrustedLookupScopeGraphRuntimeArtifact,
  parseTrustedLookupSemanticScopeRuntimeArtifact,
  type LookupReviewedFamilyRecallRuntimeEntry,
  type LookupScopeGraphRuntimeEdge,
  type LookupSemanticScopeRuntimeEntry,
} from '../domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import { createCanonicalEntityId } from '../domain/shared/types/index.js';
import type {
  LookupResolverProjection,
  LookupResolverProjectionPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { CanonicalEntityId } from '../domain/shared/types/index.js';
import type { AmbiguityInfo } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { LookupConceptRedirectInfo, LookupExactSafeMatch } from '../domain/resolver/v2/lookup-v2-types.js';
import type { LookupIdentityCertificate } from '../domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  buildLookupRuntimeBundleCachePayload,
  readLookupRuntimeBundleCacheProfiled,
  writeLookupRuntimeBundleCache,
  type LookupRuntimeBundleCacheReadProfile,
  type LookupRuntimeBundleCacheArtifactPaths,
  type LookupRuntimeBundleCachePayload,
} from './lookup-runtime-bundle-cache.js';

const LookupRuntimeBundleManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  artifacts: z.object({
    lookupAliasRuntimeJson: z.string().min(1),
    lookupAliasBroadRecallRuntimeJson: z.string().min(1).optional(),
    lookupExactSafeRuntimeJson: z.string().min(1),
    lookupResolverProjectionJson: z.string().min(1),
    lookupEntityProjectionJson: z.string().min(1),
    lookupSemanticScopeRuntimeJson: z.string().min(1),
    lookupReviewedFamilyRecallRuntimeJson: z.string().min(1),
    lookupScopeGraphRuntimeJson: z.string().min(1),
    lookupAmbiguityRuntimeJson: z.string().min(1),
    lookupConceptRedirectRuntimeJson: z.string().min(1),
  }).passthrough(),
  hashes: z.object({
    aliases: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseBundleManifest(
  raw: string,
  manifestPath: string,
): z.infer<typeof LookupRuntimeBundleManifestSchema> {
  try {
    return LookupRuntimeBundleManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Malformed lookup runtime bundle manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildResolverProjectionMap(
  raw: string,
  filePath: string,
  exactSafeCertificatesByEntity: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]>,
): ReadonlyMap<CanonicalEntityId, LookupResolverProjection> {
  const artifact = parseTrustedLookupResolverProjectionArtifact(raw, filePath);
  const docs = new Map<CanonicalEntityId, LookupResolverProjection>();
  for (const doc of artifact.documents) {
    const entityId = createCanonicalEntityId(doc.entityId);
    if (docs.has(entityId)) {
      throw new Error(`duplicate entity_id ${doc.entityId}`);
    }
    const runtimeDoc = doc as unknown as LookupResolverProjection;
    (runtimeDoc as { entityId: CanonicalEntityId }).entityId = entityId;
    if (runtimeDoc.identityCertificates === undefined) {
      const overlayCertificates = exactSafeCertificatesByEntity.get(entityId);
      if (overlayCertificates !== undefined) {
        (runtimeDoc as { identityCertificates: readonly LookupIdentityCertificate[] }).identityCertificates = overlayCertificates;
      }
    }
    docs.set(entityId, runtimeDoc);
  }
  if (docs.size === 0) {
    throw new Error(`Search snapshot resolver projection at ${filePath} contains zero documents`);
  }
  return docs;
}

function buildAmbiguityMap(
  raw: string,
  filePath: string,
): ReadonlyMap<string, AmbiguityInfo> {
  const artifact = parseTrustedLookupAmbiguityRuntimeArtifact(raw, filePath);
  return new Map(
    Object.entries(artifact.entries).map(([normalizedForm, entry]) => [
      normalizedForm,
      {
        types: [...entry.types],
        severity: entry.severity,
        ...(entry.entityIds !== undefined ? { entityIds: [...entry.entityIds] } : {}),
      },
    ]),
  );
}

function buildConceptRedirectMap(
  raw: string,
  filePath: string,
): ReadonlyMap<string, LookupConceptRedirectInfo> {
  const artifact = parseTrustedLookupConceptRedirectRuntimeArtifact(raw, filePath);
  return new Map(
    Object.entries(artifact.entries).map(([normalizedForm, entry]) => [normalizedForm, entry as LookupConceptRedirectInfo]),
  );
}

function buildExactSafeMaps(
  raw: string,
  filePath: string,
): {
  readonly exactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
  readonly compactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
  readonly certificatesByEntity: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]>;
} {
  const artifact = parseTrustedLookupExactSafeRuntimeArtifact(raw, filePath);
  const certificatesByEntityMutable = new Map<CanonicalEntityId, LookupIdentityCertificate[]>();
  const pushCertificate = (entityId: CanonicalEntityId, certificate: LookupIdentityCertificate): void => {
    const existing = certificatesByEntityMutable.get(entityId) ?? [];
    if (
      existing.some((entry) =>
        entry.kind === certificate.kind
        && entry.normalizedSurface === certificate.normalizedSurface
        && entry.compactSurface === certificate.compactSurface
        && entry.sourceTier === certificate.sourceTier
      )
    ) {
      return;
    }
    existing.push(certificate);
    certificatesByEntityMutable.set(entityId, existing);
  };
  for (const entry of [...Object.values(artifact.exactEntries), ...Object.values(artifact.compactEntries)]) {
    pushCertificate(createCanonicalEntityId(entry.entityId), entry.certificate);
  }
  return {
    exactEntries: new Map(
      Object.entries(artifact.exactEntries).map(([surface, entry]) => [
        surface,
        {
          entityId: createCanonicalEntityId(entry.entityId),
          locale: entry.locale,
          kind: entry.certificate.kind,
          normalizedSurface: entry.certificate.normalizedSurface,
          ...(entry.certificate.compactSurface !== undefined
            ? { compactSurface: entry.certificate.compactSurface }
            : {}),
        } satisfies LookupExactSafeMatch,
      ]),
    ),
    compactEntries: new Map(
      Object.entries(artifact.compactEntries).map(([surface, entry]) => [
        surface,
        {
          entityId: createCanonicalEntityId(entry.entityId),
          locale: entry.locale,
          kind: entry.certificate.kind,
          normalizedSurface: entry.certificate.normalizedSurface,
          ...(entry.certificate.compactSurface !== undefined
            ? { compactSurface: entry.certificate.compactSurface }
            : {}),
        } satisfies LookupExactSafeMatch,
        ]),
    ),
    certificatesByEntity: new Map(
      [...certificatesByEntityMutable.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entityId, certificates]) => [
          entityId,
          certificates
            .slice()
            .sort((left, right) =>
              left.normalizedSurface.localeCompare(right.normalizedSurface)
              || left.kind.localeCompare(right.kind),
            ),
        ]),
    ),
  };
}

export interface LookupRuntimeBundle {
  readonly cacheKey: string;
  readonly manifestPath: string;
  readonly aliasMatcher: SearchSnapshotAliasMatcher;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
  readonly semanticScopeRegistry: SearchSnapshotSemanticScopeRegistry;
  readonly reviewedFamilyRecallRegistry: SearchSnapshotReviewedFamilyRecallRegistry;
  readonly entityScopeGraph: SearchSnapshotEntityScopeGraph;
  readonly ambiguityDictionary: SearchSnapshotAmbiguityDictionary;
  readonly conceptRedirectRegistry: SearchSnapshotConceptRedirectRegistry;
  readonly exactSafeRegistry: SearchSnapshotExactSafeRegistry;
  readonly loadProfile: LookupRuntimeBundleLoadProfile;
}

export interface LookupRuntimeBundleMaterializeProfile {
  readonly aliasMatcherMs: number;
  readonly warmBroadRecallIndexesMs: number;
  readonly resolverProjectionMs: number;
  readonly semanticScopeRegistryMs: number;
  readonly reviewedFamilyRecallRegistryMs: number;
  readonly semanticDescriptorsMs: number;
  readonly entityScopeGraphMs: number;
  readonly ambiguityDictionaryMs: number;
  readonly conceptRedirectRegistryMs: number;
  readonly exactSafeRegistryMs: number;
  readonly totalMs: number;
}

export interface LookupRuntimeBundleLoadProfile {
  readonly source: 'cache' | 'artifacts';
  readonly manifestReadMs: number;
  readonly manifestParseMs: number;
  readonly cacheReadProfile?: LookupRuntimeBundleCacheReadProfile;
  readonly artifactReadMs?: number;
  readonly artifactParseMs?: {
    readonly aliasRuntimeMs: number;
    readonly aliasBroadRecallRuntimeMs: number;
    readonly exactSafeMapsMs: number;
    readonly resolverProjectionMs: number;
    readonly entityProjectionMs: number;
    readonly semanticScopeRuntimeMs: number;
    readonly reviewedFamilyRecallRuntimeMs: number;
    readonly scopeGraphRuntimeMs: number;
    readonly semanticDescriptorMapMs: number;
    readonly ambiguityRuntimeMs: number;
    readonly conceptRedirectRuntimeMs: number;
    readonly payloadBuildMs: number;
    readonly totalMs: number;
  };
  readonly materializeMs: LookupRuntimeBundleMaterializeProfile;
  readonly totalMs: number;
}

const lookupRuntimeBundleCache = new Map<string, Promise<LookupRuntimeBundle>>();
const manifestPathByCacheKey = new Map<string, string>();

function buildArtifactPaths(
  manifest: z.infer<typeof LookupRuntimeBundleManifestSchema>,
): LookupRuntimeBundleCacheArtifactPaths {
  return {
    lookupAliasRuntimeJson: manifest.artifacts.lookupAliasRuntimeJson,
    ...(manifest.artifacts.lookupAliasBroadRecallRuntimeJson !== undefined
      ? { lookupAliasBroadRecallRuntimeJson: manifest.artifacts.lookupAliasBroadRecallRuntimeJson }
      : {}),
    lookupExactSafeRuntimeJson: manifest.artifacts.lookupExactSafeRuntimeJson,
    lookupResolverProjectionJson: manifest.artifacts.lookupResolverProjectionJson,
    lookupSemanticScopeRuntimeJson: manifest.artifacts.lookupSemanticScopeRuntimeJson,
    lookupReviewedFamilyRecallRuntimeJson: manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
    lookupScopeGraphRuntimeJson: manifest.artifacts.lookupScopeGraphRuntimeJson,
    lookupAmbiguityRuntimeJson: manifest.artifacts.lookupAmbiguityRuntimeJson,
    lookupConceptRedirectRuntimeJson: manifest.artifacts.lookupConceptRedirectRuntimeJson,
  };
}

function buildExactSafeEntryLists(
  maps: {
    readonly exactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
    readonly compactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
  },
): {
  readonly exactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
  readonly compactEntries: readonly (readonly [string, LookupExactSafeMatch])[];
} {
  return {
    exactEntries: [...maps.exactEntries.entries()],
    compactEntries: [...maps.compactEntries.entries()],
  };
}

function buildResolverProjectionDocuments(
  projections: ReadonlyMap<CanonicalEntityId, LookupResolverProjection>,
): readonly (readonly [string, LookupResolverProjection])[] {
  return [...projections.entries()].map(([entityId, projection]) => [entityId, projection] as const);
}

function buildSemanticDescriptorEntries(
  descriptors: ReadonlyMap<string, LookupSemanticEntityDescriptor>,
): readonly (readonly [string, LookupSemanticEntityDescriptor])[] {
  return [...descriptors.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function buildSemanticScopeEntries(
  entries: Readonly<Record<string, LookupSemanticScopeRuntimeEntry>>,
): readonly (readonly [string, LookupSemanticScopeRuntimeEntry])[] {
  return Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));
}

function buildScopeGraphAdjacency(
  adjacency: Readonly<Record<string, readonly LookupScopeGraphRuntimeEdge[]>>,
): readonly (readonly [string, readonly LookupScopeGraphRuntimeEdge[]])[] {
  return Object.entries(adjacency).sort(([left], [right]) => left.localeCompare(right));
}

function buildReviewedFamilyRecallEntries(
  entries: Readonly<Record<string, LookupReviewedFamilyRecallRuntimeEntry>>,
): readonly (readonly [string, LookupReviewedFamilyRecallRuntimeEntry])[] {
  return Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function materializeLookupRuntimeBundleFromPayload(
  cacheKey: string,
  manifestPath: string,
  payload: LookupRuntimeBundleCachePayload,
  loadProfileBase: Omit<LookupRuntimeBundleLoadProfile, 'materializeMs' | 'totalMs'>,
): LookupRuntimeBundle {
  const materializeStartedAt = performance.now();
  const aliasMatcherStartedAt = performance.now();
  const aliasMatcher = SearchSnapshotAliasMatcher.fromRuntimeArtifact(
    payload.aliasRuntimeArtifact,
    buildAliasRegistryVersion({
      source: 'snapshot_manifest',
      aliasCount: payload.aliasRuntimeArtifact.aliases.length,
      snapshotId: payload.snapshotId,
      aliasContentHash: payload.aliasContentHash,
    }),
    payload.aliasBroadRecallRuntimeArtifact,
  );
  const aliasMatcherMs = roundMs(performance.now() - aliasMatcherStartedAt);
  const warmBroadRecallIndexesStartedAt = performance.now();
  aliasMatcher.warmBroadRecallIndexes();
  const warmBroadRecallIndexesMs = roundMs(performance.now() - warmBroadRecallIndexesStartedAt);

  const resolverProjectionStartedAt = performance.now();
  const resolverProjection = new Map<CanonicalEntityId, LookupResolverProjection>();
  for (const [entityId, projection] of payload.resolverProjectionDocuments) {
    const canonicalEntityId = createCanonicalEntityId(entityId);
    if (resolverProjection.has(canonicalEntityId)) {
      throw new Error(`duplicate cached resolver projection entity_id ${entityId}`);
    }
    resolverProjection.set(canonicalEntityId, projection);
  }
  const resolverProjectionMs = roundMs(performance.now() - resolverProjectionStartedAt);

  const semanticScopeRegistryStartedAt = performance.now();
  const semanticScopeRegistry = new SearchSnapshotSemanticScopeRegistry(
    payload.semanticScopeEntries.map(([, entry]) => entry),
    new Map(
      Object.entries(payload.semanticScopeComponentSurfaces ?? {}).map(
        ([key, surfaces]) => [key, new Set(surfaces)] as const,
      ),
    ),
  );
  const semanticScopeRegistryMs = roundMs(performance.now() - semanticScopeRegistryStartedAt);
  const reviewedFamilyRecallRegistryStartedAt = performance.now();
  const reviewedFamilyRecallRegistry = new SearchSnapshotReviewedFamilyRecallRegistry(
    payload.reviewedFamilyRecallEntries.map(([, entry]) => entry),
  );
  const reviewedFamilyRecallRegistryMs = roundMs(
    performance.now() - reviewedFamilyRecallRegistryStartedAt,
  );
  const semanticDescriptorsStartedAt = performance.now();
  const semanticDescriptors = new Map(payload.semanticDescriptors);
  const semanticDescriptorsMs = roundMs(performance.now() - semanticDescriptorsStartedAt);
  const resolverProjectionLookupStartedAt = performance.now();
  const resolverProjectionLookup = new SearchSnapshotResolverProjectionLookup(resolverProjection);
  const resolverProjectionLookupMs = roundMs(performance.now() - resolverProjectionLookupStartedAt);
  const entityScopeGraphStartedAt = performance.now();
  const entityScopeGraph = new SearchSnapshotEntityScopeGraph(
    new Map(payload.scopeGraphAdjacency),
    semanticDescriptors,
  );
  const entityScopeGraphMs = roundMs(performance.now() - entityScopeGraphStartedAt);
  const ambiguityDictionaryStartedAt = performance.now();
  const ambiguityDictionary = new SearchSnapshotAmbiguityDictionary(new Map(payload.ambiguityEntries));
  const ambiguityDictionaryMs = roundMs(performance.now() - ambiguityDictionaryStartedAt);
  const conceptRedirectRegistryStartedAt = performance.now();
  const conceptRedirectRegistry = new SearchSnapshotConceptRedirectRegistry(
    new Map(payload.conceptRedirectEntries),
  );
  const conceptRedirectRegistryMs = roundMs(performance.now() - conceptRedirectRegistryStartedAt);
  const exactSafeRegistryStartedAt = performance.now();
  const exactSafeRegistry = new SearchSnapshotExactSafeRegistry(
    new Map(payload.exactEntries),
    new Map(payload.compactEntries),
  );
  const exactSafeRegistryMs = roundMs(performance.now() - exactSafeRegistryStartedAt);
  const materializeMs: LookupRuntimeBundleMaterializeProfile = {
    aliasMatcherMs,
    warmBroadRecallIndexesMs,
    resolverProjectionMs: roundMs(resolverProjectionMs + resolverProjectionLookupMs),
    semanticScopeRegistryMs,
    reviewedFamilyRecallRegistryMs,
    semanticDescriptorsMs,
    entityScopeGraphMs,
    ambiguityDictionaryMs,
    conceptRedirectRegistryMs,
    exactSafeRegistryMs,
    totalMs: roundMs(performance.now() - materializeStartedAt),
  };

  return {
    cacheKey,
    manifestPath,
    aliasMatcher,
    resolverProjectionLookup,
    semanticScopeRegistry,
    reviewedFamilyRecallRegistry,
    entityScopeGraph,
    ambiguityDictionary,
    conceptRedirectRegistry,
    exactSafeRegistry,
    loadProfile: {
      ...loadProfileBase,
      materializeMs,
      totalMs: roundMs(
        loadProfileBase.manifestReadMs
        + loadProfileBase.manifestParseMs
        + (loadProfileBase.cacheReadProfile === undefined
          ? 0
          : loadProfileBase.cacheReadProfile.readMs
            + loadProfileBase.cacheReadProfile.deserializeMs
            + loadProfileBase.cacheReadProfile.validateMs)
        + (loadProfileBase.artifactReadMs ?? 0)
        + (loadProfileBase.artifactParseMs?.totalMs ?? 0)
        + materializeMs.totalMs,
      ),
    },
  };
}

async function loadLookupRuntimeBundleFromArtifacts(
  cacheKey: string,
  manifestPath: string,
  manifest: z.infer<typeof LookupRuntimeBundleManifestSchema>,
  loadProfileBase: Omit<LookupRuntimeBundleLoadProfile, 'source' | 'materializeMs' | 'totalMs' | 'artifactReadMs' | 'artifactParseMs'>,
): Promise<LookupRuntimeBundle> {
  const artifactReadStartedAt = performance.now();
  const [
    aliasRuntimeRaw,
    aliasBroadRecallRuntimeRaw,
    exactSafeRuntimeRaw,
    resolverProjectionRaw,
    entityProjectionRaw,
    semanticScopeRuntimeRaw,
    reviewedFamilyRecallRuntimeRaw,
    scopeGraphRuntimeRaw,
    ambiguityRuntimeRaw,
    conceptRedirectRuntimeRaw,
  ] = await Promise.all([
    fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
    manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? Promise.resolve(undefined)
      : fs.readFile(manifest.artifacts.lookupAliasBroadRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupEntityProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupSemanticScopeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupScopeGraphRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupAmbiguityRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, 'utf8'),
  ]);
  const artifactReadMs = roundMs(performance.now() - artifactReadStartedAt);
  const artifactParseStartedAt = performance.now();
  const aliasRuntimeStartedAt = performance.now();
  const aliasRuntimeArtifact = manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
    ? parseTrustedLookupAliasRuntimeArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    )
    : parseTrustedLookupAliasRuntimeCoreArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    );
  const aliasRuntimeMs = roundMs(performance.now() - aliasRuntimeStartedAt);
  const aliasBroadRecallRuntimeStartedAt = performance.now();
  const aliasBroadRecallRuntimeArtifact =
    aliasBroadRecallRuntimeRaw === undefined || manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? undefined
      : parseTrustedLookupAliasBroadRecallRuntimeArtifact(
        aliasBroadRecallRuntimeRaw,
        manifest.artifacts.lookupAliasBroadRecallRuntimeJson,
      );
  const aliasBroadRecallRuntimeMs = roundMs(performance.now() - aliasBroadRecallRuntimeStartedAt);

  const exactSafeMapsStartedAt = performance.now();
  const exactSafeMaps = buildExactSafeMaps(
    exactSafeRuntimeRaw,
    manifest.artifacts.lookupExactSafeRuntimeJson,
  );
  const exactSafeMapsMs = roundMs(performance.now() - exactSafeMapsStartedAt);
  const resolverProjectionStartedAt = performance.now();
  const resolverProjection = buildResolverProjectionMap(
    resolverProjectionRaw,
    manifest.artifacts.lookupResolverProjectionJson,
    exactSafeMaps.certificatesByEntity,
  );
  const resolverProjectionMs = roundMs(performance.now() - resolverProjectionStartedAt);
  const entityProjectionStartedAt = performance.now();
  const entityProjectionArtifact = parseTrustedLookupEntityProjectionArtifact(
    entityProjectionRaw,
    manifest.artifacts.lookupEntityProjectionJson,
  );
  const entityProjectionMs = roundMs(performance.now() - entityProjectionStartedAt);
  const semanticScopeRuntimeStartedAt = performance.now();
  const semanticScopeRuntimeArtifact = parseTrustedLookupSemanticScopeRuntimeArtifact(
    semanticScopeRuntimeRaw,
    manifest.artifacts.lookupSemanticScopeRuntimeJson,
  );
  const semanticScopeRuntimeMs = roundMs(performance.now() - semanticScopeRuntimeStartedAt);
  const reviewedFamilyRecallRuntimeStartedAt = performance.now();
  const reviewedFamilyRecallRuntimeArtifact = parseTrustedLookupReviewedFamilyRecallRuntimeArtifact(
    reviewedFamilyRecallRuntimeRaw,
    manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
  );
  const reviewedFamilyRecallRuntimeMs = roundMs(
    performance.now() - reviewedFamilyRecallRuntimeStartedAt,
  );
  const scopeGraphRuntimeStartedAt = performance.now();
  const scopeGraphRuntimeArtifact = parseTrustedLookupScopeGraphRuntimeArtifact(
    scopeGraphRuntimeRaw,
    manifest.artifacts.lookupScopeGraphRuntimeJson,
  );
  const scopeGraphRuntimeMs = roundMs(performance.now() - scopeGraphRuntimeStartedAt);
  const semanticDescriptorMapStartedAt = performance.now();
  const semanticDescriptorMap = buildLookupSemanticDescriptorMapFromProjectionDocuments(
    entityProjectionArtifact.documents,
  );
  const semanticDescriptorMapMs = roundMs(performance.now() - semanticDescriptorMapStartedAt);
  const ambiguityRuntimeStartedAt = performance.now();
  const ambiguityEntries = buildAmbiguityMap(
    ambiguityRuntimeRaw,
    manifest.artifacts.lookupAmbiguityRuntimeJson,
  );
  const ambiguityRuntimeMs = roundMs(performance.now() - ambiguityRuntimeStartedAt);
  const conceptRedirectRuntimeStartedAt = performance.now();
  const conceptRedirectEntries = buildConceptRedirectMap(
    conceptRedirectRuntimeRaw,
    manifest.artifacts.lookupConceptRedirectRuntimeJson,
  );
  const conceptRedirectRuntimeMs = roundMs(performance.now() - conceptRedirectRuntimeStartedAt);

  const payloadBuildStartedAt = performance.now();
  const payload = buildLookupRuntimeBundleCachePayload({
    snapshotId: manifest.snapshotId,
    aliasContentHash: manifest.hashes.aliases,
    manifestPath,
    artifactPaths: buildArtifactPaths(manifest),
    aliasRuntimeArtifact,
    ...(aliasBroadRecallRuntimeArtifact !== undefined
      ? { aliasBroadRecallRuntimeArtifact }
      : {}),
    ...buildExactSafeEntryLists(exactSafeMaps),
    resolverProjectionDocuments: buildResolverProjectionDocuments(resolverProjection),
    semanticDescriptors: buildSemanticDescriptorEntries(semanticDescriptorMap),
    semanticScopeEntries: buildSemanticScopeEntries(semanticScopeRuntimeArtifact.entries),
    semanticScopeComponentSurfaces: semanticScopeRuntimeArtifact.componentSurfaces ?? {},
    reviewedFamilyRecallEntries: buildReviewedFamilyRecallEntries(reviewedFamilyRecallRuntimeArtifact.entries),
    scopeGraphAdjacency: buildScopeGraphAdjacency(scopeGraphRuntimeArtifact.adjacency),
    ambiguityEntries: [...ambiguityEntries.entries()],
    conceptRedirectEntries: [...conceptRedirectEntries.entries()],
  });
  const payloadBuildMs = roundMs(performance.now() - payloadBuildStartedAt);
  const artifactParseMs = {
    aliasRuntimeMs,
    aliasBroadRecallRuntimeMs,
    exactSafeMapsMs,
    resolverProjectionMs,
    entityProjectionMs,
    semanticScopeRuntimeMs,
    reviewedFamilyRecallRuntimeMs,
    scopeGraphRuntimeMs,
    semanticDescriptorMapMs,
    ambiguityRuntimeMs,
    conceptRedirectRuntimeMs,
    payloadBuildMs,
    totalMs: roundMs(performance.now() - artifactParseStartedAt),
  };

  void writeLookupRuntimeBundleCache(payload).catch(() => {
    // Cache backfill is an optimization only. Serving authority remains the
    // parsed snapshot artifacts, so cache write failures must not block boot.
  });

  return materializeLookupRuntimeBundleFromPayload(cacheKey, manifestPath, payload, {
    ...loadProfileBase,
    source: 'artifacts',
    artifactReadMs,
    artifactParseMs,
  });
}

export async function loadLookupRuntimeBundle(
  cacheKey: string,
  manifestPath: string,
): Promise<LookupRuntimeBundle> {
  const knownManifestPath = manifestPathByCacheKey.get(cacheKey);
  if (knownManifestPath !== undefined && knownManifestPath !== manifestPath) {
    throw new Error(
      `Lookup runtime bundle cache key "${cacheKey}" reused with different manifestPath: ${knownManifestPath} vs ${manifestPath}`,
    );
  }
  const existing = lookupRuntimeBundleCache.get(cacheKey);
  if (existing !== undefined) {
    return await existing;
  }

  manifestPathByCacheKey.set(cacheKey, manifestPath);
  const pending = (async (): Promise<LookupRuntimeBundle> => {
    const manifestReadStartedAt = performance.now();
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifestReadMs = roundMs(performance.now() - manifestReadStartedAt);
    const manifestParseStartedAt = performance.now();
    const manifest = parseBundleManifest(manifestRaw, manifestPath);
    const manifestParseMs = roundMs(performance.now() - manifestParseStartedAt);
    const artifactPaths = buildArtifactPaths(manifest);
    const cacheResult = await readLookupRuntimeBundleCacheProfiled({
      manifestPath,
      snapshotId: manifest.snapshotId,
      aliasContentHash: manifest.hashes.aliases,
      artifactPaths,
    });
    const loadProfileBase = {
      manifestReadMs,
      manifestParseMs,
      cacheReadProfile: cacheResult.profile,
    } satisfies Omit<LookupRuntimeBundleLoadProfile, 'source' | 'materializeMs' | 'totalMs'>;
    if (cacheResult.payload !== undefined) {
      return materializeLookupRuntimeBundleFromPayload(
        cacheKey,
        manifestPath,
        cacheResult.payload,
        {
          ...loadProfileBase,
          source: 'cache',
        },
      );
    }
    return await loadLookupRuntimeBundleFromArtifacts(cacheKey, manifestPath, manifest, loadProfileBase);
  })();

  lookupRuntimeBundleCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    lookupRuntimeBundleCache.delete(cacheKey);
    manifestPathByCacheKey.delete(cacheKey);
    throw error;
  }
}

export function clearLookupRuntimeBundleCacheForTests(): void {
  lookupRuntimeBundleCache.clear();
  manifestPathByCacheKey.clear();
}

export async function backfillLookupRuntimeBundleCacheFromManifest(
  manifestPath: string,
): Promise<void> {
  const manifestRaw = await fs.readFile(manifestPath, 'utf8');
  const manifest = parseBundleManifest(manifestRaw, manifestPath);
  const [
    aliasRuntimeRaw,
    aliasBroadRecallRuntimeRaw,
    exactSafeRuntimeRaw,
    resolverProjectionRaw,
    entityProjectionRaw,
    semanticScopeRuntimeRaw,
    reviewedFamilyRecallRuntimeRaw,
    scopeGraphRuntimeRaw,
    ambiguityRuntimeRaw,
    conceptRedirectRuntimeRaw,
  ] = await Promise.all([
    fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
    manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? Promise.resolve(undefined)
      : fs.readFile(manifest.artifacts.lookupAliasBroadRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupEntityProjectionJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupSemanticScopeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupScopeGraphRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupAmbiguityRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, 'utf8'),
  ]);
  const aliasRuntimeArtifact = manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
    ? parseTrustedLookupAliasRuntimeArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    )
    : parseTrustedLookupAliasRuntimeCoreArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    );
  const aliasBroadRecallRuntimeArtifact =
    aliasBroadRecallRuntimeRaw === undefined || manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? undefined
      : parseTrustedLookupAliasBroadRecallRuntimeArtifact(
        aliasBroadRecallRuntimeRaw,
        manifest.artifacts.lookupAliasBroadRecallRuntimeJson,
      );
  const exactSafeMaps = buildExactSafeMaps(
    exactSafeRuntimeRaw,
    manifest.artifacts.lookupExactSafeRuntimeJson,
  );
  const resolverProjection = buildResolverProjectionMap(
    resolverProjectionRaw,
    manifest.artifacts.lookupResolverProjectionJson,
    exactSafeMaps.certificatesByEntity,
  );
  const entityProjectionArtifact = parseTrustedLookupEntityProjectionArtifact(
    entityProjectionRaw,
    manifest.artifacts.lookupEntityProjectionJson,
  );
  const semanticScopeRuntimeArtifact = parseTrustedLookupSemanticScopeRuntimeArtifact(
    semanticScopeRuntimeRaw,
    manifest.artifacts.lookupSemanticScopeRuntimeJson,
  );
  const reviewedFamilyRecallRuntimeArtifact = parseTrustedLookupReviewedFamilyRecallRuntimeArtifact(
    reviewedFamilyRecallRuntimeRaw,
    manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
  );
  const scopeGraphRuntimeArtifact = parseTrustedLookupScopeGraphRuntimeArtifact(
    scopeGraphRuntimeRaw,
    manifest.artifacts.lookupScopeGraphRuntimeJson,
  );
  const semanticDescriptorMap = buildLookupSemanticDescriptorMapFromProjectionDocuments(
    entityProjectionArtifact.documents,
  );
  const ambiguityEntries = buildAmbiguityMap(
    ambiguityRuntimeRaw,
    manifest.artifacts.lookupAmbiguityRuntimeJson,
  );
  const conceptRedirectEntries = buildConceptRedirectMap(
    conceptRedirectRuntimeRaw,
    manifest.artifacts.lookupConceptRedirectRuntimeJson,
  );

  await writeLookupRuntimeBundleCache(
    buildLookupRuntimeBundleCachePayload({
      snapshotId: manifest.snapshotId,
      aliasContentHash: manifest.hashes.aliases,
      manifestPath,
      artifactPaths: buildArtifactPaths(manifest),
      aliasRuntimeArtifact,
      ...(aliasBroadRecallRuntimeArtifact !== undefined
        ? { aliasBroadRecallRuntimeArtifact }
        : {}),
      ...buildExactSafeEntryLists(exactSafeMaps),
    resolverProjectionDocuments: buildResolverProjectionDocuments(resolverProjection),
    semanticDescriptors: buildSemanticDescriptorEntries(semanticDescriptorMap),
    semanticScopeEntries: buildSemanticScopeEntries(semanticScopeRuntimeArtifact.entries),
    semanticScopeComponentSurfaces: semanticScopeRuntimeArtifact.componentSurfaces ?? {},
    reviewedFamilyRecallEntries: buildReviewedFamilyRecallEntries(reviewedFamilyRecallRuntimeArtifact.entries),
    scopeGraphAdjacency: buildScopeGraphAdjacency(scopeGraphRuntimeArtifact.adjacency),
      ambiguityEntries: [...ambiguityEntries.entries()],
      conceptRedirectEntries: [...conceptRedirectEntries.entries()],
    }),
  );
}
