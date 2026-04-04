import type { Pool } from 'pg';
import type { Config } from './env.js';
import { PgBlockingAdapter } from '../infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../infrastructure/adapter/pg-calibration-store.js';
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
import type { SearchIndexPort, SparseHit, DenseHit } from '../domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../domain/query/model/threshold-profile.js';
import type { ThresholdProfileV1 } from '../domain/query/model/threshold-profile.js';
import type { EntityId, QueryClass } from '../domain/shared/types/index.js';
import type { RetrievalDocument } from '../domain/retrieval/model/retrieval-document.js';
import type { AliasMatcher, AliasMatchResult } from '../domain/query/service/anchor-extractor.js';
import type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../domain/mixed/service/mixed-solver.js';
import { AnchorProfiler, type AnchorEntityData } from '../domain/mixed/service/anchor-profiler.js';
import { SimilarityScorer, type SimilarityCandidate } from '../domain/mixed/service/similarity-scorer.js';
import { ConstraintOverlay } from '../domain/mixed/service/constraint-overlay.js';
import type { AnchorProfile } from '../domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../domain/retrieval/model/hybrid-candidate.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';

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
// Stub / noop adapters for infrastructure ports
// These will be replaced by real implementations in the adapter layer.
// ────────────────────────────────────────────────────────────────

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

/** Stub SearchIndexPort: returns empty results. */
class StubSearchIndex implements SearchIndexPort {
  async sparseSearch(
    _queries: readonly string[],
    _filters?: readonly string[],
    _limit?: number,
  ): Promise<readonly SparseHit[]> {
    return [];
  }
  async denseSearch(
    _embedding: readonly number[],
    _filters?: readonly string[],
    _limit?: number,
  ): Promise<readonly DenseHit[]> {
    return [];
  }
  async getDocument(_entityId: EntityId): Promise<RetrievalDocument | null> {
    return null;
  }
  async upsertDocument(_doc: RetrievalDocument): Promise<void> {
    // noop
  }
  async bulkUpsert(_docs: readonly RetrievalDocument[]): Promise<void> {
    // noop
  }
}

/** Stub EmbeddingServicePort: returns zero vectors. */
class StubEmbeddingService implements EmbeddingServicePort {
  async embed(_text: string): Promise<readonly number[]> {
    return new Array<number>(768).fill(0);
  }
  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(() => new Array<number>(768).fill(0));
  }
}

/** Stub AnchorResolverPort: returns undefined. */
class StubAnchorResolver implements AnchorResolverPort {
  async resolve(_entityId: EntityId): Promise<AnchorEntityData | undefined> {
    return undefined;
  }
}

/** Stub SimilarRetrievalPort: returns empty results. */
class StubSimilarRetrieval implements SimilarRetrievalPort {
  async retrieveSimilar(
    _anchorProfile: AnchorProfile,
    _limit: number,
  ): Promise<readonly HybridCandidate[]> {
    return [];
  }
}

/** Stub CandidateAttributePort: returns empty maps. */
class StubCandidateAttributes implements CandidateAttributePort {
  async loadAttributes(
    _entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>> {
    return new Map();
  }
  async loadSimilarityCandidate(
    _entityId: EntityId,
  ): Promise<SimilarityCandidate | undefined> {
    return undefined;
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
 * When a `pool` is provided, real Postgres adapters are used for the
 * blocking and calibration ports (PgBlockingAdapter, PgCalibrationStore).
 * Without a pool the container falls back to stub/noop implementations so
 * the application can still start without a database (e.g. in CI or during
 * integration testing of the query-planning layer).
 *
 * IMPORTANT: StubBlockingPort always returns [] — entity resolution will
 * produce 0 candidates and decisionConfidence=0 whenever the real
 * PgBlockingAdapter is not wired.  Always provide a pool in production.
 *
 * @param _config - Application configuration (currently unused; reserved for
 *                  future per-environment adapter setup).
 * @param pool    - Optional Postgres pool.  Provide in production.
 * @returns The fully wired container.
 */
export function createContainer(_config: Config, pool?: Pool): Container {
  // Wire real Postgres adapters when a pool is available; fall back to stubs.
  const blockingPort: BlockingPort = pool
    ? new PgBlockingAdapter(pool)
    : new StubBlockingPort();

  const calibrationStore: CalibrationStore = pool
    ? new PgCalibrationStore(pool)
    : new StubCalibrationStore();

  // Infrastructure port stubs (no real implementation yet)
  const ambiguityDict = new StubAmbiguityDictionary();
  const searchIndex = new StubSearchIndex();
  const embeddingService = new StubEmbeddingService();
  const thresholdStore = new StubThresholdStore();

  // Domain services — query planning
  const aliasMatcher = new StubAliasMatcher();
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const queryPlanner = new Planner(ambiguityDict, anchorExtractor, expansionBuilder);

  // Domain services — entity resolution
  const blocker = new Blocker(blockingPort);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(
    blocker,
    candidateScorer,
    ambiguityClassifier,
    calibrator,
  );

  // Domain services — retrieval
  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(
    searchIndex,
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

  const anchorResolver = new StubAnchorResolver();
  const anchorProfiler = new AnchorProfiler();
  const similarRetrieval = new StubSimilarRetrieval();
  const candidateAttributes = new StubCandidateAttributes();
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

  // Build RFC-015 snapshot version info from config.
  // These populate model_versions and index_versions in every DecisionSnapshot.
  const snapshotVersions: SnapshotVersions = {
    modelVersions: {
      embedding: _config.embedding.model,
    },
    indexVersions: {
      wine_content: _config.vespa.contentCluster,
    },
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

/**
 * Creates a stub Ranker that returns empty results.
 *
 * The Ranker constructor requires SignalComputer, ScoreAggregator, and
 * EvidenceMapper which are internal to the ranking domain and may not
 * exist yet. We use a duck-typed proxy until those services are available.
 */
