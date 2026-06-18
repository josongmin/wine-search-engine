import fs from 'node:fs/promises';
import { z } from 'zod';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import {
  parseLookupResolverProjectionArtifact,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';
import type { LookupResolverProjection, LookupResolverProjectionPort } from '../../application/search/port/search-pipeline-deps.port.js';

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupResolverProjectionJson: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseResolverProjectionPath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const projectionPath = manifest.artifacts.lookupResolverProjectionJson;
  if (projectionPath.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupResolverProjectionJson is required`,
    );
  }
  return projectionPath;
}

function parseResolverProjection(
  raw: string,
  projectionPath: string,
): ReadonlyMap<CanonicalEntityId, LookupResolverProjection> {
  const artifact = parseLookupResolverProjectionArtifact(raw, projectionPath);
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
  return docs;
}

export class SearchSnapshotResolverProjectionLookup implements LookupResolverProjectionPort {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotResolverProjectionLookup> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const projectionPath = parseResolverProjectionPath(manifestRaw, manifestPath);
    const projectionRaw = await fs.readFile(projectionPath, 'utf8');
    const docs = parseResolverProjection(projectionRaw, projectionPath);
    if (docs.size === 0) {
      throw new Error(
        `Search snapshot resolver projection at ${projectionPath} contains zero documents`,
      );
    }
    bootstrapLogger.info(
      {
        manifestPath,
        projectionPath,
        documentCount: docs.size,
      },
      '[Container] Search snapshot resolver projection loaded from manifest into memory',
    );
    return new SearchSnapshotResolverProjectionLookup(docs);
  }

  constructor(
    private readonly docs: ReadonlyMap<CanonicalEntityId, LookupResolverProjection>,
  ) {}

  getResolverProjections(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, LookupResolverProjection>> {
    const ordered = new Map<CanonicalEntityId, LookupResolverProjection>();
    for (const entityId of entityIds) {
      const doc = this.docs.get(entityId);
      if (doc !== undefined) {
        ordered.set(entityId, doc);
      }
    }
    return Promise.resolve(ordered);
  }
}
