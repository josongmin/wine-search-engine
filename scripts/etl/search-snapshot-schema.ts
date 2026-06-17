import path from 'node:path';
import { z } from 'zod';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../src/domain/shared/constants/search-snapshot.js';
import {
  ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  type SearchSnapshotFieldAvailability,
} from '../../src/domain/shared/types/search-field-availability.js';
import {
  hashStableJson,
  hashText,
  stableJsonStringify,
} from '../../src/domain/shared/utils/stable-json.js';

export interface AliasSnapshotRecord {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly type: string;
  readonly aliasType?: string;
  readonly scope: string;
  readonly source: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
  /** Sorted distinct Double Metaphone keys for SQL / snapshot recall substrates. */
  readonly phoneticKeys?: readonly string[];
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

export interface SearchSnapshotQualitySummary {
  readonly status: 'canonical' | 'degraded';
  readonly blockers: readonly string[];
  readonly bypasses: readonly string[];
  readonly carryForwardBenchmarkCount: number;
  readonly experimentalInputsPresent: boolean;
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
    readonly lookupAliasRuntimeJson: string;
    readonly lookupAliasBroadRecallRuntimeJson?: string;
    readonly lookupExactSafeRuntimeJson: string;
    readonly lookupResolverProjectionJson: string;
    readonly lookupEntityProjectionJson: string;
    readonly lookupSemanticScopeRuntimeJson: string;
    readonly lookupReviewedFamilyRecallRuntimeJson: string;
    readonly lookupScopeGraphRuntimeJson: string;
    readonly lookupAmbiguityRuntimeJson: string;
    readonly lookupConceptRedirectRuntimeJson: string;
    readonly ambiguityRegistryNdjson: string;
    readonly nlMappingsJson: string;
    readonly metadataJson: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly vespaFeed: number;
    readonly entities: number;
    readonly aliases: number;
    readonly lookupAliasRuntimeAliases: number;
    readonly lookupAliasBroadRecallRuntimeEntries?: number;
    readonly lookupExactSafeRuntimeEntries: number;
    readonly lookupResolverProjectionDocuments: number;
    readonly lookupEntityProjectionDocuments: number;
    readonly lookupSemanticScopeRuntimeEntries: number;
    readonly lookupReviewedFamilyRecallRuntimeEntries: number;
    readonly lookupScopeGraphRuntimeEdges: number;
    readonly lookupAmbiguityRuntimeEntries: number;
    readonly lookupConceptRedirectRuntimeEntries: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
  };
  readonly hashes: {
    readonly documents: string;
    readonly vespaFeed: string;
    readonly entities: string;
    readonly aliases: string;
    readonly lookupAliasRuntime: string;
    readonly lookupAliasBroadRecallRuntime?: string;
    readonly lookupExactSafeRuntime: string;
    readonly lookupResolverProjection: string;
    readonly lookupEntityProjection: string;
    readonly lookupSemanticScopeRuntime: string;
    readonly lookupReviewedFamilyRecallRuntime: string;
    readonly lookupScopeGraphRuntime: string;
    readonly lookupAmbiguityRuntime: string;
    readonly lookupConceptRedirectRuntime: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
  };
  readonly fieldAvailability: SearchSnapshotFieldAvailability;
  readonly quality: SearchSnapshotQualitySummary;
}

export interface SearchSnapshotArtifactHashes {
  readonly documents: string;
  readonly vespaFeed: string;
  readonly entities: string;
  readonly aliases: string;
  readonly lookupAliasRuntime: string;
  readonly lookupAliasBroadRecallRuntime?: string;
  readonly lookupExactSafeRuntime: string;
  readonly lookupResolverProjection: string;
  readonly lookupEntityProjection: string;
  readonly lookupSemanticScopeRuntime: string;
  readonly lookupReviewedFamilyRecallRuntime: string;
  readonly lookupScopeGraphRuntime: string;
  readonly lookupAmbiguityRuntime: string;
  readonly lookupConceptRedirectRuntime: string;
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
  readonly lookupAliasRuntimePath: string;
  readonly lookupAliasBroadRecallRuntimePath?: string;
  readonly lookupExactSafeRuntimePath: string;
  readonly lookupResolverProjectionPath: string;
  readonly lookupEntityProjectionPath: string;
  readonly lookupSemanticScopeRuntimePath: string;
  readonly lookupReviewedFamilyRecallRuntimePath: string;
  readonly lookupScopeGraphRuntimePath: string;
  readonly lookupAmbiguityRuntimePath: string;
  readonly lookupConceptRedirectRuntimePath: string;
  readonly quality: SearchSnapshotQualitySummary;
  readonly counts: {
    readonly entities: number;
      readonly aliases: number;
      readonly lookupAliasRuntimeAliases: number;
      readonly lookupAliasBroadRecallRuntimeEntries?: number;
      readonly lookupExactSafeRuntimeEntries: number;
    readonly lookupResolverProjectionDocuments: number;
    readonly lookupEntityProjectionDocuments: number;
    readonly lookupSemanticScopeRuntimeEntries: number;
    readonly lookupReviewedFamilyRecallRuntimeEntries: number;
    readonly lookupScopeGraphRuntimeEdges: number;
    readonly lookupAmbiguityRuntimeEntries: number;
    readonly lookupConceptRedirectRuntimeEntries: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
    readonly activeLtrModels: number;
  };
  readonly hashes: {
    readonly entities: string;
      readonly aliases: string;
      readonly lookupAliasRuntime: string;
      readonly lookupAliasBroadRecallRuntime?: string;
      readonly lookupExactSafeRuntime: string;
    readonly lookupResolverProjection: string;
    readonly lookupEntityProjection: string;
    readonly lookupSemanticScopeRuntime: string;
    readonly lookupReviewedFamilyRecallRuntime: string;
    readonly lookupScopeGraphRuntime: string;
    readonly lookupAmbiguityRuntime: string;
    readonly lookupConceptRedirectRuntime: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
    readonly activeLtrModels: string;
  };
  readonly fieldAvailability: SearchSnapshotFieldAvailability;
  readonly ltrReleaseProvenance?: {
    readonly updatedAt: string;
    readonly evalDatasetVersion: string;
    readonly featureSchemaHash: string;
    readonly summaryJsonPath: string;
    readonly summaryJsonHash: string;
    readonly summaryMarkdownPath: string;
    readonly summaryMarkdownHash: string;
    readonly noisyEntityOutputPath: string;
    readonly noisyEntityOutputHash: string;
    readonly combinedReleaseGatePassed: boolean;
    readonly activationStatus: 'activated' | 'shadow_only';
  };
}

const SearchFieldAvailabilityMetricSchema = z.object({
  populatedDocCount: z.number().int().nonnegative(),
  totalDocCount: z.number().int().nonnegative(),
  populatedDocRatio: z.number().min(0).max(1),
}).strict();

const SearchSnapshotFieldAvailabilitySchema = z.object({
  appellation: SearchFieldAvailabilityMetricSchema,
  body: SearchFieldAvailabilityMetricSchema.optional().default(ZERO_SEARCH_FIELD_AVAILABILITY_METRIC),
  sweetness: SearchFieldAvailabilityMetricSchema.optional().default(ZERO_SEARCH_FIELD_AVAILABILITY_METRIC),
  acidity: SearchFieldAvailabilityMetricSchema.optional().default(ZERO_SEARCH_FIELD_AVAILABILITY_METRIC),
  tannin: SearchFieldAvailabilityMetricSchema.optional().default(ZERO_SEARCH_FIELD_AVAILABILITY_METRIC),
}).strict().transform((value): SearchSnapshotFieldAvailability => ({
  appellation: value.appellation,
  body: value.body,
  sweetness: value.sweetness,
  acidity: value.acidity,
  tannin: value.tannin,
}));

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
    ambiguityRegistryNdjson: z.string().min(1),
    nlMappingsJson: z.string().min(1),
    metadataJson: z.string().min(1),
  }).strict(),
  counts: z.object({
    documents: z.number().int().nonnegative(),
    vespaFeed: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    aliases: z.number().int().nonnegative(),
    lookupAliasRuntimeAliases: z.number().int().nonnegative(),
    lookupAliasBroadRecallRuntimeEntries: z.number().int().nonnegative().optional(),
    lookupExactSafeRuntimeEntries: z.number().int().nonnegative(),
    lookupResolverProjectionDocuments: z.number().int().nonnegative(),
    lookupEntityProjectionDocuments: z.number().int().nonnegative(),
    lookupSemanticScopeRuntimeEntries: z.number().int().nonnegative(),
    lookupReviewedFamilyRecallRuntimeEntries: z.number().int().nonnegative(),
    lookupScopeGraphRuntimeEdges: z.number().int().nonnegative(),
    lookupAmbiguityRuntimeEntries: z.number().int().nonnegative(),
    lookupConceptRedirectRuntimeEntries: z.number().int().nonnegative(),
    ambiguityRegistry: z.number().int().nonnegative(),
    nlMappings: z.number().int().nonnegative(),
  }).strict(),
  hashes: z.object({
    documents: z.string().min(1),
    vespaFeed: z.string().min(1),
    entities: z.string().min(1),
    aliases: z.string().min(1),
    lookupAliasRuntime: z.string().min(1),
    lookupAliasBroadRecallRuntime: z.string().min(1).optional(),
    lookupExactSafeRuntime: z.string().min(1),
    lookupResolverProjection: z.string().min(1),
    lookupEntityProjection: z.string().min(1),
    lookupSemanticScopeRuntime: z.string().min(1),
    lookupReviewedFamilyRecallRuntime: z.string().min(1),
    lookupScopeGraphRuntime: z.string().min(1),
    lookupAmbiguityRuntime: z.string().min(1),
    lookupConceptRedirectRuntime: z.string().min(1),
    ambiguityRegistry: z.string().min(1),
    nlMappings: z.string().min(1),
  }).strict(),
  fieldAvailability: SearchSnapshotFieldAvailabilitySchema,
  quality: z.object({
    status: z.enum(['canonical', 'degraded']),
    blockers: z.array(z.string().min(1)),
    bypasses: z.array(z.string().min(1)),
    carryForwardBenchmarkCount: z.number().int().nonnegative(),
    experimentalInputsPresent: z.boolean(),
  }).strict(),
}).strict();

export const SearchSnapshotRuntimeStateSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_STATE_VERSION),
  snapshotId: z.string().min(1),
  contentHash: z.string().min(1),
  publishedAt: z.string().min(1),
  manifestPath: z.string().min(1),
  nlMappingsRuntimePath: z.string().min(1),
  lookupAliasRuntimePath: z.string().min(1),
  lookupAliasBroadRecallRuntimePath: z.string().min(1).optional(),
  lookupExactSafeRuntimePath: z.string().min(1),
  lookupResolverProjectionPath: z.string().min(1),
  lookupEntityProjectionPath: z.string().min(1),
  lookupSemanticScopeRuntimePath: z.string().min(1),
  lookupReviewedFamilyRecallRuntimePath: z.string().min(1),
  lookupScopeGraphRuntimePath: z.string().min(1),
  lookupAmbiguityRuntimePath: z.string().min(1),
  lookupConceptRedirectRuntimePath: z.string().min(1),
  quality: z.object({
    status: z.enum(['canonical', 'degraded']),
    blockers: z.array(z.string().min(1)),
    bypasses: z.array(z.string().min(1)),
    carryForwardBenchmarkCount: z.number().int().nonnegative(),
    experimentalInputsPresent: z.boolean(),
  }).strict(),
  counts: z.object({
    entities: z.number().int().nonnegative(),
    aliases: z.number().int().nonnegative(),
    lookupAliasRuntimeAliases: z.number().int().nonnegative(),
    lookupAliasBroadRecallRuntimeEntries: z.number().int().nonnegative().optional(),
    lookupExactSafeRuntimeEntries: z.number().int().nonnegative(),
    lookupResolverProjectionDocuments: z.number().int().nonnegative(),
    lookupEntityProjectionDocuments: z.number().int().nonnegative(),
    lookupSemanticScopeRuntimeEntries: z.number().int().nonnegative(),
    lookupReviewedFamilyRecallRuntimeEntries: z.number().int().nonnegative(),
    lookupScopeGraphRuntimeEdges: z.number().int().nonnegative(),
    lookupAmbiguityRuntimeEntries: z.number().int().nonnegative(),
    lookupConceptRedirectRuntimeEntries: z.number().int().nonnegative(),
    ambiguityRegistry: z.number().int().nonnegative(),
    nlMappings: z.number().int().nonnegative(),
    activeLtrModels: z.number().int().nonnegative(),
  }).strict(),
  hashes: z.object({
    entities: z.string().min(1),
    aliases: z.string().min(1),
    lookupAliasRuntime: z.string().min(1),
    lookupAliasBroadRecallRuntime: z.string().min(1).optional(),
    lookupExactSafeRuntime: z.string().min(1),
    lookupResolverProjection: z.string().min(1),
    lookupEntityProjection: z.string().min(1),
    lookupSemanticScopeRuntime: z.string().min(1),
    lookupReviewedFamilyRecallRuntime: z.string().min(1),
    lookupScopeGraphRuntime: z.string().min(1),
    lookupAmbiguityRuntime: z.string().min(1),
    lookupConceptRedirectRuntime: z.string().min(1),
    ambiguityRegistry: z.string().min(1),
    nlMappings: z.string().min(1),
    activeLtrModels: z.string().min(1),
  }).strict(),
  fieldAvailability: SearchSnapshotFieldAvailabilitySchema,
  ltrReleaseProvenance: z.object({
    updatedAt: z.string().min(1),
    evalDatasetVersion: z.string().min(1),
    featureSchemaHash: z.string().min(1),
    summaryJsonPath: z.string().min(1),
    summaryJsonHash: z.string().min(1),
    summaryMarkdownPath: z.string().min(1),
    summaryMarkdownHash: z.string().min(1),
    noisyEntityOutputPath: z.string().min(1),
    noisyEntityOutputHash: z.string().min(1),
    combinedReleaseGatePassed: z.boolean(),
    activationStatus: z.enum(['activated', 'shadow_only']),
  }).strict().optional(),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeLegacyManifestShape(parsed: unknown, filePath: string): unknown {
  if (!isRecord(parsed)) {
    return parsed;
  }

  const schemaVersion = readString(parsed.schemaVersion);
  if (schemaVersion === SEARCH_SNAPSHOT_SCHEMA_VERSION) {
    return parsed;
  }
  if (schemaVersion === undefined || !/^search_snapshot\.v\d+$/.test(schemaVersion)) {
    return parsed;
  }

  const artifacts = isRecord(parsed.artifacts) ? parsed.artifacts : {};
  const counts = isRecord(parsed.counts) ? parsed.counts : {};
  const hashes = isRecord(parsed.hashes) ? parsed.hashes : {};
  const documentsNdjson = readString(artifacts.documentsNdjson);
  const entitiesNdjson = readString(artifacts.entitiesNdjson);
  const aliasesNdjson = readString(artifacts.aliasesNdjson);
  const ambiguityRegistryNdjson = readString(artifacts.ambiguityRegistryNdjson);
  const nlMappingsJson = readString(artifacts.nlMappingsJson);
  const metadataJson = readString(artifacts.metadataJson);
  const artifactRoot = path.dirname(documentsNdjson ?? filePath);
  const documentsCount = readNumber(counts.documents) ?? 0;
  const entitiesCount = readNumber(counts.entities) ?? 0;
  const aliasesCount = readNumber(counts.aliases) ?? 0;
  const ambiguityCount = readNumber(counts.ambiguityRegistry) ?? 0;
  const documentsHash = readString(hashes.documents) ?? 'legacy-documents-hash';
  const entitiesHash = readString(hashes.entities) ?? documentsHash;
  const aliasesHash = readString(hashes.aliases) ?? entitiesHash;
  const ambiguityHash = readString(hashes.ambiguityRegistry) ?? aliasesHash;
  const lookupAliasBroadRecallRuntimeJson = readString(artifacts.lookupAliasBroadRecallRuntimeJson);
  const lookupAliasBroadRecallRuntimeEntries = readNumber(counts.lookupAliasBroadRecallRuntimeEntries);
  const lookupAliasBroadRecallRuntimeHash = readString(hashes.lookupAliasBroadRecallRuntime);

  return {
    ...parsed,
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    artifacts: {
      documentsNdjson,
      vespaFeedNdjson: readString(artifacts.vespaFeedNdjson) ?? path.join(artifactRoot, 'vespa-feed.ndjson'),
      entitiesNdjson,
      aliasesNdjson,
      lookupAliasRuntimeJson: readString(artifacts.lookupAliasRuntimeJson) ?? path.join(artifactRoot, 'lookup-alias-runtime.json'),
      ...(lookupAliasBroadRecallRuntimeJson === undefined
        ? {}
        : { lookupAliasBroadRecallRuntimeJson }),
      lookupExactSafeRuntimeJson: readString(artifacts.lookupExactSafeRuntimeJson) ?? path.join(artifactRoot, 'lookup-exact-safe-runtime.json'),
      lookupResolverProjectionJson: readString(artifacts.lookupResolverProjectionJson) ?? path.join(artifactRoot, 'lookup-resolver-projection.json'),
      lookupEntityProjectionJson: readString(artifacts.lookupEntityProjectionJson) ?? path.join(artifactRoot, 'lookup-entity-projection.json'),
      lookupSemanticScopeRuntimeJson: readString(artifacts.lookupSemanticScopeRuntimeJson) ?? path.join(artifactRoot, 'lookup-semantic-scope-runtime.json'),
      lookupReviewedFamilyRecallRuntimeJson: readString(artifacts.lookupReviewedFamilyRecallRuntimeJson) ?? path.join(artifactRoot, 'lookup-reviewed-family-recall-runtime.json'),
      lookupScopeGraphRuntimeJson: readString(artifacts.lookupScopeGraphRuntimeJson) ?? path.join(artifactRoot, 'lookup-scope-graph-runtime.json'),
      lookupAmbiguityRuntimeJson: readString(artifacts.lookupAmbiguityRuntimeJson) ?? path.join(artifactRoot, 'lookup-ambiguity-runtime.json'),
      lookupConceptRedirectRuntimeJson: readString(artifacts.lookupConceptRedirectRuntimeJson) ?? path.join(artifactRoot, 'lookup-concept-redirect-runtime.json'),
      ambiguityRegistryNdjson,
      nlMappingsJson,
      metadataJson,
    },
    counts: {
      documents: documentsCount,
      vespaFeed: readNumber(counts.vespaFeed) ?? documentsCount,
      entities: entitiesCount,
      aliases: aliasesCount,
      lookupAliasRuntimeAliases: readNumber(counts.lookupAliasRuntimeAliases) ?? aliasesCount,
      ...(lookupAliasBroadRecallRuntimeEntries === undefined
        ? {}
        : { lookupAliasBroadRecallRuntimeEntries }),
      lookupExactSafeRuntimeEntries: readNumber(counts.lookupExactSafeRuntimeEntries) ?? 0,
      lookupResolverProjectionDocuments: readNumber(counts.lookupResolverProjectionDocuments) ?? entitiesCount,
      lookupEntityProjectionDocuments: readNumber(counts.lookupEntityProjectionDocuments) ?? entitiesCount,
      lookupSemanticScopeRuntimeEntries: readNumber(counts.lookupSemanticScopeRuntimeEntries) ?? 0,
      lookupReviewedFamilyRecallRuntimeEntries: readNumber(counts.lookupReviewedFamilyRecallRuntimeEntries) ?? 0,
      lookupScopeGraphRuntimeEdges: readNumber(counts.lookupScopeGraphRuntimeEdges) ?? 0,
      lookupAmbiguityRuntimeEntries: readNumber(counts.lookupAmbiguityRuntimeEntries) ?? ambiguityCount,
      lookupConceptRedirectRuntimeEntries: readNumber(counts.lookupConceptRedirectRuntimeEntries) ?? 0,
      ambiguityRegistry: ambiguityCount,
      nlMappings: readNumber(counts.nlMappings) ?? 0,
    },
    hashes: {
      documents: documentsHash,
      vespaFeed: readString(hashes.vespaFeed) ?? documentsHash,
      entities: entitiesHash,
      aliases: aliasesHash,
      lookupAliasRuntime: readString(hashes.lookupAliasRuntime) ?? aliasesHash,
      ...(lookupAliasBroadRecallRuntimeHash === undefined
        ? {}
        : { lookupAliasBroadRecallRuntime: lookupAliasBroadRecallRuntimeHash }),
      lookupExactSafeRuntime: readString(hashes.lookupExactSafeRuntime) ?? aliasesHash,
      lookupResolverProjection: readString(hashes.lookupResolverProjection) ?? entitiesHash,
      lookupEntityProjection: readString(hashes.lookupEntityProjection) ?? entitiesHash,
      lookupSemanticScopeRuntime: readString(hashes.lookupSemanticScopeRuntime) ?? entitiesHash,
      lookupReviewedFamilyRecallRuntime: readString(hashes.lookupReviewedFamilyRecallRuntime) ?? entitiesHash,
      lookupScopeGraphRuntime: readString(hashes.lookupScopeGraphRuntime) ?? entitiesHash,
      lookupAmbiguityRuntime: readString(hashes.lookupAmbiguityRuntime) ?? ambiguityHash,
      lookupConceptRedirectRuntime: readString(hashes.lookupConceptRedirectRuntime) ?? entitiesHash,
      ambiguityRegistry: ambiguityHash,
      nlMappings: readString(hashes.nlMappings) ?? entitiesHash,
    },
  } as SearchSnapshotManifest;
}

export function parseManifest(raw: string, _filePath: string): SearchSnapshotManifest {
  const parsed: unknown = JSON.parse(raw);
  return SearchSnapshotManifestSchema.parse(normalizeLegacyManifestShape(parsed, _filePath)) as SearchSnapshotManifest;
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
    lookupAliasRuntime: hashes.lookupAliasRuntime,
    ...(hashes.lookupAliasBroadRecallRuntime !== undefined
      ? { lookupAliasBroadRecallRuntime: hashes.lookupAliasBroadRecallRuntime }
      : {}),
    lookupExactSafeRuntime: hashes.lookupExactSafeRuntime,
    lookupResolverProjection: hashes.lookupResolverProjection,
    lookupEntityProjection: hashes.lookupEntityProjection,
    lookupSemanticScopeRuntime: hashes.lookupSemanticScopeRuntime,
    lookupReviewedFamilyRecallRuntime: hashes.lookupReviewedFamilyRecallRuntime,
    lookupScopeGraphRuntime: hashes.lookupScopeGraphRuntime,
    lookupAmbiguityRuntime: hashes.lookupAmbiguityRuntime,
    lookupConceptRedirectRuntime: hashes.lookupConceptRedirectRuntime,
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
