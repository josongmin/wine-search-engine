import fs from 'node:fs/promises';
import type { Pool } from 'pg';
import { resolveDataPath } from '../../shared/utils/data-paths.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../shared/utils/stable-json.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../shared/constants/search-snapshot.js';
import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';
import { getCurrentFeatureSchemaHash } from '../../domain/ranking/service/feature-parity-hash.js';
import { SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN } from '../../shared/constants/public-entity-id-namespace.js';

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

export interface LoadedSearchSnapshotRuntimeState {
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
  readonly allowMissingLtr?: unknown;
  readonly counts?: {
    readonly entities?: unknown;
    readonly aliases?: unknown;
    readonly ambiguityRegistry?: unknown;
    readonly nlMappings?: unknown;
    readonly activeLtrModels?: unknown;
  };
  readonly hashes?: {
    readonly entities?: unknown;
    readonly aliases?: unknown;
    readonly ambiguityRegistry?: unknown;
    readonly nlMappings?: unknown;
    readonly activeLtrModels?: unknown;
  };
};

function isFiniteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateRuntimeStateShape(parsed: RuntimeStateShape): LoadedSearchSnapshotRuntimeState {
  const counts = parsed.counts;
  const hashes = parsed.hashes;
  if (
    parsed.schemaVersion !== SEARCH_SNAPSHOT_STATE_VERSION
    || typeof parsed.snapshotId !== 'string'
    || parsed.snapshotId.length === 0
    || typeof parsed.contentHash !== 'string'
    || parsed.contentHash.length === 0
    || typeof parsed.publishedAt !== 'string'
    || parsed.publishedAt.length === 0
    || typeof parsed.manifestPath !== 'string'
    || parsed.manifestPath.length === 0
    || typeof parsed.nlMappingsRuntimePath !== 'string'
    || parsed.nlMappingsRuntimePath.length === 0
    || typeof parsed.allowMissingLtr !== 'boolean'
    || counts === undefined
    || !isFiniteCount(counts.entities)
    || !isFiniteCount(counts.aliases)
    || !isFiniteCount(counts.ambiguityRegistry)
    || !isFiniteCount(counts.nlMappings)
    || !isFiniteCount(counts.activeLtrModels)
    || hashes === undefined
    || typeof hashes.entities !== 'string'
    || hashes.entities.length === 0
    || typeof hashes.aliases !== 'string'
    || hashes.aliases.length === 0
    || typeof hashes.ambiguityRegistry !== 'string'
    || hashes.ambiguityRegistry.length === 0
    || typeof hashes.nlMappings !== 'string'
    || hashes.nlMappings.length === 0
    || typeof hashes.activeLtrModels !== 'string'
    || hashes.activeLtrModels.length === 0
  ) {
    throw new Error('Malformed runtime search snapshot state');
  }

  return {
    schemaVersion: parsed.schemaVersion,
    snapshotId: parsed.snapshotId,
    contentHash: parsed.contentHash,
    publishedAt: parsed.publishedAt,
    manifestPath: parsed.manifestPath,
    nlMappingsRuntimePath: parsed.nlMappingsRuntimePath,
    allowMissingLtr: parsed.allowMissingLtr,
    counts: {
      entities: counts.entities,
      aliases: counts.aliases,
      ambiguityRegistry: counts.ambiguityRegistry,
      nlMappings: counts.nlMappings,
      activeLtrModels: counts.activeLtrModels,
    },
    hashes: {
      entities: hashes.entities,
      aliases: hashes.aliases,
      ambiguityRegistry: hashes.ambiguityRegistry,
      nlMappings: hashes.nlMappings,
      activeLtrModels: hashes.activeLtrModels,
    },
  };
}

async function loadNlMappingsRuntimeInfo(nlMappingsRuntimePath: string): Promise<{
  readonly count: number;
  readonly hash: string;
}> {
  const nlMappingsRaw = await fs.readFile(nlMappingsRuntimePath, 'utf8');
  const nlMappingsParsedUnknown: unknown = JSON.parse(nlMappingsRaw);
  const nlMappingsParsed = nlMappingsParsedUnknown as { mappings?: unknown[] };
  if (!Array.isArray(nlMappingsParsed.mappings)) {
    throw new Error('Malformed runtime NL mappings');
  }
  return {
    count: nlMappingsParsed.mappings.length,
    hash: hashText(`${stableJsonStringify(nlMappingsParsed)}\n`),
  };
}

async function fetchVespaSnapshotDocumentCount(vespaUrl: string, snapshotId: string): Promise<number> {
  const response = await fetch(`${vespaUrl.replace(/\/$/, '')}/search/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      yql: `select * from sources * where search_snapshot_id contains ${JSON.stringify(snapshotId)} limit 0;`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vespa snapshot readiness query failed with status ${response.status}`);
  }

  const body = await response.json() as {
    root?: { fields?: { totalCount?: unknown } };
  };
  const totalCount = body.root?.fields?.totalCount;
  if (typeof totalCount !== 'number' || !Number.isFinite(totalCount)) {
    throw new Error('Vespa snapshot readiness query returned no finite totalCount');
  }
  return totalCount;
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
  return rows.map((row) => ({
    entityId: row.entity_id,
    entityType: row.entity_type as CanonicalEntitySnapshotRecord['entityType'],
    canonicalLabel: row.canonical_label,
    identitySignature: row.identity_signature,
    relations: row.relations as Record<string, unknown>,
    attributes: row.attributes as Record<string, unknown>,
    metadata: row.metadata as Record<string, unknown>,
  })).sort((left, right) => left.entityId.localeCompare(right.entityId));
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
  return rows.map((row) => ({
    aliasId: row.alias_id,
    entityId: row.entity_id,
    value: row.surface_form,
    normalizedValue: row.normalized_value,
    type: row.alias_type,
    scope: row.alias_scope,
    source: row.source,
    sourceTrust: row.source_trust,
    confidencePrior: row.confidence,
  })).sort((left, right) =>
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.entityId.localeCompare(right.entityId)
    || left.aliasId.localeCompare(right.aliasId),
  );
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
  return rows.map((row) => ({
    registryId: row.registry_id,
    normalizedForm: row.normalized_form,
    entityIds: row.entity_ids,
    ambiguityTypes: row.ambiguity_types,
    severity: row.severity,
  })).sort((left, right) =>
    left.normalizedForm.localeCompare(right.normalizedForm)
    || left.registryId.localeCompare(right.registryId),
  );
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
  readonly runtimeStatePath?: string;
  readonly runtimeState?: LoadedSearchSnapshotRuntimeState;
  readonly strictHashes?: boolean | undefined;
}): Promise<LoadedSearchSnapshotRuntimeState> {
  const runtimeState = args.runtimeState ?? await loadSearchSnapshotRuntimeState(args.runtimeStatePath);

  const [
    entityResult,
    aliasResult,
    ambiguityResult,
    ltrResult,
    nlMappingsRuntime,
    vespaDocumentCount,
    canonicalGraphEntityResult,
    vivinoNamespaceSealResult,
    canonicalAliasJoinResult,
    canonicalAmbiguityTotalResult,
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
      `WITH counts AS (
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
       ) AS registry ON TRUE`,
      [runtimeState.snapshotId],
    ),
    loadNlMappingsRuntimeInfo(runtimeState.nlMappingsRuntimePath),
    fetchVespaSnapshotDocumentCount(args.vespaUrl, runtimeState.snapshotId),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_entities
       WHERE source_provenance->>'search_snapshot_id' = $1`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ c: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM entities WHERE search_snapshot_id = $1 AND entity_id LIKE $2)
         + (SELECT COUNT(*) FROM canonical_entities WHERE canonical_entity_id LIKE $2)
       )::text AS c`,
      [runtimeState.snapshotId, SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM canonical_aliases ca
       INNER JOIN entities e
         ON e.entity_id = ca.canonical_entity_id AND e.search_snapshot_id = $1`,
      [runtimeState.snapshotId],
    ),
    args.pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM canonical_ambiguity_registry`),
  ]);

  const entityCount = parseSqlCountText(entityResult.rows[0]?.snapshot_count, 'entities.snapshot_count');
  const entityTotalCount = parseSqlCountText(entityResult.rows[0]?.total_count, 'entities.total_count');
  const aliasCount = parseSqlCountText(aliasResult.rows[0]?.snapshot_count, 'aliases.snapshot_count');
  const aliasTotalCount = parseSqlCountText(aliasResult.rows[0]?.total_count, 'aliases.total_count');
  const ambiguityCount = parseSqlCountText(ambiguityResult.rows[0]?.snapshot_count, 'ambiguity_registry.snapshot_count');
  const ambiguityTotalCount = parseSqlCountText(ambiguityResult.rows[0]?.total_count, 'ambiguity_registry.total_count');
  const activeLtrCount = parseSqlCountText(ltrResult.rows[0]?.snapshot_count, 'ltr_model_registry.snapshot_count');
  const activeLtrTotalCount = parseSqlCountText(ltrResult.rows[0]?.total_count, 'ltr_model_registry.total_count');

  if (entityCount !== runtimeState.counts.entities || entityCount <= 0 || entityTotalCount !== entityCount) {
    throw new Error(`Entity runtime count mismatch: runtime=${entityCount}/${entityTotalCount}, state=${runtimeState.counts.entities}`);
  }

  const canonicalGraphEntityCount = parseSqlCountText(canonicalGraphEntityResult.rows[0]?.c, 'canonical_entities.snapshot');
  if (canonicalGraphEntityCount !== runtimeState.counts.entities) {
    throw new Error(
      `Canonical graph entity count mismatch: canonical_entities for snapshot=${canonicalGraphEntityCount}, runtime entities=${runtimeState.counts.entities}`,
    );
  }
  const vivinoNamespaceViolations = parseSqlCountText(vivinoNamespaceSealResult.rows[0]?.c, 'vivino_namespace_seal');
  if (vivinoNamespaceViolations > 0) {
    throw new Error(
      `ADR-007 namespace seal: ${vivinoNamespaceViolations} row(s) use entity_id LIKE '${SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN}' in entities or canonical_entities`,
    );
  }

  const canonicalAliasJoinCount = parseSqlCountText(canonicalAliasJoinResult.rows[0]?.c, 'canonical_aliases_join');
  if (canonicalAliasJoinCount !== aliasCount) {
    throw new Error(
      `Canonical alias projection mismatch: canonical_aliases joined to active snapshot=${canonicalAliasJoinCount}, runtime aliases=${aliasCount}`,
    );
  }
  const canonicalAmbiguityTotalCount = parseSqlCountText(canonicalAmbiguityTotalResult.rows[0]?.c, 'canonical_ambiguity_registry');
  if (canonicalAmbiguityTotalCount !== ambiguityCount) {
    throw new Error(
      `Canonical ambiguity projection mismatch: canonical_ambiguity_registry=${canonicalAmbiguityTotalCount}, runtime ambiguity=${ambiguityCount}`,
    );
  }

  if (aliasCount !== runtimeState.counts.aliases || aliasCount <= 0 || aliasTotalCount !== aliasCount) {
    throw new Error(`Alias runtime count mismatch: runtime=${aliasCount}/${aliasTotalCount}, state=${runtimeState.counts.aliases}`);
  }
  if (ambiguityCount !== runtimeState.counts.ambiguityRegistry || ambiguityCount <= 0 || ambiguityTotalCount !== ambiguityCount) {
    throw new Error(`Ambiguity runtime count mismatch: runtime=${ambiguityCount}/${ambiguityTotalCount}, state=${runtimeState.counts.ambiguityRegistry}`);
  }
  if (nlMappingsRuntime.count !== runtimeState.counts.nlMappings || nlMappingsRuntime.count <= 0) {
    throw new Error(`NL mappings runtime count mismatch: runtime=${nlMappingsRuntime.count}, state=${runtimeState.counts.nlMappings}`);
  }
  if (activeLtrCount !== runtimeState.counts.activeLtrModels || activeLtrTotalCount !== activeLtrCount) {
    throw new Error(`Active LTR runtime count mismatch: runtime=${activeLtrCount}/${activeLtrTotalCount}, state=${runtimeState.counts.activeLtrModels}`);
  }
  if (activeLtrCount <= 0 && !runtimeState.allowMissingLtr) {
    throw new Error('Active LTR runtime count is zero without explicit no-LTR mode');
  }
  if (vespaDocumentCount <= 0) {
    throw new Error(`Vespa snapshot document count is zero for ${runtimeState.snapshotId}`);
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
  const mismatchedFeatureSchema = ltrResult.rows.some(
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
): Promise<ReadinessStatus> {
  try {
    const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
    const nlMappingsRuntime = await loadNlMappingsRuntimeInfo(runtimeState.nlMappingsRuntimePath);
    if (
      runtimeState.counts.entities <= 0
      || runtimeState.counts.aliases <= 0
      || runtimeState.counts.ambiguityRegistry <= 0
      || nlMappingsRuntime.count !== runtimeState.counts.nlMappings
      || nlMappingsRuntime.count <= 0
      || nlMappingsRuntime.hash !== runtimeState.hashes.nlMappings
      || (!runtimeState.allowMissingLtr && runtimeState.counts.activeLtrModels <= 0)
    ) {
      return 'down';
    }
    return 'up';
  } catch {
    return 'down';
  }
}
