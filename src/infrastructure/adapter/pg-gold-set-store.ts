import type { Pool } from 'pg';
import type { GoldSetStore, GoldSetFilter } from '../../domain/evaluation/port/gold-set-store.port.js';
import type { EvalCase, LabelTier } from '../../domain/evaluation/model/eval-case.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';
import { isSourceRecordStylePublicEntityId } from '../../domain/shared/constants/public-entity-id-namespace.js';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../health/search-snapshot-readiness.js';
import {
  resolveLegacyEvalExpectedEntityIds,
  type LegacyEvalExpectedEntityIdRef,
} from './eval-expected-entity-id-resolution.js';

function toDecisionStatus(value: string): DecisionStatus {
  if (value === 'resolved' || value === 'ambiguous' || value === 'failed') return value;
  return 'failed';
}

function toLabelTier(value: string): LabelTier {
  if (value === 'gold' || value === 'silver' || value === 'bronze') return value;
  return 'bronze';
}

interface EvalCaseRow {
  case_id: string;
  query: string;
  query_class: string;
  expected_entity_id: string | null;
  expected_status: string;
  label_tier: string;
  annotator_agreement: number | null;
  slice_tags: string[];
  created_at: Date;
}

function rowToEvalCase(row: EvalCaseRow, expectedEntityId: string | null): EvalCase {
  const base = {
    caseId: row.case_id,
    query: row.query,
    queryClass: isQueryClass(row.query_class) ? row.query_class : 'unknown',
    expectedStatus: toDecisionStatus(row.expected_status),
    labelTier: toLabelTier(row.label_tier),
    timestamp: row.created_at,
    sliceTags: row.slice_tags,
  };
  const withAgreement = row.annotator_agreement != null
    ? { ...base, annotatorAgreement: row.annotator_agreement }
    : base;
  if (expectedEntityId != null) {
    return { ...withAgreement, expectedEntityId: createCanonicalEntityId(expectedEntityId) };
  }
  return withAgreement;
}

interface PgGoldSetStoreOptions {
  readonly snapshotId?: string;
  readonly runtimeStatePath?: string;
}

export class PgGoldSetStore implements GoldSetStore {
  private refreshedAtColumnPresence?: Promise<boolean>;

  constructor(
    private readonly pool: Pool,
    private readonly options: PgGoldSetStoreOptions = {},
  ) {}

  private async hasRefreshedAtColumn(): Promise<boolean> {
    this.refreshedAtColumnPresence ??= pgTableHasColumn(
      this.pool,
      'eval_cases',
      'refreshed_at',
    );
    return this.refreshedAtColumnPresence;
  }

  private async resolveSnapshotId(): Promise<string> {
    if (this.options.snapshotId != null && this.options.snapshotId.length > 0) {
      return this.options.snapshotId;
    }
    const runtimeState = await loadSearchSnapshotRuntimeState(
      this.options.runtimeStatePath ?? DEFAULT_RUNTIME_STATE_PATH,
    );
    return runtimeState.snapshotId;
  }

  private async hydrateRows(rows: readonly EvalCaseRow[]): Promise<readonly EvalCase[]> {
    const legacyRefs: LegacyEvalExpectedEntityIdRef[] = rows.flatMap((row) => {
      if (row.expected_entity_id == null || !isSourceRecordStylePublicEntityId(row.expected_entity_id)) {
        return [];
      }
      return [{
        caseId: row.case_id,
        expectedEntityId: row.expected_entity_id,
      }];
    });

    const resolvedLegacyIds = legacyRefs.length > 0
      ? await resolveLegacyEvalExpectedEntityIds(
        this.pool,
        await this.resolveSnapshotId(),
        legacyRefs,
      )
      : new Map<string, string>();

    return rows.map((row) => {
      const expectedEntityId = row.expected_entity_id == null
        ? null
        : isSourceRecordStylePublicEntityId(row.expected_entity_id)
          ? (resolvedLegacyIds.get(row.expected_entity_id) ?? null)
          : row.expected_entity_id;
      return rowToEvalCase(row, expectedEntityId);
    });
  }

  async getCases(filter?: GoldSetFilter): Promise<readonly EvalCase[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    const freshnessColumn = await this.hasRefreshedAtColumn()
      ? 'COALESCE(refreshed_at, created_at)'
      : 'created_at';

    if (filter?.queryClass != null) {
      conditions.push(`query_class = $${idx++}`);
      params.push(filter.queryClass);
    }
    if (filter?.sliceTag != null) {
      conditions.push(`$${idx++} = ANY(slice_tags)`);
      params.push(filter.sliceTag);
    }
    if (filter?.labelTier != null) {
      conditions.push(`label_tier = $${idx++}`);
      params.push(filter.labelTier);
    }
    if (filter?.since != null) {
      conditions.push(`${freshnessColumn} >= $${idx++}`);
      params.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<EvalCaseRow>(
      `SELECT * FROM eval_cases ${where} ORDER BY ${freshnessColumn} ASC, created_at ASC`,
      params,
    );
    return await this.hydrateRows(result.rows);
  }

  async addCase(evalCase: EvalCase): Promise<void> {
    if (await this.hasRefreshedAtColumn()) {
      await this.pool.query(
        `INSERT INTO eval_cases (
          case_id, query, query_class, expected_entity_id, expected_status,
          label_tier, annotator_agreement, slice_tags, created_at, refreshed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (case_id) DO UPDATE SET
          query = EXCLUDED.query,
          query_class = EXCLUDED.query_class,
          expected_entity_id = EXCLUDED.expected_entity_id,
          expected_status = EXCLUDED.expected_status,
          label_tier = EXCLUDED.label_tier,
          annotator_agreement = EXCLUDED.annotator_agreement,
          slice_tags = EXCLUDED.slice_tags,
          created_at = EXCLUDED.created_at,
          refreshed_at = CURRENT_TIMESTAMP`,
        [
          evalCase.caseId,
          evalCase.query,
          evalCase.queryClass,
          evalCase.expectedEntityId ?? null,
          evalCase.expectedStatus,
          evalCase.labelTier,
          evalCase.annotatorAgreement ?? null,
          evalCase.sliceTags,
          evalCase.timestamp,
        ],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO eval_cases (
        case_id, query, query_class, expected_entity_id, expected_status,
        label_tier, annotator_agreement, slice_tags, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (case_id) DO UPDATE SET
        query = EXCLUDED.query,
        query_class = EXCLUDED.query_class,
        expected_entity_id = EXCLUDED.expected_entity_id,
        expected_status = EXCLUDED.expected_status,
        label_tier = EXCLUDED.label_tier,
        annotator_agreement = EXCLUDED.annotator_agreement,
        slice_tags = EXCLUDED.slice_tags,
        created_at = EXCLUDED.created_at`,
      [
        evalCase.caseId,
        evalCase.query,
        evalCase.queryClass,
        evalCase.expectedEntityId ?? null,
        evalCase.expectedStatus,
        evalCase.labelTier,
        evalCase.annotatorAgreement ?? null,
        evalCase.sliceTags,
        evalCase.timestamp,
      ],
    );
  }

  async getIAAScore(sliceTag?: string): Promise<number> {
    let query: string;
    let params: unknown[];

    if (sliceTag != null) {
      query = `SELECT AVG(annotator_agreement) AS iaa
               FROM eval_cases
               WHERE annotator_agreement IS NOT NULL
                 AND $1 = ANY(slice_tags)`;
      params = [sliceTag];
    } else {
      query = `SELECT AVG(annotator_agreement) AS iaa
               FROM eval_cases
               WHERE annotator_agreement IS NOT NULL`;
      params = [];
    }

    const result = await this.pool.query<{ iaa: string | null }>(query, params);
    const iaa = result.rows[0]?.iaa;
    if (iaa == null) return 0;
    const parsed = parseFloat(iaa);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
