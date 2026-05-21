import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { EvalResultStore, EvalResultFilter } from '../../domain/evaluation/port/eval-result-store.port.js';
import type { EvalResult } from '../../domain/evaluation/model/eval-result.js';
import { createCanonicalEntityId, isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { parseDecisionSnapshotJsonb, parseEvidenceItemsJsonb } from './jsonb-schemas.js';
function toDecisionStatus(value: string): DecisionStatus {
  if (value === 'resolved' || value === 'ambiguous' || value === 'failed') return value;
  throw new Error(`PgEvalResultStore: unknown predicted_status "${value}" — schema drift or corrupted row`);
}

interface EvalResultRow {
  result_id: string;
  case_id: string;
  predicted_entity_id: string | null;
  predicted_status: string;
  decision_confidence: number;
  top1_raw_score: number | null;
  utility_score: number;
  is_correct_resolve: boolean;
  is_wrong_resolve: boolean;
  is_safe_abstain: boolean;
  is_avoidable_abstain: boolean;
  evidence_items: unknown;
  latency_ms: number;
  decision_snapshot: unknown;
  created_at: Date;
}

function rowToEvalResult(row: EvalResultRow): EvalResult {
  // top1_raw_score is NULLable (migration 021 added it; legacy rows carry NULL).
  // Guard with Number.isFinite to refuse NaN/Infinity that could be smuggled in
  // by a corrupted ETL backfill (CLAUDE.md schema rule on external numerics).
  const rawScoreFromRow = row.top1_raw_score;
  const top1RawScore: number | undefined =
    rawScoreFromRow != null && Number.isFinite(rawScoreFromRow)
      ? rawScoreFromRow
      : undefined;

  const base = {
    caseId: row.case_id,
    predictedStatus: toDecisionStatus(row.predicted_status),
    decisionConfidence: row.decision_confidence,
    utilityScore: row.utility_score,
    isCorrectResolve: row.is_correct_resolve,
    isWrongResolve: row.is_wrong_resolve,
    isSafeAbstain: row.is_safe_abstain,
    isAvoidableAbstain: row.is_avoidable_abstain,
    evidenceItems: parseEvidenceItemsJsonb(row.evidence_items, 'PgEvalResultStore'),
    latencyMs: row.latency_ms,
    decisionSnapshot: parseDecisionSnapshotJsonb(row.decision_snapshot, 'PgEvalResultStore'),
    ...(top1RawScore !== undefined ? { top1RawScore } : {}),
  };
  if (row.predicted_entity_id != null) {
    return { ...base, predictedEntityId: createCanonicalEntityId(row.predicted_entity_id) };
  }
  return base;
}

export class PgEvalResultStore implements EvalResultStore {
  constructor(private readonly pool: Pool) {}

  async saveResult(result: EvalResult): Promise<void> {
    if (isCorruptedSnapshot(result.decisionSnapshot)) {
      bootstrapLogger.warn({ caseId: result.caseId }, '[PgEvalResultStore] Skipping save — corrupted decision snapshot');
      return;
    }
    const resultId = nanoid();
    // top1RawScore is optional on EvalResult (legacy callers may omit it).
    // Persist null rather than 0 so the calibration trace extractor can
    // distinguish "no raw score recorded" from "raw score of zero".
    const rawScoreParam: number | null =
      result.top1RawScore != null && Number.isFinite(result.top1RawScore)
        ? result.top1RawScore
        : null;
    await this.pool.query(
      `INSERT INTO eval_results (
        result_id, case_id, predicted_entity_id, predicted_status,
        decision_confidence, top1_raw_score, utility_score,
        is_correct_resolve, is_wrong_resolve, is_safe_abstain, is_avoidable_abstain,
        evidence_items, latency_ms, decision_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        resultId,
        result.caseId,
        result.predictedEntityId ?? null,
        result.predictedStatus,
        result.decisionConfidence,
        rawScoreParam,
        result.utilityScore,
        result.isCorrectResolve,
        result.isWrongResolve,
        result.isSafeAbstain,
        result.isAvoidableAbstain,
        JSON.stringify(result.evidenceItems),
        result.latencyMs,
        JSON.stringify(result.decisionSnapshot),
      ],
    );
  }

  async getResults(filter?: EvalResultFilter): Promise<readonly EvalResult[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.since != null) {
      conditions.push(`er.created_at >= $${idx++}`);
      params.push(filter.since);
    }
    if (filter?.snapshotId != null) {
      conditions.push(`er.decision_snapshot->>'threshold_profile_id' = $${idx++}`);
      params.push(filter.snapshotId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<EvalResultRow>(
      `SELECT er.* FROM eval_results er ${where} ORDER BY er.created_at ASC`,
      params,
    );
    return result.rows.map(rowToEvalResult);
  }
}
