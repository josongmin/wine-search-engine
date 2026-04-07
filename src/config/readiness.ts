import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import {
  expectsRedisAtStartup,
  isWatchlistEnabled,
} from './watchlist.js';
import { probeJsonPostEndpoint } from '../infrastructure/health/readiness-probes.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type {
  HealthRouteOptions,
  ReadinessStatus,
} from '../interface/http/routes/health.route.js';

async function probePostgres(
  pool: NonNullable<RuntimeHandles['pool']>,
): Promise<ReadinessStatus> {
  try {
    await pool.query('SELECT 1');
    return 'up';
  } catch {
    return 'down';
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
  } catch {
    return 'down';
  }
}

export function buildHealthRouteOptions(
  config: Config,
  runtime: RuntimeHandles,
  watchlistRuntime?: WatchlistRuntimePort | null,
  drinkingWindowPredictor?: DrinkingWindowPredictorPort,
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
              check: async (): Promise<ReadinessStatus> =>
                probeJsonPostEndpoint(`${config.embedding.url}/embeddings`, {
                  model: config.embedding.model,
                  input: '__healthcheck__',
                }),
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
    },
  };
}
