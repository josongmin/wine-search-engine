import fs from 'node:fs/promises';
import { z } from 'zod';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotEntityLookup } from '../infrastructure/adapter/search-snapshot-entity-lookup.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { SearchSnapshotResolverProjectionLookup } from '../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';
import { buildAliasRegistryVersion } from '../domain/alias/model/alias-registry-version.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../domain/shared/constants/search-snapshot.js';
import {
  parseLookupAmbiguityRuntimeArtifact,
  parseLookupConceptRedirectRuntimeArtifact,
  parseLookupEntityProjectionArtifact,
  parseLookupExactSafeRuntimeArtifact,
  parseLookupResolverProjectionArtifact,
  parseTrustedLookupAliasRuntimeArtifact,
} from '../domain/shared/types/search-snapshot-lookup-runtime.js';
import { createCanonicalEntityId } from '../domain/shared/types/index.js';
import type { LookupResolverProjection } from '../application/search/port/search-pipeline-deps.port.js';
import type { CanonicalEntityId } from '../domain/shared/types/index.js';
import type { RetrievalDocument } from '../domain/retrieval/model/retrieval-document.js';
import type { AmbiguityInfo } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { LookupConceptRedirectInfo, LookupExactSafeMatch } from '../domain/resolver/v2/lookup-v2-types.js';

const LookupRuntimeBundleManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  artifacts: z.object({
    lookupAliasRuntimeJson: z.string().min(1),
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
): ReadonlyMap<CanonicalEntityId, LookupResolverProjection> {
  const artifact = parseLookupResolverProjectionArtifact(raw, filePath);
  const docs = new Map<CanonicalEntityId, LookupResolverProjection>();
  for (const doc of artifact.documents) {
    const entityId = createCanonicalEntityId(doc.entityId);
    if (docs.has(entityId)) {
      throw new Error(`duplicate entity_id ${doc.entityId}`);
    }
    docs.set(entityId, {
      entityId,
      entityType: doc.entityType,
      canonicalLabel: doc.canonicalLabel,
      aliasesIdentitySafe: [...doc.aliasesIdentitySafe],
      identitySafeKeys: [...doc.identitySafeKeys],
      ...(doc.identityCertificates !== undefined ? { identityCertificates: doc.identityCertificates } : {}),
      ...(doc.producer !== undefined ? { producer: doc.producer } : {}),
      ...(doc.attributeHints !== undefined ? { attributeHints: doc.attributeHints } : {}),
      ...(doc.sourceRecordRefs !== undefined ? { sourceRecordRefs: doc.sourceRecordRefs } : {}),
    });
  }
  if (docs.size === 0) {
    throw new Error(`Search snapshot resolver projection at ${filePath} contains zero documents`);
  }
  return docs;
}

function buildEntityProjectionMap(
  raw: string,
  filePath: string,
): ReadonlyMap<CanonicalEntityId, RetrievalDocument> {
  const artifact = parseLookupEntityProjectionArtifact(raw, filePath);
  const docs = new Map<CanonicalEntityId, RetrievalDocument>();
  for (const doc of artifact.documents) {
    const entityId = createCanonicalEntityId(doc.entityId);
    if (docs.has(entityId)) {
      throw new Error(`duplicate entity_id ${doc.entityId}`);
    }
    docs.set(entityId, {
      ...(doc as unknown as Omit<RetrievalDocument, 'entityId'>),
      entityId,
    });
  }
  if (docs.size === 0) {
    throw new Error(`Search snapshot entity lookup at ${filePath} contains zero documents`);
  }
  return docs;
}

function buildAmbiguityMap(
  raw: string,
  filePath: string,
): ReadonlyMap<string, AmbiguityInfo> {
  const artifact = parseLookupAmbiguityRuntimeArtifact(raw, filePath);
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
  const artifact = parseLookupConceptRedirectRuntimeArtifact(raw, filePath);
  return new Map(
    Object.entries(artifact.entries).map(([normalizedForm, entry]) => [
      normalizedForm,
      {
        conceptClass: entry.conceptClass,
        redirectReason: entry.redirectReason,
        sourceEvidence: entry.sourceEvidence,
      },
    ]),
  );
}

function buildExactSafeMaps(
  raw: string,
  filePath: string,
): {
  readonly exactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
  readonly compactEntries: ReadonlyMap<string, LookupExactSafeMatch>;
} {
  const artifact = parseLookupExactSafeRuntimeArtifact(raw, filePath);
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
  };
}

export interface LookupRuntimeBundle {
  readonly cacheKey: string;
  readonly manifestPath: string;
  readonly aliasMatcher: SearchSnapshotAliasMatcher;
  readonly entityLookup: SearchSnapshotEntityLookup;
  readonly resolverProjectionLookup: SearchSnapshotResolverProjectionLookup;
  readonly ambiguityDictionary: SearchSnapshotAmbiguityDictionary;
  readonly conceptRedirectRegistry: SearchSnapshotConceptRedirectRegistry;
  readonly exactSafeRegistry: SearchSnapshotExactSafeRegistry;
}

const lookupRuntimeBundleCache = new Map<string, Promise<LookupRuntimeBundle>>();
const manifestPathByCacheKey = new Map<string, string>();

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
    const [
      aliasRuntimeRaw,
      exactSafeRuntimeRaw,
      resolverProjectionRaw,
      entityProjectionRaw,
      ambiguityRuntimeRaw,
      conceptRedirectRuntimeRaw,
    ] = await Promise.all([
      fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupResolverProjectionJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupEntityProjectionJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupAmbiguityRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, 'utf8'),
    ]);
    const aliasRuntimeArtifact = parseTrustedLookupAliasRuntimeArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    );

    const [
      aliasMatcher,
      entityLookup,
      resolverProjectionLookup,
      ambiguityDictionary,
      conceptRedirectRegistry,
      exactSafeRegistry,
    ] = await Promise.all([
      Promise.resolve(
        SearchSnapshotAliasMatcher.fromRuntimeArtifact(
          aliasRuntimeArtifact,
          buildAliasRegistryVersion({
            source: 'snapshot_manifest',
            aliasCount: aliasRuntimeArtifact.aliases.length,
            snapshotId: manifest.snapshotId,
            aliasContentHash: manifest.hashes.aliases,
          }),
        ),
      ),
      Promise.resolve(
        new SearchSnapshotEntityLookup(
          buildEntityProjectionMap(
            entityProjectionRaw,
            manifest.artifacts.lookupEntityProjectionJson,
          ),
        ),
      ),
      Promise.resolve(
        new SearchSnapshotResolverProjectionLookup(
          buildResolverProjectionMap(
            resolverProjectionRaw,
            manifest.artifacts.lookupResolverProjectionJson,
          ),
        ),
      ),
      Promise.resolve(
        new SearchSnapshotAmbiguityDictionary(
          buildAmbiguityMap(
            ambiguityRuntimeRaw,
            manifest.artifacts.lookupAmbiguityRuntimeJson,
          ),
        ),
      ),
      Promise.resolve(
        new SearchSnapshotConceptRedirectRegistry(
          buildConceptRedirectMap(
            conceptRedirectRuntimeRaw,
            manifest.artifacts.lookupConceptRedirectRuntimeJson,
          ),
        ),
      ),
      Promise.resolve((() => {
        const { exactEntries, compactEntries } = buildExactSafeMaps(
          exactSafeRuntimeRaw,
          manifest.artifacts.lookupExactSafeRuntimeJson,
        );
        return new SearchSnapshotExactSafeRegistry(exactEntries, compactEntries);
      })()),
    ]);

    if (aliasMatcher === undefined) {
      throw new Error(`Lookup runtime bundle failed to load alias runtime from ${manifestPath}`);
    }

    return {
      cacheKey,
      manifestPath,
      aliasMatcher,
      entityLookup,
      resolverProjectionLookup,
      ambiguityDictionary,
      conceptRedirectRegistry,
      exactSafeRegistry,
    };
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
