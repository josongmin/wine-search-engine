import type { Config } from './env.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { LLMInjectionJudge } from '../domain/security/service/llm-injection-judge.js';
import type { InjectionJudgePort } from '../domain/security/port/injection-judge.port.js';
import type { JudgmentCachePort } from '../domain/security/port/judgment-cache.port.js';
import { AnthropicLLMInjectionClassifier } from '../infrastructure/adapter/anthropic-llm-injection-classifier.js';
import { OpenAiLLMInjectionClassifier } from '../infrastructure/adapter/openai-llm-injection-classifier.js';
import { CacheService } from '../domain/performance/index.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';
import type { RedisClient } from '../infrastructure/db/redis-client.js';
import { RedisQueryCache } from '../infrastructure/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '../infrastructure/cache/redis-embedding-cache.js';
import { RedisPhraseCache } from '../infrastructure/cache/redis-phrase-cache.js';
import { RedisCircuitBreakerWrapper } from '../infrastructure/db/redis-circuit-breaker-wrapper.js';
import type { PhraseCachePort } from '../domain/attribute/port/phrase-cache.port.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import { loadRuntimeLtrModels } from '../infrastructure/adapter/runtime-ltr-model-loader.js';
import { LTR_FEATURE_SCHEMA_HASH } from '../domain/ranking/service/lambdamart-ranker.js';
import { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import { DeterministicDrinkingWindowPredictor } from '../infrastructure/ml/deterministic-drinking-window-predictor.js';
import { loadSearchSnapshotRuntimeState } from '../infrastructure/health/search-snapshot-readiness.js';
import { resolveActiveSnapshot } from '../infrastructure/db/active-snapshot-resolver.js';
import { isLtrServingEnabled } from './ltr-serving-mode.js';

/** Consecutive cache failures before opening circuit (matches CacheService default). */
const CACHE_CIRCUIT_BREAKER_THRESHOLD_DEFAULT = 5;
/** Milliseconds until circuit half-closes after open (matches CacheService default). */
const CACHE_CIRCUIT_BREAKER_RESET_MS_DEFAULT = 60_000;

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
  private static readonly MAX_ENTRIES = 2_000;
  // Map iteration is insertion-order; we manually re-insert on access to
  // implement true LRU semantics (delete-then-set moves the entry to the tail).
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  /** Removes TTL-expired rows so stale allow/deny decisions cannot accumulate unbounded. */
  private pruneExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get(key: string): Promise<string | null> {
    this.pruneExpiredEntries();
    const entry = this.store.get(key);
    if (entry === undefined) return Promise.resolve(null);
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    // LRU: refresh recency by reinserting at the tail.
    this.store.delete(key);
    this.store.set(key, entry);
    return Promise.resolve(entry.value);
  }

  setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.pruneExpiredEntries();
    // Always remove existing entry first so updates also refresh recency.
    this.store.delete(key);
    // Evict oldest entry when at capacity.
    if (this.store.size >= InMemoryJudgmentCacheAdapter.MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }
}

export interface RuntimeSupportServices {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly phraseCache?: PhraseCachePort | undefined;
  readonly runtimeReadiness: RuntimeReadinessSnapshot;
}

export type RuntimeReadinessIssueKind =
  | 'unconfigured'
  | 'disabled'
  | 'missing_or_invalid'
  | 'pg_pool_missing'
  | 'active_snapshot_unavailable'
  | 'empty_registry'
  | 'load_failed'
  | 'not_selected';

export type RuntimeLtrEffectiveSource =
  | 'registry'
  | 'runtime_artifact'
  | 'none';

export interface RuntimeReadinessSnapshot {
  readonly drinkingWindowPredictor: {
    readonly configured: boolean;
    readonly loaded: boolean;
    readonly modelVersion: string;
    readonly issue?: RuntimeReadinessIssueKind | undefined;
  };
  readonly runtimeLtrArtifact: {
    readonly configured: boolean;
    readonly loaded: boolean;
    readonly modelCount?: number | undefined;
    readonly issue?: RuntimeReadinessIssueKind | undefined;
  };
  readonly ltrModels: {
    readonly registry: {
      readonly configured: boolean;
      readonly loaded: boolean;
      readonly searchSnapshotId?: string | undefined;
      readonly modelCount?: number | undefined;
      readonly issue?: RuntimeReadinessIssueKind | undefined;
    };
    readonly artifact: {
      readonly configured: boolean;
      readonly loaded: boolean;
      readonly selected: boolean;
      readonly modelCount?: number | undefined;
      readonly issue?: RuntimeReadinessIssueKind | undefined;
    };
    readonly effective: {
      readonly source: RuntimeLtrEffectiveSource;
      readonly loaded: boolean;
      readonly required: boolean;
      readonly modelCount: number;
      readonly searchSnapshotId?: string | undefined;
      readonly issue?: RuntimeReadinessIssueKind | undefined;
    };
  };
  readonly benchmarkPersistence: {
    readonly configured: boolean;
    readonly available: boolean;
    readonly issue?: RuntimeReadinessIssueKind | undefined;
  };
}

export async function buildRuntimeSupportServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<RuntimeSupportServices> {
  const querySanitizer = new QuerySanitizer();
  const { pool, redisClient } = runtime;
  const ltrServingEnabled = isLtrServingEnabled();

  // W2-BUG-03: Instantiate the Redis circuit breaker wrapper so the 'redis'
  // breaker is registered in globalCircuitBreakerRegistry at startup.
  // The wrapper gates get/set/del/ping on the hot path; the existing
  // CacheService CB covers query/embedding cache, and RedisCache swallows
  // errors for phrase cache — together they give full Redis resilience coverage.
  if (redisClient) {
    // Constructing the wrapper registers the CB; we keep a reference so it is
    // not GC'd, and we call ping() once to verify connectivity at startup.
    const redisCbWrapper = new RedisCircuitBreakerWrapper(redisClient);
    void redisCbWrapper.ping().then((ok) => {
      if (!ok) {
        bootstrapLogger.warn('[Container] Redis ping failed at startup — circuit breaker registered but Redis may be degraded');
      } else {
        bootstrapLogger.info('[Container] Redis circuit breaker registered (ping OK)');
      }
    });
  }

  let injectionJudge: InjectionJudgePort | undefined;
  if (!config.killSwitch.injectionJudge) {
    const judgmentCache = redisClient
      ? new RedisJudgmentCacheAdapter(redisClient)
      : new InMemoryJudgmentCacheAdapter();
    const provider = config.queryEntrySecurity.injectionProvider;

    const openAiInjectionApiKey = config.openai.apiKeys[0];
    if (provider === 'openai' && openAiInjectionApiKey !== undefined) {
      injectionJudge = new LLMInjectionJudge(
        new OpenAiLLMInjectionClassifier({
          apiKeys: config.openai.apiKeys,
          baseUrl: config.openai.baseUrl,
          model: config.openai.injectionModel,
          httpTimeoutMs: config.openai.injectionHttpTimeoutMs,
        }),
        judgmentCache,
      );
      bootstrapLogger.info(
        { provider, model: config.openai.injectionModel, cache: redisClient ? 'redis' : 'memory' },
        '[Container] LLM injection judge (Layer 2) enabled',
      );
    } else if (provider === 'anthropic' && config.anthropic.apiKey !== undefined) {
      injectionJudge = new LLMInjectionJudge(
        new AnthropicLLMInjectionClassifier(config.anthropic.apiKey, {
          model: config.anthropic.injectionModel,
        }),
        judgmentCache,
      );
      bootstrapLogger.info(
        { provider, model: config.anthropic.injectionModel, cache: redisClient ? 'redis' : 'memory' },
        '[Container] LLM injection judge (Layer 2) enabled',
      );
    }

    if (injectionJudge !== undefined && !redisClient) {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; using in-memory cache for LLMInjectionJudge',
      );
    }
  }
  if (!config.killSwitch.injectionJudge && injectionJudge === undefined) {
    // Loud warning: Layer 2 prompt-injection defense is silently disabled
    // because the selected provider key is unset. Production env validation throws
    // for this combination (env.ts) but dev/test silently skip — historically
    // this hid the SQL injection bypass that the SOTA++ benchmark caught.
    // The warning makes the gap visible at boot.
    bootstrapLogger.warn(
      {
        nodeEnv: config.nodeEnv,
        injectionProvider: config.queryEntrySecurity.injectionProvider,
        killSwitchInjectionJudge: config.killSwitch.injectionJudge,
      },
      '[SECURITY] Layer 2 LLM injection judge DISABLED — '
      + 'the selected provider API key is unset. Layer 1 sanitizer is the only line of defense. '
      + 'Set a provider API key or KILL_SWITCH_INJECTION_JUDGE=true to silence this warning.',
    );
  }

  let cacheService: CacheService | undefined;
  if (!config.killSwitch.queryCache) {
    if (redisClient) {
      cacheService = new CacheService(
        new RedisQueryCache(redisClient),
        new RedisEmbeddingCache(redisClient),
        CACHE_CIRCUIT_BREAKER_THRESHOLD_DEFAULT,
        CACHE_CIRCUIT_BREAKER_RESET_MS_DEFAULT,
      );
      bootstrapLogger.info('[Container] Cache infrastructure initialized');
    } else {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; continuing without cache infrastructure',
      );
    }
  }

  let discoveredRegistryLtrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  let ltrRegistrySearchSnapshotId: string | undefined;
  let ltrRegistryIssue: RuntimeReadinessIssueKind | undefined = pool === undefined
    ? 'pg_pool_missing'
    : undefined;
  let ltrRequired = ltrServingEnabled;
  let runtimeLtrArtifactModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (ltrServingEnabled && pool) {
    const ltrRegistry = new PgLtrModelRegistry(pool);
    try {
      const runtimeState = await loadSearchSnapshotRuntimeState();
      if (runtimeState.quality.blockers.length > 0) {
        bootstrapLogger.warn(
          { blockers: runtimeState.quality.blockers },
          '[Container] Search snapshot runtime state reports quality blockers',
        );
      }
    } catch (err) {
      bootstrapLogger.warn(
        { err },
        '[Container] Search snapshot runtime state unavailable; LTR requiredness unknown',
      );
    }

    try {
      ltrRegistrySearchSnapshotId = (await resolveActiveSnapshot(pool, { bypassCache: true })).activeSnapshotId;
    } catch (err) {
      ltrRegistryIssue = 'active_snapshot_unavailable';
      bootstrapLogger.warn(
        { err },
        '[Container] Active search snapshot unavailable; snapshot-bound LTR load skipped',
      );
    }

    for (let attempt = 1; ltrRegistrySearchSnapshotId !== undefined && attempt <= 2; attempt++) {
      try {
        discoveredRegistryLtrModels = await ltrRegistry.getAllModels(ltrRegistrySearchSnapshotId);
        if (discoveredRegistryLtrModels.size > 0) {
          ltrRegistryIssue = undefined;
          for (const [queryClass, model] of discoveredRegistryLtrModels.entries()) {
            if (model.featureSchemaHash !== LTR_FEATURE_SCHEMA_HASH) {
              throw new Error(
                `LTR model ${queryClass} feature schema mismatch at startup: model=${model.featureSchemaHash}, current=${LTR_FEATURE_SCHEMA_HASH}`,
              );
            }
          }
          bootstrapLogger.info(
            {
              ltrModelCount: discoveredRegistryLtrModels.size,
              featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
              searchSnapshotId: ltrRegistrySearchSnapshotId,
            },
            '[Container] Loaded LTR models from registry',
          );
          for (const [queryClass, model] of discoveredRegistryLtrModels.entries()) {
            const weightDim = model.weights.length;
            bootstrapLogger.info(
              { queryClass, weightDim, featureSchemaHash: model.featureSchemaHash },
              '[Container] LTR model weight dimension at serve time',
            );
          }
        } else {
          ltrRegistryIssue = 'empty_registry';
          bootstrapLogger.warn(
            { searchSnapshotId: ltrRegistrySearchSnapshotId },
            '[Container] No snapshot-bound LTR models found in registry',
          );
        }
        break; // success
      } catch (err) {
        bootstrapLogger.error(
          { err, attempt },
          '[Container] LTR model load failed',
        );
        ltrRegistryIssue = 'load_failed';
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  if (ltrServingEnabled && config.runtimeLtrModelsPath !== undefined) {
    runtimeLtrArtifactModels = await loadRuntimeLtrModels(config.runtimeLtrModelsPath);
    if ((discoveredRegistryLtrModels === undefined || discoveredRegistryLtrModels.size === 0)
      && runtimeLtrArtifactModels !== undefined) {
      if (discoveredRegistryLtrModels === undefined) {
        bootstrapLogger.info(
          { source: 'runtime-file', ltrModelCount: runtimeLtrArtifactModels.size },
          '[Container] Loaded LTR models from runtime artifact',
        );
      } else {
        bootstrapLogger.warn(
          {
            source: 'runtime-file',
            path: config.runtimeLtrModelsPath,
            sourceCount: discoveredRegistryLtrModels.size,
          },
          '[Container] PG returned no active LTR models; switched to runtime artifact fallback',
        );
      }
    }
  }

  bootstrapLogger.info(
    {
      enabled: ltrServingEnabled,
      registryModelCount: discoveredRegistryLtrModels?.size ?? 0,
      runtimeArtifactModelCount: runtimeLtrArtifactModels?.size ?? 0,
    },
    '[Container] LTR serving disabled; startup skips model discovery and Ranker wiring',
  );

  let drinkingWindowPredictor: DrinkingWindowPredictorPort =
    new DeterministicDrinkingWindowPredictor();
  bootstrapLogger.info(
    { modelVersion: drinkingWindowPredictor.modelVersion },
    '[Container] Drinking-window predictor loaded (deterministic default)',
  );
  if (config.drinkingWindow.modelDir !== undefined) {
    const onnxPredictor = new DrinkingWindowPredictor();
    await onnxPredictor.load(config.drinkingWindow.modelDir);
    drinkingWindowPredictor = onnxPredictor;
    bootstrapLogger.info(
      { modelVersion: drinkingWindowPredictor.modelVersion },
      '[Container] Drinking-window predictor upgraded to ONNX runtime',
    );
  }

  // Phrase cache for LlmNLMapper. Optional: when Redis is unavailable we
  // simply pay the LLM cost on every miss instead of using a Map (which would
  // not survive process restarts and would not be shared across replicas).
  let phraseCache: PhraseCachePort | undefined;
  if (config.openai.llmQueryInterpreter) {
    if (redisClient) {
      phraseCache = new RedisPhraseCache(redisClient);
      bootstrapLogger.info('[Container] LLM phrase cache (Redis) enabled');
    } else {
      bootstrapLogger.warn(
        '[Container] LLM_QUERY_INTERPRETER=true but Redis is unavailable — phrase cache disabled, every miss will pay the full LLM cost',
      );
    }
  }

  const runtimeReadiness: RuntimeReadinessSnapshot = {
    drinkingWindowPredictor: {
      configured: true,
      loaded: true,
      modelVersion: drinkingWindowPredictor.modelVersion,
    },
    runtimeLtrArtifact: {
      configured: config.runtimeLtrModelsPath !== undefined,
      loaded: runtimeLtrArtifactModels !== undefined,
      ...(runtimeLtrArtifactModels !== undefined
        ? { modelCount: runtimeLtrArtifactModels.size }
        : {}),
      ...(!ltrServingEnabled
        ? { issue: 'disabled' as const }
        : config.runtimeLtrModelsPath === undefined
        ? { issue: 'unconfigured' as const }
        : runtimeLtrArtifactModels === undefined
          ? { issue: 'missing_or_invalid' as const }
          : {}),
    },
    ltrModels: {
      registry: {
        configured: ltrServingEnabled && pool !== undefined,
        loaded: discoveredRegistryLtrModels !== undefined && discoveredRegistryLtrModels.size > 0,
        ...(ltrRegistrySearchSnapshotId !== undefined
          ? { searchSnapshotId: ltrRegistrySearchSnapshotId }
          : {}),
        ...(discoveredRegistryLtrModels !== undefined
          ? { modelCount: discoveredRegistryLtrModels.size }
          : {}),
        ...(!ltrServingEnabled
          ? { issue: 'disabled' as const }
          : ltrRegistryIssue !== undefined
          ? { issue: ltrRegistryIssue }
          : {}),
      },
      artifact: {
        configured: ltrServingEnabled && config.runtimeLtrModelsPath !== undefined,
        loaded: runtimeLtrArtifactModels !== undefined,
        selected: false,
        ...(runtimeLtrArtifactModels !== undefined
          ? { modelCount: runtimeLtrArtifactModels.size }
          : {}),
        ...(!ltrServingEnabled
          ? { issue: 'disabled' as const }
          : config.runtimeLtrModelsPath === undefined
          ? { issue: 'unconfigured' as const }
          : runtimeLtrArtifactModels === undefined
            ? { issue: 'missing_or_invalid' as const }
            : { issue: 'not_selected' as const }),
      },
      effective: {
        source: 'none',
        loaded: false,
        required: ltrServingEnabled && ltrRequired,
        modelCount: 0,
        issue: 'disabled',
      },
    },
    benchmarkPersistence: {
      configured: config.eval.runAtStartup,
      available: config.eval.runAtStartup ? pool !== undefined : false,
      ...(config.eval.runAtStartup
        ? (pool !== undefined ? {} : { issue: 'pg_pool_missing' as const })
        : { issue: 'unconfigured' as const }),
    },
  };

  return {
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels: undefined,
    drinkingWindowPredictor,
    ...(phraseCache !== undefined ? { phraseCache } : {}),
    runtimeReadiness,
  };
}
