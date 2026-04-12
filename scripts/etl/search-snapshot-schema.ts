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
    readonly entitiesNdjson: string;
    readonly aliasesNdjson: string;
    readonly ambiguityRegistryNdjson: string;
    readonly nlMappingsJson: string;
    readonly metadataJson: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly entities: number;
    readonly aliases: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
  };
  readonly hashes: {
    readonly documents: string;
    readonly entities: string;
    readonly aliases: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
  };
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

export { hashStableJson, hashText, stableJsonStringify };

export function buildSearchSnapshotId(contentHash: string): string {
  return `search-snapshot:v1:${contentHash.slice(0, 16)}`;
}

export function serializeNdjson(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
