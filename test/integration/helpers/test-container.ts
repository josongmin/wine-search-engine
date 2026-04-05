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
import { DecomposedSearchUseCase } from '../../../src/application/search/decomposed-search.usecase.js';
import { BatchSearchUseCase } from '../../../src/application/search/batch-search.usecase.js';
import { ReplayUseCase } from '../../../src/application/search/replay.usecase.js';
import { InterpretUseCase } from '../../../src/application/search/interpret.usecase.js';
import { ResolveUseCase } from '../../../src/application/search/resolve.usecase.js';
import { HybridUseCase } from '../../../src/application/search/hybrid.usecase.js';
import type { Container } from '../../../src/config/container.js';
import type { SnapshotVersions } from '../../../src/application/search/search.usecase.js';
import { AdaptiveToolExecutor } from '../../../src/interface/claude-tools/adaptive-tool-executor.js';
import { WineToolExecutor } from '../../../src/interface/claude-tools/tool-executor.js';
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

export interface TestContainerParts {
  container: Container;
  ambiguityDict: InMemoryAmbiguityDictionary;
  blockingAdapter: InMemoryBlockingAdapter;
  searchIndex: InMemorySearchIndex;
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

  // Domain services — query planning
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const noOpMappingTable: MappingTablePort = {
    findMapping: async () => null,
    findMappingsByAttribute: async () => [],
    getCurrentVersion: async () => 'v1',
  };
  const nlMapper = new NLMapper(noOpMappingTable);
  const queryPlanner = new Planner(ambiguityDict, anchorExtractor, expansionBuilder, nlMapper);

  // Domain services — entity resolution
  const blocker = new Blocker(blockingAdapter);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(blocker, candidateScorer, ambiguityClassifier, calibrator);

  // Domain services — retrieval
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(searchIndex, embeddingService, fusionService);

  // Domain services — ranking
  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper);

  // Domain services — decision, response, mixed, security
  const decisionEngine = new DecisionEngine(thresholdStore);
  const responseBuilder = new ResponseBuilder();
  const querySanitizer = new QuerySanitizer();
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
  };

  // Use cases
  const searchUseCase = new SearchUseCase({
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    querySanitizer,
    snapshotVersions,
  });

  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);

  const replayUseCase = new ReplayUseCase({ searchUseCase });
  const interpretUseCase = new InterpretUseCase({ queryPlanner });
  const resolveUseCase = new ResolveUseCase({ queryPlanner, entityResolver });
  const hybridUseCase = new HybridUseCase({
    queryPlanner,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
  });

  const wineToolExecutor = new WineToolExecutor({
    searchUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
  });
  const adaptiveToolExecutor = new AdaptiveToolExecutor(wineToolExecutor);
  const container: Container = {
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
    adaptiveToolExecutor,
    evalRunner: null,
  };

  return {
    container,
    ambiguityDict,
    blockingAdapter,
    searchIndex,
    aliasMatcher,
    anchorResolver,
    similarRetrieval,
    candidateAttributes,
  };
}
