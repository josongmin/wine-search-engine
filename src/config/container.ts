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
import { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import { SearchUseCase } from '../application/search/search.usecase.js';
import { ReplayUseCase } from '../application/search/replay.usecase.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
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
}

// ────────────────────────────────────────────────────────────────
// Minimal stub adapters — used only when real infrastructure is
// unavailable (e.g. integration tests without a live database).
// ────────────────────────────────────────────────────────────────

/** Stub BlockingPort: returns no candidates. */
class StubBlockingPort implements BlockingPort {
  async block(
    _query: string,
    _normalizedQuery: string,
    _limit?: number,
  ): Promise<readonly EntityId[]> {
    return [];
  }
}

/** Stub CalibrationStore: returns null (no trained params). */
class StubCalibrationStore implements CalibrationStore {
  async getCalibrationParams(_queryClass: QueryClass): Promise<CalibrationParams | null> {
    return null;
  }
  async save(_queryClass: QueryClass, _params: CalibrationParams): Promise<void> {
    // noop
  }
}

/** Stub EmbeddingServicePort: returns zero vectors. */
class StubEmbeddingService implements EmbeddingServicePort {
  async embed(_text: string): Promise<readonly number[]> {
    return new Array<number>(128).fill(0);
  }
  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(() => new Array<number>(128).fill(0));
  }
}

/** Stub AmbiguityDictionary: reports nothing as ambiguous. */
class StubAmbiguityDictionary implements AmbiguityDictionary {
  async isKnownAmbiguous(_term: string): Promise<boolean> {
    return false;
  }
  async getAmbiguityInfo(
    _term: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    return null;
  }
}

/** Stub AliasMatcher: returns no matches. */
class StubAliasMatcher implements AliasMatcher {
  async findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return [];
  }
}

/** Stub ThresholdStore: returns the default profile. */
class StubThresholdStore implements ThresholdStore {
  async getProfile(_id: string): Promise<ThresholdProfileV1 | null> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async getDefault(): Promise<ThresholdProfileV1> {
    return DEFAULT_THRESHOLD_PROFILE;
  }
  async save(_profile: ThresholdProfileV1): Promise<void> {
    // noop
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
export function createContainer(_config: Config, pool?: Pool): Container {
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

  // ── Domain services — retrieval ───────────────────────────────────────────
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(
    searchIndex,
    embeddingService,
    fusionService,
  );

  // ── Domain services — ranking ─────────────────────────────────────────────
  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper, reranker);

  // ── Domain services — decision, response, mixed ───────────────────────────
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

  // ── RFC-015 snapshot version info ─────────────────────────────────────────
  const snapshotVersions: SnapshotVersions = {
    modelVersions: {
      embedding: _config.embedding.model,
    },
    indexVersions: {
      wine_content: _config.vespa.contentCluster,
    },
  };

  // ── Use cases ─────────────────────────────────────────────────────────────
  const searchUseCase = new SearchUseCase({
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    snapshotVersions,
  });

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
  };
}
