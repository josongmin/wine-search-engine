import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import type { Pool } from 'pg';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { resolveDataPath } from '../../domain/shared/utils/data-paths.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../domain/shared/utils/stable-json.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';
import { getCurrentFeatureSchemaHash } from '../../domain/ranking/service/feature-parity-hash.js';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';
import {
  SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN,
  SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX,
} from '../../domain/shared/constants/public-entity-id-namespace.js';
import {
  SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES,
  ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
  type SearchFieldAvailabilityMetric,
  type SearchSnapshotFieldAvailability,
} from '../../domain/shared/types/search-field-availability.js';
import {
  canonicalizeAliasSnapshotRecords,
  canonicalizeAmbiguitySnapshotRows,
  canonicalizeEntitySnapshotRecords,
} from '../../domain/shared/utils/search-snapshot-canonicalization.js';

const VespaCountResponseSchema = z.object({
  root: z.object({
    fields: z.object({
      totalCount: z.number().int().nonnegative(),
    }),
  }),
});

const CRITICAL_WINE_TYPES = ['red', 'white', 'sparkling'] as const;
type CriticalWineType = typeof CRITICAL_WINE_TYPES[number];
const VESPA_RAW_FIELD_PROBE_LIMIT = 3;

const VESPA_RAW_PAYLOAD_REQUIREMENTS = {
  entityId: ['entity_id', 'canonical_label'],
  wineType: ['wine_type'],
} as const;

interface VespaMtlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

type VespaPayloadViolation = {
  readonly wineType: CriticalWineType;
  readonly entityId: string;
  readonly issues: readonly string[];
};

type VespaPayloadProbeResult = {
  readonly wineType: CriticalWineType;
  readonly sampleCount: number;
  readonly violations: readonly VespaPayloadViolation[];
};

export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

/**
 * Parses Postgres `COUNT(*)::text` aggregates for readiness checks.
 * Rejects NaN/Infinity from corrupt or unexpected driver shapes.
 */
function parseSqlCountText(raw: string | undefined, context: string): number {
  const n = Number(raw ?? '0');
  if (!Number.isFinite(n)) {
    throw new Error(`${context}: COUNT aggregate is not a finite number: ${String(raw)}`);
  }
  return Math.trunc(n);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVespaResponseChildren(raw: unknown): readonly Record<string, unknown>[] {
  if (!isRecordValue(raw)) {
    throw new Error('Vespa payload probe returned unexpected response shape: response body is not an object');
  }

  const root = raw['root'];
  if (!isRecordValue(root)) {
    throw new Error('Vespa payload probe returned unexpected response shape: missing root object');
  }

  const children = root['children'];
  if (children === undefined) {
    return [];
  }
  if (!Array.isArray(children)) {
    throw new Error('Vespa payload probe returned unexpected response shape: root.children is not an array');
  }

  return children.map((child) => {
    if (!isRecordValue(child)) {
      return {};
    }
    const fields = child.fields;
    return isRecordValue(fields) ? fields : {};
  });
}

function getEntityIdFromFields(fields: Record<string, unknown>): string {
  const raw = fields['entity_id'];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return '<unknown-entity-id>';
}

function wineTypeValues(raw: unknown): readonly string[] {
  if (typeof raw === 'string') {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function validateVespaPayloadFieldRequirements(
  wineType: CriticalWineType,
  fields: Record<string, unknown>,
): readonly string[] {
  const issues: string[] = [];

  for (const field of VESPA_RAW_PAYLOAD_REQUIREMENTS.entityId) {
    const raw = fields[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      issues.push(`missing-or-empty ${field}`);
    }
  }

  const wineTypeRaw = fields[VESPA_RAW_PAYLOAD_REQUIREMENTS.wineType[0]];
  if (!wineTypeValues(wineTypeRaw).some((candidate) => candidate === wineType)) {
    issues.push(`wine_type does not include ${wineType}: ${JSON.stringify(wineTypeRaw)}`);
  }

  return issues;
}

async function fetchVespaSearchJson(
  vespaUrl: string,
  payload: Record<string, unknown>,
  errorPrefix: string,
  mtls?: VespaMtlsConfig,
): Promise<unknown> {
  const url = `${vespaUrl.replace(/\/$/, '')}/search/`;
  let dispatcher: UndiciAgent | undefined;
  try {
    if (mtls !== undefined) {
      dispatcher = new UndiciAgent({
        connect: {
          cert: fsSync.readFileSync(mtls.certPath),
          key: fsSync.readFileSync(mtls.keyPath),
          rejectUnauthorized: true,
        },
        connections: 4,
        pipelining: 1,
        keepAliveTimeout: 30_000,
      });
    }

    const response = dispatcher !== undefined
      ? await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        dispatcher,
      })
      : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    if (!response.ok) {
      throw new Error(`${errorPrefix} with status ${response.status}`);
    }
    return await response.json();
  } finally {
    await dispatcher?.close();
  }
}

async function fetchVespaWineTypePayloadProbe(
  vespaUrl: string,
  snapshotId: string,
  wineType: CriticalWineType,
  mtls?: VespaMtlsConfig,
): Promise<VespaPayloadProbeResult> {
  const body = await fetchVespaSearchJson(
    vespaUrl,
    {
      yql:
        `select * from sources * where ` +
        `search_snapshot_id contains ${JSON.stringify(snapshotId)} and ` +
        `wine_type contains ${JSON.stringify(wineType)} limit ${VESPA_RAW_FIELD_PROBE_LIMIT};`,
    },
    `Vespa payload probe failed for ${wineType}`,
    mtls,
  );
  const children = parseVespaResponseChildren(body);
  const violations: VespaPayloadViolation[] = [];
  for (const fields of children) {
    const issues = validateVespaPayloadFieldRequirements(wineType, fields);
    if (issues.length > 0) {
      violations.push({
        wineType,
        entityId: getEntityIdFromFields(fields),
        issues,
      });
    }
  }

  return {
    wineType,
    sampleCount: children.length,
    violations,
  };
}

export interface LoadedSearchSnapshotRuntimeState {
  readonly schemaVersion: typeof SEARCH_SNAPSHOT_STATE_VERSION;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly publishedAt: string;
  readonly manifestPath: string;
  readonly nlMappingsRuntimePath: string;
  readonly lookupAliasRuntimePath: string;
  readonly lookupResolverProjectionPath: string;
  readonly lookupEntityProjectionPath: string;
  readonly lookupAmbiguityRuntimePath: string;
  readonly quality: {
    readonly status: 'canonical' | 'degraded';
    readonly blockers: readonly string[];
    readonly bypasses: readonly string[];
    readonly carryForwardBenchmarkCount: number;
    readonly experimentalInputsPresent: boolean;
  };
  readonly fieldAvailability: SearchSnapshotFieldAvailability;
  readonly counts: {
    readonly entities: number;
    readonly aliases: number;
    readonly lookupAliasRuntimeAliases: number;
    readonly lookupResolverProjectionDocuments: number;
    readonly lookupEntityProjectionDocuments: number;
    readonly lookupAmbiguityRuntimeEntries: number;
    readonly ambiguityRegistry: number;
    readonly nlMappings: number;
    readonly activeLtrModels: number;
  };
  readonly hashes: {
    readonly entities: string;
    readonly aliases: string;
    readonly lookupAliasRuntime: string;
    readonly lookupResolverProjection: string;
    readonly lookupEntityProjection: string;
    readonly lookupAmbiguityRuntime: string;
    readonly ambiguityRegistry: string;
    readonly nlMappings: string;
    readonly activeLtrModels: string;
  };
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

type RuntimeStateQuality = LoadedSearchSnapshotRuntimeState['quality'];
type RuntimeStateLtrReleaseProvenance =
  NonNullable<LoadedSearchSnapshotRuntimeState['ltrReleaseProvenance']>;

interface CanonicalEntitySnapshotRecord {
  readonly entityId: string;
  readonly entityType: 'wine';
  readonly canonicalLabel: string;
  readonly identitySignature: string;
  readonly relations: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

interface CanonicalAliasSnapshotRecord {
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

interface CanonicalAmbiguitySnapshotRow {
  readonly registryId: string;
  readonly normalizedForm: string;
  readonly entityIds: readonly string[];
  readonly ambiguityTypes: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

type RuntimeStateShape = {
  readonly schemaVersion?: unknown;
  readonly snapshotId?: unknown;
  readonly contentHash?: unknown;
  readonly publishedAt?: unknown;
  readonly manifestPath?: unknown;
  readonly nlMappingsRuntimePath?: unknown;
  readonly lookupAliasRuntimePath?: unknown;
  readonly lookupResolverProjectionPath?: unknown;
  readonly lookupEntityProjectionPath?: unknown;
  readonly lookupAmbiguityRuntimePath?: unknown;
  readonly quality?: {
    readonly status?: unknown;
    readonly blockers?: unknown;
    readonly bypasses?: unknown;
    readonly carryForwardBenchmarkCount?: unknown;
    readonly experimentalInputsPresent?: unknown;
  };
  readonly fieldAvailability?: {
    readonly appellation?: {
      readonly populatedDocCount?: unknown;
      readonly totalDocCount?: unknown;
      readonly populatedDocRatio?: unknown;
    };
    readonly body?: {
      readonly populatedDocCount?: unknown;
      readonly totalDocCount?: unknown;
      readonly populatedDocRatio?: unknown;
    };
    readonly sweetness?: {
      readonly populatedDocCount?: unknown;
      readonly totalDocCount?: unknown;
      readonly populatedDocRatio?: unknown;
    };
    readonly acidity?: {
      readonly populatedDocCount?: unknown;
      readonly totalDocCount?: unknown;
      readonly populatedDocRatio?: unknown;
    };
    readonly tannin?: {
      readonly populatedDocCount?: unknown;
      readonly totalDocCount?: unknown;
      readonly populatedDocRatio?: unknown;
    };
  };
  readonly counts?: {
    readonly entities?: unknown;
    readonly aliases?: unknown;
    readonly lookupAliasRuntimeAliases?: unknown;
    readonly lookupResolverProjectionDocuments?: unknown;
    readonly lookupEntityProjectionDocuments?: unknown;
    readonly lookupAmbiguityRuntimeEntries?: unknown;
    readonly ambiguityRegistry?: unknown;
    readonly nlMappings?: unknown;
    readonly activeLtrModels?: unknown;
  };
  readonly hashes?: {
    readonly entities?: unknown;
    readonly aliases?: unknown;
    readonly lookupAliasRuntime?: unknown;
    readonly lookupResolverProjection?: unknown;
    readonly lookupEntityProjection?: unknown;
    readonly lookupAmbiguityRuntime?: unknown;
    readonly ambiguityRegistry?: unknown;
    readonly nlMappings?: unknown;
    readonly activeLtrModels?: unknown;
  };
  readonly ltrReleaseProvenance?: {
    readonly updatedAt?: unknown;
    readonly evalDatasetVersion?: unknown;
    readonly featureSchemaHash?: unknown;
    readonly summaryJsonPath?: unknown;
    readonly summaryJsonHash?: unknown;
    readonly summaryMarkdownPath?: unknown;
    readonly summaryMarkdownHash?: unknown;
    readonly noisyEntityOutputPath?: unknown;
    readonly noisyEntityOutputHash?: unknown;
    readonly combinedReleaseGatePassed?: unknown;
    readonly activationStatus?: unknown;
  };
};

function isFiniteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseFieldAvailabilityMetric(
  metric: {
    readonly populatedDocCount?: unknown;
    readonly totalDocCount?: unknown;
    readonly populatedDocRatio?: unknown;
  } | undefined,
): SearchFieldAvailabilityMetric | undefined {
  if (
    metric === undefined
    || !isFiniteCount(metric.populatedDocCount)
    || !isFiniteCount(metric.totalDocCount)
    || typeof metric.populatedDocRatio !== 'number'
    || !Number.isFinite(metric.populatedDocRatio)
    || metric.populatedDocRatio < 0
    || metric.populatedDocRatio > 1
  ) {
    return undefined;
  }
  return {
    populatedDocCount: metric.populatedDocCount,
    totalDocCount: metric.totalDocCount,
    populatedDocRatio: metric.populatedDocRatio,
  };
}

function parseRuntimeStateQuality(
  quality: RuntimeStateShape['quality'],
): RuntimeStateQuality | undefined {
  const blockers = Array.isArray(quality?.blockers)
    ? quality.blockers.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
  const bypasses = Array.isArray(quality?.bypasses)
    ? quality.bypasses.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
  if (
    quality === undefined
    || (quality.status !== 'canonical' && quality.status !== 'degraded')
    || !Array.isArray(quality.blockers)
    || blockers === undefined
    || blockers.length !== quality.blockers.length
    || !Array.isArray(quality.bypasses)
    || bypasses === undefined
    || bypasses.length !== quality.bypasses.length
    || !isFiniteCount(quality.carryForwardBenchmarkCount)
    || typeof quality.experimentalInputsPresent !== 'boolean'
  ) {
    return undefined;
  }
  return {
    status: quality.status,
    blockers,
    bypasses,
    carryForwardBenchmarkCount: quality.carryForwardBenchmarkCount,
    experimentalInputsPresent: quality.experimentalInputsPresent,
  };
}

function parseRuntimeStateLtrReleaseProvenance(
  ltrReleaseProvenance: RuntimeStateShape['ltrReleaseProvenance'],
): RuntimeStateLtrReleaseProvenance | undefined {
  if (ltrReleaseProvenance === undefined) {
    return undefined;
  }
  if (
    typeof ltrReleaseProvenance.updatedAt !== 'string'
    || ltrReleaseProvenance.updatedAt.length === 0
    || typeof ltrReleaseProvenance.evalDatasetVersion !== 'string'
    || ltrReleaseProvenance.evalDatasetVersion.length === 0
    || typeof ltrReleaseProvenance.featureSchemaHash !== 'string'
    || ltrReleaseProvenance.featureSchemaHash.length === 0
    || typeof ltrReleaseProvenance.summaryJsonPath !== 'string'
    || ltrReleaseProvenance.summaryJsonPath.length === 0
    || typeof ltrReleaseProvenance.summaryJsonHash !== 'string'
    || ltrReleaseProvenance.summaryJsonHash.length === 0
    || typeof ltrReleaseProvenance.summaryMarkdownPath !== 'string'
    || ltrReleaseProvenance.summaryMarkdownPath.length === 0
    || typeof ltrReleaseProvenance.summaryMarkdownHash !== 'string'
    || ltrReleaseProvenance.summaryMarkdownHash.length === 0
    || typeof ltrReleaseProvenance.noisyEntityOutputPath !== 'string'
    || ltrReleaseProvenance.noisyEntityOutputPath.length === 0
    || typeof ltrReleaseProvenance.noisyEntityOutputHash !== 'string'
    || ltrReleaseProvenance.noisyEntityOutputHash.length === 0
    || typeof ltrReleaseProvenance.combinedReleaseGatePassed !== 'boolean'
    || (
      ltrReleaseProvenance.activationStatus !== 'activated'
      && ltrReleaseProvenance.activationStatus !== 'shadow_only'
    )
  ) {
    return undefined;
  }
  return {
    updatedAt: ltrReleaseProvenance.updatedAt,
    evalDatasetVersion: ltrReleaseProvenance.evalDatasetVersion,
    featureSchemaHash: ltrReleaseProvenance.featureSchemaHash,
    summaryJsonPath: ltrReleaseProvenance.summaryJsonPath,
    summaryJsonHash: ltrReleaseProvenance.summaryJsonHash,
    summaryMarkdownPath: ltrReleaseProvenance.summaryMarkdownPath,
    summaryMarkdownHash: ltrReleaseProvenance.summaryMarkdownHash,
    noisyEntityOutputPath: ltrReleaseProvenance.noisyEntityOutputPath,
    noisyEntityOutputHash: ltrReleaseProvenance.noisyEntityOutputHash,
    combinedReleaseGatePassed: ltrReleaseProvenance.combinedReleaseGatePassed,
    activationStatus: ltrReleaseProvenance.activationStatus,
  };
}

function validateRuntimeStateShape(parsed: RuntimeStateShape): LoadedSearchSnapshotRuntimeState {
  const counts = parsed.counts;
  const hashes = parsed.hashes;
  const fieldAvailability = parsed.fieldAvailability;
  const quality = parseRuntimeStateQuality(parsed.quality);
  const ltrReleaseProvenance = parseRuntimeStateLtrReleaseProvenance(parsed.ltrReleaseProvenance);
  const appellationFieldAvailability = parseFieldAvailabilityMetric(fieldAvailability?.appellation);
  const sensoryFieldAvailabilityMetrics = Object.fromEntries(
    SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES.map((attribute) => [
      attribute,
      parseFieldAvailabilityMetric(fieldAvailability?.[attribute]),
    ]),
  ) as Record<
    (typeof SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES)[number],
    SearchFieldAvailabilityMetric | undefined
  >;
  const missingSensoryFieldAvailabilityAttributes =
    SEARCH_SNAPSHOT_SENSORY_FIELD_AVAILABILITY_ATTRIBUTES.filter(
      (attribute) => sensoryFieldAvailabilityMetrics[attribute] === undefined,
    );
  const normalizedFieldAvailability: SearchSnapshotFieldAvailability | undefined =
    appellationFieldAvailability === undefined
      ? undefined
      : {
          appellation: appellationFieldAvailability,
          body: sensoryFieldAvailabilityMetrics['body'] ?? ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
          sweetness: sensoryFieldAvailabilityMetrics['sweetness'] ?? ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
          acidity: sensoryFieldAvailabilityMetrics['acidity'] ?? ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
          tannin: sensoryFieldAvailabilityMetrics['tannin'] ?? ZERO_SEARCH_FIELD_AVAILABILITY_METRIC,
        };
  const hasValidFieldAvailability = normalizedFieldAvailability !== undefined;
  const malformedReasons: string[] = [];
  if (parsed.schemaVersion !== SEARCH_SNAPSHOT_STATE_VERSION) malformedReasons.push('schemaVersion');
  if (typeof parsed.snapshotId !== 'string' || parsed.snapshotId.length === 0) malformedReasons.push('snapshotId');
  if (typeof parsed.contentHash !== 'string' || parsed.contentHash.length === 0) malformedReasons.push('contentHash');
  if (typeof parsed.publishedAt !== 'string' || parsed.publishedAt.length === 0) malformedReasons.push('publishedAt');
  if (typeof parsed.manifestPath !== 'string' || parsed.manifestPath.length === 0) malformedReasons.push('manifestPath');
  if (typeof parsed.nlMappingsRuntimePath !== 'string' || parsed.nlMappingsRuntimePath.length === 0) malformedReasons.push('nlMappingsRuntimePath');
  if (typeof parsed.lookupAliasRuntimePath !== 'string' || parsed.lookupAliasRuntimePath.length === 0) malformedReasons.push('lookupAliasRuntimePath');
  if (typeof parsed.lookupResolverProjectionPath !== 'string' || parsed.lookupResolverProjectionPath.length === 0) malformedReasons.push('lookupResolverProjectionPath');
  if (typeof parsed.lookupEntityProjectionPath !== 'string' || parsed.lookupEntityProjectionPath.length === 0) malformedReasons.push('lookupEntityProjectionPath');
  if (typeof parsed.lookupAmbiguityRuntimePath !== 'string' || parsed.lookupAmbiguityRuntimePath.length === 0) malformedReasons.push('lookupAmbiguityRuntimePath');
  if (quality === undefined) malformedReasons.push('quality');
  if (!hasValidFieldAvailability) malformedReasons.push('fieldAvailability');
  if (counts === undefined) malformedReasons.push('counts');
  if (counts !== undefined) {
    if (!isFiniteCount(counts.entities)) malformedReasons.push('counts.entities');
    if (!isFiniteCount(counts.aliases)) malformedReasons.push('counts.aliases');
    if (!isFiniteCount(counts.lookupAliasRuntimeAliases)) malformedReasons.push('counts.lookupAliasRuntimeAliases');
    if (!isFiniteCount(counts.lookupResolverProjectionDocuments)) malformedReasons.push('counts.lookupResolverProjectionDocuments');
    if (!isFiniteCount(counts.lookupEntityProjectionDocuments)) malformedReasons.push('counts.lookupEntityProjectionDocuments');
    if (!isFiniteCount(counts.lookupAmbiguityRuntimeEntries)) malformedReasons.push('counts.lookupAmbiguityRuntimeEntries');
    if (!isFiniteCount(counts.ambiguityRegistry)) malformedReasons.push('counts.ambiguityRegistry');
    if (!isFiniteCount(counts.nlMappings)) malformedReasons.push('counts.nlMappings');
    if (!isFiniteCount(counts.activeLtrModels)) malformedReasons.push('counts.activeLtrModels');
  }
  if (hashes === undefined) malformedReasons.push('hashes');
  if (hashes !== undefined) {
    if (typeof hashes.entities !== 'string' || hashes.entities.length === 0) malformedReasons.push('hashes.entities');
    if (typeof hashes.aliases !== 'string' || hashes.aliases.length === 0) malformedReasons.push('hashes.aliases');
    if (typeof hashes.lookupAliasRuntime !== 'string' || hashes.lookupAliasRuntime.length === 0) malformedReasons.push('hashes.lookupAliasRuntime');
    if (typeof hashes.lookupResolverProjection !== 'string' || hashes.lookupResolverProjection.length === 0) malformedReasons.push('hashes.lookupResolverProjection');
    if (typeof hashes.lookupEntityProjection !== 'string' || hashes.lookupEntityProjection.length === 0) malformedReasons.push('hashes.lookupEntityProjection');
    if (typeof hashes.lookupAmbiguityRuntime !== 'string' || hashes.lookupAmbiguityRuntime.length === 0) malformedReasons.push('hashes.lookupAmbiguityRuntime');
    if (typeof hashes.ambiguityRegistry !== 'string' || hashes.ambiguityRegistry.length === 0) malformedReasons.push('hashes.ambiguityRegistry');
    if (typeof hashes.nlMappings !== 'string' || hashes.nlMappings.length === 0) malformedReasons.push('hashes.nlMappings');
    if (typeof hashes.activeLtrModels !== 'string' || hashes.activeLtrModels.length === 0) malformedReasons.push('hashes.activeLtrModels');
  }
  if (parsed.ltrReleaseProvenance !== undefined && ltrReleaseProvenance === undefined) {
    malformedReasons.push('ltrReleaseProvenance');
  }
  if (malformedReasons.length > 0) {
    throw new Error(`Malformed runtime search snapshot state: ${malformedReasons.join(', ')}`);
  }
  const validatedSchemaVersion = parsed.schemaVersion as typeof SEARCH_SNAPSHOT_STATE_VERSION;
  const validatedSnapshotId = parsed.snapshotId as string;
  const validatedContentHash = parsed.contentHash as string;
  const validatedPublishedAt = parsed.publishedAt as string;
  const validatedManifestPath = parsed.manifestPath as string;
  const validatedNlMappingsRuntimePath = parsed.nlMappingsRuntimePath as string;
  const validatedLookupAliasRuntimePath = parsed.lookupAliasRuntimePath as string;
  const validatedLookupResolverProjectionPath = parsed.lookupResolverProjectionPath as string;
  const validatedLookupEntityProjectionPath = parsed.lookupEntityProjectionPath as string;
  const validatedLookupAmbiguityRuntimePath = parsed.lookupAmbiguityRuntimePath as string;
  const validatedQuality = quality as RuntimeStateQuality;
  const validatedFieldAvailability = normalizedFieldAvailability as SearchSnapshotFieldAvailability;
  const validatedCounts = counts as LoadedSearchSnapshotRuntimeState['counts'];
  const validatedHashes = hashes as LoadedSearchSnapshotRuntimeState['hashes'];
  const normalizedQuality: RuntimeStateQuality =
    missingSensoryFieldAvailabilityAttributes.length === 0
      ? validatedQuality
      : {
          ...validatedQuality,
          status: 'degraded',
          blockers: [
            ...validatedQuality.blockers,
            `missing_runtime_sensory_field_availability:${missingSensoryFieldAvailabilityAttributes.join(',')}`,
          ],
        };

  return {
    schemaVersion: validatedSchemaVersion,
    snapshotId: validatedSnapshotId,
    contentHash: validatedContentHash,
    publishedAt: validatedPublishedAt,
    manifestPath: validatedManifestPath,
    nlMappingsRuntimePath: validatedNlMappingsRuntimePath,
    lookupAliasRuntimePath: validatedLookupAliasRuntimePath,
    lookupResolverProjectionPath: validatedLookupResolverProjectionPath,
    lookupEntityProjectionPath: validatedLookupEntityProjectionPath,
    lookupAmbiguityRuntimePath: validatedLookupAmbiguityRuntimePath,
    quality: normalizedQuality,
    fieldAvailability: validatedFieldAvailability,
    counts: {
      entities: validatedCounts.entities,
      aliases: validatedCounts.aliases,
      lookupAliasRuntimeAliases: validatedCounts.lookupAliasRuntimeAliases,
      lookupResolverProjectionDocuments: validatedCounts.lookupResolverProjectionDocuments,
      lookupEntityProjectionDocuments: validatedCounts.lookupEntityProjectionDocuments,
      lookupAmbiguityRuntimeEntries: validatedCounts.lookupAmbiguityRuntimeEntries,
      ambiguityRegistry: validatedCounts.ambiguityRegistry,
      nlMappings: validatedCounts.nlMappings,
      activeLtrModels: validatedCounts.activeLtrModels,
    },
    hashes: {
      entities: validatedHashes.entities,
      aliases: validatedHashes.aliases,
      lookupAliasRuntime: validatedHashes.lookupAliasRuntime,
      lookupResolverProjection: validatedHashes.lookupResolverProjection,
      lookupEntityProjection: validatedHashes.lookupEntityProjection,
      lookupAmbiguityRuntime: validatedHashes.lookupAmbiguityRuntime,
      ambiguityRegistry: validatedHashes.ambiguityRegistry,
      nlMappings: validatedHashes.nlMappings,
      activeLtrModels: validatedHashes.activeLtrModels,
    },
    ...(ltrReleaseProvenance === undefined
      ? {}
      : {
          ltrReleaseProvenance,
        }),
  };
}

async function loadNlMappingsRuntimeInfo(nlMappingsRuntimePath: string): Promise<{
  readonly count: number;
  readonly hash: string;
}> {
  const nlMappingsRaw = await fs.readFile(nlMappingsRuntimePath, 'utf8');
  const nlMappingsParsedUnknown: unknown = JSON.parse(nlMappingsRaw);
  if (typeof nlMappingsParsedUnknown !== 'object' || nlMappingsParsedUnknown === null) {
    throw new Error('Malformed runtime NL mappings');
  }
  const nlMappingsParsed = nlMappingsParsedUnknown as Record<string, unknown>;
  if (!Array.isArray(nlMappingsParsed['mappings'])) {
    throw new Error('Malformed runtime NL mappings');
  }
  return {
    count: nlMappingsParsed['mappings'].length,
    hash: hashText(`${stableJsonStringify(nlMappingsParsedUnknown)}\n`),
  };
}

/**
 * ADR-007: Vespa documents must use canonical entity_id, never source-style ids.
 * Counts documents whose attribute `entity_id` starts with the source-record prefix.
 * Uses YQL `matches` against the anchored prefix pattern.
 */
async function fetchVespaNamespaceSealViolationCount(
  vespaUrl: string,
  mtls?: VespaMtlsConfig,
): Promise<number> {
  const anchoredPrefix = `^${SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX}`;
  const body = await fetchVespaSearchJson(
    vespaUrl,
    {
      yql: `select * from sources * where entity_id matches ${JSON.stringify(anchoredPrefix)} limit 0;`,
    },
    'Vespa namespace seal query failed',
    mtls,
  );
  const parsed = VespaCountResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Vespa namespace seal query returned unexpected response shape: ${parsed.error.message}`);
  }
  return parsed.data.root.fields.totalCount;
}

async function fetchVespaSnapshotDocumentCount(
  vespaUrl: string,
  snapshotId: string,
  mtls?: VespaMtlsConfig,
): Promise<number> {
  const body = await fetchVespaSearchJson(
    vespaUrl,
    {
      yql: `select * from sources * where search_snapshot_id contains ${JSON.stringify(snapshotId)} limit 0;`,
    },
    'Vespa snapshot readiness query failed',
    mtls,
  );
  const parsed = VespaCountResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Vespa snapshot readiness query returned unexpected response shape: ${parsed.error.message}`);
  }
  return parsed.data.root.fields.totalCount;
}

async function fetchVespaWineTypeDocumentCount(
  vespaUrl: string,
  snapshotId: string,
  wineType: CriticalWineType,
  mtls?: VespaMtlsConfig,
): Promise<number> {
  const body = await fetchVespaSearchJson(
    vespaUrl,
    {
      yql: `select * from sources * where search_snapshot_id contains ${JSON.stringify(snapshotId)} and wine_type contains ${JSON.stringify(wineType)} limit 0;`,
    },
    `Vespa wine_type readiness query failed for ${wineType}`,
    mtls,
  );
  const parsed = VespaCountResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Vespa wine_type readiness query returned unexpected response shape for ${wineType}: ${parsed.error.message}`);
  }
  return parsed.data.root.fields.totalCount;
}

export function canonicalizeEntityRuntimeRows(
  rows: readonly {
    readonly entity_id: string;
    readonly entity_type: string;
    readonly canonical_label: string;
    readonly identity_signature: string;
    readonly relations: unknown;
    readonly attributes: unknown;
    readonly metadata: unknown;
  }[],
): readonly CanonicalEntitySnapshotRecord[] {
  const asRecord = (val: unknown): Record<string, unknown> =>
    typeof val === 'object' && val !== null && !Array.isArray(val) ? val as Record<string, unknown> : {};

  return canonicalizeEntitySnapshotRecords(rows.map((row) => {
    if (row.entity_type !== 'wine') {
      throw new Error(`canonicalizeEntityRuntimeRows: unexpected entity_type "${row.entity_type}"`);
    }
    return {
      entityId: row.entity_id,
      entityType: 'wine' as const,
      canonicalLabel: row.canonical_label,
      identitySignature: row.identity_signature,
      relations: asRecord(row.relations),
      attributes: asRecord(row.attributes),
      metadata: asRecord(row.metadata),
    };
  }));
}

export function canonicalizeAliasRuntimeRows(
  rows: readonly {
    readonly alias_id: string;
    readonly entity_id: string;
    readonly alias_type: string;
    readonly alias_scope: string;
    readonly surface_form: string;
    readonly normalized_value: string;
    readonly source: string;
    readonly source_trust: number;
    readonly confidence: number;
  }[],
): readonly CanonicalAliasSnapshotRecord[] {
  return canonicalizeAliasSnapshotRecords(rows.map((row) => ({
    aliasId: row.alias_id,
    entityId: row.entity_id,
    value: row.surface_form,
    normalizedValue: row.normalized_value,
    type: row.alias_type,
    scope: row.alias_scope,
    source: row.source,
    sourceTrust: row.source_trust,
    confidencePrior: row.confidence,
  })));
}

export function canonicalizeAmbiguityRuntimeRows(
  rows: readonly {
    readonly registry_id: string;
    readonly normalized_form: string;
    readonly entity_ids: readonly string[];
    readonly ambiguity_types: readonly string[];
    readonly severity: 'low' | 'medium' | 'high';
  }[],
): readonly CanonicalAmbiguitySnapshotRow[] {
  return canonicalizeAmbiguitySnapshotRows(rows.map((row) => ({
    registryId: row.registry_id,
    normalizedForm: row.normalized_form,
    entityIds: row.entity_ids,
    ambiguityTypes: row.ambiguity_types,
    severity: row.severity,
  })));
}

export async function loadSearchSnapshotRuntimeState(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): Promise<LoadedSearchSnapshotRuntimeState> {
  const raw = await fs.readFile(runtimeStatePath, 'utf8');
  const parsedUnknown: unknown = JSON.parse(raw);
  return validateRuntimeStateShape(parsedUnknown as RuntimeStateShape);
}

export async function verifySearchSnapshotRuntimeStateLive(args: {
  readonly pool: Pool;
  readonly vespaUrl: string;
  readonly vespaMtls?: VespaMtlsConfig | undefined;
  readonly runtimeStatePath?: string;
  readonly runtimeState?: LoadedSearchSnapshotRuntimeState;
  readonly strictHashes?: boolean | undefined;
  readonly requireActiveLtr?: boolean | undefined;
  /** T-010/W2: when true, additionally verify active_search_snapshot pointer matches runtime state. */
  readonly requirePointerParity?: boolean | undefined;
}): Promise<LoadedSearchSnapshotRuntimeState> {
  const runtimeState = args.runtimeState ?? await loadSearchSnapshotRuntimeState(args.runtimeStatePath);

  // T-010/W2: pointer-aware readiness.
  //
  // The DB pointer is the runtime authority for "which snapshot is served".
  // If it drifts from the runtime-state file the read path will filter on a
  // different snapshot_id than the one the file advertises — pointing users
  // at one version in logs/ops and serving another version of data. Fail
  // loudly.
  //
  // Opt-in via requirePointerParity to keep legacy callers (tests, the
  // initial bootstrap step before the first publish) unaffected. The
  // publish flow should pass requirePointerParity=true once migration 010
  // is live on all environments.
  if (args.requirePointerParity === true) {
    // 42P01 (undefined_table) is only tolerable in environments without the
    // pointer migration applied. When requirePointerParity=true the caller
    // has asked for strict mode — we let the raw PG error propagate so the
    // missing table surfaces as a fatal readiness failure.
    const pointerRes = await args.pool.query<{ active_snapshot_id: string; content_hash: string }>(
      `SELECT active_snapshot_id, content_hash FROM active_search_snapshot WHERE id = 1`,
    );
    const pointerRow = pointerRes.rows[0];
    if (pointerRow === undefined) {
      throw new Error(
        '[readiness] active_search_snapshot pointer row is missing. ' +
        'The publish has not flipped the pointer — refusing to mark runtime live.',
      );
    }
    if (pointerRow.active_snapshot_id !== runtimeState.snapshotId) {
      throw new Error(
        `[readiness] pointer/runtime-state drift: ` +
        `active_search_snapshot.active_snapshot_id=${pointerRow.active_snapshot_id} ` +
        `vs runtime-state.snapshotId=${runtimeState.snapshotId}. ` +
        `The DB is serving a different snapshot than the runtime-state file advertises.`,
      );
    }
  if (
      runtimeState.contentHash.length > 0
      && pointerRow.content_hash.length > 0
      && pointerRow.content_hash !== runtimeState.contentHash
    ) {
      throw new Error(
        `[readiness] content_hash drift for snapshot ${runtimeState.snapshotId}: ` +
        `pointer=${pointerRow.content_hash} vs runtime-state=${runtimeState.contentHash}.`,
      );
    }
  }

  const ltrFeatureSchemaHashSupported = await pgTableHasColumn(
    args.pool,
    'ltr_model_registry',
    'feature_schema_hash',
  );

  const [
    entityResult,
    aliasResult,
    ambiguityResult,
    ltrResult,
    nlMappingsRuntime,
    vespaDocumentCount,
    vespaWineTypeCounts,
    canonicalGraphEntityResult,
    canonicalIdentityAuthorityResult,
    vivinoNamespaceSealResult,
    runtimeRedWineTypeCountResult,
    runtimeWhiteWineTypeCountResult,
    runtimeSparklingWineTypeCountResult,
    canonicalAliasJoinResult,
    canonicalAmbiguityTotalResult,
    vespaWineTypePayloadProbe,
  ] = await Promise.all([
    args.pool.query<{ total_count: string; snapshot_count: string }>(
      `SELECT
         COUNT(*)::text AS total_count,
         COUNT(*) FILTER (WHERE search_snapshot_id = $1)::text AS snapshot_count
       FROM entities`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ total_count: string; snapshot_count: string }>(
      `SELECT
         COUNT(*)::text AS total_count,
         COUNT(*) FILTER (WHERE search_snapshot_id = $1)::text AS snapshot_count
       FROM aliases`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ total_count: string; snapshot_count: string }>(
      `SELECT
         COUNT(*)::text AS total_count,
         COUNT(*) FILTER (WHERE search_snapshot_id = $1)::text AS snapshot_count
       FROM ambiguity_registry`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{
      total_count: string;
      snapshot_count: string;
      query_class: string | null;
      model_version: number | null;
      eval_dataset_version: string | null;
      feature_schema_hash: string | null;
      weights: number[] | null;
      bias: number | null;
    }>(
      ltrFeatureSchemaHashSupported
        ? `WITH counts AS (
             SELECT
               COUNT(*) FILTER (WHERE is_active = TRUE)::text AS total_count,
               COUNT(*) FILTER (WHERE is_active = TRUE AND search_snapshot_id = $1)::text AS snapshot_count
             FROM ltr_model_registry
           )
           SELECT
             counts.total_count,
             counts.snapshot_count,
             registry.query_class,
             registry.model_version,
             registry.eval_dataset_version,
             registry.feature_schema_hash,
             registry.weights,
             registry.bias
           FROM counts
           LEFT JOIN LATERAL (
             SELECT query_class, model_version, eval_dataset_version, feature_schema_hash, weights, bias
             FROM ltr_model_registry
             WHERE is_active = TRUE AND search_snapshot_id = $1
             ORDER BY query_class ASC, model_version ASC
           ) AS registry ON TRUE`
        : `WITH counts AS (
             SELECT
               COUNT(*) FILTER (WHERE is_active = TRUE)::text AS total_count,
               COUNT(*) FILTER (WHERE is_active = TRUE AND search_snapshot_id = $1)::text AS snapshot_count
             FROM ltr_model_registry
           )
           SELECT
             counts.total_count,
             counts.snapshot_count,
             registry.query_class,
             registry.model_version,
             registry.eval_dataset_version,
             NULL::text AS feature_schema_hash,
             registry.weights,
             registry.bias
           FROM counts
           LEFT JOIN LATERAL (
             SELECT query_class, model_version, eval_dataset_version, weights, bias
             FROM ltr_model_registry
             WHERE is_active = TRUE AND search_snapshot_id = $1
             ORDER BY query_class ASC, model_version ASC
           ) AS registry ON TRUE`,
      [runtimeState.snapshotId],
    ),
    loadNlMappingsRuntimeInfo(runtimeState.nlMappingsRuntimePath),
    fetchVespaSnapshotDocumentCount(args.vespaUrl, runtimeState.snapshotId, args.vespaMtls),
    Promise.all(
      CRITICAL_WINE_TYPES.map(async (wineType) => ({
        wineType,
        count: await fetchVespaWineTypeDocumentCount(
          args.vespaUrl,
          runtimeState.snapshotId,
          wineType,
          args.vespaMtls,
        ),
      })),
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_entities
       WHERE search_snapshot_id = $1`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities e
       INNER JOIN canonical_identity_authority cia
         ON cia.identity_signature = e.identity_signature
        AND cia.canonical_entity_id = e.entity_id
       WHERE e.search_snapshot_id = $1`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{
      entities_violations: string;
      canonical_entities_violations: string;
      aliases_violations: string;
      ambiguity_registry_violations: string;
      canonical_ambiguity_violations: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM entities
            WHERE search_snapshot_id = $1 AND entity_id LIKE $2)::text
           AS entities_violations,
         (SELECT COUNT(*) FROM canonical_entities
            WHERE search_snapshot_id = $1
              AND canonical_entity_id LIKE $2)::text
           AS canonical_entities_violations,
         (SELECT COUNT(*) FROM aliases
            WHERE search_snapshot_id = $1 AND entity_id LIKE $2)::text
           AS aliases_violations,
         (SELECT COUNT(*) FROM ambiguity_registry
            WHERE search_snapshot_id = $1
              AND EXISTS (
                SELECT 1 FROM unnest(entity_ids) AS eid
                 WHERE eid LIKE $2
              ))::text
           AS ambiguity_registry_violations,
         (SELECT COUNT(*) FROM canonical_ambiguity_registry
            WHERE search_snapshot_id = $1
              AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(canonical_entity_ids) AS eid
               WHERE eid LIKE $2
            ))::text
           AS canonical_ambiguity_violations`,
      [runtimeState.snapshotId, SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities
       WHERE search_snapshot_id = $1
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type', attributes->>'style') = $2`,
      [runtimeState.snapshotId, 'red'],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities
       WHERE search_snapshot_id = $1
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type', attributes->>'style') = $2`,
      [runtimeState.snapshotId, 'white'],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities
       WHERE search_snapshot_id = $1
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type', attributes->>'style') = $2`,
      [runtimeState.snapshotId, 'sparkling'],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_aliases ca
       INNER JOIN entities e
         ON e.entity_id = ca.canonical_entity_id
        AND e.search_snapshot_id = $1
       WHERE ca.search_snapshot_id = $1`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_ambiguity_registry
       WHERE search_snapshot_id = $1`,
      [runtimeState.snapshotId],
    ),
    Promise.all(
      CRITICAL_WINE_TYPES.map(async (wineType) =>
        fetchVespaWineTypePayloadProbe(args.vespaUrl, runtimeState.snapshotId, wineType, args.vespaMtls)),
    ),
  ]);

  const entityCount = parseSqlCountText(entityResult.rows[0]?.snapshot_count, 'entities.snapshot_count');
  const entityTotalCount = parseSqlCountText(entityResult.rows[0]?.total_count, 'entities.total_count');
  const aliasCount = parseSqlCountText(aliasResult.rows[0]?.snapshot_count, 'aliases.snapshot_count');
  const aliasTotalCount = parseSqlCountText(aliasResult.rows[0]?.total_count, 'aliases.total_count');
  const ambiguityCount = parseSqlCountText(ambiguityResult.rows[0]?.snapshot_count, 'ambiguity_registry.snapshot_count');
  const ambiguityTotalCount = parseSqlCountText(ambiguityResult.rows[0]?.total_count, 'ambiguity_registry.total_count');
  const activeLtrCount = parseSqlCountText(ltrResult.rows[0]?.snapshot_count, 'ltr_model_registry.snapshot_count');
  const activeLtrTotalCount = parseSqlCountText(ltrResult.rows[0]?.total_count, 'ltr_model_registry.total_count');
  const runtimeWineTypeCounts = {
    red: parseSqlCountText(runtimeRedWineTypeCountResult.rows[0]?.c, 'entities.wine_type.red'),
    white: parseSqlCountText(runtimeWhiteWineTypeCountResult.rows[0]?.c, 'entities.wine_type.white'),
    sparkling: parseSqlCountText(runtimeSparklingWineTypeCountResult.rows[0]?.c, 'entities.wine_type.sparkling'),
  } satisfies Record<CriticalWineType, number>;

  if (entityCount !== runtimeState.counts.entities || entityCount <= 0) {
    throw new Error(`Entity runtime count mismatch: runtime=${entityCount}/${entityTotalCount}, state=${runtimeState.counts.entities}`);
  }
  const missingRuntimeWineTypes = CRITICAL_WINE_TYPES.filter((wineType) => runtimeWineTypeCounts[wineType] <= 0);
  if (missingRuntimeWineTypes.length > 0) {
    throw new Error(
      `Critical wine_type runtime coverage missing for snapshot ${runtimeState.snapshotId}: ${missingRuntimeWineTypes.join(', ')}`,
    );
  }
  const missingVespaWineTypes = vespaWineTypeCounts
    .filter(({ count }) => count <= 0)
    .map(({ wineType }) => wineType);
  if (missingVespaWineTypes.length > 0) {
    throw new Error(
      `Critical wine_type Vespa coverage missing for snapshot ${runtimeState.snapshotId}: ${missingVespaWineTypes.join(', ')}`,
    );
  }

  const payloadEmptyButExpected = vespaWineTypePayloadProbe
    .filter((probe) => {
      const configuredCount = runtimeWineTypeCounts[probe.wineType];
      return configuredCount > 0 && probe.sampleCount === 0;
    })
    .map((probe) => `${probe.wineType}(sample_count=0)`);
  if (payloadEmptyButExpected.length > 0) {
    throw new Error(
      `Critical wine_type Vespa payload probe returned no samples for snapshot ${runtimeState.snapshotId}: ${payloadEmptyButExpected.join(', ')}`,
    );
  }

  const payloadViolations = vespaWineTypePayloadProbe
    .flatMap((probe) => probe.violations)
    .filter((violation) => violation.issues.length > 0);
  if (payloadViolations.length > 0) {
    const details = payloadViolations
      .map((violation) => {
        const issues = violation.issues.join('; ');
        return `${violation.wineType}:${violation.entityId}: ${issues}`;
      })
      .join(' | ');
    throw new Error(`Critical wine_type Vespa payload requirement violations for snapshot ${runtimeState.snapshotId}: ${details}`);
  }

  const canonicalGraphEntityCount = parseSqlCountText(canonicalGraphEntityResult.rows[0]?.c, 'canonical_entities.snapshot');
  if (canonicalGraphEntityCount !== runtimeState.counts.entities) {
    throw new Error(
      `Canonical graph entity count mismatch: canonical_entities for snapshot=${canonicalGraphEntityCount}, runtime entities=${runtimeState.counts.entities}`,
    );
  }
  const canonicalIdentityAuthorityCount = parseSqlCountText(
    canonicalIdentityAuthorityResult.rows[0]?.c,
    'canonical_identity_authority.runtime_join',
  );
  if (canonicalIdentityAuthorityCount !== runtimeState.counts.entities) {
    throw new Error(
      `Canonical identity authority mismatch: canonical_identity_authority runtime join=${canonicalIdentityAuthorityCount}, runtime entities=${runtimeState.counts.entities}`,
    );
  }
  const sealRow = vivinoNamespaceSealResult.rows[0];
  const sealCounts = {
    entities: parseSqlCountText(sealRow?.entities_violations, 'namespace_seal.entities'),
    canonical_entities: parseSqlCountText(sealRow?.canonical_entities_violations, 'namespace_seal.canonical_entities'),
    aliases: parseSqlCountText(sealRow?.aliases_violations, 'namespace_seal.aliases'),
    ambiguity_registry: parseSqlCountText(sealRow?.ambiguity_registry_violations, 'namespace_seal.ambiguity_registry'),
    canonical_ambiguity_registry: parseSqlCountText(sealRow?.canonical_ambiguity_violations, 'namespace_seal.canonical_ambiguity_registry'),
  } as const;
  const sealOffenders = Object.entries(sealCounts).filter(([, n]) => n > 0);
  if (sealOffenders.length > 0) {
    const detail = sealOffenders.map(([table, n]) => `${table}=${n}`).join(', ');
    throw new Error(
      `ADR-007 namespace seal: source-style id (LIKE '${SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN}') present in ${detail}`,
    );
  }
  const vespaNamespaceViolations = await fetchVespaNamespaceSealViolationCount(args.vespaUrl, args.vespaMtls);
  if (vespaNamespaceViolations > 0) {
    throw new Error(
      `ADR-007 namespace seal: Vespa contains ${vespaNamespaceViolations} document(s) whose entity_id starts with '${SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX}'`,
    );
  }

  const canonicalAliasJoinCount = parseSqlCountText(canonicalAliasJoinResult.rows[0]?.c, 'canonical_aliases_join');
  if (canonicalAliasJoinCount !== aliasCount) {
    throw new Error(
      `Canonical alias projection mismatch: canonical_aliases for snapshot=${canonicalAliasJoinCount}, runtime aliases=${aliasCount}`,
    );
  }
  const canonicalAmbiguityTotalCount = parseSqlCountText(canonicalAmbiguityTotalResult.rows[0]?.c, 'canonical_ambiguity_registry');
  if (canonicalAmbiguityTotalCount !== ambiguityCount) {
    throw new Error(
      `Canonical ambiguity projection mismatch: canonical_ambiguity_registry for snapshot=${canonicalAmbiguityTotalCount}, runtime ambiguity=${ambiguityCount}`,
    );
  }

  if (aliasCount !== runtimeState.counts.aliases || aliasCount <= 0) {
    throw new Error(`Alias runtime count mismatch: runtime=${aliasCount}/${aliasTotalCount}, state=${runtimeState.counts.aliases}`);
  }
  if (ambiguityCount !== runtimeState.counts.ambiguityRegistry) {
    throw new Error(`Ambiguity runtime count mismatch: runtime=${ambiguityCount}/${ambiguityTotalCount}, state=${runtimeState.counts.ambiguityRegistry}`);
  }
  if (nlMappingsRuntime.count !== runtimeState.counts.nlMappings || nlMappingsRuntime.count <= 0) {
    throw new Error(`NL mappings runtime count mismatch: runtime=${nlMappingsRuntime.count}, state=${runtimeState.counts.nlMappings}`);
  }
  const activeLtrCountMismatch = activeLtrCount !== runtimeState.counts.activeLtrModels;
  if (activeLtrCountMismatch) {
    throw new Error(`Active LTR runtime count mismatch: runtime=${activeLtrCount}/${activeLtrTotalCount}, state=${runtimeState.counts.activeLtrModels}`);
  }
  if (args.requireActiveLtr === true && activeLtrCount <= 0) {
    throw new Error('Active LTR runtime count is zero');
  }
  if (runtimeState.quality.blockers.length > 0) {
    throw new Error(`Runtime quality blockers present: ${runtimeState.quality.blockers.join(', ')}`);
  }
  if (vespaDocumentCount !== runtimeState.counts.entities) {
    throw new Error(
      `Vespa snapshot document count mismatch: runtime=${vespaDocumentCount}, state=${runtimeState.counts.entities}`,
    );
  }
  if (nlMappingsRuntime.hash !== runtimeState.hashes.nlMappings) {
    throw new Error(`NL mappings runtime hash mismatch: runtime=${nlMappingsRuntime.hash}, state=${runtimeState.hashes.nlMappings}`);
  }

  const activeLtrHash = hashStableJson(
    ltrResult.rows
      .filter((row) => row.query_class !== null)
      .map((row) => ({
        query_class: row.query_class,
        model_version: row.model_version,
        eval_dataset_version: row.eval_dataset_version,
        feature_schema_hash: row.feature_schema_hash,
        weights: row.weights,
        bias: row.bias,
      })),
  );
  if (activeLtrHash !== runtimeState.hashes.activeLtrModels) {
    throw new Error(`Active LTR runtime hash mismatch: runtime=${activeLtrHash}, state=${runtimeState.hashes.activeLtrModels}`);
  }
  const currentFeatureSchemaHash = getCurrentFeatureSchemaHash();
  const mismatchedFeatureSchema = ltrFeatureSchemaHashSupported && ltrResult.rows.some(
    (row) => row.query_class !== null && row.feature_schema_hash !== currentFeatureSchemaHash,
  );
  if (mismatchedFeatureSchema) {
    throw new Error(
      `Active LTR feature schema mismatch: expected=${currentFeatureSchemaHash}`,
    );
  }

  if (args.strictHashes === true) {
    const [entityRows, aliasRows, ambiguityRows] = await Promise.all([
      args.pool.query(
        `SELECT entity_id, entity_type, canonical_label, identity_signature, relations, attributes, metadata
         FROM entities
         WHERE search_snapshot_id = $1
         ORDER BY entity_id ASC`,
        [runtimeState.snapshotId],
      ),
      args.pool.query(
        `SELECT alias_id, entity_id, alias_type, alias_scope, surface_form, normalized_value, source, source_trust, confidence
         FROM aliases
         WHERE search_snapshot_id = $1
         ORDER BY alias_id ASC`,
        [runtimeState.snapshotId],
      ),
      args.pool.query(
        `SELECT registry_id, normalized_form, entity_ids, ambiguity_types, severity
         FROM ambiguity_registry
         WHERE search_snapshot_id = $1
         ORDER BY registry_id ASC`,
        [runtimeState.snapshotId],
      ),
    ]);

    const entityHash = hashStableJson(canonicalizeEntityRuntimeRows(entityRows.rows));
    const aliasHash = hashStableJson(canonicalizeAliasRuntimeRows(aliasRows.rows));
    const ambiguityHash = hashStableJson(canonicalizeAmbiguityRuntimeRows(ambiguityRows.rows));
    if (entityHash !== runtimeState.hashes.entities) {
      throw new Error(`Entity runtime hash mismatch: runtime=${entityHash}, state=${runtimeState.hashes.entities}`);
    }
    if (aliasHash !== runtimeState.hashes.aliases) {
      throw new Error(`Alias runtime hash mismatch: runtime=${aliasHash}, state=${runtimeState.hashes.aliases}`);
    }
    if (ambiguityHash !== runtimeState.hashes.ambiguityRegistry) {
      throw new Error(`Ambiguity runtime hash mismatch: runtime=${ambiguityHash}, state=${runtimeState.hashes.ambiguityRegistry}`);
    }
  }

  return runtimeState;
}

export async function probeSearchSnapshotRuntimeState(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
  options?: {
    readonly requireActiveLtr?: boolean | undefined;
  },
): Promise<ReadinessStatus> {
  try {
    const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
    const nlMappingsRuntime = await loadNlMappingsRuntimeInfo(runtimeState.nlMappingsRuntimePath);
    if (
      runtimeState.counts.entities <= 0
      || runtimeState.counts.aliases <= 0
      || nlMappingsRuntime.count !== runtimeState.counts.nlMappings
      || nlMappingsRuntime.count <= 0
      || nlMappingsRuntime.hash !== runtimeState.hashes.nlMappings
      || (options?.requireActiveLtr === true && runtimeState.counts.activeLtrModels <= 0)
      || runtimeState.quality.blockers.length > 0
    ) {
      return 'down';
    }
    return 'up';
  } catch {
    return 'down';
  }
}
