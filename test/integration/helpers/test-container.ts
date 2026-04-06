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
import { DrinkingWindowPredictor } from '../../../src/infrastructure/ml/drinking-window-predictor.js';
import { DrinkingWindowUseCase } from '../../../src/application/drinking-window/drinking-window.usecase.js';
import { SearchUseCase } from '../../../src/application/search/search.usecase.js';
import { DecomposedSearchAdapter } from '../../../src/application/search/decomposed-search-adapter.js';
import { DecomposedSearchUseCase } from '../../../src/application/search/decomposed-search.usecase.js';
import { BatchSearchUseCase } from '../../../src/application/search/batch-search.usecase.js';
import { ReplayUseCase } from '../../../src/application/search/replay.usecase.js';
import { InterpretUseCase } from '../../../src/application/search/interpret.usecase.js';
import { ResolveUseCase } from '../../../src/application/search/resolve.usecase.js';
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
} from './in-memory-adapters.js';
import { PlannerV1Adapter } from '../../../src/config/planner-v1-adapter.js';
import {
  MIXED_NEIGHBORHOOD_FIXTURES,
  TEST_ALIASES,
  TEST_DOCUMENTS,
  toAnchorEntityData,
  toCandidateAttributes,
  toHybridCandidate,
  toSimilarityCandidate,
} from './test-fixtures.js';

export interface TestContainerParts {
  container: Container;
  ambiguityDict: InMemoryAmbiguityDictionary;
  blockingAdapter: InMemoryBlockingAdapter;
  searchIndex: InMemorySearchIndex;
  browseRetriever: BrowseRetriever;
  compareRetriever: CompareRetriever;
  aliasMatcher: InMemoryAliasMatcher;
  anchorResolver: InMemoryAnchorResolver;
  similarRetrieval: InMemorySimilarRetrieval;
  candidateAttributes: InMemoryCandidateAttributes;
}

/**
 * Creates a fully wired DI container backed by in-memory adapters.
 */
export function createTestContainer(): TestContainerParts {
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

  for (const alias of TEST_ALIASES) {
    aliasMatcher.addAlias(alias.surfaceForm, alias.entityId, alias.confidence);
  }

  for (const doc of TEST_DOCUMENTS) {
    searchIndex.upsertDoc(doc);
    anchorResolver.addEntity(doc.entityId, toAnchorEntityData(doc));
    candidateAttributes.setAttribute(doc.entityId, toCandidateAttributes(doc));
    candidateAttributes.setSimilarity(doc.entityId, toSimilarityCandidate(doc));
  }

  const uniqueIds = new Set(TEST_ALIASES.map((alias) => alias.entityId));
  blockingAdapter.addEntityIds(Array.from(uniqueIds));

  for (const neighborhood of MIXED_NEIGHBORHOOD_FIXTURES) {
    const docs = neighborhood.candidateIds
      .map((entityId) => TEST_DOCUMENTS.find((doc) => doc.entityId === entityId))
      .filter((doc): doc is (typeof TEST_DOCUMENTS)[number] => doc !== undefined);

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
  // T1.2: wrap concrete Planner (returns QueryPlanV2) in V1 adapter for backward compat.
  const queryPlanner = new PlannerV1Adapter(
    new Planner(ambiguityDict, anchorExtractor, expansionBuilder, nlMapper),
  );

  // Domain services — entity resolution
  const blocker = new Blocker(blockingAdapter);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(blocker, candidateScorer, ambiguityClassifier, calibrator);

  // Domain services — retrieval
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(searchIndex, embeddingService, fusionService);
  const browseRetriever = new BrowseRetriever(searchIndex);
  const compareRetriever = new CompareRetriever(searchIndex);

  // Domain services — ranking
  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper);

  // Domain services — decision, response, mixed, security
  const decisionEngine = new DecisionEngine(thresholdStore);
  const responseBuilder = new ResponseBuilder();
  const querySanitizer = new QuerySanitizer();
  const injectionJudge = { judge: async () => false };
  const drinkingWindowPredictor = new DrinkingWindowPredictor();
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
  const snapshotVersions: SnapshotVersions = {
    modelVersions: { embedding: 'text-embedding-3-small-v1' },
    indexVersions: { wine_content: 'wine_content_v1' },
    featureFlags: {},
  };

  // Use cases — same DecomposedSearchAdapter cycle as production container-usecases.
  const decomposedAdapter = new DecomposedSearchAdapter();

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
    snapshotVersions,
    decomposedSearch: decomposedAdapter,
  });

  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  decomposedAdapter.setDelegate(decomposedSearchUseCase);
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);

  const replayUseCase = new ReplayUseCase({
    searchUseCase,
    snapshotVersions,
  });
  const interpretUseCase = new InterpretUseCase({ queryPlanner, querySanitizer, injectionJudge });
  const resolveUseCase = new ResolveUseCase({
    queryPlanner,
    entityResolver,
    entityLookup: searchIndex,
    querySanitizer,
    injectionJudge,
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
  const container: Container = {
    feedbackStore: null,
    proposalStore: null,
    feedbackProcessor: null,
    aliasProposer: null,
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
    hybridUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    drinkingWindowPredictor,
    batchSearchUseCase,
    adaptiveToolExecutor,
    watchlistService,
    watchlistRuntime: null,
    evalRunner: null,
  };

  return {
    container,
    ambiguityDict,
    blockingAdapter,
    searchIndex,
    browseRetriever,
    compareRetriever,
    aliasMatcher,
    anchorResolver,
    similarRetrieval,
    candidateAttributes,
  };
}
