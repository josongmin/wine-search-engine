import fs from 'node:fs';
import { Agent as UndiciAgent } from 'undici';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import {
  expectsRedisAtStartup,
  isWatchlistEnabled,
} from './watchlist.js';
import { probeJsonPostEndpoint } from '../infrastructure/health/readiness-probes.js';
import {
  probeSearchSnapshotRuntimeState,
  verifySearchSnapshotRuntimeStateLive,
} from '../infrastructure/health/search-snapshot-readiness.js';
import { resolveActiveSnapshot } from '../infrastructure/db/active-snapshot-resolver.js';
import { createSnapshotHealthReader } from '../infrastructure/health/snapshot-health-reader.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type {
  HealthRouteOptions,
  ReadinessStatus,
} from '../interface/http/routes/health.route.js';
import { bootstrapLogger } from './bootstrap-logger.js';
import { globalSilentSkipCounter } from '../observability/silent-skip-counters.js';

const log = bootstrapLogger.child({ component: 'readiness' });
const PROBE_TIMEOUT_MS = 3_000;

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

async function probeAliasSubstrate(
  pool: NonNullable<RuntimeHandles['pool']>,
): Promise<ReadinessStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const activeSnapshot = await Promise.race([
      resolveActiveSnapshot(pool, { bypassCache: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('alias substrate pointer probe timeout')); }, PROBE_TIMEOUT_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const probeResult = await Promise.race([
      pool.query(
        `SELECT 1
           FROM aliases
          WHERE search_snapshot_id = $1
            AND is_suppressed = FALSE
          LIMIT 1`,
        [activeSnapshot.activeSnapshotId],
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('alias substrate row probe timeout')); }, PROBE_TIMEOUT_MS);
      }),
    ]);

    return probeResult.rowCount != null && probeResult.rowCount > 0 ? 'up' : 'down';
  } catch (err) {
    log.warn({ err, probe: 'alias_substrate' }, 'readiness probe failed');
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function buildHealthRouteOptions(
  config: Config,
  runtime: RuntimeHandles,
  watchlistRuntime?: WatchlistRuntimePort | null,
  drinkingWindowPredictor?: DrinkingWindowPredictorPort,
  calibrationStore?: CalibrationStore,
): HealthRouteOptions {
  const expectsRedis = expectsRedisAtStartup(config);
  const watchlistEnabled = isWatchlistEnabled(config);
  const redisRequired = expectsRedis;
  const isProduction = config.nodeEnv === 'production';
  const hasPool = runtime.pool !== undefined;
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
              required: true,
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
      ...(expectsRedis
        ? {
            redis: {
              required: redisRequired,
              check: (): Promise<ReadinessStatus> => probeRedis(runtime.redisClient),
            },
          }
        : {}),
      ...(watchlistEnabled
        ? {
            watchlist_runtime: {
              required: true,
              check: (): Promise<ReadinessStatus> =>
                Promise.resolve(watchlistRuntime?.isRunning() === true ? 'up' : 'down'),
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
            return isProduction ? 'down' : probeSearchSnapshotRuntimeState();
          }
          try {
            await verifySearchSnapshotRuntimeStateLive({
              pool: runtime.pool,
              vespaUrl: config.vespa.url,
              strictHashes: true,
              // T-010/W2: pointer parity is the authoritative "we are serving this snapshot"
              // signal. A drift between pointer and runtime-state file means ops sees one
              // id, the read path serves another.
              requirePointerParity: true,
            });
            return 'up';
          } catch {
            return 'down';
          }
        },
      },
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
                if (config.openai.apiKey !== undefined) {
                  return probeJsonPostEndpoint(`${config.openai.baseUrl}/embeddings`, {
                    model: config.openai.embeddingModel,
                    input: '__healthcheck__',
                  }, { Authorization: `Bearer ${config.openai.apiKey}` });
                }
                // No OpenAI key → embedding unavailable; required probe must fail closed.
                log.warn('embedding readiness: no OPENAI_API_KEY — embedding probe down');
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
              check: (): Promise<ReadinessStatus> =>
                Promise.resolve(
                  drinkingWindowPredictor.modelVersion.startsWith('onnx:') ? 'up' : 'down',
                ),
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
