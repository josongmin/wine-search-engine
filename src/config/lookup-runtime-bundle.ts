import fs from 'node:fs/promises';
import { z } from 'zod';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotEntityLookup } from '../infrastructure/adapter/search-snapshot-entity-lookup.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { buildResolverCandidateAttributeHints } from '../application/search/search-usecase-entity-attribute-projection.js';
import { buildAliasRegistryVersion } from '../domain/alias/model/alias-registry-version.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../domain/shared/constants/search-snapshot.js';
import {
  parseLookupAmbiguityRuntimeArtifact,
  parseLookupConceptRedirectRuntimeArtifact,
  parseLookupEntityProjectionArtifact,
  parseLookupExactSafeRuntimeArtifact,
  parseTrustedLookupAliasRuntimeArtifact,
} from '../domain/shared/types/search-snapshot-lookup-runtime.js';
import { createCanonicalEntityId } from '../domain/shared/types/index.js';
import type {
  LookupResolverProjection,
  LookupResolverProjectionPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { CanonicalEntityId } from '../domain/shared/types/index.js';
import type { RetrievalDocument } from '../domain/retrieval/model/retrieval-document.js';
import type { AmbiguityInfo } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { LookupConceptRedirectInfo, LookupExactSafeMatch } from '../domain/resolver/v2/lookup-v2-types.js';
import type { LookupIdentityCertificate } from '../domain/shared/types/search-snapshot-lookup-runtime.js';
import { buildNormalizedQueryViews } from '../domain/query/service/query-normalizer.js';

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

function buildResolverProjectionFromEntityDoc(
  entityId: CanonicalEntityId,
  doc: RetrievalDocument,
  exactSafeCertificatesByEntity: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]>,
): LookupResolverProjection {
  const overlayDoc = doc as RetrievalDocument & {
    readonly identitySafeKeys?: readonly string[] | undefined;
    readonly identityCertificates?: LookupResolverProjection['identityCertificates'];
    readonly attributeHints?: Readonly<Record<string, unknown>> | undefined;
    readonly sourceRecordRefs?: LookupResolverProjection['sourceRecordRefs'];
  };
  const identitySafeKeys = overlayDoc.identitySafeKeys !== undefined
    ? [...overlayDoc.identitySafeKeys]
    : buildIdentitySafeKeysFromEntityDoc(doc);
  const identityCertificates = overlayDoc.identityCertificates ?? exactSafeCertificatesByEntity.get(entityId);
  const attributeHints = overlayDoc.attributeHints ?? buildResolverCandidateAttributeHints(doc);
  return {
    entityId,
    entityType: doc.entityType,
    canonicalLabel: doc.canonicalLabel,
    aliasesIdentitySafe: [...doc.aliasesIdentitySafe],
    identitySafeKeys,
    ...(identityCertificates !== undefined ? { identityCertificates } : {}),
    ...(doc.producer !== undefined ? { producer: doc.producer } : {}),
    ...(attributeHints !== undefined ? { attributeHints } : {}),
    ...(overlayDoc.sourceRecordRefs !== undefined ? { sourceRecordRefs: overlayDoc.sourceRecordRefs } : {}),
  };
}

class EntityBackedResolverProjectionLookup implements LookupResolverProjectionPort {
  private readonly cache = new Map<CanonicalEntityId, LookupResolverProjection>();

  constructor(
    private readonly entityDocs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>,
    private readonly exactSafeCertificatesByEntity: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]>,
  ) {}

  async getResolverProjections(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, LookupResolverProjection>> {
    const docs = new Map<CanonicalEntityId, LookupResolverProjection>();
    for (const entityId of entityIds) {
      let projection = this.cache.get(entityId);
      if (projection === undefined) {
        const entityDoc = this.entityDocs.get(entityId);
        if (entityDoc === undefined) {
          continue;
        }
        projection = buildResolverProjectionFromEntityDoc(
          entityId,
          entityDoc,
          this.exactSafeCertificatesByEntity,
        );
        this.cache.set(entityId, projection);
      }
      docs.set(entityId, projection);
    }
    return docs;
  }
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

function isProducerOnlyAliasForDistinctWine(doc: RetrievalDocument, identitySurface: string): boolean {
  if (doc.entityType !== 'wine' || typeof doc.producer !== 'string' || doc.producer.trim().length === 0) {
    return false;
  }

  const producerKey = coreIdentityKey(doc.producer);
  const aliasKey = coreIdentityKey(identitySurface);
  if (producerKey.length === 0 || aliasKey !== producerKey) {
    return false;
  }

  const canonicalKey = coreIdentityKey(doc.canonicalLabel);
  return removeAllOccurrences(canonicalKey, producerKey).length > 0;
}

function buildIdentitySafeKeysFromEntityDoc(doc: RetrievalDocument): readonly string[] {
  const keys = new Set<string>();
  const surfaces = [doc.canonicalLabel, ...doc.aliasesIdentitySafe];
  for (const surface of surfaces) {
    if (isProducerOnlyAliasForDistinctWine(doc, surface)) {
      continue;
    }
    for (const key of explicitIdentitySurfaceKeys(surface)) {
      keys.add(key);
    }
  }
  return [...keys].sort();
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
  readonly certificatesByEntity: ReadonlyMap<CanonicalEntityId, readonly LookupIdentityCertificate[]>;
} {
  const artifact = parseLookupExactSafeRuntimeArtifact(raw, filePath);
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
  readonly entityLookup: SearchSnapshotEntityLookup;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
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
      entityProjectionRaw,
      ambiguityRuntimeRaw,
      conceptRedirectRuntimeRaw,
    ] = await Promise.all([
      fs.readFile(manifest.artifacts.lookupAliasRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupExactSafeRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupEntityProjectionJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupAmbiguityRuntimeJson, 'utf8'),
      fs.readFile(manifest.artifacts.lookupConceptRedirectRuntimeJson, 'utf8'),
    ]);
    const aliasRuntimeArtifact = parseTrustedLookupAliasRuntimeArtifact(
      aliasRuntimeRaw,
      manifest.artifacts.lookupAliasRuntimeJson,
    );

    const entityProjection = buildEntityProjectionMap(
      entityProjectionRaw,
      manifest.artifacts.lookupEntityProjectionJson,
    );
    const exactSafeMaps = buildExactSafeMaps(
      exactSafeRuntimeRaw,
      manifest.artifacts.lookupExactSafeRuntimeJson,
    );
    const [
      aliasMatcher,
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
      Promise.resolve(
        new SearchSnapshotExactSafeRegistry(
          exactSafeMaps.exactEntries,
          exactSafeMaps.compactEntries,
        ),
      ),
    ]);
    const entityLookup = new SearchSnapshotEntityLookup(entityProjection);
    const resolverProjectionLookup = new EntityBackedResolverProjectionLookup(
      entityProjection,
      exactSafeMaps.certificatesByEntity,
    );

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
