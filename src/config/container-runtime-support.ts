import type { Config } from './env.js';
import { bootstrapLogger } from './bootstrap-logger.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { LLMInjectionJudge } from '../domain/security/service/llm-injection-judge.js';
import type { InjectionJudgePort } from '../domain/security/port/injection-judge.port.js';
import type { JudgmentCachePort } from '../domain/security/port/judgment-cache.port.js';
import { AnthropicLLMInjectionClassifier } from '../infrastructure/adapter/anthropic-llm-injection-classifier.js';
import { CacheService } from '../domain/performance/index.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';
import type { RedisClient } from '../infrastructure/db/redis-client.js';
import { RedisQueryCache } from '../infrastructure/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '../infrastructure/cache/redis-embedding-cache.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';

class RedisJudgmentCacheAdapter implements JudgmentCachePort {
  constructor(
    private readonly redis: RedisClient,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.redis.setEx(key, ttlSeconds, value);
  }
}

class InMemoryJudgmentCacheAdapter implements JudgmentCachePort {
  private readonly store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  setEx(key: string, _ttlSeconds: number, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

export interface RuntimeSupportServices {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
}

export async function buildRuntimeSupportServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<RuntimeSupportServices> {
  const querySanitizer = new QuerySanitizer();
  const { pool, redisClient } = runtime;

  let injectionJudge: InjectionJudgePort | undefined;
  if (config.anthropic.apiKey && !config.killSwitch.injectionJudge) {
    injectionJudge = new LLMInjectionJudge(
      new AnthropicLLMInjectionClassifier(config.anthropic.apiKey, {
        model: config.anthropic.injectionModel,
      }),
      redisClient
        ? new RedisJudgmentCacheAdapter(redisClient)
        : new InMemoryJudgmentCacheAdapter(),
    );
    bootstrapLogger.info(
      { model: config.anthropic.injectionModel, cache: redisClient ? 'redis' : 'memory' },
      '[Container] LLM injection judge (Layer 2) enabled',
    );
    if (!redisClient) {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; using in-memory cache for LLMInjectionJudge',
      );
    }
  }

  let cacheService: CacheService | undefined;
  if (!config.killSwitch.queryCache) {
    if (redisClient) {
      cacheService = new CacheService(
        new RedisQueryCache(redisClient),
        new RedisEmbeddingCache(redisClient),
        5,
        60000,
      );
      bootstrapLogger.warn('[Container] Cache infrastructure initialized');
    } else {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; continuing without cache infrastructure',
      );
    }
  }

  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool) {
    const ltrRegistry = new PgLtrModelRegistry(pool);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ltrModels = await ltrRegistry.getAllModels();
        if (ltrModels.size > 0) {
          bootstrapLogger.warn(
            { ltrModelCount: ltrModels.size },
            '[Container] Loaded LTR models from registry',
          );
        } else {
          bootstrapLogger.warn('[Container] No LTR models found in registry');
        }
        break; // success
      } catch (err) {
        bootstrapLogger.error(
          { err, attempt },
          '[Container] LTR model load failed',
        );
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  const allowHeuristicFallback =
    config.nodeEnv !== 'production' || config.drinkingWindow.allowHeuristicInProduction;

  const drinkingWindowPredictor = new DrinkingWindowPredictor({ allowHeuristicFallback });
  if (config.drinkingWindow.modelDir !== undefined) {
    await drinkingWindowPredictor.load(config.drinkingWindow.modelDir);
    bootstrapLogger.warn(
      { modelVersion: drinkingWindowPredictor.modelVersion },
      '[Container] Drinking-window predictor loaded',
    );
  }
  if (
    config.nodeEnv === 'production'
    && drinkingWindowPredictor.modelVersion.startsWith('heuristic')
    && !config.drinkingWindow.allowHeuristicInProduction
  ) {
    throw new Error(
      'Production startup refuses heuristic-only drinking-window prediction. Set ALLOW_HEURISTIC_DRINKING_WINDOW=true only with explicit approval.',
    );
  }

  return {
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels,
    drinkingWindowPredictor,
  };
}
