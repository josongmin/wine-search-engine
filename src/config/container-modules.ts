import type { Pool } from 'pg';
import { PgBlockingAdapter } from '../infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../infrastructure/adapter/pg-calibration-store.js';
import { PgAmbiguityDictionary } from '../infrastructure/adapter/pg-ambiguity-dictionary.js';
import { PgThresholdStore } from '../infrastructure/adapter/pg-threshold-store.js';
import { PgAliasMatcher } from '../infrastructure/adapter/pg-alias-matcher.js';
import { FileMappingTableAdapter } from '../infrastructure/adapter/file-mapping-table.js';
import { HttpLearnedMatcherAdapter } from '../infrastructure/adapter/http-learned-matcher.js';
import { VespaClient } from '../infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../infrastructure/vespa/vespa-search-index.js';
import { HttpEmbeddingService } from '../infrastructure/vespa/embedding-service.js';
import { HttpCrossEncoderReranker } from '../infrastructure/vespa/reranker.js';
import { VespaAnchorResolver } from '../infrastructure/vespa/vespa-anchor-resolver.js';
import { VespaSimilarRetrieval } from '../infrastructure/vespa/vespa-similar-retrieval.js';
import { VespaCandidateAttributes } from '../infrastructure/vespa/vespa-candidate-attributes.js';
import { Planner } from '../domain/query/service/planner.js';
import { AnchorExtractor } from '../domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../domain/query/service/expansion-builder.js';
import { Resolver } from '../domain/resolver/service/resolver.js';
import { Blocker } from '../domain/resolver/service/blocker.js';
import { CandidateScorer } from '../domain/resolver/service/candidate-scorer.js';
import { AmbiguityClassifier } from '../domain/resolver/service/ambiguity-classifier.js';
import { Calibrator } from '../domain/resolver/service/calibrator.js';
import { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../domain/retrieval/service/fusion.js';
import { Ranker } from '../domain/ranking/service/ranker.js';
import { SignalComputer } from '../domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../domain/ranking/service/evidence-mapper.js';
import { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import { ResponseBuilder } from '../domain/response/service/response-builder.js';
import { ConfidenceRefusalPolicy } from '../domain/decision/service/confidence-refusal.js';
import { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import { SearchUseCase } from '../application/search/search.usecase.js';
import { ReplayUseCase } from '../application/search/replay.usecase.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
import { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';
import { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { Config } from './env.js';
import type { AmbiguityDictionary } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../domain/resolver/port/blocking.port.js';
import type {
  CalibrationStore,
  CalibrationParams,
} from '../domain/resolver/port/calibration-store.port.js';
import type { SearchIndexPort } from '../domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import {
  DEFAULT_THRESHOLD_PROFILE,
  type ThresholdProfileV1,
} from '../domain/query/model/threshold-profile.js';
import type { EntityId, QueryClass } from '../domain/shared/types/index.js';
import type {
  AliasMatcher,
  AliasMatchResult,
} from '../domain/query/service/anchor-extractor.js';
import { NLMapper } from '../domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../domain/attribute/port/mapping-table.port.js';
import type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../domain/mixed/port/mixed-query.port.js';
import { AnchorProfiler } from '../domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../domain/mixed/service/constraint-overlay.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { LearnedMatcherPort } from '../domain/resolver/port/learned-matcher.port.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { LLMInjectionJudge } from '../domain/security/service/llm-injection-judge.js';
import { getRedisClient } from '../infrastructure/db/redis-client.js';
import { RedisQueryCache } from '../infrastructure/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '../infrastructure/cache/redis-embedding-cache.js';
import { CacheService } from '../domain/performance/index.js';
import { WineToolExecutor } from '../interface/claude-tools/tool-executor.js';
import { AdaptiveToolExecutor } from '../interface/claude-tools/adaptive-tool-executor.js';
import { RedisWatchlistPublisher } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import { RedisWatchlistSubscriber } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import { PgGoldSetStore } from '../infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../infrastructure/adapter/pg-eval-result-store.js';
import { SearchPipelineEvaluator } from '../infrastructure/adapter/search-pipeline-evaluator.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';

class StubBlockingPort implements BlockingPort {
  block(
    _query: string,
    _normalizedQuery: string,
    _limit?: number,
  ): Promise<readonly EntityId[]> {
    return Promise.resolve([]);
  }
}

class StubCalibrationStore implements CalibrationStore {
  getCalibrationParams(_queryClass: QueryClass): Promise<CalibrationParams | null> {
    return Promise.resolve(null);
  }

  save(_queryClass: QueryClass, _params: CalibrationParams): Promise<void> {
    return Promise.resolve();
  }
}

class StubEmbeddingService implements EmbeddingServicePort {
  embed(_text: string): Promise<readonly number[]> {
    return Promise.resolve(new Array<number>(128).fill(0));
  }

  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return Promise.resolve(texts.map(() => new Array<number>(128).fill(0)));
  }
}

class StubAmbiguityDictionary implements AmbiguityDictionary {
  isKnownAmbiguous(_term: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  getAmbiguityInfo(
    _term: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    return Promise.resolve(null);
  }
}

class StubAliasMatcher implements AliasMatcher {
  findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve([]);
  }
}

class StubThresholdStore implements ThresholdStore {
  getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return Promise.resolve(DEFAULT_THRESHOLD_PROFILE);
  }

  getDefault(): Promise<ThresholdProfileV1> {
    return Promise.resolve(DEFAULT_THRESHOLD_PROFILE);
  }

  save(_profile: ThresholdProfileV1): Promise<void> {
    return Promise.resolve();
  }
}

export interface CoreContainerServices {
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly snapshotVersions: SnapshotVersions;
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: LLMInjectionJudge | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictor;
}

export interface FeatureContainerServices {
  readonly searchUseCase: SearchUseCase;
  readonly replayUseCase: ReplayUseCase;
  readonly interpretUseCase: InterpretUseCase;
  readonly resolveUseCase: ResolveUseCase;
  readonly hybridUseCase: HybridUseCase;
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
  readonly batchSearchUseCase: BatchSearchUseCase;
  readonly wineToolExecutor: WineToolExecutor;
  readonly adaptiveToolExecutor: AdaptiveToolExecutor;
  readonly watchlistPublisher: RedisWatchlistPublisher;
  readonly watchlistSubscriber: RedisWatchlistSubscriber;
  readonly webhookDelivery: WebhookDelivery;
  readonly evalRunner: EvalRunner | null;
}

export async function buildCoreContainerServices(
  config: Config,
  pool?: Pool,
): Promise<CoreContainerServices> {
  const vespaClient = new VespaClient(
    config.vespa.url,
    'wine',
    'wine_entity',
  );
  const searchIndex: SearchIndexPort = new VespaSearchIndex(vespaClient);

  const embeddingService: EmbeddingServicePort = config.killSwitch.denseRetrieval
    ? new StubEmbeddingService()
    : new HttpEmbeddingService();
  const reranker = new HttpCrossEncoderReranker();

  const blockingPort: BlockingPort = pool
    ? new PgBlockingAdapter(pool)
    : new StubBlockingPort();
  const calibrationStore: CalibrationStore = pool
    ? new PgCalibrationStore(pool)
    : new StubCalibrationStore();
  const ambiguityDict: AmbiguityDictionary = pool
    ? new PgAmbiguityDictionary(pool)
    : new StubAmbiguityDictionary();
  const thresholdStore: ThresholdStore = pool
    ? new PgThresholdStore(pool)
    : new StubThresholdStore();
  const aliasMatcher: AliasMatcher = !config.killSwitch.aliasOverlay && pool
    ? new PgAliasMatcher(pool)
    : new StubAliasMatcher();

  const mappingTable: MappingTablePort = new FileMappingTableAdapter();
  const anchorResolver: AnchorResolverPort = new VespaAnchorResolver(searchIndex);
  const similarRetrieval: SimilarRetrievalPort = new VespaSimilarRetrieval(searchIndex);
  const candidateAttributes: CandidateAttributePort = new VespaCandidateAttributes(searchIndex);

  const learnedMatcher: LearnedMatcherPort | undefined =
    config.learnedMatcher.url !== undefined
      ? new HttpLearnedMatcherAdapter(config.learnedMatcher.url)
      : undefined;

  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const nlMapper = new NLMapper(mappingTable);
  const queryPlanner = new Planner(ambiguityDict, anchorExtractor, expansionBuilder, nlMapper);

  const blocker = new Blocker(blockingPort);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(
    blocker,
    candidateScorer,
    ambiguityClassifier,
    calibrator,
    learnedMatcher,
  );

  let cacheService: CacheService | undefined;
  if (!config.killSwitch.queryCache) {
    try {
      const redisClient = await getRedisClient();
      cacheService = new CacheService(
        new RedisQueryCache(redisClient),
        new RedisEmbeddingCache(redisClient),
        5,
        60000,
      );
      console.warn('[Container] Cache infrastructure initialized');
    } catch (err) {
      console.warn('[Container] Failed to initialize caches; continuing without:', err);
    }
  }

  const candidatePool = new CandidatePoolService(
    searchIndex,
    embeddingService,
    new FusionService(),
    cacheService,
    config.embedding.model,
  );

  const ranker = new Ranker(
    new SignalComputer(),
    new ScoreAggregator(),
    new EvidenceMapper(),
    reranker,
    { rerankBlendScale: config.reranker.blendScale },
  );

  const confidenceRefusalPolicy = config.confidenceRefusal.threshold !== undefined
    ? new ConfidenceRefusalPolicy(config.confidenceRefusal.threshold)
    : undefined;

  const decisionEngine = new DecisionEngine(thresholdStore, confidenceRefusalPolicy);
  const responseBuilder = new ResponseBuilder();
  const mixedSolver = new MixedSolver(
    anchorResolver,
    new AnchorProfiler(),
    similarRetrieval,
    candidateAttributes,
    new SimilarityScorer(),
    new ConstraintOverlay(),
    ranker,
  );

  const snapshotVersions: SnapshotVersions = {
    modelVersions: { embedding: config.embedding.model },
    indexVersions: { wine_content: config.vespa.contentCluster },
  };

  const querySanitizer = new QuerySanitizer();
  let injectionJudge: LLMInjectionJudge | undefined;
  if (config.anthropic.apiKey && !config.killSwitch.injectionJudge) {
    try {
      injectionJudge = new LLMInjectionJudge(
        config.anthropic.apiKey,
        await getRedisClient(),
      );
    } catch (err) {
      console.error('[Container] Failed to initialize LLMInjectionJudge:', err);
    }
  }

  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool) {
    try {
      const ltrRegistry = new PgLtrModelRegistry(pool);
      ltrModels = await ltrRegistry.getAllModels();
      if (ltrModels.size > 0) {
        console.warn(`[Container] Loaded ${ltrModels.size} LTR models from registry`);
      }
    } catch (err) {
      console.warn('[Container] Failed to load LTR models; continuing without:', err);
    }
  }

  return {
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    snapshotVersions,
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels,
    drinkingWindowPredictor: new DrinkingWindowPredictor(),
  };
}

export async function buildFeatureContainerServices(
  config: Config,
  core: CoreContainerServices,
  pool?: Pool,
): Promise<FeatureContainerServices> {
  const drinkingWindowUseCase = new DrinkingWindowUseCase(core.drinkingWindowPredictor);

  const searchUseCase = new SearchUseCase({
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    snapshotVersions: core.snapshotVersions,
    querySanitizer: core.querySanitizer,
    injectionJudge: core.injectionJudge,
    drinkingWindow: drinkingWindowUseCase,
    cacheService: core.cacheService,
    ltrModels: core.ltrModels,
  });

  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);
  const replayUseCase = new ReplayUseCase({
    searchUseCase,
    snapshotVersions: core.snapshotVersions,
  });
  const interpretUseCase = new InterpretUseCase({
    queryPlanner: core.queryPlanner,
  });
  const resolveUseCase = new ResolveUseCase({
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
  });
  const hybridUseCase = new HybridUseCase({
    queryPlanner: core.queryPlanner,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    snapshotVersions: core.snapshotVersions,
  });

  const wineToolExecutor = new WineToolExecutor({
    searchUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
  });
  const adaptiveToolExecutor = new AdaptiveToolExecutor(wineToolExecutor);

  const watchlistPublisher = new RedisWatchlistPublisher();
  const watchlistSubscriber = new RedisWatchlistSubscriber();
  const webhookDelivery = config.watchlist.webhookSecret
    ? new WebhookDelivery(config.watchlist.webhookSecret)
    : new WebhookDelivery('dummy-secret-min-16-chars!!!');
  if (!config.watchlist.webhookSecret) {
    console.warn('[Container] WEBHOOK_SECRET not configured; watchlist webhooks disabled');
  }

  let evalRunner: EvalRunner | null = null;
  if (pool) {
    evalRunner = new EvalRunner(
      new PgGoldSetStore(pool),
      new PgEvalResultStore(pool),
      new SearchPipelineEvaluator(searchUseCase),
    );
    console.warn('[Container] Evaluation infrastructure initialized');
  } else {
    console.warn('[Container] Evaluation infrastructure skipped (Postgres pool not available)');
  }

  return {
    searchUseCase,
    replayUseCase,
    interpretUseCase,
    resolveUseCase,
    hybridUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase,
    wineToolExecutor,
    adaptiveToolExecutor,
    watchlistPublisher,
    watchlistSubscriber,
    webhookDelivery,
    evalRunner,
  };
}
