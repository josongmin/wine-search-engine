import fs from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import { resolveDataPath } from '../../shared/utils/data-paths.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../shared/utils/stable-json.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../shared/constants/search-snapshot.js';
import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';
import { getCurrentFeatureSchemaHash } from '../../domain/ranking/service/feature-parity-hash.js';
import {
  SOURCE_RECORD_PUBLIC_ENTITY_ID_LIKE_PATTERN,
  SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX,
} from '../../shared/constants/public-entity-id-namespace.js';

const VespaCountResponseSchema = z.object({
  root: z.object({
    fields: z.object({
      totalCount: z.number().int().nonnegative(),
    }),
  }),
});

const CRITICAL_WINE_TYPES = ['red', 'white', 'sparkling'] as const;
type CriticalWineType = typeof CRITICAL_WINE_TYPES[number];

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
async function fetchVespaNamespaceSealViolationCount(vespaUrl: string): Promise<number> {
  const anchoredPrefix = `^${SOURCE_RECORD_PUBLIC_ENTITY_ID_PREFIX}`;
  const response = await fetch(`${vespaUrl.replace(/\/$/, '')}/search/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      yql: `select * from sources * where entity_id matches ${JSON.stringify(anchoredPrefix)} limit 0;`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Vespa namespace seal query failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  const parsed = VespaCountResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Vespa namespace seal query returned unexpected response shape: ${parsed.error.message}`);
  }
  return parsed.data.root.fields.totalCount;
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

  const body: unknown = await response.json();
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
): Promise<number> {
  const response = await fetch(`${vespaUrl.replace(/\/$/, '')}/search/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      yql: `select * from sources * where search_snapshot_id contains ${JSON.stringify(snapshotId)} and wine_type contains ${JSON.stringify(wineType)} limit 0;`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vespa wine_type readiness query failed with status ${response.status} for ${wineType}`);
  }

  const body: unknown = await response.json();
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

  return rows.map((row) => {
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
  }).sort((left, right) => left.entityId.localeCompare(right.entityId));
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
    Promise.all(
      CRITICAL_WINE_TYPES.map(async (wineType) => ({
        wineType,
        count: await fetchVespaWineTypeDocumentCount(args.vespaUrl, runtimeState.snapshotId, wineType),
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
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type') = $2`,
      [runtimeState.snapshotId, 'red'],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities
       WHERE search_snapshot_id = $1
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type') = $2`,
      [runtimeState.snapshotId, 'white'],
    ),
    args.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM entities
       WHERE search_snapshot_id = $1
         AND COALESCE(attributes->>'wineType', attributes->>'wine_type') = $2`,
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

  if (entityCount !== runtimeState.counts.entities || entityCount <= 0 || entityTotalCount !== entityCount) {
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
  const vespaNamespaceViolations = await fetchVespaNamespaceSealViolationCount(args.vespaUrl);
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

  if (aliasCount !== runtimeState.counts.aliases || aliasCount <= 0 || aliasTotalCount !== aliasCount) {
    throw new Error(`Alias runtime count mismatch: runtime=${aliasCount}/${aliasTotalCount}, state=${runtimeState.counts.aliases}`);
  }
  if (ambiguityCount !== runtimeState.counts.ambiguityRegistry || ambiguityTotalCount !== ambiguityCount) {
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
