import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { EvalResultStore, EvalResultFilter } from '../../domain/evaluation/port/eval-result-store.port.js';
import type { EvalResult } from '../../domain/evaluation/model/eval-result.js';
import { isCanonicalPublicEntityId, isCorruptedSnapshot } from '../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';
import { QUERY_INTENTS, type QueryIntent } from '../../domain/query/model/query-intent.js';
import { QUERY_ROUTES, type QueryRoute } from '../../domain/query/model/query-route.js';
import { RETRIEVAL_MODES, type RetrievalMode } from '../../domain/query/model/retrieval-mode.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';
import {
  parseDecisionSnapshotJsonb,
  parseEvidenceItemsJsonb,
  parseLtrScoreComponentsJsonb,
} from './jsonb-schemas.js';
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
  top_result_score_components?: unknown;
  runtime_query_class?: string | null;
  runtime_intent?: string | null;
  runtime_route?: string | null;
  runtime_retrieval_mode?: string | null;
  gold_runtime_query_class_mismatch?: boolean | null;
  latency_ms: number;
  decision_snapshot: unknown;
  created_at: Date;
}

const QUERY_INTENT_SET = new Set<string>(QUERY_INTENTS);
const QUERY_ROUTE_SET = new Set<string>(QUERY_ROUTES);
const RETRIEVAL_MODE_SET = new Set<string>(RETRIEVAL_MODES);

function isRuntimeIntent(value: string): value is QueryIntent {
  return QUERY_INTENT_SET.has(value);
}

function isRuntimeRoute(value: string): value is QueryRoute {
  return QUERY_ROUTE_SET.has(value);
}

function isRuntimeRetrievalMode(value: string): value is RetrievalMode {
  return RETRIEVAL_MODE_SET.has(value);
}

function toRuntimeIntent(value: string | null | undefined): QueryIntent | undefined {
  return value != null && isRuntimeIntent(value) ? value : undefined;
}

function toRuntimeRoute(value: string | null | undefined): QueryRoute | undefined {
  return value != null && isRuntimeRoute(value) ? value : undefined;
}

function toRuntimeRetrievalMode(value: string | null | undefined): RetrievalMode | undefined {
  return value != null && isRuntimeRetrievalMode(value) ? value : undefined;
}

function rowToEvalResult(row: EvalResultRow): {
  readonly result: EvalResult;
  readonly droppedLegacyPredictedEntityId: boolean;
} {
  // top1_raw_score is NULLable (migration 021 added it; legacy rows carry NULL).
  // Guard with Number.isFinite to refuse NaN/Infinity that could be smuggled in
  // by a corrupted ETL backfill (CLAUDE.md schema rule on external numerics).
  const rawScoreFromRow = row.top1_raw_score;
  const top1RawScore: number | undefined =
    rawScoreFromRow != null && Number.isFinite(rawScoreFromRow)
      ? rawScoreFromRow
      : undefined;
  const runtimeIntent = toRuntimeIntent(row.runtime_intent);
  const runtimeRoute = toRuntimeRoute(row.runtime_route);
  const runtimeRetrievalMode = toRuntimeRetrievalMode(row.runtime_retrieval_mode);

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
    ...(row.top_result_score_components != null
      ? {
          topResultScoreComponents: parseLtrScoreComponentsJsonb(
            row.top_result_score_components,
            'PgEvalResultStore',
          ),
        }
      : {}),
    ...(row.runtime_query_class != null && isQueryClass(row.runtime_query_class)
      ? { runtimeQueryClass: row.runtime_query_class }
      : {}),
    ...(runtimeIntent !== undefined
      ? { runtimeIntent }
      : {}),
    ...(runtimeRoute !== undefined
      ? { runtimeRoute }
      : {}),
    ...(runtimeRetrievalMode !== undefined
      ? { runtimeRetrievalMode }
      : {}),
    ...(row.gold_runtime_query_class_mismatch === true
      ? { goldRuntimeQueryClassMismatch: true }
      : {}),
    ...(top1RawScore !== undefined ? { top1RawScore } : {}),
  };
  if (row.predicted_entity_id != null && isCanonicalPublicEntityId(row.predicted_entity_id)) {
    return {
      result: { ...base, predictedEntityId: row.predicted_entity_id },
      droppedLegacyPredictedEntityId: false,
    };
  }
  return {
    result: base,
    droppedLegacyPredictedEntityId: row.predicted_entity_id != null,
  };
}

export class PgEvalResultStore implements EvalResultStore {
  private topResultScoreComponentsColumnPresence?: Promise<boolean>;
  private runtimeClassificationColumnsPresence?: Promise<boolean>;

  constructor(private readonly pool: Pool) {}

  private async hasTopResultScoreComponentsColumn(): Promise<boolean> {
    this.topResultScoreComponentsColumnPresence ??= pgTableHasColumn(
      this.pool,
      'eval_results',
      'top_result_score_components',
    );
    return this.topResultScoreComponentsColumnPresence;
  }

  private async hasRuntimeClassificationColumns(): Promise<boolean> {
    this.runtimeClassificationColumnsPresence ??= pgTableHasColumn(
      this.pool,
      'eval_results',
      'runtime_query_class',
    );
    return this.runtimeClassificationColumnsPresence;
  }

  async saveResult(result: EvalResult): Promise<void> {
    // LOAD-BEARING: `runtime_query_class` (persisted below from
    // `result.runtimeQueryClass`) is the stratification key the nightly
    // calibration trainer reads. `extract-calibration-trace.ts` keys calibration
    // by `COALESCE(runtime_query_class, gold_query_class)` — NOT by the gold
    // class. If this column stops being written, calibration silently reverts to
    // gold-class keying and re-introduces the eval↔runtime taxonomy mismatch
    // (migration 025; surfaced as EvalMetrics.goldRuntimeQueryClassMismatchRate).
    // `gold_runtime_query_class_mismatch` is the precomputed disagreement flag
    // that EvalMetrics aggregates. Do not drop either column.
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
    const topResultScoreComponentsParam =
      result.topResultScoreComponents !== undefined
        ? JSON.stringify(result.topResultScoreComponents)
        : null;
    const hasTopResultScoreComponentsColumn = await this.hasTopResultScoreComponentsColumn();
    const hasRuntimeClassificationColumns = await this.hasRuntimeClassificationColumns();
    if (hasTopResultScoreComponentsColumn && hasRuntimeClassificationColumns) {
      await this.pool.query(
        `INSERT INTO eval_results (
          result_id, case_id, predicted_entity_id, predicted_status,
          decision_confidence, top1_raw_score, utility_score,
          is_correct_resolve, is_wrong_resolve, is_safe_abstain, is_avoidable_abstain,
          evidence_items, top_result_score_components,
          runtime_query_class, runtime_intent, runtime_route, runtime_retrieval_mode,
          gold_runtime_query_class_mismatch,
          latency_ms, decision_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
          topResultScoreComponentsParam,
          result.runtimeQueryClass ?? null,
          result.runtimeIntent ?? null,
          result.runtimeRoute ?? null,
          result.runtimeRetrievalMode ?? null,
          result.goldRuntimeQueryClassMismatch ?? false,
          result.latencyMs,
          JSON.stringify(result.decisionSnapshot),
        ],
      );
      return;
    }
    if (hasTopResultScoreComponentsColumn) {
      await this.pool.query(
        `INSERT INTO eval_results (
          result_id, case_id, predicted_entity_id, predicted_status,
          decision_confidence, top1_raw_score, utility_score,
          is_correct_resolve, is_wrong_resolve, is_safe_abstain, is_avoidable_abstain,
          evidence_items, top_result_score_components, latency_ms, decision_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
          topResultScoreComponentsParam,
          result.latencyMs,
          JSON.stringify(result.decisionSnapshot),
        ],
      );
      return;
    }
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
      conditions.push(`er.decision_snapshot->>'snapshot_id' = $${idx++}`);
      params.push(filter.snapshotId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<EvalResultRow>(
      `SELECT er.* FROM eval_results er ${where} ORDER BY er.created_at ASC`,
      params,
    );
    const mapped = result.rows.map(rowToEvalResult);
    const droppedLegacyPredictedEntityIdCount = mapped.filter(
      (row) => row.droppedLegacyPredictedEntityId,
    ).length;
    if (droppedLegacyPredictedEntityIdCount > 0) {
      bootstrapLogger.warn(
        {
          droppedLegacyPredictedEntityIdCount,
          ...(filter?.snapshotId !== undefined ? { snapshotId: filter.snapshotId } : {}),
        },
        '[PgEvalResultStore] Dropped legacy source-record predicted_entity_id values from eval_results',
      );
    }
    return mapped.map((row) => row.result);
  }
}
