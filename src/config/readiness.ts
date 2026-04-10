import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import {
  expectsRedisAtStartup,
  isWatchlistEnabled,
} from './watchlist.js';
import { probeJsonPostEndpoint } from '../infrastructure/health/readiness-probes.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type {
  HealthRouteOptions,
  ReadinessStatus,
} from '../interface/http/routes/health.route.js';
import { bootstrapLogger } from './bootstrap-logger.js';

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

  try {
    await redisClient.ping();
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'redis' }, 'readiness probe failed');
    return 'down';
  }
}

async function probeCalibrationStore(
  calibrationStore: CalibrationStore,
): Promise<ReadinessStatus> {
  try {
    // Use a representative query class to verify the store is reachable.
    await calibrationStore.getCalibrationParams('short_entity');
    return 'up';
  } catch (err) {
    log.warn({ err, probe: 'calibration_store' }, 'readiness probe failed');
    return 'down';
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

  return {
    readiness: {
      ...(runtime.pool
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
        check: async (): Promise<ReadinessStatus> =>
          probeJsonPostEndpoint(`${config.vespa.url}/search/`, {
            yql: 'select * from sources * where true limit 0;',
          }),
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
                // Fall back to self-hosted embedding service URL.
                if (config.embedding.url === undefined) {
                  log.warn('embedding readiness: no OPENAI_API_KEY and no EMBEDDING_SERVICE_URL — no embedding configured, reporting down');
                  return 'down';
                }
                return probeJsonPostEndpoint(`${config.embedding.url}/embeddings`, {
                  model: config.embedding.model,
                  input: '__healthcheck__',
                });
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
                  drinkingWindowPredictor.modelVersion.startsWith('heuristic') ? 'down' : 'up',
                ),
            },
          }
        : {}),
      ...(config.reranker.url !== undefined
        ? {
            reranker: {
              required: false,
              check: async (): Promise<ReadinessStatus> =>
                probeJsonPostEndpoint(`${config.reranker.url}/rerank`, {
                  query: '__healthcheck__',
                  texts: ['__healthcheck__'],
                }),
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
