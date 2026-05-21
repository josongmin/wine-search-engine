import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type {
  EvalBenchmarkKind,
  EvalBenchmarkRun,
  EvalBenchmarkRunInput,
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
  activation_status: string;
  report_json: unknown;
  metrics: unknown;
  created_at: Date;
}

const VALID_BENCHMARK_KINDS: ReadonlySet<string> = new Set([
  'noisy_entity',
  'offline_eval',
  'entity_retrieval_fixture',
  'search_feature_behavior_fixture',
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

function toActivationStatus(value: string): EvalBenchmarkRun['activationStatus'] {
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

function rowToEvalBenchmarkRun(row: EvalBenchmarkRunRow): EvalBenchmarkRun {
  const metrics = parseMetrics(row.metrics);
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
    activationStatus: toActivationStatus(row.activation_status),
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
      await this.pool.query(
        `INSERT INTO eval_benchmark_runs (
          run_id, benchmark_kind, search_snapshot_id, eval_dataset_version, feature_schema_hash,
          query_count, recall_at_1, recall_at_3, mrr, false_exact_rate,
          release_gate_passed, activation_status, report_json, metrics, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          runId,
          run.benchmarkKind,
          run.snapshotId ?? null,
          run.evalDatasetVersion,
          run.featureSchemaHash,
          run.queryCount,
          run.recallAt1 ?? null,
          run.recallAt3 ?? null,
          run.mrr ?? null,
          run.falseExactRate ?? null,
          run.releaseGatePassed,
          run.activationStatus,
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
