import fs from 'node:fs/promises';
import { z } from 'zod';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { SearchSnapshotResolverProjectionLookup } from '../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';
import { buildAliasRegistryVersion } from '../domain/alias/model/alias-registry-version.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../domain/shared/constants/search-snapshot.js';
import {
  parseTrustedLookupAliasBroadRecallRuntimeArtifact,
  parseTrustedLookupAliasRuntimeArtifact,
  parseTrustedLookupAliasRuntimeCoreArtifact,
  parseTrustedLookupAmbiguityRuntimeArtifact,
  parseTrustedLookupConceptRedirectRuntimeArtifact,
  parseTrustedLookupExactSafeRuntimeArtifact,
  parseTrustedLookupResolverProjectionArtifact,
} from '../domain/shared/types/search-snapshot-lookup-runtime.js';
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
  writeLookupRuntimeBundleCache,
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
  readonly ambiguityDictionary: SearchSnapshotAmbiguityDictionary;
  readonly conceptRedirectRegistry: SearchSnapshotConceptRedirectRegistry;
  readonly exactSafeRegistry: SearchSnapshotExactSafeRegistry;
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

function materializeLookupRuntimeBundleFromPayload(
  cacheKey: string,
  manifestPath: string,
  payload: LookupRuntimeBundleCachePayload,
): LookupRuntimeBundle {
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
  aliasMatcher.warmBroadRecallIndexes();

  const resolverProjection = new Map<CanonicalEntityId, LookupResolverProjection>();
  for (const [entityId, projection] of payload.resolverProjectionDocuments) {
    const canonicalEntityId = createCanonicalEntityId(entityId);
    if (resolverProjection.has(canonicalEntityId)) {
      throw new Error(`duplicate cached resolver projection entity_id ${entityId}`);
    }
    resolverProjection.set(canonicalEntityId, projection);
  }

  return {
    cacheKey,
    manifestPath,
    aliasMatcher,
    resolverProjectionLookup: new SearchSnapshotResolverProjectionLookup(resolverProjection),
    ambiguityDictionary: new SearchSnapshotAmbiguityDictionary(new Map(payload.ambiguityEntries)),
    conceptRedirectRegistry: new SearchSnapshotConceptRedirectRegistry(new Map(payload.conceptRedirectEntries)),
    exactSafeRegistry: new SearchSnapshotExactSafeRegistry(
      new Map(payload.exactEntries),
      new Map(payload.compactEntries),
    ),
  };
}

async function loadLookupRuntimeBundleFromArtifacts(
  cacheKey: string,
  manifestPath: string,
  manifest: z.infer<typeof LookupRuntimeBundleManifestSchema>,
): Promise<LookupRuntimeBundle> {
  const [
    aliasRuntimeRaw,
    aliasBroadRecallRuntimeRaw,
    exactSafeRuntimeRaw,
    resolverProjectionRaw,
    ambiguityRuntimeRaw,
    conceptRedirectRuntimeRaw,
  ] = await Promise.all([
    fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
    manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? Promise.resolve(undefined)
      : fs.readFile(manifest.artifacts.lookupAliasBroadRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
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
  const ambiguityEntries = buildAmbiguityMap(
    ambiguityRuntimeRaw,
    manifest.artifacts.lookupAmbiguityRuntimeJson,
  );
  const conceptRedirectEntries = buildConceptRedirectMap(
    conceptRedirectRuntimeRaw,
    manifest.artifacts.lookupConceptRedirectRuntimeJson,
  );

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
    ambiguityEntries: [...ambiguityEntries.entries()],
    conceptRedirectEntries: [...conceptRedirectEntries.entries()],
  });

  return materializeLookupRuntimeBundleFromPayload(cacheKey, manifestPath, payload);
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
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = parseBundleManifest(manifestRaw, manifestPath);
    return await loadLookupRuntimeBundleFromArtifacts(cacheKey, manifestPath, manifest);
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
    ambiguityRuntimeRaw,
    conceptRedirectRuntimeRaw,
  ] = await Promise.all([
    fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
    manifest.artifacts.lookupAliasBroadRecallRuntimeJson === undefined
      ? Promise.resolve(undefined)
      : fs.readFile(manifest.artifacts.lookupAliasBroadRecallRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
    fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
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
      ambiguityEntries: [...ambiguityEntries.entries()],
      conceptRedirectEntries: [...conceptRedirectEntries.entries()],
    }),
  );
}
