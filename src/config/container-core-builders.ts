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
import {
  InMemoryBudgetLedger,
  type BudgetLedger,
  type BudgetLedgerOptions,
} from '../domain/retrieval/service/budget-ledger.js';
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
import { AmbiguityIntentCompiler } from '../domain/query/service/ambiguity-intent-compiler.js';
import type { PhraseCachePort } from '../domain/attribute/port/phrase-cache.port.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import { ConstraintTopologyPlanner } from '../domain/query/service/constraint-topology-planner.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { Config } from './env.js';
import type { CoreAdapterServices } from './container-adapters.js';
import type { RuntimeSupportServices } from './container-runtime-support.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { validateFeatureFlagsAtStartup } from './feature-flag-coherence.js';
import { resolveActiveSnapshot } from '../infrastructure/db/active-snapshot-resolver.js';
import { globalSilentSkipCounter } from '../domain/observability/silent-skip-counters.js';
import { getRetrievalDegradationCollector } from '../infrastructure/observability/retrieval-degradation-metrics.js';
import type {
  BlockingUseCasePort,
  BrowseRetrieverPort,
  CompareRetrieverPort,
} from '../application/search/port/search-pipeline-deps.port.js';

/** Default blocking limit for standard queries. */
const BLOCKER_DEFAULT_LIMIT = 100;
/** Broader blocking limit for corrective retry recall expansion (TA3). */
const BLOCKER_BROADER_LIMIT = 200;

export function buildSnapshotVersions(config: Config): SnapshotVersions {
  return {
    modelVersions: {
      dense_model: config.embedding.model,
      reranker_model: process.env['COHERE_RERANK_MODEL'] ?? 'rerank-v4.0-pro',
    },
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
  // ADR-018 Wave F3: reject incoherent feature flag combinations BEFORE
  // constructing any planner dependencies. A mis-configured container
  // MUST refuse to start — see docs/adr/018-feature-flag-coherence.md
  // for the full rule set and rationale. The validator is cached per
  // process via validateFeatureFlagsAtStartup, so repeated builder
  // invocations in tests do not re-read env.
  validateFeatureFlagsAtStartup();

  let fuzzyMatcher: FuzzyMatcherPort | undefined;

  if (pool !== undefined) {
    try {
      // Migration 016: snapshot-scoped read. Warmup must not blend surface
      // forms across snapshots — reaped or stale snapshot aliases would
      // poison the fuzzy-matcher corpus otherwise. `resolveActiveSnapshot`
      // returns the authoritative pointer; if the pointer table itself is
      // missing we degrade cleanly below.
      const { activeSnapshotId } = await resolveActiveSnapshot(pool);
      const { rows } = await pool.query<{ surface_form: string }>(
        `SELECT DISTINCT surface_form
         FROM aliases
         WHERE search_snapshot_id = $1 AND is_suppressed = FALSE
         LIMIT 100000`,
        [activeSnapshotId],
      );
      const terms = rows.map((r) => r.surface_form);
      if (terms.length > 0) {
        const fm = new FuzzyMatcher();
        fm.initialize(terms);
        fuzzyMatcher = fm;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== '42P01') {
        throw err;
      }
      // Snapshot pointer or aliases table does not exist yet (fresh DB before
      // first publish). Learning-side warmup is a bootstrap enhancement, not
      // a required dependency — degrade cleanly and count the skip.
      globalSilentSkipCounter.increment(
        'learning_warmup_disabled_snapshot_pointer_missing',
        { surface: 'container-core-builders' },
      );
      bootstrapLogger.info('[Planner] snapshot pointer / aliases table missing — fuzzy matching disabled');
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

  // ADR-012 Phase 1b.2 + Wave I4: auto-instantiate the
  // ConstraintTopologyPlanner whenever a ChatLlmPort is available.
  //
  // Container-vs-compiler gate separation:
  //   - The container gate (here) controls *construction*: the planner
  //     instance must exist for the compiler to ever invoke it.
  //   - The compiler gate (constraint-compiler.ts
  //     `isConstraintGraphTopologyLlmEnabled()`) controls *invocation*
  //     per-request by re-reading `CONSTRAINT_GRAPH_TOPOLOGY_LLM` on
  //     every `compile()` call.
  const topologyPlanner =
    chatLlm !== undefined
      ? new ConstraintTopologyPlanner(chatLlm)
      : undefined;
  const ambiguityIntentCompiler =
    chatLlm !== undefined
      ? new AmbiguityIntentCompiler(chatLlm)
      : undefined;

  return new Planner(
    adapters.ambiguityDict,
    new AnchorExtractor(adapters.aliasMatcher),
    new ExpansionBuilder(),
    nlMapper,
    fuzzyMatcher,
    topologyPlanner,
    ambiguityIntentCompiler,
  );
}

/**
 * TA2-T5: Adapts the domain-layer Blocker to the application-layer
 * BlockingUseCasePort so that SearchUseCase, HybridUseCase, and
 * ResolveUseCase can all consume the blocker without depending on
 * the domain resolver internals.
 *
 * Maps `options.broader = true` to a higher blocking limit (BLOCKER_BROADER_LIMIT)
 * for corrective retry recall expansion (TA3).
 */
export function buildBlockingUseCaseAdapter(adapters: CoreAdapterServices): BlockingUseCasePort {
  const blocker = new Blocker(adapters.blockingPort);
  return {
    block: (
      query: string,
      normalizedQuery: string,
      options?: { readonly broader?: boolean },
    ) => blocker.block(query, normalizedQuery, {
      limit: options?.broader === true ? BLOCKER_BROADER_LIMIT : BLOCKER_DEFAULT_LIMIT,
    }),
  };
}

export function buildEntityResolver(adapters: CoreAdapterServices, config: Config): Resolver {
  return new Resolver(
    new Blocker(adapters.blockingPort),
    new CandidateScorer(),
    new AmbiguityClassifier(),
    new Calibrator(adapters.calibrationStore, {
      requireTrainedParams: config.nodeEnv === 'production',
      // P0.1: surface the env-driven TTL so AdmissionGate trust is gated on
      // nightly-pipeline freshness rather than the legacy `trained_at`
      // back-fill timestamp.
      calibrationTtlDays: config.calibration.ttlDays,
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

/**
 * ADR-013 Phase 1c.x: factory for per-request {@link BudgetLedger}
 * instances. Returns a *factory function*, not a ledger — the ledger
 * itself is per-request state (reservations MUST NOT leak across
 * requests, which would constitute a cross-request race condition).
 *
 * Call this factory from the hybrid-candidates retrieval flow on every
 * request; dispose by letting the instance fall out of scope at the
 * end of the request lifecycle. A central builder is kept here (rather
 * than inlining `new InMemoryBudgetLedger(...)` in the hybrid-candidates
 * path alone) so the composition root has a single wire-up call-site
 * visible to audit tools (rule 33 — ensure new capabilities are
 * imported by a composition root).
 */
export function buildBudgetLedgerFactory(): (
  options?: BudgetLedgerOptions,
) => BudgetLedger {
  return (options) => new InMemoryBudgetLedger(options ?? {});
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
  // Epic 17.3: ConfidenceRefusalPolicy is on by default. The threshold is
  // sourced from env (CONFIDENCE_REFUSAL_THRESHOLD), which carries the
  // AURC-calibrated 0.45 default when the operator hasn't overridden it.
  // The policy is always instantiated so the AdmissionGate's confidence-floor
  // check (§e) never silently no-ops — pre-fix wiring made the policy
  // conditional on the env being explicitly set, which left prod with the
  // hallucination guard disabled until someone remembered to flip the flag.
  // To effectively disable, set CONFIDENCE_REFUSAL_THRESHOLD=0 (NaN is still
  // refused since it's treated as zero confidence).
  const confidenceRefusalPolicy = new ConfidenceRefusalPolicy(
    config.confidenceRefusal.threshold,
  );

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
