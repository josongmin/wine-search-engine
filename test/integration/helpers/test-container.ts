/**
 * Factory that wires the full DI container with in-memory adapters.
 * No real DB or network is required.
 */

import { Planner } from '../../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../../src/domain/query/service/expansion-builder.js';
import { NLMapper } from '../../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../../src/domain/attribute/port/mapping-table.port.js';
import { Resolver } from '../../../src/domain/resolver/service/resolver.js';
import { Blocker } from '../../../src/domain/resolver/service/blocker.js';
import { CandidateScorer } from '../../../src/domain/resolver/service/candidate-scorer.js';
import { AmbiguityClassifier } from '../../../src/domain/resolver/service/ambiguity-classifier.js';
import { Calibrator } from '../../../src/domain/resolver/service/calibrator.js';
import { CandidatePoolService } from '../../../src/domain/retrieval/service/candidate-pool.js';
import { BrowseRetriever } from '../../../src/domain/retrieval/service/browse-retriever.js';
import { CompareRetriever } from '../../../src/domain/retrieval/service/compare-retriever.js';
import { FusionService } from '../../../src/domain/retrieval/service/fusion.js';
import { Ranker } from '../../../src/domain/ranking/service/ranker.js';
import { SignalComputer } from '../../../src/domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../../../src/domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../../../src/domain/ranking/service/evidence-mapper.js';
import { DecisionEngine } from '../../../src/domain/decision/service/decision-engine.js';
import { ResponseBuilder } from '../../../src/domain/response/service/response-builder.js';
import { QuerySanitizer } from '../../../src/domain/security/service/query-sanitizer.js';
import { MixedSolver } from '../../../src/domain/mixed/service/mixed-solver.js';
import { AnchorProfiler } from '../../../src/domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../../../src/domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../../../src/domain/mixed/service/constraint-overlay.js';
import type { DrinkingWindowPredictorPort } from '../../../src/domain/drinking-window/port/drinking-window-predictor.port.js';
import type { RerankerPort } from '../../../src/domain/ranking/port/reranker.port.js';
import type { LearnedMatcherPort } from '../../../src/domain/resolver/port/learned-matcher.port.js';
import { DeterministicDrinkingWindowPredictor } from '../../../src/infrastructure/ml/deterministic-drinking-window-predictor.js';
import { DrinkingWindowUseCase } from '../../../src/application/drinking-window/drinking-window.usecase.js';
import { SearchUseCase } from '../../../src/application/search/search.usecase.js';
import { DecomposedSearchAdapter } from '../../../src/application/search/decomposed-search-adapter.js';
import { DecomposedSearchUseCase } from '../../../src/application/search/decomposed-search.usecase.js';
import { BatchSearchUseCase } from '../../../src/application/search/batch-search.usecase.js';
import { ReplayUseCase } from '../../../src/application/search/replay.usecase.js';
import { InterpretUseCase } from '../../../src/application/search/interpret.usecase.js';
import { ResolveUseCase } from '../../../src/application/search/resolve.usecase.js';
import { AutocompleteUseCase } from '../../../src/application/search/autocomplete.usecase.js';
import { HybridUseCase } from '../../../src/application/search/hybrid.usecase.js';
import { WatchlistService } from '../../../src/application/watchlist/watchlist.service.js';
import type { Container } from '../../../src/config/container.js';
import type { SnapshotVersions } from '../../../src/application/search/search.usecase.js';
import { AdaptiveToolExecutor } from '../../../src/interface/claude-tools/adaptive-tool-executor.js';
import { WineToolExecutor } from '../../../src/interface/claude-tools/tool-executor.js';
import { InMemoryWatchlistStore } from '../../../src/infrastructure/watchlist/in-memory-watchlist-store.js';
import {
  InMemoryAmbiguityDictionary,
  InMemoryBlockingAdapter,
  InMemoryCalibrationStore,
  InMemorySearchIndex,
  InMemoryEmbeddingService,
  InMemoryThresholdStore,
  InMemoryAliasMatcher,
  InMemoryAnchorResolver,
  InMemorySimilarRetrieval,
  InMemoryCandidateAttributes,
  type InMemoryAliasProvenance,
} from './in-memory-adapters.js';
import { PlannerV1Adapter } from '../../../src/config/planner-v1-adapter.js';
import {
  FallbackAmbiguityDictionary,
  StaticAmbiguityDictionary,
} from '../../../src/domain/query/service/static-ambiguity-dictionary.js';
import {
  MIXED_NEIGHBORHOOD_FIXTURES,
  TEST_ALIASES_WITH_DERIVED,
  TEST_DOCUMENTS,
  toAnchorEntityData,
  toCandidateAttributes,
  toHybridCandidate,
  toSimilarityCandidate,
} from './test-fixtures.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { EntityId } from '../../../src/domain/shared/types/index.js';

export interface TestFixtureAlias {
  readonly surfaceForm: string;
  readonly entityId: EntityId;
  readonly confidence: number;
  /** Origin of the alias entry — defaults to 'curated' when omitted. */
  readonly provenance?: InMemoryAliasProvenance;
}

export interface TestContainerParts {
  container: Container;
  ambiguityDict: InMemoryAmbiguityDictionary;
  blockingAdapter: InMemoryBlockingAdapter;
  searchIndex: InMemorySearchIndex;
  fixtureDocuments: readonly RetrievalDocument[];
  browseRetriever: BrowseRetriever;
  compareRetriever: CompareRetriever;
  aliasMatcher: InMemoryAliasMatcher;
  anchorResolver: InMemoryAnchorResolver;
  similarRetrieval: InMemorySimilarRetrieval;
  candidateAttributes: InMemoryCandidateAttributes;
}

export interface TestContainerOptions {
  readonly snapshotVersions?: SnapshotVersions;
  readonly reranker?: RerankerPort;
  readonly learnedMatcher?: LearnedMatcherPort;
  readonly signalComputer?: SignalComputer;
  readonly drinkingWindowPredictor?: DrinkingWindowPredictorPort;
  readonly rerankThreshold?: number;
  readonly stripCachedDrinkingWindow?: boolean;
  readonly drinkingWindowModelVersionOverride?: string;
  readonly fixtureAliases?: readonly TestFixtureAlias[];
  readonly fixtureDocuments?: readonly RetrievalDocument[];
}

/**
 * Creates a fully wired DI container backed by in-memory adapters.
 */
export function createTestContainer(options: TestContainerOptions = {}): TestContainerParts {
  // Infrastructure ports (in-memory)
  const ambiguityDict = new InMemoryAmbiguityDictionary();
  const blockingAdapter = new InMemoryBlockingAdapter();
  const calibrationStore = new InMemoryCalibrationStore();
  const searchIndex = new InMemorySearchIndex();
  const embeddingService = new InMemoryEmbeddingService();
  const thresholdStore = new InMemoryThresholdStore();
  const aliasMatcher = new InMemoryAliasMatcher();
  const anchorResolver = new InMemoryAnchorResolver();
  const similarRetrieval = new InMemorySimilarRetrieval();
  const candidateAttributes = new InMemoryCandidateAttributes();
  const watchlistStore = new InMemoryWatchlistStore();

  // Default to curated ∪ deterministic initialism derivations.
  // The InMemoryAliasMatcher propagates provenance through
  // `lookupStrategy` decoration (`+initialism_match` suffix) so the
  // downstream resolver scorer applies DERIVED_INITIALISM_CAP only to
  // initialism-only matches, preventing initialism aliases from
  // competing with curated aliases at full weight. Tests that want a
  // pure curated baseline can pass `fixtureAliases: TEST_ALIASES`.
  const fixtureAliases = options.fixtureAliases ?? TEST_ALIASES_WITH_DERIVED;
  const fixtureDocuments = options.fixtureDocuments ?? TEST_DOCUMENTS;

  for (const alias of fixtureAliases) {
    aliasMatcher.addAlias(
      alias.surfaceForm,
      alias.entityId,
      alias.confidence,
      alias.provenance ?? 'curated',
    );
  }

  const materializedDocuments = fixtureDocuments.map((doc) => {
    const baseDoc = options.stripCachedDrinkingWindow === true
      ? {
        ...doc,
        drinkingWindowStart: undefined,
        drinkingWindowEnd: undefined,
        drinkingWindowModelVersion: undefined,
      }
      : { ...doc };

    const projectedAttributes = toCandidateAttributes(baseDoc);
    const enrichedDoc = {
      ...baseDoc,
      ...(typeof projectedAttributes['country'] === 'string'
        ? { country: projectedAttributes['country'] }
        : {}),
      ...(typeof projectedAttributes['appellation'] === 'string'
        ? { appellation: projectedAttributes['appellation'] }
        : {}),
      ...(typeof projectedAttributes['wineType'] === 'string'
        ? { wineType: projectedAttributes['wineType'] }
        : {}),
      ...(typeof projectedAttributes['grapePrimary'] === 'string'
        ? { grapePrimary: projectedAttributes['grapePrimary'] }
        : {}),
      ...(typeof projectedAttributes['producerType'] === 'string'
        ? { producerType: projectedAttributes['producerType'] }
        : {}),
    };

    if (options.drinkingWindowModelVersionOverride === undefined) {
      return enrichedDoc;
    }

    return {
      ...enrichedDoc,
      drinkingWindowStart: enrichedDoc.drinkingWindowStart ?? 2024,
      drinkingWindowEnd: enrichedDoc.drinkingWindowEnd ?? 2032,
      drinkingWindowModelVersion: options.drinkingWindowModelVersionOverride,
    };
  });

  for (const doc of materializedDocuments) {
    searchIndex.upsertDoc(doc);
    anchorResolver.addEntity(doc.entityId, toAnchorEntityData(doc));
    candidateAttributes.setAttribute(doc.entityId, toCandidateAttributes(doc));
    candidateAttributes.setSimilarity(doc.entityId, toSimilarityCandidate(doc));
  }

  const uniqueIds = new Set(fixtureAliases.map((alias) => alias.entityId));
  blockingAdapter.addEntityIds(Array.from(uniqueIds));

  for (const neighborhood of MIXED_NEIGHBORHOOD_FIXTURES) {
    const docs = neighborhood.candidateIds
      .map((entityId) => materializedDocuments.find((doc) => doc.entityId === entityId))
      .filter((doc): doc is RetrievalDocument => doc !== undefined);

    const candidates = docs.map((doc, index) =>
      toHybridCandidate(doc, index + 1, ['anchor', 'dense', 'sparse']),
    );

    similarRetrieval.setResults(neighborhood.anchorId, candidates);
  }

  // Domain services — query planning
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const noOpMappingTable: MappingTablePort = {
    findMapping: async () => null,
    findMappingsByAttribute: async () => [],
    getCurrentVersion: async () => 'v1',
  };
  const nlMapper = new NLMapper(noOpMappingTable);
  const plannerAmbiguityDict = new FallbackAmbiguityDictionary(
    ambiguityDict,
    new StaticAmbiguityDictionary(),
  );
  // T1.2: wrap concrete Planner (returns QueryPlanV2) in V1 adapter for backward compat.
  const queryPlanner = new PlannerV1Adapter(
    new Planner(plannerAmbiguityDict, anchorExtractor, expansionBuilder, nlMapper),
  );

  // Domain services — entity resolution
  const blocker = new Blocker(blockingAdapter);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(
    blocker,
    candidateScorer,
    ambiguityClassifier,
    calibrator,
    options.learnedMatcher,
  );

  // Domain services — retrieval
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(searchIndex, embeddingService, fusionService);
  const browseRetriever = new BrowseRetriever(searchIndex);
  const compareRetriever = new CompareRetriever(searchIndex);

  // Domain services — ranking
  const signalComputer = options.signalComputer ?? new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(
    signalComputer,
    scoreAggregator,
    evidenceMapper,
    options.reranker,
    options.rerankThreshold,
  );

  // Domain services — decision, response, mixed, security
  const decisionEngine = new DecisionEngine(thresholdStore);
  const responseBuilder = new ResponseBuilder();
  const querySanitizer = new QuerySanitizer();
  const injectionJudge = { judge: async () => false };
  const judgeTimeoutMs = 5_000;
  const drinkingWindowPredictor =
    options.drinkingWindowPredictor ?? new DeterministicDrinkingWindowPredictor();
  const drinkingWindowUseCase = new DrinkingWindowUseCase(drinkingWindowPredictor);
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

  // RFC-015 snapshot version info for test containers.
  // Provides stable, meaningful version strings so snapshots are not empty.
  const snapshotVersions: SnapshotVersions = options.snapshotVersions ?? {
    modelVersions: { embedding: 'text-embedding-3-small-v1' },
    indexVersions: { wine_content: 'wine_content_v1' },
    featureFlags: {},
  };

  // Use cases — same DecomposedSearchAdapter cycle as production container-usecases.
  const decomposedRef: { impl?: DecomposedSearchUseCase } = {};
  const decomposedAdapter = new DecomposedSearchAdapter(() => {
    const impl = decomposedRef.impl;
    if (impl === undefined) {
      throw new Error('[DecomposedSearchAdapter] wiring incomplete — impl not set');
    }
    return impl;
  });

  const searchUseCase = new SearchUseCase({
    queryPlanner,
    entityResolver,
    entityLookup: searchIndex,
    candidatePool,
    browseRetriever,
    compareRetriever,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
    snapshotVersions,
    decomposedSearch: decomposedAdapter,
    ...(options.drinkingWindowPredictor !== undefined ? { drinkingWindow: drinkingWindowUseCase } : {}),
  });

  decomposedRef.impl = new DecomposedSearchUseCase(searchUseCase);
  const decomposedSearchUseCase = decomposedRef.impl;
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);

  const replayUseCase = new ReplayUseCase({
    searchUseCase,
    snapshotVersions,
  });
  const interpretUseCase = new InterpretUseCase({
    queryPlanner,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
  });
  const resolveUseCase = new ResolveUseCase({
    queryPlanner,
    entityResolver,
    entityLookup: searchIndex,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
  });
  const autocompleteUseCase = new AutocompleteUseCase({
    resolveUseCase,
    entityLookup: searchIndex,
  });
  const hybridUseCase = new HybridUseCase({
    queryPlanner,
    candidatePool,
    browseRetriever,
    compareRetriever,
    entityResolver,
    entityLookup: searchIndex,
    ranker,
    decisionEngine,
    responseBuilder,
    snapshotVersions,
    drinkingWindow: drinkingWindowUseCase,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
    judgeFailureMode: 'fail_closed',
    decomposedSearch: decomposedSearchUseCase,
  });

  const wineToolExecutor = new WineToolExecutor({
    searchUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
  });
  const adaptiveToolExecutor = new AdaptiveToolExecutor(wineToolExecutor);
  const watchlistService = new WatchlistService({
    storage: watchlistStore,
  });
  const container = {
    feedbackStore: null,
    proposalStore: null,
    feedbackProcessor: null,
    aliasProposer: null,
    feedbackTtlEnforcer: null,
    promotionGate: null,
    feedbackIngestEnabled: false,
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
    autocompleteUseCase,
    hybridUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    drinkingWindowPredictor,
    batchSearchUseCase,
    adaptiveToolExecutor,
    watchlistService,
    watchlistRuntime: null,
    evalRunner: null,
    calibrationStore,
  } satisfies Container;

  return {
    container,
    ambiguityDict,
    blockingAdapter,
    searchIndex,
    fixtureDocuments: materializedDocuments,
    browseRetriever,
    compareRetriever,
    aliasMatcher,
    anchorResolver,
    similarRetrieval,
    candidateAttributes,
  };
}
