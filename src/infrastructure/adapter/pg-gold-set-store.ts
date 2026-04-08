import type { Pool } from 'pg';
import type { GoldSetStore, GoldSetFilter } from '../../domain/evaluation/port/gold-set-store.port.js';
import type { EvalCase, LabelTier } from '../../domain/evaluation/model/eval-case.js';
import { createEntityId } from '../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';

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

function rowToEvalCase(row: EvalCaseRow): EvalCase {
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
  if (row.expected_entity_id != null) {
    return { ...withAgreement, expectedEntityId: createEntityId(row.expected_entity_id) };
  }
  return withAgreement;
}

export class PgGoldSetStore implements GoldSetStore {
  constructor(private readonly pool: Pool) {}

  async getCases(filter?: GoldSetFilter): Promise<readonly EvalCase[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

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
      conditions.push(`created_at >= $${idx++}`);
      params.push(filter.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<EvalCaseRow>(
      `SELECT * FROM eval_cases ${where} ORDER BY created_at ASC`,
      params,
    );
    return result.rows.map(rowToEvalCase);
  }

  async addCase(evalCase: EvalCase): Promise<void> {
    await this.pool.query(
      `INSERT INTO eval_cases (
        case_id, query, query_class, expected_entity_id, expected_status,
        label_tier, annotator_agreement, slice_tags, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (case_id) DO NOTHING`,
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
