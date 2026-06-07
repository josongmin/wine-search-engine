import fs from 'node:fs';
import { Agent as UndiciAgent } from 'undici';
import type { Config } from './env.js';
import type { RuntimeReadinessSnapshot } from './container-runtime-support.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { probeJsonPostEndpoint } from '../infrastructure/health/readiness-probes.js';
import {
  loadSearchSnapshotRuntimeState,
} from '../infrastructure/health/search-snapshot-readiness.js';
import { createSnapshotHealthReader } from '../infrastructure/health/snapshot-health-reader.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import { inspectEvalBenchmarkLedgerStatus } from '../infrastructure/db/eval-benchmark-ledger-bootstrap.js';
import type { Pool, PoolClient } from 'pg';
import type {
  HealthRouteOptions,
  ReadinessStatus,
} from '../interface/http/routes/health.route.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../domain/observability/silent-skip-counters.js';
import { isRuntimeSupportedDrinkingWindowModelVersion } from '../application/search/drinking-window-confidence.js';

const log = bootstrapLogger.child({ component: 'readiness' });
const PROBE_TIMEOUT_MS = 3_000;
const ALIAS_SUBSTRATE_PROBE_TIMEOUT_MS = 750;
const SEARCH_SNAPSHOT_RUNTIME_PROBE_TIMEOUT_MS = 1_500;

async function raceWithProbeTimeout<T>(
  operation: Promise<T>,
  timeoutMessage: string,
  timerRef: { current?: ReturnType<typeof setTimeout> | undefined },
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<T> {
  const timeoutPromise: Promise<never> = new Promise((_, reject) => {
    timerRef.current = setTimeout(() => { reject(new Error(timeoutMessage)); }, timeoutMs);
  });
  return await Promise.race([operation, timeoutPromise]);
}

async function probePostgres(
  pool: NonNullable<RuntimeHandles['pool']>,
): Promise<ReadinessStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('pg probe timeout')); }, PROBE_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'postgres' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeRedis(
  redisClient: RuntimeHandles['redisClient'] | null | undefined,
): Promise<ReadinessStatus> {
  if (redisClient == null || !redisClient.isOpen) {
    return 'down';
  }

  // Apply a timeout: a half-open TCP socket (network partition, routing blackhole)
  // could cause `ping()` to hang indefinitely, blocking the entire /ready response
  // for the LB health check. Mirror the pattern used by probePostgres.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redisClient.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('redis probe timeout')); }, PROBE_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'redis' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeCalibrationStore(
  calibrationStore: CalibrationStore,
): Promise<ReadinessStatus> {
  // Apply a timeout: calibrationStore.getCalibrationParams issues a PG query.
  // A live connection with a slow/locked query will hang indefinitely, blocking
  // the /ready endpoint (this probe is required:true in production).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // Use a representative query class to verify the store is reachable.
      calibrationStore.getCalibrationParams('short_entity'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('calibration store probe timeout')); }, PROBE_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'calibration_store' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probeBenchmarkPersistence(pool: Pool): Promise<ReadinessStatus> {
  let client: PoolClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerRef: { current?: ReturnType<typeof setTimeout> | undefined } = {};
  try {
    client = await raceWithProbeTimeout(
      pool.connect(),
      'benchmark persistence connect timeout',
      timerRef,
    );
    timer = timerRef.current;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const status = await raceWithProbeTimeout(
      inspectEvalBenchmarkLedgerStatus(client),
      'benchmark persistence schema probe timeout',
      timerRef,
    );
    timer = timerRef.current;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (status.missingObjects.length > 0) {
      throw new Error(`missing objects: ${status.missingObjects.join(', ')}`);
    }
    if (status.missingColumns.length > 0) {
      throw new Error(`missing columns: ${status.missingColumns.join(', ')}`);
    }
    if (!status.canInsert) {
      throw new Error('missing INSERT privilege on eval_benchmark_runs');
    }
    return 'up';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`benchmark persistence unavailable: ${detail}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client?.release();
  }
}

async function probeSearchSnapshotRuntimeWithoutPool(args?: {
  readonly requireActiveLtr?: boolean;
}): Promise<ReadinessStatus> {
  const runtimeState = await loadSearchSnapshotRuntimeState();
  if (args?.requireActiveLtr === true && runtimeState.counts.activeLtrModels <= 0) {
    throw new Error('Active LTR runtime count is zero');
  }
  if (runtimeState.quality.blockers.length > 0) {
    throw new Error(`Runtime quality blockers present: ${runtimeState.quality.blockers.join(', ')}`);
  }
  return 'up';
}

async function probeAliasSubstrate(
  pool: NonNullable<RuntimeHandles['pool']>,
): Promise<ReadinessStatus> {
  let client: PoolClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerRef: { current?: ReturnType<typeof setTimeout> | undefined } = {};
  try {
    client = await raceWithProbeTimeout(
      pool.connect(),
      'alias substrate connect probe timeout',
      timerRef,
      ALIAS_SUBSTRATE_PROBE_TIMEOUT_MS,
    );
    timer = timerRef.current;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${ALIAS_SUBSTRATE_PROBE_TIMEOUT_MS}ms'`);

    const { rows: pointerRows } = await client.query<{ active_snapshot_id: string }>(
      `SELECT active_snapshot_id
         FROM active_search_snapshot
        WHERE id = 1`,
    );
    const activeSnapshotId = pointerRows[0]?.active_snapshot_id;
    if (typeof activeSnapshotId !== 'string' || activeSnapshotId.length === 0) {
      throw new Error('alias substrate active snapshot pointer missing');
    }

    const probeResult = await client.query(
      `SELECT 1
         FROM aliases
        WHERE search_snapshot_id = $1
          AND is_suppressed = FALSE
        LIMIT 1`,
      [activeSnapshotId],
    );

    await client.query('COMMIT');

    return probeResult.rowCount != null && probeResult.rowCount > 0 ? 'up' : 'down';
  } catch (err) {
    if (client !== undefined) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.debug({ err: rollbackErr, probe: 'alias_substrate' }, 'alias substrate rollback failed');
      }
    }
    log.warn({ err, probe: 'alias_substrate' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client?.release();
  }
}

async function probeSearchSnapshotRuntimeWithPool(args: {
  readonly pool: NonNullable<RuntimeHandles['pool']>;
  readonly requireActiveLtr?: boolean;
}): Promise<ReadinessStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerRef: { current?: ReturnType<typeof setTimeout> | undefined } = {};
  try {
    const runtimeState = await raceWithProbeTimeout(
      loadSearchSnapshotRuntimeState(),
      'search snapshot runtime state load timeout',
      timerRef,
      SEARCH_SNAPSHOT_RUNTIME_PROBE_TIMEOUT_MS,
    );
    timer = timerRef.current;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const pointerRes = await raceWithProbeTimeout(
      args.pool.query<{ active_snapshot_id: string; content_hash: string }>(
        `SELECT active_snapshot_id, content_hash
           FROM active_search_snapshot
          WHERE id = 1`,
      ),
      'search snapshot runtime pointer probe timeout',
      timerRef,
      SEARCH_SNAPSHOT_RUNTIME_PROBE_TIMEOUT_MS,
    );
    timer = timerRef.current;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const pointerRow = pointerRes.rows[0];
    if (pointerRow === undefined) {
      throw new Error('search snapshot runtime pointer row missing');
    }
    if (pointerRow.active_snapshot_id !== runtimeState.snapshotId) {
      throw new Error(
        `search snapshot runtime pointer mismatch: pointer=${pointerRow.active_snapshot_id}, state=${runtimeState.snapshotId}`,
      );
    }
    if (
      runtimeState.contentHash.length > 0
      && pointerRow.content_hash.length > 0
      && pointerRow.content_hash !== runtimeState.contentHash
    ) {
      throw new Error(
        `search snapshot runtime content hash mismatch: pointer=${pointerRow.content_hash}, state=${runtimeState.contentHash}`,
      );
    }
    if (args.requireActiveLtr === true && runtimeState.counts.activeLtrModels <= 0) {
      throw new Error('Active LTR runtime count is zero');
    }
    if (runtimeState.quality.blockers.length > 0) {
      throw new Error(`Runtime quality blockers present: ${runtimeState.quality.blockers.join(', ')}`);
    }
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'search_snapshot_runtime' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function buildHealthRouteOptions(
  config: Config,
  runtime: RuntimeHandles,
  drinkingWindowPredictor?: DrinkingWindowPredictorPort,
  calibrationStore?: CalibrationStore,
  runtimeReadiness?: RuntimeReadinessSnapshot,
): HealthRouteOptions {
  const isProduction = config.nodeEnv === 'production';
  const hasPool = runtime.pool !== undefined;
  const runtimePool = runtime.pool;
  const runStartupEval = config.eval.runAtStartup;
  const blockerZeroCandidatesBaseline =
    globalSilentSkipCounter.snapshot().blocker_zero_candidates;

  return {
    // Runtime plane composite-PK migration (016): attach the snapshot_health
    // observability reader when a PG pool is available. Absent in test and
    // dev environments without PG, where /ready simply omits the block.
    ...(hasPool
      ? { snapshotHealthReader: createSnapshotHealthReader(runtime.pool) }
      : {}),
    readiness: {
      ...((hasPool || isProduction)
        ? {
            postgres: {
              required: true,
              check: (): Promise<ReadinessStatus> => {
                const pool = runtime.pool;
                if (pool === undefined) {
                  return Promise.resolve('down');
                }
                return probePostgres(pool);
              },
            },
            alias_substrate: {
              // Runtime serves anchors from the in-memory alias overlay and
              // degrades to SearchIndexAliasMatcher when PostgreSQL alias rows
              // are unavailable. A live PG alias-row probe is therefore a
              // quality signal, not a hard traffic gate.
              required: false,
              check: (): Promise<ReadinessStatus> => {
                const pool = runtime.pool;
                if (pool === undefined) {
                  return Promise.resolve('down');
                }
                return probeAliasSubstrate(pool);
              },
            },
          }
        : {}),
      ...(runtime.redisClient !== undefined
        ? {
            redis: {
              required: true,
              check: (): Promise<ReadinessStatus> => probeRedis(runtime.redisClient),
            },
          }
        : {}),
      vespa: {
        required: true,
        check: async (): Promise<ReadinessStatus> => {
          const dispatcher =
            config.vespa.certPath !== undefined && config.vespa.keyPath !== undefined
              ? new UndiciAgent({
                  connect: {
                    cert: fs.readFileSync(config.vespa.certPath),
                    key: fs.readFileSync(config.vespa.keyPath),
                    rejectUnauthorized: true,
                  },
                })
              : undefined;
          return probeJsonPostEndpoint(
            `${config.vespa.url}/search/`,
            { yql: 'select * from sources * where true limit 0;' },
            undefined,
            dispatcher,
          );
        },
      },
      search_snapshot_runtime: {
        required: true, // T-E7-02: strict fail-closed regardless of NODE_ENV
        check: async (): Promise<ReadinessStatus> => {
          if (runtime.pool === undefined) {
            if (isProduction) {
              return 'down';
            }
            return probeSearchSnapshotRuntimeWithoutPool({ requireActiveLtr: false });
          }
          return probeSearchSnapshotRuntimeWithPool({
            pool: runtime.pool,
            requireActiveLtr: false,
          });
        },
      },
      ...(runtimeReadiness !== undefined
        ? {
            runtime_ltr_effective: {
              required: runtimeReadiness.ltrModels.effective.required,
              check: (): Promise<ReadinessStatus> =>
                Promise.resolve(
                  runtimeReadiness.ltrModels.effective.loaded
                    || runtimeReadiness.ltrModels.effective.issue === 'disabled'
                    || runtimeReadiness.ltrModels.effective.issue === 'unsupported'
                    ? 'up'
                    : 'down',
                ),
            },
          }
        : {}),
      ...(config.cohere.apiKey !== undefined
        ? {
            reranker: {
              required: false,
              check: async (): Promise<ReadinessStatus> =>
                probeJsonPostEndpoint(
                  `${config.cohere.baseUrl.replace(/\/$/, '')}/rerank`,
                  {
                    model: config.cohere.rerankModel,
                    query: '__healthcheck__',
                    documents: ['__healthcheck__'],
                    top_n: 1,
                  },
                  { Authorization: `Bearer ${config.cohere.apiKey}` },
                ),
            },
          }
        : {}),
      blocking_zero_candidates: {
        required: false,
        check: (): ReadinessStatus =>
          globalSilentSkipCounter.snapshot().blocker_zero_candidates === blockerZeroCandidatesBaseline
            ? 'up'
            : 'down',
      },
      ...(!config.killSwitch.denseRetrieval
        ? {
            embedding: {
              required: true,
              check: async (): Promise<ReadinessStatus> => {
                // OpenAI embedding takes priority (same logic as container-adapters.ts).
                const openAiApiKeys =
                  config.openai.apiKeys.length > 0
                    ? config.openai.apiKeys
                    : config.openai.apiKey !== undefined
                      ? [config.openai.apiKey]
                      : [];
                if (openAiApiKeys.length > 0) {
                  for (const apiKey of openAiApiKeys) {
                    const status = await probeJsonPostEndpoint(`${config.openai.baseUrl}/embeddings`, {
                      model: config.openai.embeddingModel,
                      input: '__healthcheck__',
                    }, { Authorization: `Bearer ${apiKey}` });
                    if (status === 'up') return 'up';
                  }
                  return 'down';
                }
                // No OpenAI key → embedding unavailable; required probe must fail closed.
                log.warn('embedding readiness: no OPENAI_API_KEY/OPENAI_API_KEYS — embedding probe down');
                return 'down';
              },
            },
          }
        : {}),
      ...(config.learnedMatcher.url !== undefined
        ? {
            learned_matcher: {
              required: false,
              check: async (): Promise<ReadinessStatus> =>
                probeJsonPostEndpoint(`${config.learnedMatcher.url}/match`, {
                  query: '__healthcheck__',
                  candidates: [],
                }),
            },
          }
        : {}),
      ...(drinkingWindowPredictor !== undefined
        ? {
            drinking_window_model: {
              required: false,
              check: (): ReadinessStatus => {
                if (drinkingWindowPredictor.modelVersion === 'unloaded') {
                  throw new Error('drinking window predictor unloaded');
                }
                if (!isRuntimeSupportedDrinkingWindowModelVersion(drinkingWindowPredictor.modelVersion)) {
                  throw new Error(`drinking window predictor is not a supported runtime model: ${drinkingWindowPredictor.modelVersion}`);
                }
                return 'up';
              },
            },
          }
        : {}),
      ...(runStartupEval && runtimePool !== undefined
        ? {
            benchmark_persistence: {
              required: true,
              check: async (): Promise<ReadinessStatus> =>
                probeBenchmarkPersistence(runtimePool),
            },
          }
        : runStartupEval
          ? {
              benchmark_persistence: {
                required: true,
                check: (): ReadinessStatus => {
                  throw new Error('benchmark persistence unavailable: PostgreSQL pool missing');
                },
              },
            }
          : {}),
      ...(config.nodeEnv === 'production' && calibrationStore !== undefined
        ? {
            calibration_store: {
              required: true,
              check: (): Promise<ReadinessStatus> =>
                probeCalibrationStore(calibrationStore),
            },
          }
        : {}),
    },
  };
}
