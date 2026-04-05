import type { Pool } from 'pg';
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
import { NLMapper } from '../domain/attribute/service/nl-mapper.js';
import { AnchorProfiler } from '../domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../domain/mixed/service/constraint-overlay.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { Config } from './env.js';
import type { DrinkingWindowPredictorContract } from './container-contracts.js';
import { buildCoreAdapterServices } from './container-adapters.js';
import {
  buildRuntimeSupportServices,
  type RuntimeSupportServices,
} from './container-runtime-support.js';

export interface CoreContainerServices {
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly snapshotVersions: SnapshotVersions;
  readonly querySanitizer: RuntimeSupportServices['querySanitizer'];
  readonly injectionJudge?: RuntimeSupportServices['injectionJudge'];
  readonly cacheService?: RuntimeSupportServices['cacheService'];
  readonly ltrModels?: RuntimeSupportServices['ltrModels'];
  readonly drinkingWindowPredictor: DrinkingWindowPredictorContract;
}

export async function buildCoreContainerServices(
  config: Config,
  pool?: Pool,
): Promise<CoreContainerServices> {
  const support = await buildRuntimeSupportServices(config, pool);
  const adapters = buildCoreAdapterServices(config, pool);

  const queryPlanner = new Planner(
    adapters.ambiguityDict,
    new AnchorExtractor(adapters.aliasMatcher),
    new ExpansionBuilder(),
    new NLMapper(adapters.mappingTable),
  );

  const entityResolver = new Resolver(
    new Blocker(adapters.blockingPort),
    new CandidateScorer(),
    new AmbiguityClassifier(),
    new Calibrator(adapters.calibrationStore),
    adapters.learnedMatcher,
  );

  const candidatePool = new CandidatePoolService(
    adapters.searchIndex,
    adapters.embeddingService,
    new FusionService(),
    support.cacheService,
    config.embedding.model,
  );

  const ranker = new Ranker(
    new SignalComputer(),
    new ScoreAggregator(),
    new EvidenceMapper(),
    adapters.reranker,
    { rerankBlendScale: config.reranker.blendScale },
  );

  const confidenceRefusalPolicy = config.confidenceRefusal.threshold !== undefined
    ? new ConfidenceRefusalPolicy(config.confidenceRefusal.threshold)
    : undefined;

  return {
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine: new DecisionEngine(adapters.thresholdStore, confidenceRefusalPolicy),
    responseBuilder: new ResponseBuilder(),
    mixedSolver: new MixedSolver(
      adapters.anchorResolver,
      new AnchorProfiler(),
      adapters.similarRetrieval,
      adapters.candidateAttributes,
      new SimilarityScorer(),
      new ConstraintOverlay(),
      ranker,
    ),
    snapshotVersions: {
      modelVersions: { embedding: config.embedding.model },
      indexVersions: { wine_content: config.vespa.contentCluster },
    },
    ...support,
  };
}
