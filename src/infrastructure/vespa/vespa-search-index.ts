/**
 * Vespa implementation of {@link SearchIndexPort}.
 *
 * Handles sparse (BM25) retrieval, dense (ANN) retrieval, single-document
 * fetch, and document upsert / bulk-upsert operations.
 */

import type { EntityId } from '../../domain/shared/types/index.js';
import { isEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type {
  RetrievalDocument,
  RetrievalHitProjection,
  RetrievalFeatureProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import type {
  SearchIndexPort,
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
} from '../../domain/retrieval/port/search-index.port.js';
import { type VespaClient } from './vespa-client.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import type { VespaHit, VespaQueryResponse } from './vespa-client.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import {
  toVespaFields,
  fromVespaFields,
  buildSparseFilters,
  buildDenseFilters,
  readRawVespaRetrievalSummary,
  parseHitSummary,
  parseFeatureSummary,
  yqlEscapeString,
} from './mapping.js';
import {
  normalizeRetrievalHitSummary,
} from '../../domain/retrieval/service/hybrid-candidate-summary.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = 'wine_entity';
const DEFAULT_SPARSE_LIMIT = 100;
const DEFAULT_DENSE_LIMIT = 100;
const BULK_BATCH_SIZE = 50;
/** Inflate ANN targetHits when post-filters prune neighbors (recall vs latency). */
const DENSE_FILTER_TARGET_HITS_MULTIPLIER = 5;
/** Hard cap on targetHits passed to Vespa HNSW (memory / latency guard). */
const DENSE_TARGET_HITS_ABSOLUTE_CAP = 1000;
/** Cap exploreAdditionalHits to limit HNSW graph exploration tail latency. */
const DENSE_HNSW_EXPLORE_ADDITIONAL_CAP = 200;
const STRUCTURED_QUERY_BASELINE_COUNT = 1;
/**
 * Hard cap on entity-id count for bulk fetch helpers. Prevents a buggy or
 * malicious caller from issuing thousands of parallel Vespa batches that
 * would saturate the connection pool and cluster.
 */
const MAX_BULK_FETCH_IDS = 5000;

/**
 * Maximum number of entity IDs to include in a single Vespa IN(...) clause.
 *
 * Vespa imposes no hard documented limit on IN-clause size, but very large
 * clauses (hundreds of IDs) can cause request-body size limits to be hit and
 * significantly increase query planning time. Batching at 200 keeps each
 * request within safe bounds while still being efficient for typical callers.
 * Results from multiple batches are concatenated in call order.
 */
const FETCH_SUMMARY_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * Lower bound for any YQL `limit` / `targetHits` / `exploreAdditionalHits` value.
 * Zero is a legal Vespa limit (returns no hits) but we treat anything below 1 as
 * a caller bug and force at least 1 so the query shape stays valid.
 */
const MIN_YQL_LIMIT = 1;
/**
 * Absolute upper bound on any YQL `limit` clause. Vespa's default
 * `maxHits` is 400; values beyond this typically come from caller bugs
 * (NaN, Infinity, or integer overflow from upstream arithmetic) and
 * would either be rejected by Vespa or exhaust memory.
 */
const MAX_YQL_LIMIT = 10_000;

/**
 * Coerces a runtime-unknown number into a safe non-negative integer suitable
 * for direct interpolation into a YQL `limit` / `targetHits` /
 * `hnsw.exploreAdditionalHits` clause.
 *
 * TypeScript's `number` type does NOT guarantee integrality or finiteness at
 * runtime — external callers can pass `NaN`, `Infinity`, negative numbers, or
 * fractional values. Interpolating those directly into YQL produces invalid
 * queries (e.g. `limit NaN`) or, worse, unexpected behavior.
 *
 * This helper clamps to `[MIN_YQL_LIMIT, MAX_YQL_LIMIT]` and rounds to the
 * nearest integer. It replaces the implicit trust we previously placed on
 * upstream callers to respect the port contract.
 */
function sanitizeYqlIntLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < MIN_YQL_LIMIT) return MIN_YQL_LIMIT;
  if (rounded > MAX_YQL_LIMIT) return MAX_YQL_LIMIT;
  return rounded;
}

/** Circuit breaker thresholds for the Vespa search endpoint. */
const VESPA_SEARCH_BREAKER_NAME = 'vespa-search';
const VESPA_SEARCH_FAILURE_THRESHOLD = 3;
const VESPA_SEARCH_RECOVERY_TIMEOUT_MS = 30_000;
const VESPA_SEARCH_HALF_OPEN_MAX = 2;

const STRUCTURED_QUERY_STRENGTH_MULTIPLIER = 0.35;
const FILTER_STRENGTH_MULTIPLIER = 0.2;
const STRUCTURED_QUERY_VALUE_MATCH_CAP = 3;

function countStructuredFilterMatches(
  filters: readonly string[],
  prefixes: readonly string[],
): number {
  let count = 0;
  for (const filter of filters) {
    if (prefixes.some((prefix) => filter.startsWith(prefix))) {
      count++;
    }
  }
  return count;
}

function buildStructuredQueryFeatureParams(
  queries: readonly string[],
  filters: readonly string[],
): Record<string, number> {
  const structuredQueryCount = Math.max(0, queries.length - STRUCTURED_QUERY_BASELINE_COUNT);
  const normalizedQueries = queries.map((query) => query.toLowerCase());
  const regionBoostFromQuery = normalizedQueries.some((query) =>
    query.includes('bordeaux')
    || query.includes('burgundy')
    || query.includes('napa')
    || query.includes('champagne')
    || query.includes('rioja')
  ) ? 1 : 0;
  const countryBoostFromQuery = normalizedQueries.some((query) =>
    query.includes('france')
    || query.includes('italy')
    || query.includes('spain')
    || query.includes('usa')
  ) ? 1 : 0;
  const grapeBoostFromQuery = normalizedQueries.some((query) =>
    query.includes('cabernet')
    || query.includes('merlot')
    || query.includes('pinot')
    || query.includes('chardonnay')
    || query.includes('riesling')
  ) ? 1 : 0;
  const regionFilterCount = countStructuredFilterMatches(filters, ['region:', 'appellation:']);
  const countryFilterCount = countStructuredFilterMatches(filters, ['country:']);
  const grapeFilterCount = countStructuredFilterMatches(filters, ['grape_primary:', 'grape_family:']);
  const regionBoost = Math.min(1, regionBoostFromQuery + regionFilterCount);
  const countryBoost = Math.min(1, countryBoostFromQuery + countryFilterCount);
  const grapeBoost = Math.min(1, grapeBoostFromQuery + grapeFilterCount);
  const structuredStrength = Math.min(
    1,
    structuredQueryCount * STRUCTURED_QUERY_STRENGTH_MULTIPLIER
      + Math.min(
        STRUCTURED_QUERY_VALUE_MATCH_CAP,
        regionFilterCount + countryFilterCount + grapeFilterCount,
      ) * FILTER_STRENGTH_MULTIPLIER,
  );
  const filterStrength = Math.min(1, filters.length * FILTER_STRENGTH_MULTIPLIER);

  return {
    'ranking.features.query(structured_query_terms_count)': structuredQueryCount,
    'ranking.features.query(structured_query_strength)': structuredStrength,
    'ranking.features.query(structured_region_boost)': regionBoost,
    'ranking.features.query(structured_country_boost)': countryBoost,
    'ranking.features.query(structured_grape_boost)': grapeBoost,
    'ranking.features.query(filter_strength)': filterStrength,
    // wine_aware second-phase uses current_year for vintage freshness and
    // drinking-window proximity scoring. Always send the real calendar year
    // so the deployed profile doesn't fall back to its hardcoded default (2024).
    'ranking.features.query(current_year)': new Date().getFullYear(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determines which text fields contributed to a Vespa hit by inspecting the
 * `matchfeatures` or `summaryfeatures` maps, falling back to a static list
 * when those are absent.
 */
function extractMatchedFields(fields: Record<string, unknown>): readonly string[] {
  const matched: string[] = [];

  // Vespa can return `matchfeatures` with per-field BM25 scores.
  const mf = fields['matchfeatures'];
  if (isRecord(mf)) {
    const fieldNames = [
      'canonical_label',
      'search_text_ko',
      'search_text_en',
      'aliases_identity_safe',
      'aliases_noisy_recall',
      'producer',
      'appellation',
      'grape_primary',
      'grape_family',
      'region_hierarchy',
      'flavor_profiles',
      'classification',
    ];
    for (const name of fieldNames) {
      const bm25Key = `bm25(${name})`;
      const score = mf[bm25Key];
      if (typeof score === 'number' && score > 0) {
        matched.push(name);
      }
    }
  }

  // Do NOT fabricate a default field set when matchfeatures are missing.
  // The previous behavior returned a hardcoded list, which corrupted
  // downstream evidence accumulators by claiming fields matched even when
  // they did not. Returning [] makes the absence visible to consumers.
  return matched;
}

/**
 * Normalises a raw ANN distance/closeness score from Vespa (angular metric,
 * range 0–1 where 1 = identical) to the [0, 1] similarity range expected by
 * {@link DenseHit.similarity}.
 *
 * Vespa's `closeness(field, embedding)` with `distance-metric: angular`
 * already returns values in [0, 1], where 1 means perfect similarity.
 */
function normaliseSimilarity(score: number): number {
  // clamp01 handles NaN/Infinity → 0 (Math.min/max alone do NOT, since
  // NaN propagates through both). NaN here would corrupt provenance and
  // break the deterministic downstream sort.
  return clamp01(score);
}

/**
 * Pulls summary fields from a Vespa hit for hybrid reranking passages
 * and wine attribute enrichment (Epic 15).
 */
function extractHitSummary(fields: Record<string, unknown>): RetrievalHitSummary | undefined {
  return normalizeRetrievalHitSummary(readRawVespaRetrievalSummary(fields));
}

// ---------------------------------------------------------------------------
// VespaSearchIndex
// ---------------------------------------------------------------------------

/**
 * Vespa-backed implementation of {@link SearchIndexPort}.
 *
 * Requires a pre-configured {@link VespaClient}.
 */
export class VespaSearchIndex implements SearchIndexPort {
  private readonly circuitBreaker: CircuitBreaker;

  constructor(private readonly client: VespaClient) {
    this.circuitBreaker = createCircuitBreaker({
      name: VESPA_SEARCH_BREAKER_NAME,
      failureThreshold: VESPA_SEARCH_FAILURE_THRESHOLD,
      recoveryTimeoutMs: VESPA_SEARCH_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: VESPA_SEARCH_HALF_OPEN_MAX,
    });
    globalCircuitBreakerRegistry.register(VESPA_SEARCH_BREAKER_NAME, this.circuitBreaker);
  }

  /**
   * Run a Vespa query under the circuit breaker.
   *
   * Uses `circuitBreaker.execute()` (which records every throw as a failure)
   * rather than the LLM classifier, because Vespa errors are always transient
   * infrastructure failures — there is no concept of a "caller fault" 4xx
   * that should keep the breaker CLOSED.
   *
   * Throws CircuitBreakerOpenError when the breaker is OPEN.
   */
  private async queryUnderBreaker(
    yql: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<VespaQueryResponse> {
    if (this.circuitBreaker.state === 'OPEN') {
      throw new CircuitBreakerOpenError(VESPA_SEARCH_BREAKER_NAME);
    }
    return this.circuitBreaker.execute(() => this.client.query(yql, params, signal, requestId));
  }

  // -------------------------------------------------------------------------
  // sparseSearch
  // -------------------------------------------------------------------------

  /**
   * Executes a sparse (BM25 / lexical) search across wine entity documents.
   *
   * Queries the `canonical_label`, `search_text_ko`, `search_text_en`,
   * `aliases_identity_safe`, `aliases_noisy_recall`, and `producer` fields
   * using a combination of `userInput()` and `weakAnd()`. Only documents
   * where `availability = true` are returned (hardcoded baseline filter).
   *
   * @param queries - One or more query strings.
   * @param filters - Optional filter tokens (see {@link buildSparseFilters}).
   * @param limit - Maximum hits to return (default: 100).
   * @param rankProfile - Vespa rank profile to use (default: `'hybrid'`).
   * @returns Sparse hits sorted by descending BM25 score.
   */
  async sparseSearch(
    queries: readonly string[],
    filters?: readonly string[],
    limit?: number,
    rankProfile: string = 'hybrid',
    requestId?: string,
  ): Promise<readonly SparseHit[]> {
    // Sanitize limit BEFORE interpolating into YQL: the port type is `number`
    // but at runtime a buggy caller can pass NaN / Infinity / negatives, and
    // `limit NaN` is invalid YQL.
    const hits = sanitizeYqlIntLimit(limit ?? DEFAULT_SPARSE_LIMIT, DEFAULT_SPARSE_LIMIT);
    const effectiveFilters = filters ?? [];
    const filterClause = buildSparseFilters(effectiveFilters);

    // Guard: empty queries array would produce `where () AND ...` which is
    // invalid Vespa YQL syntax and causes a 400 parse error on the Vespa side.
    if (queries.length === 0) {
      return [];
    }

    // Per-query clause:
    //   userInput(@queryN)                             — general multi-term match via WAND
    //   canonical_label contains phrase(@queryN)        — exact phrase for full wine names
    //   aliases_identity_safe contains phrase(@queryN)  — exact phrase for identity aliases
    //   search_text_ko contains phrase(@queryN)         — Korean tasting notes / descriptions
    //   search_text_en contains phrase(@queryN)         — English tasting notes / doc2query
    //   producer contains phrase(@queryN)               — producer name exact match
    //
    // The OR of phrase operators ensures Korean queries like "샤토 마고" and
    // semantic queries matching doc2query text are found even when the WAND
    // tokeniser splits differently.
    const queryClauses = queries.map(
      (_, i) =>
        `(userInput(@query${i})` +
        ` OR canonical_label contains phrase(@query${i})` +
        ` OR aliases_identity_safe contains phrase(@query${i})` +
        ` OR search_text_ko contains phrase(@query${i})` +
        ` OR search_text_en contains phrase(@query${i})` +
        ` OR producer contains phrase(@query${i}))`,
    );

    const queryUnion =
      queryClauses.length === 1
        ? queryClauses[0]!
        : `(${queryClauses.join(' OR ')})`;

    const yql =
      `select * from ${SCHEMA} where ` +
      `${queryUnion} AND availability = true` +
      filterClause +
      ` limit ${hits}`;

    // Build query parameters — one @queryN binding per query string.
    const queryParams: Record<string, unknown> = {
      'ranking.profile': rankProfile,
      'presentation.summary': 'default',
      ...buildStructuredQueryFeatureParams(queries, effectiveFilters),
    };
    for (let i = 0; i < queries.length; i++) {
      queryParams[`query${i}`] = queries[i];
    }

    const response = await this.queryUnderBreaker(yql, queryParams, undefined, requestId);
    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const entityId = this.extractEntityId(hit);
      const summary = extractHitSummary(hit.fields);
      return {
        entityId,
        score: hit.relevance,
        rank: index + 1,
        matchedFields: extractMatchedFields(hit.fields),
        ...(summary !== undefined ? { summary } : {}),
      } satisfies SparseHit;
    });
  }

  // -------------------------------------------------------------------------
  // denseSearch
  // -------------------------------------------------------------------------

  /**
   * Executes a dense (embedding / ANN) search using Vespa's
   * `nearestNeighbor` operator.
   *
   * @param embedding - The query embedding vector (must match schema dimension).
   * @param filters - Optional filter tokens (see {@link buildDenseFilters}).
   * @param limit - Maximum hits to return (default: 100).
   * @param rankProfile - Vespa rank profile to use (default: `'hybrid'`).
   * @returns Dense hits sorted by descending closeness (similarity).
   */
  async denseSearch(
    embedding: readonly number[],
    filters?: readonly string[],
    limit?: number,
    rankProfile: string = 'hybrid',
    requestId?: string,
  ): Promise<readonly DenseHit[]> {
    // Guard: empty embedding would send a zero-dimension vector to Vespa's nearestNeighbor
    // operator, causing a dimension-mismatch error. CLAUDE.md rule 32: empty array [] is
    // truthy — cannot use bare truthiness check here.
    if (embedding.length === 0) return [];
    // Sanitize limit BEFORE interpolating into YQL (see sparseSearch).
    const requestedLimit = sanitizeYqlIntLimit(limit ?? DEFAULT_DENSE_LIMIT, DEFAULT_DENSE_LIMIT);
    const effectiveFilters = filters ?? [];
    const filterClause = buildDenseFilters(effectiveFilters);
    // Filter starvation defense: when filters are present, the HNSW pass
    // returns `targetHits` candidates whose ordering is based on cosine
    // similarity ALONE — then `availability = true` and any custom filters
    // prune them post-hoc. With targetHits == limit, the post-filter set is
    // typically much smaller than the requested limit, silently cutting
    // recall. Inflate targetHits relative to filter selectivity so the
    // candidate pool can survive filter pruning.
    const hasFilters = filterClause.length > 0;
    const filterMultiplier = hasFilters ? DENSE_FILTER_TARGET_HITS_MULTIPLIER : 1;
    // Both inputs are integers so the product is an integer; sanitize once more
    // as a belt-and-braces guard against any future arithmetic drift that might
    // reintroduce NaN / Infinity into the YQL interpolation path.
    const targetHits = sanitizeYqlIntLimit(
      Math.min(DENSE_TARGET_HITS_ABSOLUTE_CAP, requestedLimit * filterMultiplier),
      DEFAULT_DENSE_LIMIT,
    );
    // exploreAdditionalHits raises ef_search beyond targetHits so the HNSW
    // graph explores more neighbours at query time, improving ANN recall at
    // a small latency cost. Cap at 200 to avoid tail spikes on large corpora.
    const exploreAdditional = sanitizeYqlIntLimit(
      Math.min(targetHits, DENSE_HNSW_EXPLORE_ADDITIONAL_CAP),
      MIN_YQL_LIMIT,
    );
    const yql =
      `select * from ${SCHEMA} where ` +
      `({targetHits: ${targetHits}, hnsw.exploreAdditionalHits: ${exploreAdditional}} ` +
      `nearestNeighbor(embedding, query_embedding))` +
      ` AND availability = true` +
      filterClause +
      ` limit ${requestedLimit}`;

    const response = await this.queryUnderBreaker(yql, {
      'ranking.profile': rankProfile,
      'presentation.summary': 'default',
      'input.query(query_embedding)': embedding,
      ...buildStructuredQueryFeatureParams([], effectiveFilters),
    }, undefined, requestId);

    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const entityId = this.extractEntityId(hit);
      const summary = extractHitSummary(hit.fields);
      return {
        entityId,
        score: hit.relevance,
        rank: index + 1,
        similarity: normaliseSimilarity(hit.relevance),
        ...(summary !== undefined ? { summary } : {}),
      } satisfies DenseHit;
    });
  }

  // -------------------------------------------------------------------------
  // searchLearnedSparse
  // -------------------------------------------------------------------------

  /**
   * Executes a learned-sparse (SPLADE-style) retrieval pass against the
   * `learned_sparse_weights` mapped tensor field.
   *
   * Uses Vespa's `dotProduct` operator — the correct operator for
   * `tensor<float>(token{})` mapped tensor fields. The query tensor is passed
   * as an input parameter rather than inlined in the YQL to avoid size limits
   * on large token vocabularies.
   *
   * @param queryWeights - Token → weight pairs from the sparse encoder.
   *   An empty array causes an immediate `[]` return without any I/O.
   * @param filters - Optional filter tokens (see {@link buildDenseFilters}).
   * @param limit - Maximum hits to return (default: 100).
   * @returns Hits sorted by descending learned-sparse score.
   */
  async searchLearnedSparse(
    queryWeights: readonly { token: string; weight: number }[],
    filters?: readonly string[],
    limit?: number,
    requestId?: string,
  ): Promise<readonly DenseHit[]> {
    if (queryWeights.length === 0) {
      return [];
    }

    // Sanitize limit BEFORE interpolating into YQL (see sparseSearch).
    const targetHits = sanitizeYqlIntLimit(limit ?? DEFAULT_DENSE_LIMIT, DEFAULT_DENSE_LIMIT);
    const filterClause = buildDenseFilters(filters ?? []);

    // Build the query tensor as a Vespa mapped tensor cell array.
    // Vespa computes dotProduct(learned_sparse_weights, sparse_query_embedding)
    // by summing weight_doc[t] * weight_query[t] for each shared token t.
    const sparseQueryTensor = {
      cells: queryWeights.map(({ token, weight }) => ({
        address: { token },
        value: weight,
      })),
    };

    const yql =
      `select * from ${SCHEMA} where ` +
      `({targetHits: ${targetHits}}` +
      `dotProduct(learned_sparse_weights, sparse_query_embedding))` +
      ` AND availability = true` +
      filterClause +
      ` limit ${targetHits}`;

    const response = await this.queryUnderBreaker(yql, {
      'ranking.profile': 'learned_sparse',
      'presentation.summary': 'default',
      'input.query(sparse_query_embedding)': sparseQueryTensor,
    }, undefined, requestId);

    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const entityId = this.extractEntityId(hit);
      const summary = extractHitSummary(hit.fields);
      return {
        entityId,
        score: hit.relevance,
        rank: index + 1,
        similarity: normaliseSimilarity(hit.relevance),
        ...(summary !== undefined ? { summary } : {}),
      } satisfies DenseHit;
    });
  }

  // -------------------------------------------------------------------------
  // getDocument
  // -------------------------------------------------------------------------

  /**
   * Retrieves a single {@link RetrievalDocument} by entity ID.
   *
   * @param entityId - The entity to fetch.
   * @returns The document, or `null` if not found.
   */
  async getDocument(entityId: EntityId): Promise<RetrievalDocument | null> {
    const fields = await this.client.get(entityId);
    if (fields === null) return null;
    return fromVespaFields(fields);
  }

  async getDocuments(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, RetrievalDocument>> {
    if (entityIds.length === 0) {
      return new Map<EntityId, RetrievalDocument>();
    }
    if (entityIds.length > MAX_BULK_FETCH_IDS) {
      throw new Error(`getDocuments: too many ids (${entityIds.length} > ${MAX_BULK_FETCH_IDS})`);
    }
    const settled = await Promise.allSettled(entityIds.map(async (entityId) => {
      const doc = await this.getDocument(entityId);
      return doc === null ? null : [entityId, doc] as const;
    }));
    const docs = new Map<EntityId, RetrievalDocument>();
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== null) {
        docs.set(result.value[0], result.value[1]);
      }
    }
    return docs;
  }

  // -------------------------------------------------------------------------
  // upsertDocument
  // -------------------------------------------------------------------------

  /**
   * Inserts or replaces a single document in the Vespa index.
   *
   * @param doc - The domain document to index.
   */
  async upsertDocument(doc: RetrievalDocument): Promise<void> {
    const fields = toVespaFields(doc);
    await this.client.put(doc.entityId, fields);
  }

  // -------------------------------------------------------------------------
  // bulkUpsert
  // -------------------------------------------------------------------------

  /**
   * Inserts or replaces multiple documents in the Vespa index.
   *
   * Documents are fed in batches of {@link BULK_BATCH_SIZE} to avoid
   * overwhelming the Vespa container. All batch errors are collected and
   * thrown as a single aggregated error after all batches complete.
   *
   * @param docs - The documents to index.
   * @throws {Error} If any document fails to feed (aggregated error message).
   */
  async bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    const allErrors: string[] = [];
    let totalSuccess = 0;
    let totalFailure = 0;

    for (let offset = 0; offset < docs.length; offset += BULK_BATCH_SIZE) {
      const batch = docs.slice(offset, offset + BULK_BATCH_SIZE);
      const feedBatch = batch.map((doc) => ({
        id: doc.entityId,
        fields: toVespaFields(doc),
      }));

      const result = await this.client.bulkFeed(feedBatch);
      totalSuccess += result.successCount;
      totalFailure += result.failureCount;
      allErrors.push(...result.errors);
    }

    if (totalFailure > 0) {
      throw new Error(
        `Vespa bulkUpsert: ${totalFailure} of ${totalSuccess + totalFailure} documents failed.\n` +
          allErrors.join('\n'),
      );
    }
  }

  // -------------------------------------------------------------------------
  // fetchWithHitSummary
  // -------------------------------------------------------------------------

  /**
   * Fetches hit-projection fields for a set of entity IDs using the
   * `hit_summary` Vespa document-summary (T7.2).
   *
   * Only the fields defined by {@link RetrievalHitProjection} are returned;
   * feature/ranking fields are excluded from the response payload.
   *
   * @param entityIds - Entity identifiers to fetch.
   * @returns Hit projections in the same order as `entityIds` (absent docs omitted).
   */
  async fetchWithHitSummary(
    entityIds: readonly EntityId[],
  ): Promise<readonly RetrievalHitProjection[]> {
    return this.batchFetchBySummary({
      entityIds,
      callerName: 'fetchWithHitSummary',
      selectFields:
        'entity_id, canonical_label, producer, region, appellation,' +
        ' grape_primary, vintage_year, search_text_en, producer_prestige',
      summaryName: 'hit_summary',
      parseHit: (fields) => parseHitSummary(fields),
      entityIdOf: (proj) => String(proj.entityId),
    });
  }

  // -------------------------------------------------------------------------
  // fetchWithFeatureSummary
  // -------------------------------------------------------------------------

  /**
   * Fetches feature-projection fields for a set of entity IDs using the
   * `feature_summary` Vespa document-summary (T7.2).
   *
   * Only the fields defined by {@link RetrievalFeatureProjection} are returned;
   * display/hit fields are excluded from the response payload.
   *
   * @param entityIds - Entity identifiers to fetch.
   * @returns Feature projections in the same order as `entityIds` (absent docs omitted).
   */
  async fetchWithFeatureSummary(
    entityIds: readonly EntityId[],
  ): Promise<readonly RetrievalFeatureProjection[]> {
    return this.batchFetchBySummary({
      entityIds,
      callerName: 'fetchWithFeatureSummary',
      selectFields:
        'entity_id, body, tannin, acidity, sweetness, critic_score_normalized,' +
        ' drinking_window_start, drinking_window_end, drinking_window_model_version',
      summaryName: 'feature_summary',
      parseHit: (fields) => parseFeatureSummary(fields),
      entityIdOf: (proj) => proj.entityId !== undefined ? String(proj.entityId) : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Common batch-fetch helper (bugbash P2-5 SSoT extraction)
  // -------------------------------------------------------------------------

  /**
   * Shared implementation for fetchWithHitSummary / fetchWithFeatureSummary.
   *
   * Batches entity IDs into chunks of FETCH_SUMMARY_BATCH_SIZE, runs batches
   * in parallel via Promise.allSettled, re-keys results by entity_id, and
   * emits in input order. A single batch failure does not discard the rest.
   */
  private async batchFetchBySummary<T>(opts: {
    entityIds: readonly EntityId[];
    callerName: string;
    selectFields: string;
    summaryName: string;
    parseHit: (fields: Record<string, unknown>) => T;
    entityIdOf: (parsed: T) => string | undefined;
  }): Promise<readonly T[]> {
    const { entityIds, callerName, selectFields, summaryName, parseHit, entityIdOf } = opts;
    if (entityIds.length === 0) return [];
    if (entityIds.length > MAX_BULK_FETCH_IDS) {
      throw new Error(`${callerName}: too many ids (${entityIds.length} > ${MAX_BULK_FETCH_IDS})`);
    }

    // Batch large ID lists to avoid unbounded YQL IN-clause size.
    // Entity IDs are escaped via yqlEscapeString to prevent YQL injection.
    const batches: EntityId[][] = [];
    for (let offset = 0; offset < entityIds.length; offset += FETCH_SUMMARY_BATCH_SIZE) {
      batches.push([...entityIds.slice(offset, offset + FETCH_SUMMARY_BATCH_SIZE)]);
    }
    const settled = await Promise.allSettled(batches.map(async (batch) => {
      const idList = batch.map((id) => yqlEscapeString(id)).join(', ');
      const yql =
        `select ${selectFields}` +
        ` from ${SCHEMA} where entity_id in (${idList})` +
        ` limit ${batch.length}`;
      const response = await this.queryUnderBreaker(yql, {
        'presentation.summary': summaryName,
      });
      const children = response.root.children ?? [];
      return children.map((hit) => parseHit(hit.fields));
    }));

    // Build Map<entityId, projection> from successful batches.
    // Log failed batches — previously they were silently swallowed, making partial
    // failures invisible in production and causing silent ranking feature data loss.
    const projectionMap = new Map<string, T>();
    for (const result of settled) {
      if (result.status === 'rejected') {
        bootstrapLogger.warn(
          { err: result.reason instanceof Error ? result.reason.message : String(result.reason), callerName },
          `[VespaSearchIndex] ${callerName}: batch query failed — results will be partial`,
        );
        continue;
      }
      for (const proj of result.value) {
        const eid = entityIdOf(proj);
        if (eid !== undefined) {
          projectionMap.set(eid, proj);
        }
      }
    }
    // Emit in input order, dropping IDs that did not return a doc.
    const ordered: T[] = [];
    for (const id of entityIds) {
      const proj = projectionMap.get(String(id));
      if (proj !== undefined) ordered.push(proj);
    }
    return ordered;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extracts a validated {@link EntityId} from a Vespa hit's fields.
   * Falls back to parsing the hit `id` URI as a last resort.
   *
   * @param hit - The Vespa search hit.
   * @returns A valid entity ID.
   * @throws {Error} If no usable entity ID can be found.
   */
  private extractEntityId(hit: VespaHit): EntityId {
    // Prefer the indexed `entity_id` field.
    const fromField = hit.fields['entity_id'];
    if (isString(fromField) && isEntityId(fromField)) {
      return fromField;
    }

    // Fall back to the document ID from the Vespa hit URI.
    // Format: "id:<namespace>:<doctype>::<docid>"
    const parts = hit.id.split('::');
    const docId = parts[parts.length - 1];
    if (isString(docId) && isEntityId(docId)) {
      return docId;
    }

    throw new Error(
      `Vespa: unable to extract EntityId from hit id="${hit.id}"`,
    );
  }
}
