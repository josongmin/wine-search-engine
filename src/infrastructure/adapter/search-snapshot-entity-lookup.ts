import fs from 'node:fs/promises';
import { z } from 'zod';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { fromVespaFields } from '../vespa/mapping.js';

const SnapshotManifestSchema = z.object({
  artifacts: z.object({
    vespaFeedNdjson: z.string().min(1),
  }).passthrough(),
}).passthrough();

const VespaFeedRowSchema = z.object({
  id: z.string().min(1).optional(),
  fields: z.record(z.string(), z.unknown()),
}).passthrough();

function parseVespaFeedPath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const vespaFeedNdjson = manifest.artifacts.vespaFeedNdjson;
  if (vespaFeedNdjson.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.vespaFeedNdjson is required`,
    );
  }
  return vespaFeedNdjson;
}

interface ParsedVespaFeed {
  readonly docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>;
  readonly parseFailures: number;
}

function parseVespaFeed(raw: string, feedPath: string): ParsedVespaFeed {
  const docs = new Map<CanonicalEntityId, RetrievalDocument>();
  let parseFailures = 0;
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const row = VespaFeedRowSchema.parse(parsed);
      let doc: RetrievalDocument;
      try {
        doc = fromVespaFields(row.fields);
      } catch (error) {
        parseFailures += 1;
        bootstrapLogger.warn(
          {
            feedPath,
            row: index + 1,
            err: error,
          },
          '[Container] Search snapshot entity lookup skipped malformed Vespa feed row',
        );
        continue;
      }
      if (docs.has(doc.entityId)) {
        throw new Error(`duplicate entity_id ${doc.entityId}`);
      }
      docs.set(doc.entityId, doc);
    } catch (error) {
      throw new Error(
        `Failed to parse Vespa feed row ${index + 1} from ${feedPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    docs,
    parseFailures,
  };
}

export class SearchSnapshotEntityLookup {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotEntityLookup> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const vespaFeedPath = parseVespaFeedPath(manifestRaw, manifestPath);
    const vespaFeedRaw = await fs.readFile(vespaFeedPath, 'utf8');
    const parsedFeed = parseVespaFeed(vespaFeedRaw, vespaFeedPath);
    const docs = parsedFeed.docs;
    if (docs.size === 0) {
      throw new Error(
        `Search snapshot entity lookup at ${vespaFeedPath} contains zero documents`,
      );
    }
    bootstrapLogger.info(
      {
        manifestPath,
        vespaFeedPath,
        documentCount: docs.size,
        parseFailures: parsedFeed.parseFailures,
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
