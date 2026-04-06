import { Planner } from '../domain/query/service/planner.js';
import { AnchorExtractor } from '../domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../domain/query/service/expansion-builder.js';
import type { Pool } from 'pg';
import { FuzzyMatcher } from '../domain/query/service/fuzzy-matcher.js';
import type { FuzzyMatcherPort } from '../domain/query/port/fuzzy-matcher.port.js';
import { CharNgramIndex } from '../domain/alias/service/char-ngram-index.js';
import { Resolver } from '../domain/resolver/service/resolver.js';
import { Blocker } from '../domain/resolver/service/blocker.js';
import { CandidateScorer } from '../domain/resolver/service/candidate-scorer.js';
import { AmbiguityClassifier } from '../domain/resolver/service/ambiguity-classifier.js';
import { Calibrator } from '../domain/resolver/service/calibrator.js';
import { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import { BrowseRetriever } from '../domain/retrieval/service/browse-retriever.js';
import { CompareRetriever } from '../domain/retrieval/service/compare-retriever.js';
import { FusionService } from '../domain/retrieval/service/fusion.js';
import { Ranker } from '../domain/ranking/service/ranker.js';
import { SignalComputer } from '../domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../domain/ranking/service/evidence-mapper.js';
import { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import { ConfidenceRefusalPolicy } from '../domain/decision/service/confidence-refusal.js';
import { ResponseBuilder } from '../domain/response/service/response-builder.js';
import { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import { AnchorProfiler } from '../domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../domain/mixed/service/constraint-overlay.js';
import { NLMapper } from '../domain/attribute/service/nl-mapper.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { Config } from './env.js';
import type { CoreAdapterServices } from './container-adapters.js';
import type { RuntimeSupportServices } from './container-runtime-support.js';
import type {
  BrowseRetrieverPort,
  CompareRetrieverPort,
} from '../application/search/port/search-pipeline-deps.port.js';

export function buildSnapshotVersions(config: Config): SnapshotVersions {
  return {
    modelVersions: { embedding: config.embedding.model },
    indexVersions: { wine_content: config.vespa.contentCluster },
    featureFlags: {
      killSwitchAliasOverlay: config.killSwitch.aliasOverlay,
      killSwitchLearning: config.killSwitch.learning,
      killSwitchDenseRetrieval: config.killSwitch.denseRetrieval,
      killSwitchInjectionJudge: config.killSwitch.injectionJudge,
      killSwitchQueryCache: config.killSwitch.queryCache,
      watchlistEnabled: config.watchlist.enabled,
    },
  };
}

export async function buildCharNgramIndex(pool?: Pool): Promise<CharNgramIndex | undefined> {
  if (pool === undefined) return undefined;
  try {
    const { rows } = await pool.query<{ surface_form: string }>(
      'SELECT DISTINCT surface_form FROM aliases WHERE is_suppressed = FALSE',
    );
    const terms = rows.map((r) => r.surface_form);
    if (terms.length > 0) {
      const index = new CharNgramIndex();
      index.initialize(terms);
      return index;
    }
  } catch {
    // Alias table may not exist yet; proceed without char n-gram index.
  }
  return undefined;
}

export async function buildQueryPlanner(
  adapters: CoreAdapterServices,
  pool?: Pool,
): Promise<Planner> {
  let fuzzyMatcher: FuzzyMatcherPort | undefined;

  if (pool !== undefined) {
    try {
      const { rows } = await pool.query<{ surface_form: string }>(
        'SELECT DISTINCT surface_form FROM aliases WHERE is_suppressed = FALSE',
      );
      const terms = rows.map((r) => r.surface_form);
      if (terms.length > 0) {
        const fm = new FuzzyMatcher();
        fm.initialize(terms);
        fuzzyMatcher = fm;
      }
    } catch {
      // Alias table may not exist yet; proceed without fuzzy matching.
    }
  }

  return new Planner(
    adapters.ambiguityDict,
    new AnchorExtractor(adapters.aliasMatcher),
    new ExpansionBuilder(),
    new NLMapper(adapters.mappingTable),
    fuzzyMatcher,
  );
}

export function buildEntityResolver(adapters: CoreAdapterServices, config: Config): Resolver {
  return new Resolver(
    new Blocker(adapters.blockingPort),
    new CandidateScorer(),
    new AmbiguityClassifier(),
    new Calibrator(adapters.calibrationStore, {
      requireTrainedParams: config.nodeEnv === 'production',
    }),
    adapters.learnedMatcher,
  );
}

export function buildCandidatePool(
  adapters: CoreAdapterServices,
  support: RuntimeSupportServices,
  config: Config,
): CandidatePoolService {
  return new CandidatePoolService(
    adapters.searchIndex,
    adapters.embeddingService,
    new FusionService(),
    support.cacheService,
    config.embedding.model,
  );
}

export function buildBrowseRetriever(adapters: CoreAdapterServices): BrowseRetrieverPort {
  return new BrowseRetriever(adapters.searchIndex);
}

export function buildCompareRetriever(adapters: CoreAdapterServices): CompareRetrieverPort {
  return new CompareRetriever(adapters.searchIndex);
}

export function buildRanker(
  adapters: CoreAdapterServices,
  config: Config,
): Ranker {
  return new Ranker(
    new SignalComputer(),
    new ScoreAggregator(),
    new EvidenceMapper(),
    {
      reranker: adapters.reranker,
      rerankBlendScale: config.reranker.blendScale,
    },
  );
}

export function buildDecisionEngine(
  adapters: CoreAdapterServices,
  config: Config,
): DecisionEngine {
  const { threshold } = config.confidenceRefusal;
  const confidenceRefusalPolicy =
    threshold !== undefined ? new ConfidenceRefusalPolicy(threshold) : undefined;

  return new DecisionEngine(adapters.thresholdStore, confidenceRefusalPolicy);
}

export function buildResponseBuilder(): ResponseBuilder {
  return new ResponseBuilder();
}

export function buildMixedSolver(
  adapters: CoreAdapterServices,
  ranker: Ranker,
): MixedSolver {
  return new MixedSolver(
    adapters.anchorResolver,
    new AnchorProfiler(),
    adapters.similarRetrieval,
    adapters.candidateAttributes,
    new SimilarityScorer(),
    new ConstraintOverlay(),
    ranker,
  );
}
