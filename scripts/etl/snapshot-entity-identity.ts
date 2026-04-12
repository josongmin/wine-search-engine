/**
 * ADR-007: search snapshot `entityId` is canonical public identity — never `sourceId`.
 *
 * Gold overlay: `wine-engine-fixture/goldens/canonical-entities.json` provides
 * stable slugs keyed by normalized canonical label + vintage (exact join).
 * Rows without a gold hit use a deterministic `wine-ce-{identitySignature}` id
 * derived from the same RFC-001 wine identity signature (not Vivino/source ids).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { z } from 'zod';

import { normalizeForMatch } from '../../src/domain/alias/service/alias-matcher.js';
import {
  computeIdentitySignature,
  normalizeCanonicalLabelForIdentity,
} from '../../src/domain/entity/model/identity-signature.js';
import type { EnrichedSilverRecord } from './types.js';
import {
  createCanonicalEntityId,
  type CanonicalEntityId,
} from '../../src/domain/shared/types/entity-id.js';

/** Fields sufficient for ADR-007 wine canonical id (gold overlay + identity signature). */
export type WineSnapshotIdentityRow = Pick<
  EnrichedSilverRecord,
  'sourceId' | 'canonicalLabel' | 'producer' | 'country' | 'region' | 'vintageYear'
>;
import { hashText } from './search-snapshot-schema.js';
import {
  isSourceRecordStylePublicEntityId,
} from '../../src/shared/constants/public-entity-id-namespace.js';

/** Prefix for snapshot entity ids when no benchmark gold row matches (ADR-007). */
export const SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX = 'wine-ce-' as const;

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

export interface WineSnapshotEntityResolution {
  readonly entityId: CanonicalEntityId;
  readonly identitySignature: string;
  readonly producerId: string;
  readonly regionId: string;
  readonly resolution: GoldCanonicalResolution;
}

/**
 * Resolves gold canonical lookup for ETL CLIs: explicit `--fixture-repo`, else
 * `FIXTURE_REPO_PATH` / sibling `wine-engine-fixture` when present.
 */
export async function loadGoldCanonicalLookupForBuild(options: {
  readonly fixtureRepoRoot?: string | undefined;
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
): WineSnapshotEntityResolution {
  const producerId = buildSyntheticProducerId(record.producer);
  const regionId = buildSyntheticRegionId(record.country, record.region);
  const identitySignature = computeIdentitySignature('wine', {
    canonicalLabel: record.canonicalLabel,
    producerId,
    regionId,
  });

  const key = silverGoldMatchKey(record);
  const goldHit = goldLookup.get(key);
  if (goldHit != null) {
    if (isSourceRecordStylePublicEntityId(goldHit)) {
      throw new Error(`Gold lookup returned forbidden source-style id for ${key}: ${goldHit}`);
    }
    return {
      entityId: createCanonicalEntityId(goldHit),
      identitySignature,
      producerId,
      regionId,
      resolution: 'gold_overlay',
    };
  }

  const fallbackId = `${SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX}${identitySignature}`;
  if (isSourceRecordStylePublicEntityId(fallbackId)) {
    throw new Error('Invariant: fallback canonical entity id must not use vivino- prefix');
  }

  return {
    entityId: createCanonicalEntityId(fallbackId),
    identitySignature,
    producerId,
    regionId,
    resolution: 'identity_signature',
  };
}

export function buildEntityIdBySourceId(
  records: readonly WineSnapshotIdentityRow[],
  goldLookup: ReadonlyMap<string, string>,
): ReadonlyMap<string, CanonicalEntityId> {
  const map = new Map<string, CanonicalEntityId>();
  for (const record of records) {
    map.set(record.sourceId, resolveWineSnapshotEntity(record, goldLookup).entityId);
  }
  return map;
}
