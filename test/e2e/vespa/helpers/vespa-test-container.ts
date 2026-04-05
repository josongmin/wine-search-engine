/**
 * Vespa-backed test DI container.
 *
 * Wires the full application stack with:
 *   - Real VespaSearchIndex (talks to a live Vespa instance)
 *   - InMemory stubs for everything else (aliases, thresholds, etc.)
 *
 * The Vespa URL is read from process.env['VESPA_URL'] and falls back
 * to 'http://localhost:18080'.
 */

import { Planner } from '../../../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../../../src/domain/query/service/expansion-builder.js';
import { NLMapper } from '../../../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../../../src/domain/attribute/port/mapping-table.port.js';
import { Resolver } from '../../../../src/domain/resolver/service/resolver.js';
import { Blocker } from '../../../../src/domain/resolver/service/blocker.js';
import { CandidateScorer } from '../../../../src/domain/resolver/service/candidate-scorer.js';
import { AmbiguityClassifier } from '../../../../src/domain/resolver/service/ambiguity-classifier.js';
import { Calibrator } from '../../../../src/domain/resolver/service/calibrator.js';
import { CandidatePoolService } from '../../../../src/domain/retrieval/service/candidate-pool.js';
import { FusionService } from '../../../../src/domain/retrieval/service/fusion.js';
import { Ranker } from '../../../../src/domain/ranking/service/ranker.js';
import { SignalComputer } from '../../../../src/domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../../../../src/domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../../../../src/domain/ranking/service/evidence-mapper.js';
import { DecisionEngine } from '../../../../src/domain/decision/service/decision-engine.js';
import { ResponseBuilder } from '../../../../src/domain/response/service/response-builder.js';
import { QuerySanitizer } from '../../../../src/domain/security/service/query-sanitizer.js';
import { MixedSolver } from '../../../../src/domain/mixed/service/mixed-solver.js';
import { AnchorProfiler } from '../../../../src/domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../../../../src/domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../../../../src/domain/mixed/service/constraint-overlay.js';
import { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import { DecomposedSearchUseCase } from '../../../../src/application/search/decomposed-search.usecase.js';
import { BatchSearchUseCase } from '../../../../src/application/search/batch-search.usecase.js';
import { DrinkingWindowUseCase } from '../../../../src/application/drinking-window/drinking-window.usecase.js';
import { ReplayUseCase } from '../../../../src/application/search/replay.usecase.js';
import { InterpretUseCase } from '../../../../src/application/search/interpret.usecase.js';
import { ResolveUseCase } from '../../../../src/application/search/resolve.usecase.js';
import { HybridUseCase } from '../../../../src/application/search/hybrid.usecase.js';
import type { Container } from '../../../../src/config/container.js';
import type { SnapshotVersions } from '../../../../src/application/search/search.usecase.js';
import { WineToolExecutor } from '../../../../src/interface/claude-tools/tool-executor.js';
import { AdaptiveToolExecutor } from '../../../../src/interface/claude-tools/adaptive-tool-executor.js';

import { VespaClient } from '../../../../src/infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../../../../src/infrastructure/vespa/vespa-search-index.js';

import {
  InMemoryAmbiguityDictionary,
  InMemoryBlockingAdapter,
  InMemoryCalibrationStore,
  InMemoryEmbeddingService,
  InMemoryThresholdStore,
  InMemoryAliasMatcher,
  InMemoryAnchorResolver,
  InMemorySimilarRetrieval,
  InMemoryCandidateAttributes,
} from '../../../integration/helpers/in-memory-adapters.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VESPA_NAMESPACE = 'wine';
const VESPA_DOC_TYPE = 'wine_entity';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface VespaTestContainerParts {
  /** The fully wired DI container backed by real Vespa. */
  readonly container: Container;
  /** The raw VespaClient for low-level operations in tests. */
  readonly vespaClient: VespaClient;
  /** The VespaSearchIndex for direct port-level assertions. */
  readonly vespaSearchIndex: VespaSearchIndex;
  /** In-memory alias matcher — tests can add aliases for resolution. */
  readonly aliasMatcher: InMemoryAliasMatcher;
  /** In-memory ambiguity dictionary. */
  readonly ambiguityDict: InMemoryAmbiguityDictionary;
  /** In-memory blocking adapter. */
  readonly blockingAdapter: InMemoryBlockingAdapter;
  /** Base URL of the Vespa instance used for this container. */
  readonly vespaUrl: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the full DI container wired against a REAL Vespa instance.
 *
 * Use `process.env['VESPA_URL']` (or the default 'http://localhost:18080')
 * to point at the running Vespa container during test execution.
 */
export function createVespaTestContainer(): VespaTestContainerParts {
  const vespaUrl =
    process.env['VESPA_URL'] ?? 'http://localhost:18080';

  // Real Vespa infrastructure
  const vespaClient = new VespaClient(vespaUrl, VESPA_NAMESPACE, VESPA_DOC_TYPE);
  const vespaSearchIndex = new VespaSearchIndex(vespaClient);

  // In-memory stubs for all other infrastructure
  const ambiguityDict = new InMemoryAmbiguityDictionary();
  const blockingAdapter = new InMemoryBlockingAdapter();
  const calibrationStore = new InMemoryCalibrationStore();
  const embeddingService = new InMemoryEmbeddingService();
  const thresholdStore = new InMemoryThresholdStore();
  const aliasMatcher = new InMemoryAliasMatcher();
  const anchorResolver = new InMemoryAnchorResolver();
  const similarRetrieval = new InMemorySimilarRetrieval();
  const candidateAttributes = new InMemoryCandidateAttributes();
  const querySanitizer = new QuerySanitizer();
  const injectionJudge = { judge: async () => false };

  // Domain services — query planning
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const noOpMappingTable: MappingTablePort = {
    findMapping: () => Promise.resolve(null),
    findMappingsByAttribute: () => Promise.resolve([]),
    getCurrentVersion: () => Promise.resolve('v1'),
  };
  const nlMapper = new NLMapper(noOpMappingTable);
  const queryPlanner = new Planner(
    ambiguityDict,
    anchorExtractor,
    expansionBuilder,
    nlMapper,
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
  );

  // Domain services — retrieval (using real Vespa search index)
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(
    vespaSearchIndex,
    embeddingService,
    fusionService,
  );

  // Domain services — ranking
  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper);

  // Domain services — decision, response, mixed
  const decisionEngine = new DecisionEngine(thresholdStore);
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

  // Snapshot versions for tracing
  const snapshotVersions: SnapshotVersions = {
    modelVersions: { embedding: 'in-memory-hash-v1' },
    indexVersions: { wine_content: 'vespa-e2e-test' },
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
    snapshotVersions,
    querySanitizer,
    injectionJudge,
  });

  const replayUseCase = new ReplayUseCase({ searchUseCase });
  const interpretUseCase = new InterpretUseCase({ queryPlanner, querySanitizer, injectionJudge });
  const resolveUseCase = new ResolveUseCase({ queryPlanner, entityResolver, querySanitizer, injectionJudge });
  const hybridUseCase = new HybridUseCase({
    queryPlanner,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    snapshotVersions,
    querySanitizer,
    injectionJudge,
  });
  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);
  const drinkingWindowUseCase = new DrinkingWindowUseCase({
    predict: () => ({
      drinkingWindowStart: 2020,
      drinkingWindowEnd: 2030,
      peakYear: 2025,
      confidence: 'medium',
      modelVersion: 'vespa-test',
    }),
  });
  const adaptiveToolExecutor = new AdaptiveToolExecutor(
    new WineToolExecutor({
      searchUseCase,
      decomposedSearchUseCase,
      drinkingWindowUseCase,
    }),
  );

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
    vespaClient,
    vespaSearchIndex,
    aliasMatcher,
    ambiguityDict,
    blockingAdapter,
    vespaUrl,
  };
}
