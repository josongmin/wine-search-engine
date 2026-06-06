/**
 * Vespa-backed test DI container.
 *
 * Wires the application stack with:
 * - Real VespaSearchIndex
 * - Optional real PostgreSQL-backed lookup/decision stores when TEST_DB_URL is set
 * - In-memory fallbacks for the remaining adapters so the suite can still run
 *   in lighter environments
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { DrinkingWindowPredictorPort } from '../../../../src/domain/drinking-window/port/drinking-window-predictor.port.js';
import { Planner } from '../../../../src/domain/query/service/planner.js';
import { PlannerV1Adapter } from '../../../../src/config/planner-v1-adapter.js';
import { AnchorExtractor } from '../../../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../../../src/domain/query/service/expansion-builder.js';
import { normalizeQueryStrict } from '../../../../src/domain/query/service/query-normalizer.js';
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
import { InterpretUseCase } from '../../../../src/application/search/interpret.usecase.js';
import { ResolveUseCase } from '../../../../src/application/search/resolve.usecase.js';
import { AutocompleteUseCase } from '../../../../src/application/search/autocomplete.usecase.js';
import { HybridUseCase } from '../../../../src/application/search/hybrid.usecase.js';
import type { Container } from '../../../../src/config/container.js';
import type { SnapshotVersions } from '../../../../src/application/search/search.usecase.js';
import { VespaClient } from '../../../../src/infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../../../../src/infrastructure/vespa/vespa-search-index.js';
import { HttpLearnedMatcherAdapter } from '../../../../src/infrastructure/adapter/http-learned-matcher.js';
import type { EmbeddingServicePort } from '../../../../src/domain/retrieval/port/embedding-service.port.js';
import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../../../src/domain/ranking/port/reranker.port.js';
import { PgAliasMatcher } from '../../../../src/infrastructure/adapter/pg-alias-matcher.js';
import { PgAmbiguityDictionary } from '../../../../src/infrastructure/adapter/pg-ambiguity-dictionary.js';
import { PgBlockingAdapter } from '../../../../src/infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../../../../src/infrastructure/adapter/pg-calibration-store.js';
import { PgThresholdStore } from '../../../../src/infrastructure/adapter/pg-threshold-store.js';
import { PgLtrModelRegistry } from '../../../../src/infrastructure/adapter/pg-ltr-model-registry.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../../../src/domain/query/model/threshold-profile.js';
import {
  FallbackAmbiguityDictionary,
  StaticAmbiguityDictionary,
} from '../../../../src/domain/query/service/static-ambiguity-dictionary.js';
import type { QueryClassWeights } from '../../../../src/domain/ranking/index.js';
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
import type { EntityId } from '../../../../src/domain/shared/types/index.js';

const VESPA_NAMESPACE = 'wine';
const VESPA_DOC_TYPE = 'wine_entity';
const TEST_DB_URL = process.env['TEST_DB_URL'] ?? process.env['PG_TEST_URL'];

type AmbiguitySeverity = 'low' | 'medium' | 'high';

async function applyMigrations(pool: Pool): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../src/infrastructure/db/migrations',
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }
}

async function resetPgFixtures(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      threshold_profiles,
      calibration_params,
      ambiguity_registry,
      aliases
    RESTART IDENTITY
    CASCADE
  `);
}

async function seedDefaultThresholdProfile(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO threshold_profiles (profile_id, profile_data, is_default, updated_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (profile_id) DO UPDATE SET
       profile_data = EXCLUDED.profile_data,
       is_default = TRUE,
       updated_at = NOW()`,
    [DEFAULT_THRESHOLD_PROFILE.id, JSON.stringify(DEFAULT_THRESHOLD_PROFILE)],
  );
}

/**
 * Counting embedding service for the Vespa e2e lane.
 *
 * Produces deterministic in-memory hash vectors (real Vespa sparse+dense
 * retrieval still runs against the live index) and records how many times the
 * dense channel asked for an embedding, so tests can assert the dense path was
 * exercised. Replaces the removed `HttpEmbeddingService`
 * (`src/infrastructure/vespa/embedding-service.ts`, deleted in c4fba804 on
 * 2026-04-13) — production embeddings moved to `OpenAiEmbeddingService` and no
 * longer flow over an internal HTTP ML service.
 */
class CountingEmbeddingService implements EmbeddingServicePort {
  private readonly inner = new InMemoryEmbeddingService();
  embedCalls = 0;

  async embed(text: string): Promise<readonly number[]> {
    this.embedCalls += 1;
    return this.inner.embed(text);
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.embedCalls += texts.length;
    return this.inner.embedBatch(texts);
  }
}

/**
 * Deterministic, no-network stub reranker for the Vespa e2e lane.
 *
 * Preserves candidate order with descending scores and records invocation
 * count so tests can assert the rerank step was wired in. Replaces the removed
 * `HttpCrossEncoderReranker` (`src/infrastructure/vespa/reranker.ts`, deleted in
 * 094fb76b on 2026-04-11) — cross-encoder rerank moved to `CohereReranker` /
 * `CachedReranker` (external APIs) in production, so the e2e uses a stub to keep
 * the rerank wiring under test without an external call.
 */
class StubReranker implements RerankerPort {
  readonly modelId = 'vespa-e2e-stub-reranker';
  rerankCalls = 0;

  async rerank(
    _query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
    this.rerankCalls += 1;
    const denominator = candidates.length > 0 ? candidates.length : 1;
    return candidates.slice(0, limit).map((candidate, index) => ({
      entityId: candidate.entityId,
      score: 1 - index / denominator,
      rank: index + 1,
    }));
  }
}

export interface VespaTestContainerParts {
  readonly container: Container;
  readonly vespaClient: VespaClient;
  readonly vespaSearchIndex: VespaSearchIndex;
  readonly vespaUrl: string;
  readonly usesPgBackedLookup: boolean;
  /** Number of dense-channel embedding requests served so far. */
  embeddingInvocations(): number;
  /** Number of rerank invocations served so far. */
  rerankInvocations(): number;
  seedAlias(surfaceForm: string, entityId: EntityId, confidence: number): Promise<void>;
  seedBlockingEntities(entityIds: readonly EntityId[]): Promise<void>;
  seedAmbiguity(
    normalizedForm: string,
    ambiguityTypes: readonly string[],
    severity: AmbiguitySeverity,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface VespaTestContainerOptions {
  readonly mlServiceBaseUrl?: string;
  readonly rerankThreshold?: number;
  readonly mlServiceHttpTimeoutMs?: number;
  readonly killSwitchLearning?: boolean;
  readonly disableDrinkingWindow?: boolean;
  readonly drinkingWindowPredictor?: DrinkingWindowPredictorPort;
}

export async function createVespaTestContainer(
  options: VespaTestContainerOptions = {},
): Promise<VespaTestContainerParts> {
  const vespaUrl = process.env['VESPA_URL'] ?? 'http://localhost:18080';
  const vespaClient = new VespaClient(vespaUrl, VESPA_NAMESPACE, VESPA_DOC_TYPE);
  const vespaSearchIndex = new VespaSearchIndex(vespaClient);

  const pool = TEST_DB_URL !== undefined
    ? new Pool({
        connectionString: TEST_DB_URL,
        max: 4,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 5_000,
      })
    : null;

  if (pool !== null) {
    await applyMigrations(pool);
    await resetPgFixtures(pool);
    await seedDefaultThresholdProfile(pool);
  }

  const ambiguityDict = pool ? new PgAmbiguityDictionary(pool) : new InMemoryAmbiguityDictionary();
  const plannerAmbiguityDict = new FallbackAmbiguityDictionary(
    ambiguityDict,
    new StaticAmbiguityDictionary(),
  );
  const blockingAdapter = pool ? new PgBlockingAdapter(pool) : new InMemoryBlockingAdapter();
  const calibrationStore = pool ? new PgCalibrationStore(pool) : new InMemoryCalibrationStore();
  // Embeddings no longer flow over an HTTP ML service (HttpEmbeddingService was
  // removed in c4fba804). Use a deterministic counting wrapper; real Vespa
  // sparse+dense retrieval still runs against the live index.
  const embeddingService = new CountingEmbeddingService();
  const thresholdStore = pool ? new PgThresholdStore(pool) : new InMemoryThresholdStore();
  const aliasMatcher = pool ? new PgAliasMatcher(pool) : new InMemoryAliasMatcher();
  const anchorResolver = new InMemoryAnchorResolver();
  const similarRetrieval = new InMemorySimilarRetrieval();
  const candidateAttributes = new InMemoryCandidateAttributes();
  const querySanitizer = new QuerySanitizer();
  const injectionJudge = { judge: async () => false };
  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool !== null) {
    ltrModels = await new PgLtrModelRegistry(pool).getAllModels();
  }

  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  const noOpMappingTable: MappingTablePort = {
    findMapping: () => Promise.resolve(null),
    findMappingsByAttribute: () => Promise.resolve([]),
    getCurrentVersion: () => Promise.resolve('v1'),
  };
  const nlMapper = new NLMapper(noOpMappingTable);
  const queryPlanner = new PlannerV1Adapter(
    new Planner(
      plannerAmbiguityDict,
      anchorExtractor,
      expansionBuilder,
      nlMapper,
    ),
  );

  const blocker = new Blocker(blockingAdapter);
  const candidateScorer = new CandidateScorer();
  const ambiguityClassifier = new AmbiguityClassifier();
  const calibrator = new Calibrator(calibrationStore);
  const entityResolver = new Resolver(
    blocker,
    candidateScorer,
    ambiguityClassifier,
    calibrator,
    options.mlServiceBaseUrl !== undefined
      ? new HttpLearnedMatcherAdapter({
          url: options.mlServiceBaseUrl,
          ...(options.mlServiceHttpTimeoutMs !== undefined
            ? { httpTimeoutMs: options.mlServiceHttpTimeoutMs }
            : {}),
        })
      : undefined,
  );

  const fusionService = new FusionService();
  const candidatePool = new CandidatePoolService(
    vespaSearchIndex,
    embeddingService,
    fusionService,
    undefined,
    undefined,
    options.killSwitchLearning ?? false,
  );

  const signalComputer = new SignalComputer();
  const scoreAggregator = new ScoreAggregator();
  const evidenceMapper = new EvidenceMapper();
  // Cross-encoder rerank moved to CohereReranker/CachedReranker (external APIs);
  // the removed HttpCrossEncoderReranker no longer exists. Use a deterministic
  // no-network stub so the rerank wiring stays under test.
  const reranker = new StubReranker();
  const ranker = new Ranker(signalComputer, scoreAggregator, evidenceMapper, {
    reranker,
    ...(options.rerankThreshold !== undefined
      ? { rerankThreshold: options.rerankThreshold }
      : {}),
  });

  const decisionEngine = new DecisionEngine(thresholdStore);
  const responseBuilder = new ResponseBuilder();
  const anchorProfiler = new AnchorProfiler();
  const similarityScorer = new SimilarityScorer();
  const constraintOverlay = new ConstraintOverlay();
  const judgeTimeoutMs = 5_000;

  const mixedSolver = new MixedSolver(
    anchorResolver,
    anchorProfiler,
    similarRetrieval,
    candidateAttributes,
    similarityScorer,
    constraintOverlay,
    ranker,
  );

  const snapshotVersions: SnapshotVersions = {
    modelVersions: { embedding: 'in-memory-hash-v1' },
    indexVersions: { wine_content: 'vespa-e2e-test' },
    featureFlags: {},
  };
  const defaultDrinkingWindowPredictor = {
    modelVersion: 'deterministic:vespa-test',
    predict: () => ({
      drinkingWindowStart: 2020,
      drinkingWindowEnd: 2030,
      peakYear: 2025,
      confidence: 'medium' as const,
      modelVersion: 'deterministic:vespa-test',
    }),
  };
  const drinkingWindowPredictor =
    options.drinkingWindowPredictor ?? defaultDrinkingWindowPredictor;
  const drinkingWindowUseCase = new DrinkingWindowUseCase(drinkingWindowPredictor);

  const searchUseCase = new SearchUseCase({
    queryPlanner,
    entityResolver,
    entityLookup: vespaSearchIndex,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    snapshotVersions,
    ...(!options.disableDrinkingWindow ? { drinkingWindow: drinkingWindowUseCase } : {}),
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
    ltrModels,
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
    entityLookup: vespaSearchIndex,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
  });
  const autocompleteUseCase = new AutocompleteUseCase({
    resolveUseCase,
    entityLookup: vespaSearchIndex,
  });
  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  const hybridUseCase = new HybridUseCase({
    queryPlanner,
    candidatePool,
    entityResolver,
    entityLookup: vespaSearchIndex,
    ranker,
    decisionEngine,
    responseBuilder,
    snapshotVersions,
    drinkingWindow: drinkingWindowUseCase,
    ltrModels,
    querySanitizer,
    injectionJudge,
    judgeTimeoutMs,
    judgeFailureMode: 'fail_closed',
    decomposedSearch: decomposedSearchUseCase,
  });
  const batchSearchUseCase = new BatchSearchUseCase(searchUseCase);
  const container = {
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine,
    responseBuilder,
    mixedSolver,
    searchUseCase,
    interpretUseCase,
    resolveUseCase,
    autocompleteUseCase,
    hybridUseCase,
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    drinkingWindowPredictor,
    batchSearchUseCase,
    evalRunner: null,
    calibrationStore,
    runtimeReadiness: {} as never,
  } satisfies Container;

  return {
    container,
    vespaClient,
    vespaSearchIndex,
    vespaUrl,
    usesPgBackedLookup: pool !== null,
    embeddingInvocations: () => embeddingService.embedCalls,
    rerankInvocations: () => reranker.rerankCalls,
    async seedAlias(surfaceForm, entityId, confidence) {
      if (pool === null) {
        (aliasMatcher as InMemoryAliasMatcher).addAlias(surfaceForm, entityId, confidence);
        return;
      }

      await pool.query(
        `INSERT INTO aliases (
          alias_id, entity_id, alias_type, alias_scope, surface_form,
          normalized_value, language, source, source_trust, confidence, is_suppressed
        ) VALUES ($1, $2, 'identity_safe', 'global', $3, $4, NULL, 'vespa-e2e', 1.0, $5, FALSE)`,
        [randomUUID(), entityId, surfaceForm, normalizeQueryStrict(surfaceForm), confidence],
      );
    },
    async seedBlockingEntities(_entityIds) {
      if (pool === null) {
        (blockingAdapter as InMemoryBlockingAdapter).addEntityIds(_entityIds);
      }
    },
    async seedAmbiguity(normalizedForm, ambiguityTypes, severity) {
      if (pool === null) {
        (ambiguityDict as InMemoryAmbiguityDictionary).setAmbiguous(
          normalizedForm,
          [...ambiguityTypes],
          severity,
        );
        return;
      }

      await pool.query(
        `INSERT INTO ambiguity_registry (
          registry_id, normalized_form, entity_ids, ambiguity_types, severity
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (normalized_form) DO UPDATE SET
          entity_ids = EXCLUDED.entity_ids,
          ambiguity_types = EXCLUDED.ambiguity_types,
          severity = EXCLUDED.severity,
          updated_at = NOW()`,
        [randomUUID(), normalizedForm, [], ambiguityTypes, severity],
      );
    },
    async close() {
      if (pool !== null) {
        await resetPgFixtures(pool);
        await pool.end();
      }
    },
  };
}
