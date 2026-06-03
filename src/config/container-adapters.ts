import type { Pool } from 'pg';
import { PgBlockingAdapter } from '../infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../infrastructure/adapter/pg-calibration-store.js';
import { PgAmbiguityDictionary } from '../infrastructure/adapter/pg-ambiguity-dictionary.js';
import { PgThresholdStore } from '../infrastructure/adapter/pg-threshold-store.js';
import { PgRefusalThresholdStore } from '../infrastructure/adapter/pg-refusal-threshold-store.js';
import {
  CascadingAliasMatcher,
  ExactOnlySecondaryAliasMatcher,
  SearchIndexAliasMatcher,
} from '../infrastructure/adapter/search-index-alias-matcher.js';
import { FileMappingTableAdapter } from '../infrastructure/adapter/file-mapping-table.js';
import { HttpLearnedMatcherAdapter } from '../infrastructure/adapter/http-learned-matcher.js';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SnapshotScopedSearchIndex } from '../infrastructure/adapter/snapshot-scoped-search-index.js';
import { CachedAliasMatcher } from '../infrastructure/adapter/cached-alias-matcher.js';
import { LazyFuzzyMatcher } from '../infrastructure/adapter/lazy-fuzzy-matcher.js';
import { UnavailableFastFailSearchIndex } from '../infrastructure/adapter/unavailable-fast-fail-search-index.js';
import { VespaClient } from '../infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../infrastructure/vespa/vespa-search-index.js';
import { OpenAiEmbeddingService } from '../infrastructure/ai/openai-embedding-service.js';
import { OpenAiDoc2QueryGenerator } from '../infrastructure/ai/openai-doc2query-generator.js';
import { StubDoc2QueryGenerator } from '../infrastructure/adapter/stub-doc2query-generator.js';
import { createChatLlmFromEnv } from '../infrastructure/ai/chat-llm-from-env.js';
import { CohereReranker } from '../infrastructure/ai/cohere-reranker.js';
import { CachedReranker } from '../infrastructure/ai/cached-reranker.js';
import { VespaAnchorResolver } from '../infrastructure/vespa/vespa-anchor-resolver.js';
import { VespaSimilarRetrieval } from '../infrastructure/vespa/vespa-similar-retrieval.js';
import { VespaCandidateAttributes } from '../infrastructure/vespa/vespa-candidate-attributes.js';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import type { AmbiguityDictionary } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { SearchIndexPort } from '../domain/retrieval/port/search-index.port.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import type { FuzzyMatcherPort } from '../domain/query/port/fuzzy-matcher.port.js';
import type { RefusalThresholdProvider } from '../domain/decision/port/refusal-threshold-provider.port.js';
import type { AliasMatcher } from '../domain/query/service/anchor-extractor.js';
import type { MappingTablePort } from '../domain/attribute/port/mapping-table.port.js';
import type {
  AnchorResolverPort,
  CandidateAttributePort,
  SimilarRetrievalPort,
} from '../domain/mixed/port/mixed-query.port.js';
import type { LearnedMatcherPort } from '../domain/resolver/port/learned-matcher.port.js';
import type { RerankerPort } from '../domain/ranking/port/reranker.port.js';
import type { Doc2QueryGeneratorPort } from '../domain/retrieval/port/doc2query-generator.port.js';
import {
  FallbackAmbiguityDictionary,
  StaticAmbiguityDictionary,
} from '../domain/query/service/static-ambiguity-dictionary.js';
import {
  StubAmbiguityDictionary,
  StubBlockingPort,
  StubCalibrationStore,
  StubEmbeddingService,
  StubThresholdStore,
} from './container-stubs.js';

export interface CoreAdapterServices {
  readonly searchIndex: SearchIndexPort;
  readonly embeddingService: EmbeddingServicePort;
  /** Present when an OpenAI credential pool or Codex ChatGPT login token is available. */
  readonly chatLlm?: ChatLlmPort;
  readonly reranker?: RerankerPort;
  /**
   * Doc2Query generator used by index-time ETL only.
   *
   * Backed by the OpenAI chat LLM when an OpenAI credential is set; otherwise
   * a deterministic stub so dev / test environments can boot the
   * container without an API key.
   */
  readonly doc2queryGenerator: Doc2QueryGeneratorPort;
  readonly blockingPort: BlockingPort;
  readonly calibrationStore: CalibrationStore;
  readonly ambiguityDict: AmbiguityDictionary;
  readonly thresholdStore: ThresholdStore;
  readonly fuzzyMatcher?: FuzzyMatcherPort | undefined;
  /**
   * P0.2: per-class refusal threshold provider. Undefined when no PG pool is
   * wired (dev/test stub mode); the runtime policy degrades to the legacy
   * scalar fallback in that case. See `ConfidenceRefusalPolicy`.
   */
  readonly refusalThresholdProvider?: RefusalThresholdProvider | undefined;
  readonly aliasMatcher: AliasMatcher;
  readonly mappingTable: MappingTablePort;
  readonly anchorResolver: AnchorResolverPort;
  readonly similarRetrieval: SimilarRetrievalPort;
  readonly candidateAttributes: CandidateAttributePort;
  readonly learnedMatcher?: LearnedMatcherPort | undefined;
}

function resolvePool(runtime?: Pool | RuntimeHandles): Pool | undefined {
  if (runtime === undefined) {
    return undefined;
  }

  if ('totalCount' in runtime) {
    return runtime;
  }

  return runtime.pool;
}

function resolveRuntimeHandles(runtime?: Pool | RuntimeHandles): RuntimeHandles {
  if (runtime === undefined) {
    return {};
  }

  if ('totalCount' in runtime) {
    return { pool: runtime };
  }

  return runtime;
}

export async function buildCoreAdapterServices(
  config: Config,
  runtime?: Pool | RuntimeHandles,
): Promise<CoreAdapterServices> {
  const runtimeHandles = resolveRuntimeHandles(runtime);
  const pool = resolvePool(runtimeHandles);

  if (config.nodeEnv === 'production' && pool === undefined) {
    throw new Error(
      'Production core adapter wiring requires PostgreSQL-backed adapters; refusing to start with stub core adapters.',
    );
  }

  const vespaMtls = config.vespa.certPath !== undefined && config.vespa.keyPath !== undefined
    ? { certPath: config.vespa.certPath, keyPath: config.vespa.keyPath }
    : undefined;
  const vespaClient = new VespaClient(
    config.vespa.url,
    'wine',
    'wine_entity',
    {
      searchRequestMs: config.vespa.timeouts.searchRequestMs,
      documentMutationMs: config.vespa.timeouts.documentMutationMs,
      documentGetDeleteMs: config.vespa.timeouts.documentGetDeleteMs,
    },
    vespaMtls,
  );
  const baseSearchIndex: SearchIndexPort = new VespaSearchIndex(vespaClient);
  const searchIndex: SearchIndexPort = runtimeHandles.searchSnapshotId !== undefined
    ? new SnapshotScopedSearchIndex({
        inner: baseSearchIndex,
        snapshotId: runtimeHandles.searchSnapshotId,
      })
    : baseSearchIndex;
  const failFastSearchIndex: SearchIndexPort = new UnavailableFastFailSearchIndex(searchIndex);

  const embeddingService: EmbeddingServicePort = (() => {
    if (config.killSwitch.denseRetrieval) {
      return new StubEmbeddingService(config.embedding.dimension);
    }
    if (config.openai.apiKeys.length > 0) {
        return new OpenAiEmbeddingService({
          baseUrl: config.openai.baseUrl,
          apiKeys: config.openai.apiKeys,
          model: config.openai.embeddingModel,
          httpTimeoutMs: config.embedding.httpTimeoutMs,
          dimensions: config.embedding.dimension,
        });
    }
    // No embedding source configured — dense retrieval won't work.
    // Return stub so the process boots; the kill switch guard downstream
    // will degrade gracefully.
    bootstrapLogger.warn(
      'No embedding source configured (set OPENAI_API_KEY or OPENAI_API_KEYS). Dense retrieval disabled.',
    );
    return new StubEmbeddingService(config.embedding.dimension);
  })();

  const chatLlm: ChatLlmPort | undefined = createChatLlmFromEnv({
    env: process.env,
    openAiBaseUrl: config.openai.baseUrl,
    defaultModel: config.openai.chatModel,
    httpTimeoutMs: config.openai.httpTimeoutMs,
    allowCodexFallback: true,
  });

  let inMemoryAliasMatcher: SearchSnapshotAliasMatcher | undefined;
  if (!config.killSwitch.aliasOverlay) {
    if (runtimeHandles.searchSnapshotManifestPath !== undefined) {
      inMemoryAliasMatcher = await SearchSnapshotAliasMatcher.loadFromManifest(
        runtimeHandles.searchSnapshotManifestPath,
      );
      if (inMemoryAliasMatcher === undefined) {
        throw new Error(
          `Snapshot-bound lookup runtime artifacts are required but failed to load from ${runtimeHandles.searchSnapshotManifestPath}`,
        );
      }
    } else if (pool !== undefined) {
      throw new Error(
        'Pool-backed core adapter wiring requires searchSnapshotManifestPath for artifact-only lookup authority.',
      );
    }
  }

  // Doc2Query generator (index-time only). Prefer the OpenAI-backed
  // implementation when a chat adapter is available so it inherits the
  // chat circuit breaker / retries; otherwise fall back to the
  // deterministic stub so dev/test wiring keeps booting. Doc2Query uses
  // its own model env (`OPENAI_DOC2QUERY_MODEL`) so the ETL pass can run
  // on a cheaper model without affecting the runtime chat path.
  const doc2queryGenerator: Doc2QueryGeneratorPort =
    chatLlm !== undefined
      ? new OpenAiDoc2QueryGenerator({ chatLlm, model: config.openai.doc2queryModel })
      : new StubDoc2QueryGenerator();
  const fuzzyMatcher: FuzzyMatcherPort | undefined =
    inMemoryAliasMatcher !== undefined
      ? (() => {
          const matcher = new LazyFuzzyMatcher(inMemoryAliasMatcher.getSurfaceForms());
          // Cold-starting the BK-tree on the first user query caused the
          // initial hybrid request after deploy to spend tens of seconds in
          // planner pre-route. Warm the in-memory fuzzy index during startup
          // so the cost is paid before the server serves traffic.
          matcher.warm();
          return matcher;
        })()
      : undefined;

  return {
    searchIndex: failFastSearchIndex,
    embeddingService,
    doc2queryGenerator,
    ...(chatLlm !== undefined ? { chatLlm } : {}),
    ...(config.cohere.apiKey !== undefined
      ? {
          reranker: new CachedReranker({
            modelId: config.cohere.rerankModel,
            inner: new CohereReranker({
              apiKey: config.cohere.apiKey,
              baseUrl: config.cohere.baseUrl,
              model: config.cohere.rerankModel,
              httpTimeoutMs: config.reranker.httpTimeoutMs,
            }),
            ...(runtimeHandles.redisClient !== undefined ? { redis: runtimeHandles.redisClient } : {}),
          }),
        }
      : {}),
    blockingPort: pool
      ? new PgBlockingAdapter(pool, runtimeHandles.searchSnapshotId)
      : new StubBlockingPort(),
    calibrationStore: pool ? new PgCalibrationStore(pool) : new StubCalibrationStore(),
    ambiguityDict: new FallbackAmbiguityDictionary(
      pool
        ? new PgAmbiguityDictionary(pool, runtimeHandles.searchSnapshotId)
        : new StubAmbiguityDictionary(),
      new StaticAmbiguityDictionary(),
    ),
    thresholdStore: pool ? new PgThresholdStore(pool) : new StubThresholdStore(),
    ...(fuzzyMatcher !== undefined ? { fuzzyMatcher } : {}),
    ...(pool !== undefined
      ? {
          refusalThresholdProvider: new PgRefusalThresholdStore(pool, {
            ...(config.confidenceRefusal.ttlSeconds !== undefined
              ? { ttlSeconds: config.confidenceRefusal.ttlSeconds }
              : {}),
          }),
        }
      : {}),
    aliasMatcher: ((): AliasMatcher => {
      const indexAliasMatcher = new SearchIndexAliasMatcher(failFastSearchIndex, {
        // When the PG/snapshot alias overlay is available, the search-index
        // matcher is a degraded exact fallback only. Keep it on full-surface
        // variants so generic browse/semantic queries do not explode into
        // span-level Vespa alias lookups on misses.
        surfaceOnly: inMemoryAliasMatcher !== undefined,
      });
      const degradedExactFallback = new ExactOnlySecondaryAliasMatcher(indexAliasMatcher);
      if (config.killSwitch.aliasOverlay) {
        bootstrapLogger.warn(
          {
            killSwitch: 'aliasOverlay',
            nodeEnv: config.nodeEnv,
            consequence:
              'pg_alias_overlay_disabled — using search-index exact alias substrate only',
          },
          '[container] kill-switch active: using SearchIndexAliasMatcher (exact alias substrate from Vespa docs)',
        );
        return new CachedAliasMatcher(indexAliasMatcher);
      }
      if (inMemoryAliasMatcher !== undefined) {
        if (runtimeHandles.searchSnapshotId !== undefined) {
          bootstrapLogger.info(
            {
              nodeEnv: config.nodeEnv,
              searchSnapshotId: runtimeHandles.searchSnapshotId,
              manifestPath: runtimeHandles.searchSnapshotManifestPath,
            },
            '[container] using snapshot-scoped in-memory alias substrate only',
          );
          return new CachedAliasMatcher(inMemoryAliasMatcher);
        }
        return new CachedAliasMatcher(new CascadingAliasMatcher(
          inMemoryAliasMatcher,
          degradedExactFallback,
        ));
      }
      if (!pool) {
        bootstrapLogger.warn(
          {
            nodeEnv: config.nodeEnv,
            consequence:
              'pg_alias_substrate_unavailable — using search-index exact alias substrate only',
          },
          '[container] PostgreSQL alias substrate unavailable: using SearchIndexAliasMatcher',
        );
        return new CachedAliasMatcher(indexAliasMatcher);
      }
      return new CachedAliasMatcher(indexAliasMatcher);
    })(),
    mappingTable: await FileMappingTableAdapter.create(),
    anchorResolver: new VespaAnchorResolver(failFastSearchIndex),
    similarRetrieval: new VespaSimilarRetrieval(failFastSearchIndex),
    candidateAttributes: new VespaCandidateAttributes(failFastSearchIndex),
    learnedMatcher:
      config.learnedMatcher.url !== undefined
        ? new HttpLearnedMatcherAdapter({
            url: config.learnedMatcher.url,
            httpTimeoutMs: config.learnedMatcher.httpTimeoutMs,
          })
        : undefined,
  };
}
