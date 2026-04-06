import type { Pool } from 'pg';
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
import { RedisWatchlistPublisher } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import { WatchlistAwareSearchIndex } from '../infrastructure/watchlist/watchlist-aware-search-index.js';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { isWatchlistEnabled } from './watchlist.js';
import type { AmbiguityDictionary } from '../domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { SearchIndexPort } from '../domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../domain/query/port/threshold-store.port.js';
import type { AliasMatcher } from '../domain/query/service/anchor-extractor.js';
import type { MappingTablePort } from '../domain/attribute/port/mapping-table.port.js';
import type {
  AnchorResolverPort,
  CandidateAttributePort,
  SimilarRetrievalPort,
} from '../domain/mixed/port/mixed-query.port.js';
import type { LearnedMatcherPort } from '../domain/resolver/port/learned-matcher.port.js';
import type { RerankerPort } from '../domain/ranking/port/reranker.port.js';
import {
  StubAliasMatcher,
  StubAmbiguityDictionary,
  StubBlockingPort,
  StubCalibrationStore,
  StubEmbeddingService,
  StubThresholdStore,
} from './container-stubs.js';

export interface CoreAdapterServices {
  readonly searchIndex: SearchIndexPort;
  readonly embeddingService: EmbeddingServicePort;
  readonly reranker: RerankerPort;
  readonly blockingPort: BlockingPort;
  readonly calibrationStore: CalibrationStore;
  readonly ambiguityDict: AmbiguityDictionary;
  readonly thresholdStore: ThresholdStore;
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

export function buildCoreAdapterServices(
  config: Config,
  runtime?: Pool | RuntimeHandles,
): CoreAdapterServices {
  const runtimeHandles = resolveRuntimeHandles(runtime);
  const pool = resolvePool(runtimeHandles);

  if (config.nodeEnv === 'production' && pool === undefined) {
    throw new Error(
      'Production core adapter wiring requires PostgreSQL-backed adapters; refusing to start with stub core adapters.',
    );
  }

  const vespaClient = new VespaClient(config.vespa.url, 'wine', 'wine_entity');
  const baseSearchIndex: SearchIndexPort = new VespaSearchIndex(vespaClient);
  const searchIndex: SearchIndexPort = isWatchlistEnabled(config)
    ? new WatchlistAwareSearchIndex({
        inner: baseSearchIndex,
        publisher: runtimeHandles.createWatchlistPublisher?.()
          ?? new RedisWatchlistPublisher({
            ...(runtimeHandles.redisClient
              ? { client: runtimeHandles.redisClient }
              : { redisConfig: config.redis }),
          }),
      })
    : baseSearchIndex;

  return {
    searchIndex,
    embeddingService: config.killSwitch.denseRetrieval
      ? new StubEmbeddingService()
      : new HttpEmbeddingService(),
    reranker: new HttpCrossEncoderReranker(),
    blockingPort: pool ? new PgBlockingAdapter(pool) : new StubBlockingPort(),
    calibrationStore: pool ? new PgCalibrationStore(pool) : new StubCalibrationStore(),
    ambiguityDict: pool ? new PgAmbiguityDictionary(pool) : new StubAmbiguityDictionary(),
    thresholdStore: pool ? new PgThresholdStore(pool) : new StubThresholdStore(),
    aliasMatcher:
      !config.killSwitch.aliasOverlay && pool
        ? new PgAliasMatcher(pool)
        : new StubAliasMatcher(),
    mappingTable: new FileMappingTableAdapter(),
    anchorResolver: new VespaAnchorResolver(searchIndex),
    similarRetrieval: new VespaSimilarRetrieval(searchIndex),
    candidateAttributes: new VespaCandidateAttributes(searchIndex),
    learnedMatcher:
      config.learnedMatcher.url !== undefined
        ? new HttpLearnedMatcherAdapter({
            url: config.learnedMatcher.url,
            httpTimeoutMs: config.learnedMatcher.httpTimeoutMs,
          })
        : undefined,
  };
}
