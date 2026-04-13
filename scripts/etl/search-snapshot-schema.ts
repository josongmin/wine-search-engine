import { z } from 'zod';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../src/shared/constants/search-snapshot.js';
import {
  hashStableJson,
  hashText,
  stableJsonStringify,
} from '../../src/shared/utils/stable-json.js';

export interface AliasSnapshotRecord {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly type: string;
  readonly scope: string;
  readonly source: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
}

export interface EntitySnapshotRecord {
  readonly entityId: string;
  readonly entityType: 'wine';
  readonly canonicalLabel: string;
  readonly identitySignature: string;
  readonly relations: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

export interface AmbiguityRegistrySnapshotRow {
  readonly registryId: string;
  readonly normalizedForm: string;
  readonly entityIds: readonly string[];
  readonly ambiguityTypes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

export interface SearchSnapshotManifest {
  readonly schemaVersion: typeof SEARCH_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly contentHash: string;
  readonly sourceInputPath: string;
  readonly artifacts: {
    readonly documentsNdjson: string;
    readonly vespaFeedNdjson: string;
    readonly entitiesNdjson: string;
    readonly aliasesNdjson: string;
    readonly ambiguityRegistryNdjson: string;
    readonly nlMappingsJson: string;
    readonly metadataJson: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly vespaFeed: number;
    readonly entities: number;
    readonly aliases: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
  };
  readonly hashes: {
    readonly documents: string;
    readonly vespaFeed: string;
    readonly entities: string;
    readonly aliases: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
  };
}

export interface SearchSnapshotArtifactHashes {
  readonly documents: string;
  readonly vespaFeed: string;
  readonly entities: string;
  readonly aliases: string;
  readonly ambiguityRegistry: string;
  readonly nlMappings: string;
}

export interface SearchSnapshotRuntimeState {
  readonly schemaVersion: typeof SEARCH_SNAPSHOT_STATE_VERSION;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly publishedAt: string;
  readonly manifestPath: string;
  readonly nlMappingsRuntimePath: string;
  readonly allowMissingLtr: boolean;
  readonly counts: {
    readonly entities: number;
    readonly aliases: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
    readonly activeLtrModels: number;
  };
  readonly hashes: {
    readonly entities: string;
    readonly aliases: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
    readonly activeLtrModels: string;
  };
}

export const SearchSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: z.string().min(1),
  contentHash: z.string().min(1),
  sourceInputPath: z.string().min(1),
  artifacts: z.object({
    documentsNdjson: z.string().min(1),
    vespaFeedNdjson: z.string().min(1),
    entitiesNdjson: z.string().min(1),
    aliasesNdjson: z.string().min(1),
    ambiguityRegistryNdjson: z.string().min(1),
    nlMappingsJson: z.string().min(1),
    metadataJson: z.string().min(1),
  }).strict(),
  counts: z.object({
    documents: z.number().int().nonnegative(),
    vespaFeed: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    aliases: z.number().int().nonnegative(),
    ambiguityRegistry: z.number().int().nonnegative(),
    nlMappings: z.number().int().nonnegative(),
  }).strict(),
  hashes: z.object({
    documents: z.string().min(1),
    vespaFeed: z.string().min(1),
    entities: z.string().min(1),
    aliases: z.string().min(1),
    ambiguityRegistry: z.string().min(1),
    nlMappings: z.string().min(1),
  }).strict(),
}).strict();

export const SearchSnapshotRuntimeStateSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_STATE_VERSION),
  snapshotId: z.string().min(1),
  contentHash: z.string().min(1),
  publishedAt: z.string().min(1),
  manifestPath: z.string().min(1),
  nlMappingsRuntimePath: z.string().min(1),
  allowMissingLtr: z.boolean(),
  counts: z.object({
    entities: z.number().int().nonnegative(),
    aliases: z.number().int().nonnegative(),
    ambiguityRegistry: z.number().int().nonnegative(),
    nlMappings: z.number().int().nonnegative(),
    activeLtrModels: z.number().int().nonnegative(),
  }).strict(),
  hashes: z.object({
    entities: z.string().min(1),
    aliases: z.string().min(1),
    ambiguityRegistry: z.string().min(1),
    nlMappings: z.string().min(1),
    activeLtrModels: z.string().min(1),
  }).strict(),
}).strict();

export function parseManifest(raw: string, _filePath: string): SearchSnapshotManifest {
  const parsed: unknown = JSON.parse(raw);
  return SearchSnapshotManifestSchema.parse(parsed);
}

export { hashStableJson, hashText, stableJsonStringify };

/**
 * Snapshot identity is anchored to the logical runtime substrates and source
 * documents, not the operational exact-replay feed artifact. The exact Vespa
 * feed is materialized later during publish and may be rewritten without
 * changing the canonical snapshot id.
 */
export function buildSearchSnapshotContentHash(hashes: SearchSnapshotArtifactHashes): string {
  return hashStableJson({
    documents: hashes.documents,
    entities: hashes.entities,
    aliases: hashes.aliases,
    ambiguityRegistry: hashes.ambiguityRegistry,
    nlMappings: hashes.nlMappings,
  });
}

export function buildSearchSnapshotId(contentHash: string): string {
  return `search-snapshot:v1:${contentHash.slice(0, 16)}`;
}

export function serializeNdjson(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
