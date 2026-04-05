import type { Pool } from 'pg';
import type { Config } from './env.js';
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
import type { AmbiguityDictionary } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../domain/resolver/port/blocking.port.js';
import type { CalibrationStore, CalibrationParams } from '../domain/resolver/port/calibration-store.port.js';
import type { SearchIndexPort } from '../domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../domain/query/model/threshold-profile.js';
import type { ThresholdProfileV1 } from '../domain/query/model/threshold-profile.js';
import type { EntityId, QueryClass } from '../domain/shared/types/index.js';
import type { AliasMatcher, AliasMatchResult } from '../domain/query/service/anchor-extractor.js';
import { NLMapper } from '../domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../domain/attribute/port/mapping-table.port.js';
import type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../domain/mixed/service/mixed-solver.js';
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

/**
 * The DI container — holds all wired domain services and use cases.
 */
export interface Container {
  // Domain services
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;

  // Use cases
  readonly searchUseCase: SearchUseCase;
  readonly replayUseCase: ReplayUseCase;
  readonly interpretUseCase: InterpretUseCase;
  readonly resolveUseCase: ResolveUseCase;
  readonly hybridUseCase: HybridUseCase;
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
  readonly batchSearchUseCase: BatchSearchUseCase;

  // ML infrastructure
  readonly drinkingWindowPredictor: DrinkingWindowPredictor;

  // Epic 17.2: Claude tool integration
  readonly wineToolExecutor: WineToolExecutor;
  readonly adaptiveToolExecutor: AdaptiveToolExecutor;

  // Epic 17.1: Watchlist infrastructure
  readonly watchlistPublisher: InstanceType<typeof RedisWatchlistPublisher>;
  readonly watchlistSubscriber: InstanceType<typeof RedisWatchlistSubscriber>;
  readonly webhookDelivery: InstanceType<typeof WebhookDelivery>;
}

// ────────────────────────────────────────────────────────────────
// Minimal stub adapters — used only when real infrastructure is
// unavailable (e.g. integration tests without a live database).
// ────────────────────────────────────────────────────────────────

/** Stub BlockingPort: returns no candidates. */
class StubBlockingPort implements BlockingPort {
  block(
    _query: string,
    _normalizedQuery: string,
    _limit?: number,
  ): Promise<readonly EntityId[]> {
    return Promise.resolve([]);
  }
}

/** Stub CalibrationStore: returns null (no trained params). */
class StubCalibrationStore implements CalibrationStore {
  getCalibrationParams(_queryClass: QueryClass): Promise<CalibrationParams | null> {
    return Promise.resolve(null);
  }
  save(_queryClass: QueryClass, _params: CalibrationParams): Promise<void> {
    return Promise.resolve();
  }
}

/** Stub EmbeddingServicePort: returns zero vectors. */
class StubEmbeddingService implements EmbeddingServicePort {
  embed(_text: string): Promise<readonly number[]> {
    return Promise.resolve(new Array<number>(128).fill(0));
  }
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return Promise.resolve(texts.map(() => new Array<number>(128).fill(0)));
  }
}

/** Stub AmbiguityDictionary: reports nothing as ambiguous. */
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

/** Stub AliasMatcher: returns no matches. */
class StubAliasMatcher implements AliasMatcher {
  findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve([]);
  }
}

/** Stub ThresholdStore: returns the default profile. */
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

/**
 * Creates and wires the full DI container.
 *
 * Real infrastructure adapters are used wherever the runtime supports them:
 * - Vespa search index (always, using VESPA_URL)
 * - HTTP embedding service (unless KILL_SWITCH_DENSE_RETRIEVAL=true)
 * - HTTP cross-encoder reranker (always)
 * - Vespa-backed mixed-query adapters (always)
 * - PostgreSQL-backed adapters when `pool` is provided
 * - File-backed NL mapping table (always, falls back gracefully if file absent)
 * - HTTP learned matcher when LEARNED_MATCHER_SERVICE_URL is set
 *
 * Stub fallbacks ensure the application starts cleanly without external
 * services (e.g. in CI or local development without a Vespa/Postgres stack).
 *
 * @param _config - Application configuration.
 * @param pool    - Optional Postgres pool.  Provide in production.
 * @returns The fully wired container.
 */
export async function createContainer(_config: Config, pool?: Pool): Promise<Container> {
  // ── Vespa ──────────────────────────────────────────────────────────────────
  const vespaClient = new VespaClient(
    _config.vespa.url,
    'wine',
    'wine_entity',
  );
  const searchIndex: SearchIndexPort = new VespaSearchIndex(vespaClient);

  // ── Embedding (kill-switch guarded) ───────────────────────────────────────
  const embeddingService: EmbeddingServicePort = _config.killSwitch.denseRetrieval
    ? new StubEmbeddingService()
    : new HttpEmbeddingService();

  // ── Cross-encoder reranker ─────────────────────────────────────────────────
  const reranker = new HttpCrossEncoderReranker();

  // ── Postgres-backed adapters (real when pool is present) ──────────────────
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

  // Alias overlay is disabled when KILL_SWITCH_ALIAS_OVERLAY=true (RFC-015 §7).
  const aliasMatcher: AliasMatcher = !_config.killSwitch.aliasOverlay && pool
    ? new PgAliasMatcher(pool)
    : new StubAliasMatcher();

  // ── File-backed mapping table (graceful fallback if data file absent) ──────
  const mappingTable: MappingTablePort = new FileMappingTableAdapter();

  // ── Vespa-backed mixed-query adapters ─────────────────────────────────────
  const anchorResolver: AnchorResolverPort = new VespaAnchorResolver(searchIndex);
  const similarRetrieval: SimilarRetrievalPort = new VespaSimilarRetrieval(searchIndex);
  const candidateAttributes: CandidateAttributePort = new VespaCandidateAttributes(searchIndex);

  // ── Optional learned matcher (RFC-006 §5.2) ───────────────────────────────
  const learnedMatcher: LearnedMatcherPort | undefined =
    _config.learnedMatcher.url !== undefined
      ? new HttpLearnedMatcherAdapter(_config.learnedMatcher.url)
      : undefined;

  // ── Domain services — query planning ──────────────────────────────────────
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const nlMapper = new NLMapper(mappingTable);
  const queryPlanner = new Planner(ambiguityDict, anchorExtractor, expansionBuilder, nlMapper);

  // ── Domain services — entity resolution ───────────────────────────────────
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

  // ── Cache infrastructure (Wave 4, Phase 3) ───────────────────────────────
  let cacheService: CacheService | undefined;

  // Initialize unified cache service with Redis backends if available
  if (!_config.killSwitch.queryCache) {
    try {
      const redisClient = await getRedisClient();
      const queryCache = new RedisQueryCache(redisClient);
      const embeddingCache = new RedisEmbeddingCache(redisClient);

      cacheService = new CacheService(
        queryCache,
        embeddingCache,
        5, // circuit breaker threshold (errors before opening)
        60000, // circuit breaker reset time (ms)
      );
      console.warn('[Container] Cache infrastructure initialized');
    } catch (err) {
      console.warn('[Container] Failed to initialize caches; continuing without:', err);
      // Continue without caches — Layer 1 search still works
    }
  }

  // ── Domain services — retrieval ───────────────────────────────────────────
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(
    searchIndex,
    embeddingService,
    fusionService,
    cacheService,
    _config.embedding.model, // Embedding model ID from config (not hardcoded)
  );

  // ── Domain services — ranking ─────────────────────────────────────────────
  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper, reranker, {
    rerankBlendScale: _config.reranker.blendScale,
  });

  // ── Domain services — decision, response, mixed ───────────────────────────
  // Confidence refusal policy (Epic 17.3): optional, only if env var is set
  let confidenceRefusalPolicy: ConfidenceRefusalPolicy | undefined;
  if (_config.confidenceRefusal.threshold !== undefined) {
    confidenceRefusalPolicy = new ConfidenceRefusalPolicy(_config.confidenceRefusal.threshold);
  }

  const decisionEngine = new DecisionEngine(thresholdStore, confidenceRefusalPolicy);
  const responseBuilder = new ResponseBuilder();

  const anchorProfiler = new AnchorProfiler();
  const similarityScorer = new SimilarityScorer();
  const constraintOverlay = new ConstraintOverlay();

  const mixedSolver = new MixedSolver(
    anchorResolver,
    anchorProfiler,
    similarRetrieval,
    candidateAttributes,
    similarityScorer,
    constraintOverlay,
    ranker,
  );

  // ── RFC-015 snapshot version info ─────────────────────────────────────────
  const snapshotVersions: SnapshotVersions = {
    modelVersions: {
      embedding: _config.embedding.model,
    },
    indexVersions: {
      wine_content: _config.vespa.contentCluster,
    },
  };

  // ── ML infrastructure (Epic 15: Drinking Window) ─────────────────────────
  const drinkingWindowPredictor = new DrinkingWindowPredictor();
  // Note: predictor.load() must be called at app startup with model directory

  // ── Security: Prompt injection defense (Epic 16.1) ────────────────────────
  const querySanitizer = new QuerySanitizer();

  // LLM-based injection judge (optional, depends on ANTHROPIC_API_KEY)
  let injectionJudge: LLMInjectionJudge | undefined;
  if (_config.anthropic.apiKey && !_config.killSwitch.injectionJudge) {
    try {
      const redisClient = await getRedisClient();
      injectionJudge = new LLMInjectionJudge(_config.anthropic.apiKey, redisClient);
    } catch (err) {
      console.error('[Container] Failed to initialize LLMInjectionJudge:', err);
      // Continue without judge — Layer 1 (static patterns) still active
    }
  }

  // ── Use cases ─────────────────────────────────────────────────────────────
  // Create independent use cases first (no dependencies on SearchUseCase)
  const drinkingWindowUseCase = new DrinkingWindowUseCase(drinkingWindowPredictor);

  // Create SearchUseCase with Epic 15 drinkingWindow + Wave 4 unified cache service
  const searchUseCase = new SearchUseCase({
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
    drinkingWindow: drinkingWindowUseCase, // ← Epic 15: Inject drinking window
    cacheService, // ← Wave 4, Phase 3: Unified cache service (query + embedding + version checking)
  });

  // Dependent use cases created after SearchUseCase
  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);

  const replayUseCase = new ReplayUseCase({
    searchUseCase,
    snapshotVersions,
  });

  const interpretUseCase = new InterpretUseCase({
    queryPlanner,
  });

  const resolveUseCase = new ResolveUseCase({
    queryPlanner,
    entityResolver,
  });

  const hybridUseCase = new HybridUseCase({
    queryPlanner,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    snapshotVersions,
  });

  // ── Epic 17.2: Claude tool integration ──────────────────────────────────────
  const wineToolExecutor = new WineToolExecutor({
    searchUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
  });

  const adaptiveToolExecutor = new AdaptiveToolExecutor(wineToolExecutor);

  // ── Epic 17.1: Watchlist infrastructure ─────────────────────────────────────
  const watchlistPublisher = new RedisWatchlistPublisher();
  const watchlistSubscriber = new RedisWatchlistSubscriber();

  // Webhook delivery requires WEBHOOK_SECRET; gracefully skip if not configured
  let webhookDelivery: WebhookDelivery;
  if (_config.watchlist.webhookSecret) {
    webhookDelivery = new WebhookDelivery(_config.watchlist.webhookSecret);
  } else {
    // Create with dummy secret (will fail if used); production requires WEBHOOK_SECRET
    webhookDelivery = new WebhookDelivery('dummy-secret-min-16-chars!!!');
    console.warn('[Container] WEBHOOK_SECRET not configured; watchlist webhooks disabled');
  }

  return {
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    searchUseCase,
    replayUseCase,
    interpretUseCase,
    resolveUseCase,
    hybridUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase,
    drinkingWindowPredictor,
    wineToolExecutor,
    adaptiveToolExecutor,
    watchlistPublisher,
    watchlistSubscriber,
    webhookDelivery,
  };
}
