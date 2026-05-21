/**
 * ADR-007: search snapshot `entityId` is canonical public identity — never `sourceId`.
 *
 * Public ids are always derived from the identity signature. Gold fixtures are
 * benchmark linkages only and must not replace the runtime public id.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { z } from 'zod';

import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  computeIdentitySignature,
  normalizeCanonicalLabelForIdentity,
} from '../../src/domain/entity/model/identity-signature.js';
import type { EnrichedSilverRecord } from './types.js';
import { parseNdjson } from './ndjson.js';
import {
  createCanonicalEntityId,
  type CanonicalEntityId,
  type SourceRecordId,
} from '../../src/domain/shared/types/entity-id.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import type { EntitySnapshotRecord } from './search-snapshot-schema.js';

/** Fields sufficient for ADR-007 wine canonical id (gold overlay + identity signature). */
export type WineSnapshotIdentityRow = Pick<
  EnrichedSilverRecord,
  'canonicalLabel' | 'producer' | 'country' | 'region' | 'vintageYear'
> & {
  readonly sourceId: SourceRecordId;
};
import { hashText } from './search-snapshot-schema.js';
import {
  isSourceRecordStylePublicEntityId,
} from '../../src/domain/shared/constants/public-entity-id-namespace.js';

/** Prefix for snapshot entity ids when no benchmark gold row matches (ADR-007). */
export const SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX = 'wine-ce-' as const;

/**
 * Versioning hook for `WineSnapshotEntityResolution` records.
 *
 * Bumped when the resolution record shape or identity-derivation rules change.
 * Defaults to '1' for backward compatibility with previously emitted records.
 * Downstream consumers MUST tolerate unknown future versions (warn + degrade)
 * but MUST NOT silently accept a missing version on new code paths — read the
 * field with `?? SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION` only on legacy
 * deserialization sites.
 */
export const SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION = '1' as const;
export type SnapshotEntityIdentitySchemaVersion = typeof SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION;

const GoldEntityRowSchema = z
  .object({
    entity_id: z.string().min(1),
    canonical_label: z.string().min(1),
    vintage: z.union([z.number().int(), z.null()]),
  })
  .strip();

const CanonicalEntitiesFileSchema = z
  .object({
    entities: z.array(GoldEntityRowSchema).max(5000),
  })
  .passthrough();

export type GoldCanonicalResolution = 'gold_overlay' | 'identity_signature';
export const RUNTIME_PUBLIC_ID_AUTHORITY = 'identity_signature' as const;
export const BENCHMARK_LINKAGE_AUTHORITY = 'benchmark_linkage' as const;

export type RuntimePublicIdAuthority = typeof RUNTIME_PUBLIC_ID_AUTHORITY;
export type BenchmarkLinkageAuthority = typeof BENCHMARK_LINKAGE_AUTHORITY;

/**
 * T-011/W3: two-authority identity model.
 *
 *   runtime public-id authority = `identity_signature` — immutable
 *                        deterministic id derived from
 *                        (canonicalLabel, producerId, regionId) hash. This is
 *                        the public id exposed to clients, Vespa, and the
 *                        read path. Once a snapshot containing this id has
 *                        been promoted, the id must NEVER change.
 *
 *   benchmark linkage authority = `benchmark_linkage` — benchmark/gold
 *                        fixture id used ONLY for linking runtime results to
 *                        evaluation sets. Mutable on the benchmark side.
 *                        MUST NOT be used as a runtime public id.
 *
 *   `resolution` records which authority attached the benchmark linkage. It
 *   does NOT
 *   choose the runtime public id — that is always `entityId`.
 *
 * Consequence: a gold overlay can only ATTACH a benchmark link to an existing
 * runtime entity; it can never rename an entity's runtime public id.
 */
export interface WineSnapshotEntityResolution {
  /** Schema version of this resolution record (see {@link SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION}). */
  readonly schemaVersion: SnapshotEntityIdentitySchemaVersion;
  /** Runtime public id (immutable authority). */
  readonly entityId: CanonicalEntityId;
  readonly identitySignature: string;
  readonly runtimePublicIdAuthority: RuntimePublicIdAuthority;
  readonly producerId: string;
  readonly regionId: string;
  readonly resolution: GoldCanonicalResolution;
  /** Benchmark/gold linkage id (mutable; benchmark-only; NEVER a runtime id). */
  readonly benchmarkEntityId?: CanonicalEntityId;
  readonly benchmarkLinkageAuthority?: BenchmarkLinkageAuthority;
}

export interface SourceEntityContinuityRecord {
  readonly entityId: CanonicalEntityId;
  readonly identitySignature: string;
  readonly benchmarkEntityId?: CanonicalEntityId;
}

/**
 * Wave 4 (fail-loud): explicit "fixture required" mode for build/eval/publish
 * paths where missing gold linkage would silently degrade benchmark coverage
 * to zero.
 *
 * Lookup precedence:
 *   1. options.fixtureRepoRoot (explicit `--fixture-repo`)
 *   2. FIXTURE_REPO_PATH env
 *   3. sibling `wine-engine-fixture` directory
 *
 * If `requireFixtureRepo: true` and none of the above resolves, the loader
 * throws with operator-actionable guidance. Returning `new Map()` silently
 * masks this state and turns evaluations into "all zero coverage" with no
 * surface signal.
 *
 * Default `requireFixtureRepo: false` preserves the previous behavior for
 * dev/local use cases that legitimately have no fixture.
 */
export async function loadGoldCanonicalLookupForBuild(options: {
  readonly fixtureRepoRoot?: string | undefined;
  readonly requireFixtureRepo?: boolean | undefined;
}): Promise<ReadonlyMap<string, string>> {
  if (options.fixtureRepoRoot != null && options.fixtureRepoRoot.length > 0) {
    const root = normalize(
      isAbsolute(options.fixtureRepoRoot)
        ? options.fixtureRepoRoot
        : resolve(options.fixtureRepoRoot),
    );
    if (!existsSync(root)) {
      throw new Error(`fixture repo path does not exist: ${root}`);
    }
    return await loadGoldCanonicalLookup(root);
  }
  const def = resolveDefaultFixtureRepoRoot();
  if (def == null) {
    if (options.requireFixtureRepo === true) {
      throw new Error(
        'Gold fixture repo is required for this path but none was found. ' +
        'Set FIXTURE_REPO_PATH env var, pass --fixture-repo <path>, or clone ' +
        '`wine-engine-fixture` as a sibling directory. Returning an empty map ' +
        'would silently zero benchmark coverage — refusing fail-open.',
      );
    }
    return new Map();
  }
  return await loadGoldCanonicalLookup(def);
}

export function resolveDefaultFixtureRepoRoot(): string | undefined {
  const fromEnv = process.env['FIXTURE_REPO_PATH'];
  if (fromEnv != null && fromEnv.length > 0) {
    const abs = isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
    return normalize(abs);
  }
  const sibling = resolve(process.cwd(), '..', 'wine-engine-fixture');
  return existsSync(sibling) ? normalize(sibling) : undefined;
}

export async function loadActiveSourceEntityContinuity(
  runtimeStatePath: string = resolveDataPath('data/runtime-search-snapshot.json'),
): Promise<ReadonlyMap<SourceRecordId, SourceEntityContinuityRecord>> {
  if (!existsSync(runtimeStatePath)) {
    return new Map();
  }

  const runtimeRaw = await readFile(runtimeStatePath, 'utf8');
  const runtimeParsed = JSON.parse(runtimeRaw) as {
    manifestPath?: unknown;
  };
  if (typeof runtimeParsed.manifestPath !== 'string' || runtimeParsed.manifestPath.length === 0) {
    return new Map();
  }

  const manifestRaw = await readFile(runtimeParsed.manifestPath, 'utf8');
  const manifestParsed = JSON.parse(manifestRaw) as {
    artifacts?: { entitiesNdjson?: unknown };
  };
  const entitiesNdjson = manifestParsed.artifacts?.entitiesNdjson;
  if (typeof entitiesNdjson !== 'string' || entitiesNdjson.length === 0 || !existsSync(entitiesNdjson)) {
    return new Map();
  }

  const entitiesRaw = await readFile(entitiesNdjson, 'utf8');
  const entities = parseNdjson<EntitySnapshotRecord>(entitiesRaw, entitiesNdjson).records;
  const continuity = new Map<SourceRecordId, SourceEntityContinuityRecord>();
  for (const entity of entities) {
    const metadata = entity.metadata as {
      benchmarkEntityId?: unknown;
      sourceRecordRefs?: readonly { sourceSystem?: string; sourceRecordId?: string }[];
    };
    const refs = Array.isArray(metadata.sourceRecordRefs) ? metadata.sourceRecordRefs : [];
    for (const ref of refs) {
      if (ref?.sourceSystem !== 'vivino-silver' || typeof ref.sourceRecordId !== 'string') {
        continue;
      }
      continuity.set(ref.sourceRecordId as SourceRecordId, {
        entityId: createCanonicalEntityId(entity.entityId),
        identitySignature: entity.identitySignature,
        ...(typeof metadata.benchmarkEntityId === 'string'
          ? { benchmarkEntityId: createCanonicalEntityId(metadata.benchmarkEntityId) }
          : {}),
      });
    }
  }
  return continuity;
}

/**
 * Loads gold canonical entities and returns a lookup:
 * `${normalizeCanonicalLabelForIdentity(canonical_label)}|${vintage or 'nv'}` → entity_id.
 */
export async function loadGoldCanonicalLookup(fixtureRepoRoot: string): Promise<ReadonlyMap<string, string>> {
  const path = join(fixtureRepoRoot, 'goldens', 'canonical-entities.json');
  const raw = await readFile(path, 'utf8');
  const parsedUnknown: unknown = JSON.parse(raw);
  const parsed = CanonicalEntitiesFileSchema.parse(parsedUnknown);
  const map = new Map<string, string>();

  for (const row of parsed.entities) {
    if (isSourceRecordStylePublicEntityId(row.entity_id)) {
      throw new Error(
        `canonical-entities.json entity_id must not use source_record namespace: ${row.entity_id}`,
      );
    }
    const key = goldMatchKey(row.canonical_label, row.vintage);
    const existing = map.get(key);
    if (existing !== undefined && existing !== row.entity_id) {
      throw new Error(
        `canonical-entities.json duplicate gold key "${key}" → "${existing}" vs "${row.entity_id}"`,
      );
    }
    map.set(key, row.entity_id);
  }

  return map;
}

export function goldMatchKey(canonicalLabel: string, vintageYear: number | null): string {
  const vintagePart = vintageYear == null ? 'nv' : String(vintageYear);
  return `${normalizeCanonicalLabelForIdentity(canonicalLabel)}|${vintagePart}`;
}

export function silverGoldMatchKey(record: Pick<EnrichedSilverRecord, 'canonicalLabel' | 'vintageYear'>): string {
  const vintagePart = record.vintageYear == null ? 'nv' : String(record.vintageYear);
  return `${normalizeCanonicalLabelForIdentity(record.canonicalLabel)}|${vintagePart}`;
}

export function buildSyntheticProducerId(producer: string): string {
  return `producer:${hashText(normalizeForMatch(producer))}`;
}

export function buildSyntheticRegionId(country: string, region: string): string {
  return `region:${hashText(`${normalizeForMatch(country)}\n${normalizeForMatch(region)}`)}`;
}

export function resolveWineSnapshotEntity(
  record: WineSnapshotIdentityRow,
  goldLookup: ReadonlyMap<string, string>,
  sourceContinuityLookup: ReadonlyMap<SourceRecordId, SourceEntityContinuityRecord> = new Map(),
): WineSnapshotEntityResolution {
  const producerId = buildSyntheticProducerId(record.producer);
  const regionId = buildSyntheticRegionId(record.country, record.region);
  const computedIdentitySignature = computeIdentitySignature('wine', {
    canonicalLabel: record.canonicalLabel,
    producerId,
    regionId,
  });
  const continuity = sourceContinuityLookup.get(record.sourceId);
  const identitySignature = continuity?.identitySignature ?? computedIdentitySignature;
  const publicEntityId = continuity?.entityId
    ?? createCanonicalEntityId(`${SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX}${identitySignature}`);

  const key = silverGoldMatchKey(record);
  const goldHit = goldLookup.get(key);
  const continuityBenchmarkEntityId = continuity?.benchmarkEntityId;
  if (goldHit != null) {
    if (isSourceRecordStylePublicEntityId(goldHit)) {
      throw new Error(`Gold lookup returned forbidden source-style id for ${key}: ${goldHit}`);
    }
    return {
      schemaVersion: SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION,
      entityId: publicEntityId,
      identitySignature,
      runtimePublicIdAuthority: RUNTIME_PUBLIC_ID_AUTHORITY,
      producerId,
      regionId,
      resolution: 'gold_overlay',
      benchmarkEntityId: createCanonicalEntityId(goldHit),
      benchmarkLinkageAuthority: BENCHMARK_LINKAGE_AUTHORITY,
    };
  }

  if (isSourceRecordStylePublicEntityId(publicEntityId)) {
    throw new Error('Invariant: fallback canonical entity id must not use vivino- prefix');
  }

  return {
    schemaVersion: SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION,
    entityId: publicEntityId,
    identitySignature,
    runtimePublicIdAuthority: RUNTIME_PUBLIC_ID_AUTHORITY,
    producerId,
    regionId,
    resolution: 'identity_signature',
    ...(continuityBenchmarkEntityId !== undefined
      ? {
          benchmarkEntityId: continuityBenchmarkEntityId,
          benchmarkLinkageAuthority: BENCHMARK_LINKAGE_AUTHORITY,
        }
      : {}),
  };
}

export function buildEntityIdBySourceId(
  records: readonly WineSnapshotIdentityRow[],
  goldLookup: ReadonlyMap<string, string>,
): ReadonlyMap<SourceRecordId, CanonicalEntityId> {
  const map = new Map<SourceRecordId, CanonicalEntityId>();
  for (const record of records) {
    map.set(record.sourceId, resolveWineSnapshotEntity(record, goldLookup).entityId);
  }
  return map;
}
