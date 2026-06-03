import fs from 'node:fs/promises';
import { z } from 'zod';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import {
  parseLookupEntityProjectionArtifact,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupEntityProjectionJson: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseLookupEntityProjectionPath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const lookupEntityProjectionJson = manifest.artifacts.lookupEntityProjectionJson;
  if (lookupEntityProjectionJson.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupEntityProjectionJson is required`,
    );
  }
  return lookupEntityProjectionJson;
}

function parseLookupEntityProjection(
  raw: string,
  projectionPath: string,
): ReadonlyMap<CanonicalEntityId, RetrievalDocument> {
  const artifact = parseLookupEntityProjectionArtifact(raw, projectionPath);
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
  return docs;
}

export class SearchSnapshotEntityLookup {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotEntityLookup> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const projectionPath = parseLookupEntityProjectionPath(manifestRaw, manifestPath);
    const projectionRaw = await fs.readFile(projectionPath, 'utf8');
    const docs = parseLookupEntityProjection(projectionRaw, projectionPath);
    if (docs.size === 0) {
      throw new Error(
        `Search snapshot entity lookup at ${projectionPath} contains zero documents`,
      );
    }
    bootstrapLogger.info(
      {
        manifestPath,
        projectionPath,
        documentCount: docs.size,
      },
      '[Container] Search snapshot entity lookup loaded from manifest into memory',
    );
    return new SearchSnapshotEntityLookup(docs);
  }

  constructor(
    private readonly docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>,
  ) {}

  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null> {
    return Promise.resolve(this.docs.get(entityId) ?? null);
  }

  getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>> {
    const ordered = new Map<CanonicalEntityId, RetrievalDocument>();
    for (const entityId of entityIds) {
      const doc = this.docs.get(entityId);
      if (doc !== undefined) {
        ordered.set(entityId, doc);
      }
    }
    return Promise.resolve(ordered);
  }

  getDrinkingWindowDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>> {
    const ordered = new Map<CanonicalEntityId, RetrievalDrinkingWindowProjection>();
    for (const entityId of entityIds) {
      const doc = this.docs.get(entityId);
      if (doc === undefined) {
        continue;
      }
      ordered.set(entityId, {
        entityId: doc.entityId,
        canonicalLabel: doc.canonicalLabel,
        ...(doc.drinkingWindowStart !== undefined
          ? { drinkingWindowStart: doc.drinkingWindowStart }
          : {}),
        ...(doc.drinkingWindowEnd !== undefined
          ? { drinkingWindowEnd: doc.drinkingWindowEnd }
          : {}),
        ...(doc.drinkingWindowModelVersion !== undefined
          ? { drinkingWindowModelVersion: doc.drinkingWindowModelVersion }
          : {}),
      });
    }
    return Promise.resolve(ordered);
  }
}
