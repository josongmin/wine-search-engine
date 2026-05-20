import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

export interface PgQueryable {
  query: <T = unknown>(text: string, values?: readonly unknown[]) => Promise<{
    rows: T[];
    rowCount?: number | null;
  }>;
}

interface EvalBenchmarkLedgerObjectPresenceRow {
  readonly runs_table: string | null;
  readonly metrics_view: string | null;
  readonly trends_view: string | null;
  readonly can_insert: boolean;
}

interface EvalBenchmarkLedgerColumnRow {
  readonly column_name: string;
}

const log = bootstrapLogger.child({ component: 'EvalBenchmarkLedgerBootstrap' });

const bootstrapCache = new WeakMap<object, Promise<void>>();

export const EVAL_BENCHMARK_LEDGER_REQUIRED_COLUMNS = [
  'run_id',
  'benchmark_kind',
  'search_snapshot_id',
  'eval_dataset_version',
  'feature_schema_hash',
  'query_count',
  'recall_at_1',
  'recall_at_3',
  'mrr',
  'false_exact_rate',
  'release_gate_passed',
  'activation_status',
  'report_json',
  'metrics',
  'created_at',
] as const;

export const EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS eval_benchmark_runs (
    run_id TEXT PRIMARY KEY,
    benchmark_kind TEXT NOT NULL,
    search_snapshot_id TEXT,
    eval_dataset_version TEXT NOT NULL,
    feature_schema_hash TEXT NOT NULL,
    query_count INT NOT NULL CHECK (query_count >= 0),
    recall_at_1 FLOAT8,
    recall_at_3 FLOAT8,
    mrr FLOAT8,
    false_exact_rate FLOAT8,
    release_gate_passed BOOLEAN NOT NULL,
    activation_status TEXT NOT NULL,
    report_json JSONB NOT NULL,
    metrics JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (activation_status IN ('activated', 'shadow_only'))
  )`,
  `ALTER TABLE eval_benchmark_runs
    ALTER COLUMN search_snapshot_id DROP NOT NULL`,
  `ALTER TABLE eval_benchmark_runs
    ADD COLUMN IF NOT EXISTS metrics JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_kind_created
    ON eval_benchmark_runs(benchmark_kind, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_snapshot_created
    ON eval_benchmark_runs(search_snapshot_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_gate_created
    ON eval_benchmark_runs(release_gate_passed, created_at DESC)`,
  `CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v AS
  SELECT
    run_id,
    benchmark_kind,
    search_snapshot_id,
    eval_dataset_version,
    release_gate_passed,
    created_at,
    'recall_at_1' AS metric_name,
    recall_at_1 AS metric_value
  FROM eval_benchmark_runs
  WHERE recall_at_1 IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    release_gate_passed, created_at,
    'recall_at_3', recall_at_3
  FROM eval_benchmark_runs
  WHERE recall_at_3 IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    release_gate_passed, created_at,
    'mrr', mrr
  FROM eval_benchmark_runs
  WHERE mrr IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    release_gate_passed, created_at,
    'false_exact_rate', false_exact_rate
  FROM eval_benchmark_runs
  WHERE false_exact_rate IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    release_gate_passed, created_at,
    'query_count', query_count::float8
  FROM eval_benchmark_runs

  UNION ALL

  SELECT
    r.run_id,
    r.benchmark_kind,
    r.search_snapshot_id,
    r.eval_dataset_version,
    r.release_gate_passed,
    r.created_at,
    kv.key AS metric_name,
    (kv.value)::float8 AS metric_value
  FROM eval_benchmark_runs r,
       LATERAL jsonb_each_text(r.metrics) AS kv(key, value)
  WHERE r.metrics IS NOT NULL
    AND r.metrics != 'null'::jsonb
    AND kv.key NOT IN ('recall_at_1', 'recall_at_3', 'mrr', 'false_exact_rate', 'query_count')
    AND kv.value ~ '^-?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?$'`,
  `CREATE OR REPLACE VIEW eval_benchmark_run_trends_v AS
  SELECT
    benchmark_kind,
    search_snapshot_id,
    metric_name,
    metric_value,
    release_gate_passed,
    created_at,
    run_id,
    ROW_NUMBER() OVER (
      PARTITION BY benchmark_kind, metric_name
      ORDER BY created_at DESC
    ) AS run_ordinal
  FROM eval_benchmark_run_metrics_v`,
] as const;

async function applyEvalBenchmarkLedgerBootstrap(queryable: PgQueryable): Promise<void> {
  for (const statement of EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS) {
    await queryable.query(statement);
  }
  log.info(
    { statementCount: EVAL_BENCHMARK_LEDGER_BOOTSTRAP_STATEMENTS.length },
    'Applied targeted eval benchmark ledger bootstrap (017/018/019 final schema)',
  );
}

export async function ensureEvalBenchmarkLedgerBootstrap(queryable: PgQueryable): Promise<void> {
  const cacheKey = queryable as object;
  const cached = bootstrapCache.get(cacheKey);
  if (cached !== undefined) {
    await cached;
    return;
  }

  const bootstrapPromise = applyEvalBenchmarkLedgerBootstrap(queryable).catch((err: unknown) => {
    bootstrapCache.delete(cacheKey);
    throw err;
  });
  bootstrapCache.set(cacheKey, bootstrapPromise);
  await bootstrapPromise;
}

export async function inspectEvalBenchmarkLedgerStatus(
  queryable: PgQueryable,
): Promise<{
    readonly missingObjects: readonly string[];
    readonly missingColumns: readonly string[];
    readonly canInsert: boolean;
  }> {
  const presenceResult = await queryable.query<EvalBenchmarkLedgerObjectPresenceRow>(
    `SELECT
       to_regclass('public.eval_benchmark_runs')::text AS runs_table,
       to_regclass('public.eval_benchmark_run_metrics_v')::text AS metrics_view,
       to_regclass('public.eval_benchmark_run_trends_v')::text AS trends_view,
       COALESCE(
         has_table_privilege(current_user, 'public.eval_benchmark_runs', 'INSERT'),
         FALSE
       ) AS can_insert`,
  );
  const presence = presenceResult.rows[0] ?? {
    runs_table: null,
    metrics_view: null,
    trends_view: null,
    can_insert: false,
  };
  const missingObjects = [
    ...(presence.runs_table === 'eval_benchmark_runs' ? [] : ['eval_benchmark_runs']),
    ...(presence.metrics_view === 'eval_benchmark_run_metrics_v' ? [] : ['eval_benchmark_run_metrics_v']),
    ...(presence.trends_view === 'eval_benchmark_run_trends_v' ? [] : ['eval_benchmark_run_trends_v']),
  ];

  const columnResult = await queryable.query<EvalBenchmarkLedgerColumnRow>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'eval_benchmark_runs'`,
  );
  const presentColumns = new Set(columnResult.rows.map((row) => row.column_name));
  const missingColumns = EVAL_BENCHMARK_LEDGER_REQUIRED_COLUMNS
    .filter((columnName) => !presentColumns.has(columnName));

  return {
    missingObjects,
    missingColumns,
    canInsert: presence.can_insert,
  };
}
