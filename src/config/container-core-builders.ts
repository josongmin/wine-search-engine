import { Planner } from '../domain/query/service/planner.js';
import { AnchorExtractor } from '../domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../domain/query/service/expansion-builder.js';
import type { Pool } from 'pg';
import { FuzzyMatcher } from '../domain/query/service/fuzzy-matcher.js';
import type { FuzzyMatcherPort } from '../domain/query/port/fuzzy-matcher.port.js';
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
import { RankingStagePipeline } from '../domain/ranking/service/ranking-stage-pipeline.js';
import { SignalComputer } from '../domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../domain/ranking/service/evidence-mapper.js';
import { DefaultRankingPolicy } from '../domain/ranking/service/default-ranking-policy.js';
import { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import { ConfidenceRefusalPolicy } from '../domain/decision/service/confidence-refusal.js';
import { ResponseBuilder } from '../domain/response/service/response-builder.js';
import { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import { AnchorProfiler } from '../domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer } from '../domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../domain/mixed/service/constraint-overlay.js';
import { NLMapper } from '../domain/attribute/service/nl-mapper.js';
import { LlmNLMapper } from '../domain/attribute/service/llm-nl-mapper.js';
import type { PhraseCachePort } from '../domain/attribute/port/phrase-cache.port.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { Config } from './env.js';
import type { CoreAdapterServices } from './container-adapters.js';
import type { RuntimeSupportServices } from './container-runtime-support.js';
import { bootstrapLogger } from './bootstrap-logger.js';
import { getRetrievalDegradationCollector } from '../infrastructure/observability/retrieval-degradation-metrics.js';
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

export async function buildQueryPlanner(
  adapters: CoreAdapterServices,
  pool?: Pool,
  chatLlm?: ChatLlmPort,
  llmQueryInterpreter?: boolean,
  llmQueryInterpreterTimeoutMs?: number,
  phraseCache?: PhraseCachePort,
): Promise<Planner> {
  let fuzzyMatcher: FuzzyMatcherPort | undefined;

  if (pool !== undefined) {
    try {
      const { rows } = await pool.query<{ surface_form: string }>(
        'SELECT DISTINCT surface_form FROM aliases WHERE is_suppressed = FALSE LIMIT 100000',
      );
      const terms = rows.map((r) => r.surface_form);
      if (terms.length > 0) {
        const fm = new FuzzyMatcher();
        fm.initialize(terms);
        fuzzyMatcher = fm;
      }
    } catch (err: unknown) {
      // Catch ONLY "relation does not exist" (PG SQLSTATE 42P01).
      // Any other error — pool exhaustion, auth failure, network flap —
      // must propagate so the operator notices instead of silently
      // running production with no fuzzy matching.
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== '42P01') {
        throw err;
      }
      // Alias table may not exist yet; proceed without fuzzy matching.
      bootstrapLogger.info('[Planner] aliases table does not exist yet — fuzzy matching disabled');
    }
  }

  // Defense-in-depth: env validation already throws when LLM_QUERY_INTERPRETER
  // is true and OPENAI_API_KEY is unset (see config/env.ts). If we reach this
  // point with the flag enabled but no chatLlm, fail loudly rather than
  // silently falling back to the rule-only mapper.
  if (llmQueryInterpreter === true && chatLlm === undefined) {
    throw new Error(
      'LLM_QUERY_INTERPRETER=true but no ChatLlm was constructed — check OPENAI_API_KEY and chatLlm wiring',
    );
  }
  const nlMapper = llmQueryInterpreter && chatLlm !== undefined
    ? new LlmNLMapper(adapters.mappingTable, chatLlm, llmQueryInterpreterTimeoutMs, phraseCache, fuzzyMatcher)
    : new NLMapper(adapters.mappingTable);

  return new Planner(
    adapters.ambiguityDict,
    new AnchorExtractor(adapters.aliasMatcher),
    new ExpansionBuilder(),
    nlMapper,
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
    // Mirror the CandidatePoolService kill-switch guard: when KILL_SWITCH_LEARNING is true,
    // suppress the learned-matcher blend in the Resolver as well. Without this guard,
    // KILL_SWITCH_LEARNING=true disables SPLADE retrieval but the learned-matcher service
    // is still called on every entity resolution — defeating the kill switch's intent.
    config.killSwitch.learning ? undefined : adapters.learnedMatcher,
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
    config.killSwitch.learning,
    getRetrievalDegradationCollector(),
    config.killSwitch.denseRetrieval,
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
  support?: RuntimeSupportServices,
): Ranker {
  if (support?.ltrModels === undefined) {
    bootstrapLogger.warn('[Ranker] ltrModels not configured — LTR reranking disabled for all query classes');
  } else if (support.ltrModels.size === 0) {
    bootstrapLogger.warn('[Ranker] ltrModels is an empty Map — LTR reranking will be skipped for all query classes');
  }

  return new Ranker(
    new SignalComputer(),
    new ScoreAggregator(),
    new EvidenceMapper(),
    {
      ...(adapters.reranker !== undefined ? { reranker: adapters.reranker } : {}),
      rerankBlendScale: config.reranker.blendScale,
      ltrModels: support?.ltrModels,
    },
  );
}

export function buildRankingPipeline(ranker: Ranker): RankingStagePipeline {
  return new RankingStagePipeline(ranker, {
    policy: new DefaultRankingPolicy(),
  });
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
  ranker: RankingStagePipeline,
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
