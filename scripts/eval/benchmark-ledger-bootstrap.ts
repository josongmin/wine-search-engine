import { nanoid } from 'nanoid';
import type { Pool } from 'pg';

type PoolLike = Pick<Pool, 'query' | 'end'>;

interface BenchmarkLedgerColumnRow {
  readonly table_schema: string;
  readonly column_name: string;
  readonly is_nullable: 'YES' | 'NO';
}

export interface BenchmarkLedgerSchema {
  readonly tableSchema: string;
  readonly hasMetricsColumn: boolean;
  readonly searchSnapshotNullable: boolean;
  readonly hasProvenanceColumns: boolean;
}

export interface BenchmarkLedgerRunInput {
  readonly benchmarkKind: string;
  readonly evalDatasetVersion: string;
  readonly featureSchemaHash: string;
  readonly queryCount: number;
  readonly recallAt1?: number | undefined;
  readonly recallAt3?: number | undefined;
  readonly mrr?: number | undefined;
  readonly falseExactRate?: number | undefined;
  readonly provenance: {
    readonly provenanceSchemaVersion: 1;
    readonly corpusId: string;
    readonly corpusHash: string;
    readonly runtimeTarget: string;
    readonly usesLiveApi: boolean;
    readonly smokeSynthesized: boolean;
    readonly thresholdSource: string;
    readonly gateEligible: boolean;
    readonly suiteGatePassed: boolean;
    readonly searchSnapshotId?: string | undefined;
    readonly runtimeActivationStatus?: 'activated' | 'shadow_only' | undefined;
    readonly readinessPassed?: boolean | undefined;
    readonly activeLtrModels?: number | undefined;
    readonly labelTierMix?: Readonly<Record<string, number>> | undefined;
    readonly sliceMix?: Readonly<Record<string, number>> | undefined;
    readonly queryClassMix?: Readonly<Record<string, number>> | undefined;
  };
  readonly report: Readonly<Record<string, unknown>>;
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly createdAt?: Date | undefined;
}

export type BenchmarkLedgerPersistResult =
  | {
    readonly status: 'persisted';
    readonly runId: string;
    readonly schema: BenchmarkLedgerSchema;
  }
  | {
    readonly status: 'skipped';
    readonly reason: 'table_missing' | 'snapshot_required';
    readonly detail: string;
    readonly schema?: BenchmarkLedgerSchema | undefined;
  };

export type BenchmarkLedgerBootstrap =
  | {
    readonly status: 'ready';
    readonly schema: BenchmarkLedgerSchema;
    persistRun(run: BenchmarkLedgerRunInput): Promise<BenchmarkLedgerPersistResult>;
    close(): Promise<void>;
  }
  | {
    readonly status: 'skipped';
    readonly reason: 'table_missing';
    readonly detail: string;
    close(): Promise<void>;
  };

interface BootstrapOptions {
  readonly createPool?: (() => PoolLike | Promise<PoolLike>) | undefined;
}

const LEDGER_SCHEMA_QUERY = `
  WITH active_schemas AS (
    SELECT schema_name, ord
      FROM unnest(current_schemas(true)) WITH ORDINALITY AS s(schema_name, ord)
  )
  SELECT c.table_schema, c.column_name, c.is_nullable
    FROM information_schema.columns c
    JOIN active_schemas s
      ON s.schema_name = c.table_schema
   WHERE c.table_name = 'eval_benchmark_runs'
   ORDER BY s.ord, c.ordinal_position
`;

function buildInsertStatement(schema: BenchmarkLedgerSchema): string {
  const columns = [
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
  ];
  if (schema.hasMetricsColumn) {
    columns.push('metrics');
  }
  columns.push('created_at');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  return `INSERT INTO eval_benchmark_runs (${columns.join(', ')}) VALUES (${placeholders})`;
}

async function resolvePool(
  createPool?: (() => PoolLike | Promise<PoolLike>) | undefined,
): Promise<PoolLike> {
  if (createPool !== undefined) {
    return await createPool();
  }
  const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');
  return getPgPool();
}

function resolveSchema(rows: readonly BenchmarkLedgerColumnRow[]): BenchmarkLedgerSchema | undefined {
  const tableSchema = rows[0]?.table_schema;
  if (tableSchema === undefined) return undefined;
  const schemaRows = rows.filter((row) => row.table_schema === tableSchema);
  const snapshotColumn = schemaRows.find((row) => row.column_name === 'search_snapshot_id');
  if (snapshotColumn === undefined) {
    throw new Error('benchmark ledger schema missing search_snapshot_id');
  }
  return {
    tableSchema,
    hasMetricsColumn: schemaRows.some((row) => row.column_name === 'metrics'),
    searchSnapshotNullable: snapshotColumn.is_nullable === 'YES',
    hasProvenanceColumns: schemaRows.some((row) => row.column_name === 'provenance_schema_version'),
  };
}

export async function bootstrapBenchmarkLedgerPersistence(
  options: BootstrapOptions = {},
): Promise<BenchmarkLedgerBootstrap> {
  const pool = await resolvePool(options.createPool);
  const close = async (): Promise<void> => {
    await pool.end?.();
  };

  const schemaResult = await pool.query<BenchmarkLedgerColumnRow>(LEDGER_SCHEMA_QUERY);
  const schema = resolveSchema(schemaResult.rows);
  if (schema === undefined) {
    return {
      status: 'skipped',
      reason: 'table_missing',
      detail: 'eval_benchmark_runs not found in current schema search path',
      close,
    };
  }

  return {
    status: 'ready',
    schema,
    close,
    persistRun: async (run: BenchmarkLedgerRunInput): Promise<BenchmarkLedgerPersistResult> => {
      if (run.provenance.searchSnapshotId === undefined && !schema.searchSnapshotNullable) {
        return {
          status: 'skipped',
          reason: 'snapshot_required',
          detail: 'eval_benchmark_runs.search_snapshot_id is NOT NULL in the current schema',
          schema,
        };
      }

      if (!schema.hasProvenanceColumns) {
        return {
          status: 'skipped',
          reason: 'table_missing',
          detail: 'eval_benchmark_runs provenance columns are missing in the current schema',
          schema,
        };
      }

      const releaseGatePassed = run.provenance.gateEligible && run.provenance.suiteGatePassed;
      const runId = nanoid();
      const params: unknown[] = [
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
      ];
      if (schema.hasMetricsColumn) {
        params.push(run.metrics != null ? JSON.stringify(run.metrics) : null);
      }
      params.push(run.createdAt ?? new Date());

      await pool.query(buildInsertStatement(schema), params);
      return {
        status: 'persisted',
        runId,
        schema,
      };
    },
  };
}
