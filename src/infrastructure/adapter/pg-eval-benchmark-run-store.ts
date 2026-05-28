import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type {
  EvalBenchmarkKind,
  EvalBenchmarkRun,
  EvalBenchmarkRunInput,
  EvalBenchmarkRunProvenance,
  EvalBenchmarkRuntimeActivationStatus,
} from '../../domain/evaluation/model/eval-benchmark-run.js';
import type {
  EvalBenchmarkRunFilter,
  EvalBenchmarkRunStore,
} from '../../domain/evaluation/port/eval-benchmark-run-store.port.js';
import { ensureEvalBenchmarkLedgerBootstrap } from '../db/eval-benchmark-ledger-bootstrap.js';
import { readPgSqlState } from '../db/pg-sqlstate.js';

interface EvalBenchmarkRunRow {
  run_id: string;
  benchmark_kind: string;
  search_snapshot_id: string | null;
  eval_dataset_version: string;
  feature_schema_hash: string;
  query_count: number;
  recall_at_1: number | null;
  recall_at_3: number | null;
  mrr: number | null;
  false_exact_rate: number | null;
  release_gate_passed: boolean;
  activation_status: string | null;
  provenance_schema_version: number | null;
  corpus_id: string | null;
  corpus_hash: string | null;
  runtime_target: string | null;
  uses_live_api: boolean | null;
  smoke_synthesized: boolean | null;
  threshold_source: string | null;
  gate_eligible: boolean | null;
  suite_gate_passed: boolean | null;
  readiness_passed: boolean | null;
  active_ltr_models: number | null;
  label_tier_mix: unknown;
  slice_mix: unknown;
  query_class_mix: unknown;
  runtime_activation_status: string | null;
  report_json: unknown;
  metrics: unknown;
  created_at: Date;
}

const VALID_BENCHMARK_KINDS: ReadonlySet<string> = new Set([
  'noisy_entity',
  'offline_eval',
  'offline_eval_in_memory_regression',
  'offline_eval_live_runtime',
  'offline_eval_embedding_sensitive_live_runtime',
  'entity_retrieval_fixture',
  'search_feature_behavior_fixture',
  'search_feature_behavior_structural',
  'search_feature_behavior_live',
  'agentic_tool_use_fixture',
] satisfies EvalBenchmarkKind[]);

function isEvalBenchmarkKind(value: string): value is EvalBenchmarkKind {
  return VALID_BENCHMARK_KINDS.has(value);
}

function toEvalBenchmarkKind(raw: unknown): EvalBenchmarkKind {
  if (typeof raw === 'string' && isEvalBenchmarkKind(raw)) {
    return raw;
  }
  throw new Error(`Invalid benchmark_kind from DB: ${String(raw)}`);
}

function toRuntimeActivationStatus(
  value: string | null,
): EvalBenchmarkRuntimeActivationStatus | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === 'activated' || value === 'shadow_only') {
    return value;
  }
  throw new Error(`PgEvalBenchmarkRunStore: unknown activation_status "${value}"`);
}

function isPlainRecord(raw: unknown): raw is Readonly<Record<string, unknown>> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function parseMetrics(raw: unknown): Readonly<Record<string, number>> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const result: Record<string, number> = {};
  let hasKey = false;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      result[k] = v;
      hasKey = true;
    }
  }
  return hasKey ? result : undefined;
}

function parseMix(raw: unknown): Readonly<Record<string, number>> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const result: Record<string, number> = {};
  let hasKey = false;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
      hasKey = true;
    }
  }
  return hasKey ? result : undefined;
}

function rowToProvenance(row: EvalBenchmarkRunRow): EvalBenchmarkRunProvenance | undefined {
  if (row.provenance_schema_version == null) {
    return undefined;
  }
  if (row.provenance_schema_version !== 1) {
    throw new Error(`PgEvalBenchmarkRunStore: unknown provenance_schema_version "${String(row.provenance_schema_version)}"`);
  }
  if (
    row.corpus_id == null
    || row.corpus_hash == null
    || row.runtime_target == null
    || row.uses_live_api == null
    || row.smoke_synthesized == null
    || row.threshold_source == null
    || row.gate_eligible == null
    || row.suite_gate_passed == null
  ) {
    throw new Error('PgEvalBenchmarkRunStore: provenance schema version is present but required provenance columns are null');
  }
  return {
    provenanceSchemaVersion: 1,
    corpusId: row.corpus_id,
    corpusHash: row.corpus_hash,
    runtimeTarget: row.runtime_target,
    usesLiveApi: row.uses_live_api,
    smokeSynthesized: row.smoke_synthesized,
    thresholdSource: row.threshold_source,
    gateEligible: row.gate_eligible,
    suiteGatePassed: row.suite_gate_passed,
    ...(row.search_snapshot_id != null ? { searchSnapshotId: row.search_snapshot_id } : {}),
    ...(toRuntimeActivationStatus(row.runtime_activation_status) !== undefined
      ? { runtimeActivationStatus: toRuntimeActivationStatus(row.runtime_activation_status) }
      : {}),
    ...(row.readiness_passed == null ? {} : { readinessPassed: row.readiness_passed }),
    ...(row.active_ltr_models == null ? {} : { activeLtrModels: row.active_ltr_models }),
    ...(parseMix(row.label_tier_mix) !== undefined ? { labelTierMix: parseMix(row.label_tier_mix) } : {}),
    ...(parseMix(row.slice_mix) !== undefined ? { sliceMix: parseMix(row.slice_mix) } : {}),
    ...(parseMix(row.query_class_mix) !== undefined ? { queryClassMix: parseMix(row.query_class_mix) } : {}),
  };
}

function rowToEvalBenchmarkRun(row: EvalBenchmarkRunRow): EvalBenchmarkRun {
  const metrics = parseMetrics(row.metrics);
  const provenance = rowToProvenance(row);
  const runtimeActivationStatus = toRuntimeActivationStatus(row.runtime_activation_status ?? row.activation_status);
  return {
    runId: row.run_id,
    benchmarkKind: toEvalBenchmarkKind(row.benchmark_kind),
    ...(row.search_snapshot_id != null ? { snapshotId: row.search_snapshot_id } : {}),
    evalDatasetVersion: row.eval_dataset_version,
    featureSchemaHash: row.feature_schema_hash,
    queryCount: row.query_count,
    ...(row.recall_at_1 === null ? {} : { recallAt1: row.recall_at_1 }),
    ...(row.recall_at_3 === null ? {} : { recallAt3: row.recall_at_3 }),
    ...(row.mrr === null ? {} : { mrr: row.mrr }),
    ...(row.false_exact_rate === null ? {} : { falseExactRate: row.false_exact_rate }),
    releaseGatePassed: row.release_gate_passed,
    ...(runtimeActivationStatus !== undefined ? { runtimeActivationStatus } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    report: isPlainRecord(row.report_json) ? row.report_json : {},
    ...(metrics != null ? { metrics } : {}),
    createdAt: row.created_at,
  };
}

export class PgEvalBenchmarkRunStore implements EvalBenchmarkRunStore {
  constructor(private readonly pool: Pool) {}

  private async withLedgerBootstrapRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      const code = readPgSqlState(err);
      if (code !== '42P01' && code !== '42703') {
        throw err;
      }
      await ensureEvalBenchmarkLedgerBootstrap(this.pool);
      return operation();
    }
  }

  async saveRun(run: EvalBenchmarkRunInput): Promise<string> {
    return this.withLedgerBootstrapRetry(async () => {
      const runId = nanoid();
      const releaseGatePassed = run.provenance.gateEligible && run.provenance.suiteGatePassed;
      await this.pool.query(
        `INSERT INTO eval_benchmark_runs (
          run_id, benchmark_kind, search_snapshot_id, eval_dataset_version, feature_schema_hash,
          query_count, recall_at_1, recall_at_3, mrr, false_exact_rate,
          release_gate_passed, activation_status, provenance_schema_version,
          corpus_id, corpus_hash, runtime_target, uses_live_api, smoke_synthesized,
          threshold_source, gate_eligible, suite_gate_passed, readiness_passed,
          active_ltr_models, label_tier_mix, slice_mix, query_class_mix,
          runtime_activation_status, report_json, metrics, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30
        )`,
        [
          runId,
          run.benchmarkKind,
          run.provenance.searchSnapshotId ?? null,
          run.evalDatasetVersion,
          run.featureSchemaHash,
          run.queryCount,
          run.recallAt1 ?? null,
          run.recallAt3 ?? null,
          run.mrr ?? null,
          run.falseExactRate ?? null,
          releaseGatePassed,
          run.provenance.runtimeActivationStatus ?? null,
          run.provenance.provenanceSchemaVersion,
          run.provenance.corpusId,
          run.provenance.corpusHash,
          run.provenance.runtimeTarget,
          run.provenance.usesLiveApi,
          run.provenance.smokeSynthesized,
          run.provenance.thresholdSource,
          run.provenance.gateEligible,
          run.provenance.suiteGatePassed,
          run.provenance.readinessPassed ?? null,
          run.provenance.activeLtrModels ?? null,
          run.provenance.labelTierMix != null ? JSON.stringify(run.provenance.labelTierMix) : null,
          run.provenance.sliceMix != null ? JSON.stringify(run.provenance.sliceMix) : null,
          run.provenance.queryClassMix != null ? JSON.stringify(run.provenance.queryClassMix) : null,
          run.provenance.runtimeActivationStatus ?? null,
          JSON.stringify(run.report),
          run.metrics != null ? JSON.stringify(run.metrics) : null,
          run.createdAt ?? new Date(),
        ],
      );
      return runId;
    });
  }

  async listRuns(filter?: EvalBenchmarkRunFilter): Promise<readonly EvalBenchmarkRun[]> {
    return this.withLedgerBootstrapRetry(async () => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let index = 1;

      if (filter?.benchmarkKind !== undefined) {
        conditions.push(`benchmark_kind = $${index++}`);
        params.push(filter.benchmarkKind);
      }
      if (filter?.snapshotId !== undefined) {
        conditions.push(`search_snapshot_id = $${index++}`);
        params.push(filter.snapshotId);
      }
      if (filter?.since !== undefined) {
        conditions.push(`created_at >= $${index++}`);
        params.push(filter.since);
      }
      if (filter?.includeLegacy !== true) {
        conditions.push('provenance_schema_version IS NOT NULL');
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      let limitClause = '';
      if (filter?.limit !== undefined) {
        const safeLimit = Math.max(1, Math.trunc(filter.limit));
        if (Number.isFinite(safeLimit)) {
          params.push(safeLimit);
          limitClause = `LIMIT $${params.length}`;
        }
      }
      const result = await this.pool.query<EvalBenchmarkRunRow>(
        `SELECT *
         FROM eval_benchmark_runs
         ${whereClause}
         ORDER BY created_at DESC
         ${limitClause}`,
        params,
      );
      return result.rows.map(rowToEvalBenchmarkRun);
    });
  }
}
