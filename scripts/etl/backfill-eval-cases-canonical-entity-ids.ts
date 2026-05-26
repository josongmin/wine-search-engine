#!/usr/bin/env tsx

import { Pool } from 'pg';
import { loadConfig } from '../../src/config/env.js';
import { isSourceRecordStylePublicEntityId } from '../../src/domain/shared/constants/public-entity-id-namespace.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import {
  createPgPool,
  shouldUsePgPool,
} from '../../src/infrastructure/db/pg-pool.js';
import {
  resolveLegacyEvalExpectedEntityIds,
  type LegacyEvalExpectedEntityIdRef,
} from '../../src/infrastructure/adapter/eval-expected-entity-id-resolution.js';

interface CliArgs {
  readonly snapshotId?: string;
  readonly runtimeStatePath: string;
  readonly dryRun: boolean;
}

interface EvalCaseLegacyRow {
  readonly case_id: string;
  readonly expected_entity_id: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let snapshotId: string | undefined;
  let runtimeStatePath = DEFAULT_RUNTIME_STATE_PATH;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot-id') {
      snapshotId = argv[index + 1] ?? snapshotId;
      index += 1;
    } else if (arg === '--runtime-state-path') {
      runtimeStatePath = argv[index + 1] ?? runtimeStatePath;
      index += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  return {
    snapshotId,
    runtimeStatePath,
    dryRun,
  };
}

async function fetchLegacyEvalCases(pool: Pool): Promise<readonly LegacyEvalExpectedEntityIdRef[]> {
  const result = await pool.query<EvalCaseLegacyRow>(
    `SELECT case_id, expected_entity_id
       FROM eval_cases
      WHERE expected_entity_id IS NOT NULL
        AND expected_entity_id LIKE 'vivino-%'
      ORDER BY created_at ASC`,
  );
  return result.rows
    .filter((row) => isSourceRecordStylePublicEntityId(row.expected_entity_id))
    .map((row) => ({
      caseId: row.case_id,
      expectedEntityId: row.expected_entity_id,
    }));
}

async function backfillEvalCaseExpectedEntityIds(
  pool: Pool,
  snapshotId: string,
  dryRun: boolean,
): Promise<void> {
  const legacyRefs = await fetchLegacyEvalCases(pool);
  if (legacyRefs.length === 0) {
    console.log(JSON.stringify({
      snapshotId,
      legacyCaseCount: 0,
      updatedRowCount: 0,
      dryRun,
    }, null, 2));
    return;
  }

  const resolved = await resolveLegacyEvalExpectedEntityIds(pool, snapshotId, legacyRefs);
  const uniqueSourceIds = [...resolved.keys()];
  if (dryRun) {
    console.log(JSON.stringify({
      snapshotId,
      legacyCaseCount: legacyRefs.length,
      uniqueSourceIdCount: uniqueSourceIds.length,
      updatedRowCount: legacyRefs.length,
      dryRun,
      sample: legacyRefs.slice(0, 5).map((ref) => ({
        caseId: ref.caseId,
        sourceRecordId: ref.expectedEntityId,
        canonicalEntityId: resolved.get(ref.expectedEntityId),
      })),
    }, null, 2));
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const valuePlaceholders: string[] = [];
    const params: string[] = [];
    let paramIndex = 1;
    for (const [sourceRecordId, canonicalEntityId] of resolved.entries()) {
      valuePlaceholders.push(`($${paramIndex++}, $${paramIndex++})`);
      params.push(sourceRecordId, canonicalEntityId);
    }
    const updateResult = await client.query(
      `UPDATE eval_cases ec
          SET expected_entity_id = mapped.canonical_entity_id
         FROM (
           VALUES ${valuePlaceholders.join(', ')}
         ) AS mapped(source_record_id, canonical_entity_id)
        WHERE ec.expected_entity_id = mapped.source_record_id`,
      params,
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({
      snapshotId,
      legacyCaseCount: legacyRefs.length,
      uniqueSourceIdCount: uniqueSourceIds.length,
      updatedRowCount: updateResult.rowCount ?? 0,
      dryRun,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres is required');
  }
  const snapshotId = args.snapshotId ?? (await loadSearchSnapshotRuntimeState(args.runtimeStatePath)).snapshotId;
  const pool = createPgPool(config.pg);
  try {
    await backfillEvalCaseExpectedEntityIds(pool, snapshotId, args.dryRun);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
