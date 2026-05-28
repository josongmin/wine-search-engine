import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

/**
 * Minimal PG-compatible queryable surface used by the ledger bootstrap helpers.
 *
 * The generic on the underlying `pg.Pool.query<R>` is preserved at the call site
 * via {@link typedRowsQuery}, keeping this interface itself free of the
 * single-use type-parameter anti-pattern (`@typescript-eslint/no-unnecessary-type-parameters`).
 */
interface PgQueryable {
  query: (text: string, values?: readonly unknown[]) => Promise<{
    rows: readonly unknown[];
    rowCount?: number | null;
  }>;
}

/**
 * Typed projection over {@link PgQueryable.query}. The generic parameter `T`
 * appears in both the input position (`rowGuard`) and the output position
 * (`Promise<readonly T[]>`), satisfying the no-unnecessary-type-parameters rule
 * while keeping row narrowing on the caller side.
 */
async function typedRowsQuery<T>(
  queryable: PgQueryable,
  text: string,
  rowGuard: (row: unknown) => row is T,
  values?: readonly unknown[],
): Promise<readonly T[]> {
  const result = await queryable.query(text, values);
  const rows: T[] = [];
  for (const row of result.rows) {
    if (!rowGuard(row)) {
      throw new Error(`eval-benchmark-ledger-bootstrap: row failed schema guard for query: ${text}`);
    }
    rows.push(row);
  }
  return rows;
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

const EVAL_BENCHMARK_LEDGER_REQUIRED_COLUMNS = [
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
  'provenance_schema_version',
  'corpus_id',
  'corpus_hash',
  'runtime_target',
  'uses_live_api',
  'smoke_synthesized',
  'threshold_source',
  'gate_eligible',
  'suite_gate_passed',
  'readiness_passed',
  'active_ltr_models',
  'label_tier_mix',
  'slice_mix',
  'query_class_mix',
  'runtime_activation_status',
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
    activation_status TEXT,
    provenance_schema_version INT,
    corpus_id TEXT,
    corpus_hash TEXT,
    runtime_target TEXT,
    uses_live_api BOOLEAN,
    smoke_synthesized BOOLEAN,
    threshold_source TEXT,
    gate_eligible BOOLEAN,
    suite_gate_passed BOOLEAN,
    readiness_passed BOOLEAN,
    active_ltr_models INT,
    label_tier_mix JSONB,
    slice_mix JSONB,
    query_class_mix JSONB,
    runtime_activation_status TEXT,
    report_json JSONB NOT NULL,
    metrics JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (activation_status IS NULL OR activation_status IN ('activated', 'shadow_only')),
    CHECK (runtime_activation_status IS NULL OR runtime_activation_status IN ('activated', 'shadow_only'))
  )`,
  `ALTER TABLE eval_benchmark_runs
    ALTER COLUMN search_snapshot_id DROP NOT NULL`,
  `ALTER TABLE eval_benchmark_runs
    ALTER COLUMN activation_status DROP NOT NULL`,
  `ALTER TABLE eval_benchmark_runs
    ADD COLUMN IF NOT EXISTS metrics JSONB`,
  `ALTER TABLE eval_benchmark_runs
    ADD COLUMN IF NOT EXISTS provenance_schema_version INT,
    ADD COLUMN IF NOT EXISTS corpus_id TEXT,
    ADD COLUMN IF NOT EXISTS corpus_hash TEXT,
    ADD COLUMN IF NOT EXISTS runtime_target TEXT,
    ADD COLUMN IF NOT EXISTS uses_live_api BOOLEAN,
    ADD COLUMN IF NOT EXISTS smoke_synthesized BOOLEAN,
    ADD COLUMN IF NOT EXISTS threshold_source TEXT,
    ADD COLUMN IF NOT EXISTS gate_eligible BOOLEAN,
    ADD COLUMN IF NOT EXISTS suite_gate_passed BOOLEAN,
    ADD COLUMN IF NOT EXISTS readiness_passed BOOLEAN,
    ADD COLUMN IF NOT EXISTS active_ltr_models INT,
    ADD COLUMN IF NOT EXISTS label_tier_mix JSONB,
    ADD COLUMN IF NOT EXISTS slice_mix JSONB,
    ADD COLUMN IF NOT EXISTS query_class_mix JSONB,
    ADD COLUMN IF NOT EXISTS runtime_activation_status TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_kind_created
    ON eval_benchmark_runs(benchmark_kind, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_snapshot_created
    ON eval_benchmark_runs(search_snapshot_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_gate_created
    ON eval_benchmark_runs(release_gate_passed, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_compat_created
    ON eval_benchmark_runs(
      benchmark_kind,
      corpus_hash,
      runtime_target,
      uses_live_api,
      threshold_source,
      gate_eligible,
      created_at DESC
    )`,
  `DROP VIEW IF EXISTS eval_benchmark_run_trends_v`,
  `DROP VIEW IF EXISTS eval_benchmark_run_metrics_v`,
  `CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v AS
  SELECT
    run_id,
    benchmark_kind,
    search_snapshot_id,
    eval_dataset_version,
    provenance_schema_version,
    corpus_id,
    corpus_hash,
    runtime_target,
    uses_live_api,
    smoke_synthesized,
    threshold_source,
    gate_eligible,
    suite_gate_passed,
    readiness_passed,
    active_ltr_models,
    runtime_activation_status,
    release_gate_passed,
    created_at,
    'recall_at_1' AS metric_name,
    recall_at_1 AS metric_value
  FROM eval_benchmark_runs
  WHERE recall_at_1 IS NOT NULL
    AND provenance_schema_version IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    provenance_schema_version, corpus_id, corpus_hash, runtime_target,
    uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
    suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
    release_gate_passed, created_at,
    'recall_at_3', recall_at_3
  FROM eval_benchmark_runs
  WHERE recall_at_3 IS NOT NULL
    AND provenance_schema_version IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    provenance_schema_version, corpus_id, corpus_hash, runtime_target,
    uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
    suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
    release_gate_passed, created_at,
    'mrr', mrr
  FROM eval_benchmark_runs
  WHERE mrr IS NOT NULL
    AND provenance_schema_version IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    provenance_schema_version, corpus_id, corpus_hash, runtime_target,
    uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
    suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
    release_gate_passed, created_at,
    'false_exact_rate', false_exact_rate
  FROM eval_benchmark_runs
  WHERE false_exact_rate IS NOT NULL
    AND provenance_schema_version IS NOT NULL

  UNION ALL

  SELECT
    run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
    provenance_schema_version, corpus_id, corpus_hash, runtime_target,
    uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
    suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
    release_gate_passed, created_at,
    'query_count', query_count::float8
  FROM eval_benchmark_runs
  WHERE provenance_schema_version IS NOT NULL

  UNION ALL

  SELECT
    r.run_id,
    r.benchmark_kind,
    r.search_snapshot_id,
    r.eval_dataset_version,
    r.provenance_schema_version,
    r.corpus_id,
    r.corpus_hash,
    r.runtime_target,
    r.uses_live_api,
    r.smoke_synthesized,
    r.threshold_source,
    r.gate_eligible,
    r.suite_gate_passed,
    r.readiness_passed,
    r.active_ltr_models,
    r.runtime_activation_status,
    r.release_gate_passed,
    r.created_at,
    kv.key AS metric_name,
    (kv.value)::float8 AS metric_value
  FROM eval_benchmark_runs r,
       LATERAL jsonb_each_text(r.metrics) AS kv(key, value)
  WHERE r.provenance_schema_version IS NOT NULL
    AND r.metrics IS NOT NULL
    AND r.metrics != 'null'::jsonb
    AND kv.key NOT IN ('recall_at_1', 'recall_at_3', 'mrr', 'false_exact_rate', 'query_count')
    AND kv.value ~ '^-?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?$'`,
  `CREATE OR REPLACE VIEW eval_benchmark_run_trends_v AS
  SELECT
    benchmark_kind,
    search_snapshot_id,
    provenance_schema_version,
    corpus_id,
    corpus_hash,
    runtime_target,
    uses_live_api,
    smoke_synthesized,
    threshold_source,
    gate_eligible,
    suite_gate_passed,
    readiness_passed,
    active_ltr_models,
    runtime_activation_status,
    metric_name,
    metric_value,
    release_gate_passed,
    created_at,
    run_id,
    md5(
      concat_ws(
        E'\\n',
        benchmark_kind,
        coalesce(corpus_hash, ''),
        coalesce(runtime_target, ''),
        coalesce(uses_live_api::text, ''),
        coalesce(threshold_source, ''),
        coalesce(gate_eligible::text, '')
      )
    ) AS comparison_compatibility_key,
    ROW_NUMBER() OVER (
      PARTITION BY benchmark_kind, corpus_hash, runtime_target, uses_live_api, threshold_source, gate_eligible, metric_name
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

function isPresenceRow(row: unknown): row is EvalBenchmarkLedgerObjectPresenceRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
  return (
    isStringOrNull(r['runs_table']) &&
    isStringOrNull(r['metrics_view']) &&
    isStringOrNull(r['trends_view']) &&
    typeof r['can_insert'] === 'boolean'
  );
}

function isColumnRow(row: unknown): row is EvalBenchmarkLedgerColumnRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r['column_name'] === 'string';
}

export async function inspectEvalBenchmarkLedgerStatus(
  queryable: PgQueryable,
): Promise<{
    readonly missingObjects: readonly string[];
    readonly missingColumns: readonly string[];
    readonly canInsert: boolean;
  }> {
  const presenceRows = await typedRowsQuery(
    queryable,
    `SELECT
       to_regclass('public.eval_benchmark_runs')::text AS runs_table,
       to_regclass('public.eval_benchmark_run_metrics_v')::text AS metrics_view,
       to_regclass('public.eval_benchmark_run_trends_v')::text AS trends_view,
       COALESCE(
         has_table_privilege(current_user, 'public.eval_benchmark_runs', 'INSERT'),
         FALSE
       ) AS can_insert`,
    isPresenceRow,
  );
  const presence: EvalBenchmarkLedgerObjectPresenceRow = presenceRows[0] ?? {
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

  const columnRows = await typedRowsQuery(
    queryable,
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'eval_benchmark_runs'`,
    isColumnRow,
  );
  const presentColumns = new Set(columnRows.map((row) => row.column_name));
  const missingColumns = EVAL_BENCHMARK_LEDGER_REQUIRED_COLUMNS
    .filter((columnName) => !presentColumns.has(columnName));

  return {
    missingObjects,
    missingColumns,
    canInsert: presence.can_insert,
  };
}
