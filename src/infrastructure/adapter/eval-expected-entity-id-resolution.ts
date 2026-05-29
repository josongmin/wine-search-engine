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

interface EvalEntityIdRow {
  readonly requested_id: string;
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

export async function resolveEvalEntityIds(
  queryable: Pick<Pool, 'query'>,
  snapshotId: string,
  refs: readonly LegacyEvalEntityIdRef[],
): Promise<ReadonlyMap<string, CanonicalEntityId>> {
  const uniqueRequestedIds = [...new Set(
    refs
      .map((ref) => ref.entityId.trim())
      .filter((entityId) => entityId.length > 0),
  )];
  if (uniqueRequestedIds.length === 0) {
    return new Map();
  }

  const result = await queryable.query<EvalEntityIdRow>(
    `WITH requested AS (
       SELECT DISTINCT UNNEST($2::text[]) AS requested_id
     )
     SELECT DISTINCT requested_id, entity_id
     FROM (
       SELECT
         r.requested_id,
         e.entity_id
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
        AND e.entity_id = r.requested_id

       UNION ALL

       SELECT
         r.requested_id,
         e.entity_id
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
        AND e.metadata->>'benchmarkEntityId' = r.requested_id

       UNION ALL

       SELECT
         r.requested_id,
         e.entity_id
       FROM requested r
       JOIN entities e
         ON e.search_snapshot_id = $1
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.metadata->'sourceRecordRefs', '[]'::jsonb)) ref
       WHERE ref->>'sourceRecordId' = r.requested_id
     ) matches`,
    [snapshotId, uniqueRequestedIds],
  );

  const resolved = new Map<string, CanonicalEntityId>();
  for (const row of result.rows) {
    const nextEntityId = createCanonicalEntityId(row.entity_id);
    const prev = resolved.get(row.requested_id);
    if (prev !== undefined && prev !== nextEntityId) {
      throw new Error(
        `Offline eval entity_id ${row.requested_id} maps to multiple runtime entity ids in snapshot ${snapshotId}: ${prev} vs ${nextEntityId}`,
      );
    }
    resolved.set(row.requested_id, nextEntityId);
  }

  const missingRequestedIds = uniqueRequestedIds.filter((requestedId) => !resolved.has(requestedId));
  if (missingRequestedIds.length > 0) {
    const sample = refs
      .filter((ref) => missingRequestedIds.includes(ref.entityId))
      .slice(0, LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT)
      .map((ref) => `${ref.caseId}:${ref.entityId}`)
      .join(', ');
    throw new Error(
      `Offline eval entity_id values are unmapped in snapshot ${snapshotId}: ${missingRequestedIds.length} id(s) missing. Sample: ${sample}${missingRequestedIds.length > LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT ? ', …' : ''}`,
    );
  }

  return resolved;
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

  try {
    return await resolveEvalEntityIds(queryable, snapshotId, legacyRefs);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    throw new Error(
      error.message
        .replace('Offline eval entity_id ', 'Legacy eval entity_id ')
        .replace('Offline eval entity_id values', 'Legacy eval entity_id values')
        .replace(' id(s) missing', ' source record id(s) missing'),
    );
  }
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
