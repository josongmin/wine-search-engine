import type { Config } from './env.js';
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
import type { DrinkingWindowPredictorContract } from './container-contracts.js';

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

export interface RuntimeSupportServices {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorContract;
}

export async function buildRuntimeSupportServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<RuntimeSupportServices> {
  const querySanitizer = new QuerySanitizer();
  const { pool, redisClient } = runtime;

  let injectionJudge: InjectionJudgePort | undefined;
  if (config.anthropic.apiKey && !config.killSwitch.injectionJudge) {
    if (redisClient) {
      injectionJudge = new LLMInjectionJudge(
        new AnthropicLLMInjectionClassifier(config.anthropic.apiKey),
        new RedisJudgmentCacheAdapter(redisClient),
      );
    } else {
      console.warn('[Container] Redis unavailable; skipping LLMInjectionJudge initialization');
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
      console.warn('[Container] Cache infrastructure initialized');
    } else {
      console.warn('[Container] Redis unavailable; continuing without cache infrastructure');
    }
  }

  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool) {
    const ltrRegistry = new PgLtrModelRegistry(pool);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ltrModels = await ltrRegistry.getAllModels();
        if (ltrModels.size > 0) {
          console.warn(`[Container] Loaded ${ltrModels.size} LTR models from registry`);
        } else {
          console.warn('[Container] No LTR models found in registry');
        }
        break; // success
      } catch (err) {
        console.error(`[Container] LTR model load attempt ${attempt}/2 failed:`, err);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  return {
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels,
    drinkingWindowPredictor: new DrinkingWindowPredictor(),
  };
}
