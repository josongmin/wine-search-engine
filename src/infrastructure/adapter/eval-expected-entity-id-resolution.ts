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

/**
 * Phase of the eval entity-id resolution pipeline that emitted an error.
 * The wrappers (`resolveLegacyEvalEntityIds`, `resolveLegacyEvalExpectedEntityIds`)
 * re-throw with a wider phase while preserving the original `cause`, so callers
 * can `instanceof EvalEntityIdResolutionError` and inspect `.init.phase` /
 * `.init.missingIds` rather than scraping the human-readable message.
 */
export type EvalEntityIdResolutionPhase = 'offline' | 'legacy' | 'legacy_expected';

export type EvalEntityIdResolutionErrorKind = 'unmapped' | 'conflict';

interface EvalEntityIdResolutionErrorInit {
  readonly phase: EvalEntityIdResolutionPhase;
  readonly kind: EvalEntityIdResolutionErrorKind;
  readonly snapshotId: string;
  // 'unmapped' payload
  readonly missingIds?: readonly string[];
  readonly sampleCases?: readonly string[];
  // 'conflict' payload
  readonly requestedId?: string;
  readonly previousEntityId?: CanonicalEntityId;
  readonly nextEntityId?: CanonicalEntityId;
}

export class EvalEntityIdResolutionError extends Error {
  readonly init: EvalEntityIdResolutionErrorInit;

  constructor(init: EvalEntityIdResolutionErrorInit, options?: { cause?: unknown }) {
    super(formatMessage(init), options);
    this.name = 'EvalEntityIdResolutionError';
    this.init = init;
  }
}

function subjectFor(phase: EvalEntityIdResolutionPhase): string {
  if (phase === 'offline') return 'Offline eval entity_id';
  if (phase === 'legacy') return 'Legacy eval entity_id';
  return 'Legacy eval expected_entity_id';
}

function unmappedIdLabelFor(phase: EvalEntityIdResolutionPhase): string {
  // The legacy paths describe missing rows as "source record id(s)" because the
  // requested ids are source-record-style identifiers (vivino-* etc) that the
  // pipeline expects to back-resolve via metadata.sourceRecordRefs. The offline
  // (canonical) path uses the generic "id(s)" wording.
  return phase === 'offline' ? 'id(s)' : 'source record id(s)';
}

function formatMessage(init: EvalEntityIdResolutionErrorInit): string {
  if (init.kind === 'conflict') {
    // Runtime label is uniformly "runtime entity ids" — every phase resolves
    // requested ids against the same `entities` table, so the runtime-side
    // identifier is invariant. Phase only renames the *requested* subject.
    return `${subjectFor(init.phase)} ${init.requestedId ?? '<unknown>'} maps to multiple runtime entity ids in snapshot ${init.snapshotId}: ${init.previousEntityId ?? '<unknown>'} vs ${init.nextEntityId ?? '<unknown>'}`;
  }
  const missingCount = init.missingIds?.length ?? 0;
  const sample = (init.sampleCases ?? []).join(', ');
  const ellipsis = missingCount > LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT ? ', …' : '';
  return `${subjectFor(init.phase)} values are unmapped in snapshot ${init.snapshotId}: ${missingCount} ${unmappedIdLabelFor(init.phase)} missing. Sample: ${sample}${ellipsis}`;
}

function rewrapWithPhase(error: unknown, phase: EvalEntityIdResolutionPhase): never {
  if (error instanceof EvalEntityIdResolutionError) {
    throw new EvalEntityIdResolutionError({ ...error.init, phase }, { cause: error });
  }
  throw error;
}

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
      throw new EvalEntityIdResolutionError({
        phase: 'offline',
        kind: 'conflict',
        snapshotId,
        requestedId: row.requested_id,
        previousEntityId: prev,
        nextEntityId,
      });
    }
    resolved.set(row.requested_id, nextEntityId);
  }

  const missingRequestedIds = uniqueRequestedIds.filter((requestedId) => !resolved.has(requestedId));
  if (missingRequestedIds.length > 0) {
    const sampleCases = refs
      .filter((ref) => missingRequestedIds.includes(ref.entityId))
      .slice(0, LEGACY_EVAL_ID_ERROR_SAMPLE_LIMIT)
      .map((ref) => `${ref.caseId}:${ref.entityId}`);
    throw new EvalEntityIdResolutionError({
      phase: 'offline',
      kind: 'unmapped',
      snapshotId,
      missingIds: missingRequestedIds,
      sampleCases,
    });
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
    rewrapWithPhase(error, 'legacy');
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
    rewrapWithPhase(error, 'legacy_expected');
  }
}
