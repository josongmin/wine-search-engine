import type { Pool } from 'pg';
import { isSourceRecordStylePublicEntityId } from '../../domain/shared/constants/public-entity-id-namespace.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../domain/shared/types/entity-id.js';

export interface LegacyEvalExpectedEntityIdRef {
  readonly caseId: string;
  readonly expectedEntityId: string;
}

export interface LegacyEvalEntityIdRef {
  readonly caseId: string;
  readonly entityId: string;
}

interface LegacyEvalExpectedEntityIdRow {
  readonly source_record_id: string;
  readonly entity_id: string;
}

const LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT = 5;

export function hasLegacyEvalExpectedEntityId(
  refs: readonly LegacyEvalExpectedEntityIdRef[],
): boolean {
  return hasLegacyEvalEntityId(
    refs.map((ref) => ({
      caseId: ref.caseId,
      entityId: ref.expectedEntityId,
    })),
  );
}

export function hasLegacyEvalEntityId(
  refs: readonly LegacyEvalEntityIdRef[],
): boolean {
  return refs.some((ref) => isSourceRecordStylePublicEntityId(ref.entityId));
}

export async function resolveLegacyEvalEntityIds(
  queryable: Pick<Pool, 'query'>,
  snapshotId: string,
  refs: readonly LegacyEvalEntityIdRef[],
): Promise<ReadonlyMap<string, CanonicalEntityId>> {
  const legacyRefs = refs.filter((ref) => isSourceRecordStylePublicEntityId(ref.entityId));
  if (legacyRefs.length === 0) {
    return new Map();
  }

  const uniqueSourceIds = [...new Set(legacyRefs.map((ref) => ref.entityId))];
  const result = await queryable.query<LegacyEvalExpectedEntityIdRow>(
    `SELECT
       ref->>'sourceRecordId' AS source_record_id,
       e.entity_id
     FROM entities e
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.metadata->'sourceRecordRefs', '[]'::jsonb)) ref
     WHERE e.search_snapshot_id = $1
       AND ref->>'sourceRecordId' = ANY($2::text[])`,
    [snapshotId, uniqueSourceIds],
  );

  const resolved = new Map<string, CanonicalEntityId>();
  for (const row of result.rows) {
    const nextEntityId = createCanonicalEntityId(row.entity_id);
    const prev = resolved.get(row.source_record_id);
    if (prev !== undefined && prev !== nextEntityId) {
      throw new Error(
        `Legacy eval entity_id source record ${row.source_record_id} maps to multiple runtime entity ids in snapshot ${snapshotId}: ${prev} vs ${nextEntityId}`,
      );
    }
    resolved.set(row.source_record_id, nextEntityId);
  }

  const missingSourceIds = uniqueSourceIds.filter((sourceId) => !resolved.has(sourceId));
  if (missingSourceIds.length > 0) {
    const sample = legacyRefs
      .filter((ref) => missingSourceIds.includes(ref.entityId))
      .slice(0, LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT)
      .map((ref) => `${ref.caseId}:${ref.entityId}`)
      .join(', ');
    throw new Error(
      `Legacy eval entity_id values are unmapped in snapshot ${snapshotId}: ${missingSourceIds.length} source record id(s) missing. Sample: ${sample}${missingSourceIds.length > LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT ? ', …' : ''}`,
    );
  }

  return resolved;
}

export async function resolveLegacyEvalExpectedEntityIds(
  queryable: Pick<Pool, 'query'>,
  snapshotId: string,
  refs: readonly LegacyEvalExpectedEntityIdRef[],
): Promise<ReadonlyMap<string, CanonicalEntityId>> {
  try {
    return await resolveLegacyEvalEntityIds(
      queryable,
      snapshotId,
      refs.map((ref) => ({
        caseId: ref.caseId,
        entityId: ref.expectedEntityId,
      })),
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    throw new Error(error.message.replaceAll('entity_id', 'expected_entity_id'));
  }
}
