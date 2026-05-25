/**
 * Vespa implementation of {@link SearchIndexPort}.
 *
 * Handles sparse (BM25) retrieval, dense (ANN) retrieval, single-document
 * fetch, and document upsert / bulk-upsert operations.
 */

import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
  RetrievalHitProjection,
  RetrievalFeatureProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import type {
  SearchIndexPort,
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
} from '../../domain/retrieval/port/search-index.port.js';
import { type VespaClient, VespaHttpError } from './vespa-client.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import {
  VESPA_BULK_HYDRATION_BATCH_SIZE,
  VESPA_BULK_HYDRATION_TIMEOUT_MS,
} from './per-channel-timeouts.js';
import type { VespaHit, VespaQueryResponse } from './vespa-client.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import {
  toVespaFields,
  fromVespaFields,
  MalformedVespaDocumentError,
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
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { isEligiblePrefixQuery } from '../../domain/query/service/alias-prefix-terms.js';
import { RETRIEVAL_CHANNEL_LEARNED_SPARSE } from '../../domain/retrieval/model/retrieval-channel.js';
import {
  MAJOR_REGION_KEYWORDS,
  MAJOR_COUNTRY_KEYWORDS,
  MAJOR_GRAPE_KEYWORDS,
  queryMentionsAny,
} from './query-boost-vocabulary.js';

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
/**
 * Batch size for bulk-hydration calls (getDocuments / batchFetchBySummary).
 *
 * Reduced from 200 → 50 (2026-05-24): full-summary fetches of 200 ids
 * routinely exceeded the shared 3 s search timeout on Vespa Cloud, dropping
 * the entire batch (`getDocuments: batch query failed`) and producing the
 * deceptive "alias overlay drift" symptom in the PtE bench. Smaller batches
 * + a dedicated 12 s bulk-hydration channel (see per-channel-timeouts.ts)
 * together solve the timeout cluster.
 *
 * Override via env if cluster profile differs: `VESPA_BULK_HYDRATION_BATCH_SIZE=N`.
 */
const FETCH_SUMMARY_BATCH_SIZE = VESPA_BULK_HYDRATION_BATCH_SIZE;
const ALIAS_PREFIX_TERMS_FIELD = 'alias_prefix_terms';

/**
 * Diagnostic-rich result shape for {@link VespaSearchIndex.getDocumentsReport}.
 *
 * `docs` is keyed by `CanonicalEntityId` and ordered to match the caller-
 * supplied id list, mirroring legacy `getDocuments` semantics.
 *
 * `missingIds` enumerates the requested ids for which no valid document was
 * produced — caller-side policy code (e.g. fail-loud, retry, downgrade) can
 * branch on this instead of recomputing the diff against the input list.
 *
 * `parseFailures` counts individual Vespa hits whose `fromVespaFields()`
 * parse threw (`MalformedVespaDocumentError`); the affected ids are also
 * reflected in `missingIds`.
 *
 * `batchFailures` counts batch-level Vespa query rejections (timeout, 5xx,
 * circuit-breaker open). When `batchFailures > 0`, every id assigned to the
 * failing batch will also appear in `missingIds`.
 */
export interface GetDocumentsReport {
  readonly docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>;
  readonly missingIds: readonly CanonicalEntityId[];
  readonly parseFailures: number;
  readonly batchFailures: number;
}

interface VespaSearchIndexSchemaCapabilities {
  readonly aliasPrefixTerms: boolean;
}

const DEFAULT_VESPA_SEARCH_INDEX_SCHEMA_CAPABILITIES: VespaSearchIndexSchemaCapabilities = {
  aliasPrefixTerms: true,
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseDrinkingWindowSummary(raw: Record<string, unknown>): RetrievalDrinkingWindowProjection {
  const entityIdRaw = raw['entity_id'];
  if (!isString(entityIdRaw) || entityIdRaw.length === 0) {
    throw new Error('parseDrinkingWindowSummary: missing or empty entity_id');
  }
  const canonicalLabelRaw = raw['canonical_label'];
  if (!isString(canonicalLabelRaw) || canonicalLabelRaw.length === 0) {
    throw new Error('parseDrinkingWindowSummary: missing or empty canonical_label');
  }
  const drinkingWindowStart = raw['drinking_window_start'];
  const drinkingWindowEnd = raw['drinking_window_end'];
  const modelVersion = raw['drinking_window_model_version'];
  return {
    entityId: createCanonicalEntityId(entityIdRaw),
    canonicalLabel: canonicalLabelRaw,
    ...(isFiniteNumber(drinkingWindowStart) ? { drinkingWindowStart } : {}),
    ...(isFiniteNumber(drinkingWindowEnd) ? { drinkingWindowEnd } : {}),
    ...(isString(modelVersion) && modelVersion.length > 0 ? { drinkingWindowModelVersion: modelVersion } : {}),
  };
}

/**
 * Lower bound for any YQL `limit` / `targetHits` / `exploreAdditionalHits` value.
 * Zero is a legal Vespa limit (returns no hits) but we treat anything below 1 as
 * a caller bug and force at least 1 so the query shape stays valid.
 */
const MIN_YQL_LIMIT = 1;
/**
 * Absolute upper bound on any YQL `limit` / `targetHits` clause.
 *
 * Vespa Cloud rejects requests above the cluster `maxHits` ceiling; in this
 * deployment that ceiling is 400. Anything larger is therefore a caller-side
 * contract bug, not a valid retrieval request.
 */
const MAX_YQL_LIMIT = 400;

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
  if (Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return MAX_YQL_LIMIT;
  if (value === Number.NEGATIVE_INFINITY) return MIN_YQL_LIMIT;
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
  // Vocabulary-driven word-boundary matching (Unicode-safe) replaces the
  // legacy `query.includes(...)` substring checks. See
  // `./query-boost-vocabulary.ts` for the SSoT keyword lists and the
  // word-boundary contract — substring matching was producing false
  // positives on compound tokens (`new_bordeaux_style`, `pinotage`, …).
  const regionBoostFromQuery = queries.some(
    (query) => queryMentionsAny(query, MAJOR_REGION_KEYWORDS),
  ) ? 1 : 0;
  const countryBoostFromQuery = queries.some(
    (query) => queryMentionsAny(query, MAJOR_COUNTRY_KEYWORDS),
  ) ? 1 : 0;
  const grapeBoostFromQuery = queries.some(
    (query) => queryMentionsAny(query, MAJOR_GRAPE_KEYWORDS),
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
      'alias_prefix_terms',
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

function parseHitSummaryWithContext(
  callerName: string,
  hit: VespaHit,
  rank: number,
): RetrievalHitSummary | undefined {
  try {
    return extractHitSummary(hit.fields);
  } catch (err) {
    const rawEntityId = isString(hit.fields['entity_id']) && hit.fields['entity_id'].length > 0
      ? hit.fields['entity_id']
      : '<missing_or_empty>';
    bootstrapLogger.warn(
      {
        callerName,
        entityId: rawEntityId,
        rank,
        fieldCount: Object.keys(hit.fields).length,
        err: err instanceof Error ? err.message : String(err),
      },
      `[VespaSearchIndex] ${callerName}: hit summary parse failed`,
    );
    throw err;
  }
}

function logDocumentParseFailure(
  callerName: string,
  err: unknown,
  fields: Record<string, unknown>,
  rank?: number,
): void {
  const rawEntityId = isString(fields['entity_id']) && fields['entity_id'].length > 0
    ? fields['entity_id']
    : '<missing_or_empty>';
  bootstrapLogger.warn(
    {
      callerName,
      entityId: rawEntityId,
      ...(rank !== undefined ? { rank } : {}),
      fieldCount: Object.keys(fields).length,
      missingField: err instanceof MalformedVespaDocumentError ? err.missingField : undefined,
      err: err instanceof Error ? err.message : String(err),
    },
    `[VespaSearchIndex] ${callerName}: document parse failed`,
  );
}

function getEntityIdForLog(hit: VespaHit): string {
  const fromField = hit.fields['entity_id'];
  if (isString(fromField) && fromField.length > 0) {
    return fromField;
  }
  const parts = hit.id.split('::');
  const docId = parts[parts.length - 1];
  return isString(docId) && docId.length > 0 ? docId : '<missing_or_empty>';
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
  private readonly schemaCapabilities: { aliasPrefixTerms: boolean };
  private hasLoggedAliasPrefixTermsDowngrade = false;

  constructor(
    private readonly client: VespaClient,
    capabilities: Partial<VespaSearchIndexSchemaCapabilities> = {},
  ) {
    this.circuitBreaker = createCircuitBreaker({
      name: VESPA_SEARCH_BREAKER_NAME,
      failureThreshold: VESPA_SEARCH_FAILURE_THRESHOLD,
      recoveryTimeoutMs: VESPA_SEARCH_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: VESPA_SEARCH_HALF_OPEN_MAX,
    });
    this.schemaCapabilities = {
      ...DEFAULT_VESPA_SEARCH_INDEX_SCHEMA_CAPABILITIES,
      ...capabilities,
    };
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
    /**
     * Override the per-request HTTP timeout. Bulk-hydration call sites
     * (getDocuments / batchFetchBySummary) pass
     * `VESPA_BULK_HYDRATION_TIMEOUT_MS` to tolerate the wider latency on
     * full-summary fetches over many ids; everything else (hot search)
     * defaults to the tight `VESPA_SEARCH_TIMEOUT_MS`.
     */
    timeoutMsOverride?: number,
  ): Promise<VespaQueryResponse> {
    if (this.circuitBreaker.state === 'OPEN') {
      throw new CircuitBreakerOpenError(VESPA_SEARCH_BREAKER_NAME);
    }
    let clientError: VespaHttpError | undefined;
    const result = await this.circuitBreaker.execute(async () => {
      try {
        return await this.client.query(yql, params, signal, requestId, timeoutMsOverride);
      } catch (err) {
        if (err instanceof VespaHttpError && err.isClientError && !err.isRateLimited) {
          clientError = err;
          return null;
        }
        throw err;
      }
    });
    if (clientError !== undefined) {
      throw clientError;
    }
    if (result === null) {
      throw new Error('queryUnderBreaker invariant violated: Vespa client error swallowed without classification');
    }
    return result;
  }

  private static isMissingSchemaFieldError(error: unknown, field: string): error is VespaHttpError {
    return error instanceof VespaHttpError
      && error.isClientError
      && error.message.includes(`Field '${field}' does not exist.`);
  }

  private disableAliasPrefixTermsCapability(error: VespaHttpError): void {
    if (!this.schemaCapabilities.aliasPrefixTerms) {
      return;
    }
    this.schemaCapabilities.aliasPrefixTerms = false;
    if (this.hasLoggedAliasPrefixTermsDowngrade) {
      return;
    }
    this.hasLoggedAliasPrefixTermsDowngrade = true;
    bootstrapLogger.warn(
      {
        field: ALIAS_PREFIX_TERMS_FIELD,
        statusCode: error.statusCode,
      },
      '[VespaSearchIndex] Remote Vespa schema is missing alias_prefix_terms; disabling prefix substrate clauses for this process',
    );
  }

  private buildSparseSearchRequest(
    queries: readonly string[],
    effectiveFilters: readonly string[],
    hits: number,
    rankProfile: string,
    useAliasPrefixTerms: boolean,
  ): {
    readonly yql: string;
    readonly queryParams: Record<string, unknown>;
    readonly usedAliasPrefixTerms: boolean;
  } {
    const filterClause = buildSparseFilters(effectiveFilters);
    const normalizedPrefixQueries = queries.map((query) => buildNormalizedQueryViews(query).strict);
    const eligiblePrefixQueries = normalizedPrefixQueries.map((normalizedQuery) =>
      useAliasPrefixTerms && isEligiblePrefixQuery(normalizedQuery),
    );

    const queryClauses = queries.map(
      (_, i) =>
        `(userInput(@query${i})` +
        ` OR canonical_label contains phrase(@query${i})` +
        ` OR aliases_identity_safe contains phrase(@query${i})` +
        ` OR aliases_noisy_recall contains phrase(@query${i})` +
        (eligiblePrefixQueries[i] === true
          ? ` OR ${ALIAS_PREFIX_TERMS_FIELD} contains ({prefix:true}@query${i}_prefix)`
          : '') +
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

    const queryParams: Record<string, unknown> = {
      'ranking.profile': rankProfile,
      'presentation.summary': 'hit_summary',
      ...buildStructuredQueryFeatureParams(queries, effectiveFilters),
    };
    for (let i = 0; i < queries.length; i++) {
      queryParams[`query${i}`] = queries[i];
      if (eligiblePrefixQueries[i] === true) {
        queryParams[`query${i}_prefix`] = normalizedPrefixQueries[i];
      }
    }

    return {
      yql,
      queryParams,
      usedAliasPrefixTerms: eligiblePrefixQueries.some((eligible) => eligible),
    };
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

    // Guard: empty queries array would produce `where () AND ...` which is
    // invalid Vespa YQL syntax and causes a 400 parse error on the Vespa side.
    if (queries.length === 0) {
      return [];
    }

    let sparseRequest = this.buildSparseSearchRequest(
      queries,
      effectiveFilters,
      hits,
      rankProfile,
      this.schemaCapabilities.aliasPrefixTerms,
    );
    let response: VespaQueryResponse;
    try {
      response = await this.queryUnderBreaker(
        sparseRequest.yql,
        sparseRequest.queryParams,
        undefined,
        requestId,
      );
    } catch (error) {
      if (
        sparseRequest.usedAliasPrefixTerms
        && VespaSearchIndex.isMissingSchemaFieldError(error, ALIAS_PREFIX_TERMS_FIELD)
      ) {
        this.disableAliasPrefixTermsCapability(error);
        sparseRequest = this.buildSparseSearchRequest(
          queries,
          effectiveFilters,
          hits,
          rankProfile,
          false,
        );
        response = await this.queryUnderBreaker(
          sparseRequest.yql,
          sparseRequest.queryParams,
          undefined,
          requestId,
        );
      } else {
        throw error;
      }
    }
    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const rank = index + 1;
      let entityId: CanonicalEntityId;
      try {
        entityId = this.extractEntityId(hit);
      } catch (err) {
        bootstrapLogger.warn(
          {
            callerName: 'sparseSearch',
            entityId: getEntityIdForLog(hit),
            rank,
            fieldCount: Object.keys(hit.fields).length,
            err: err instanceof Error ? err.message : String(err),
          },
          '[VespaSearchIndex] sparseSearch: failed to extract entityId',
        );
        throw err;
      }
      const summary = parseHitSummaryWithContext('sparseSearch', hit, rank);
      return {
        entityId,
        score: hit.relevance,
        rank,
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
      'presentation.summary': 'hit_summary',
      'input.query(query_embedding)': embedding,
      ...buildStructuredQueryFeatureParams([], effectiveFilters),
    }, undefined, requestId);

    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const rank = index + 1;
      let entityId: CanonicalEntityId;
      try {
        entityId = this.extractEntityId(hit);
      } catch (err) {
        bootstrapLogger.warn(
          {
            callerName: 'denseSearch',
            entityId: getEntityIdForLog(hit),
            rank,
            fieldCount: Object.keys(hit.fields).length,
            err: err instanceof Error ? err.message : String(err),
          },
          '[VespaSearchIndex] denseSearch: failed to extract entityId',
        );
        throw err;
      }
      const summary = parseHitSummaryWithContext('denseSearch', hit, rank);
      return {
        entityId,
        score: hit.relevance,
        rank,
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
      'ranking.profile': RETRIEVAL_CHANNEL_LEARNED_SPARSE,
      'presentation.summary': 'hit_summary',
      'input.query(sparse_query_embedding)': sparseQueryTensor,
    }, undefined, requestId);

    const children = response.root.children ?? [];

    return children.map((hit, index) => {
      const rank = index + 1;
      let entityId: CanonicalEntityId;
      try {
        entityId = this.extractEntityId(hit);
      } catch (err) {
        bootstrapLogger.warn(
          {
            callerName: 'searchLearnedSparse',
            entityId: getEntityIdForLog(hit),
            rank,
            fieldCount: Object.keys(hit.fields).length,
            err: err instanceof Error ? err.message : String(err),
          },
          '[VespaSearchIndex] searchLearnedSparse: failed to extract entityId',
        );
        throw err;
      }
      const summary = parseHitSummaryWithContext('searchLearnedSparse', hit, rank);
      return {
        entityId,
        score: hit.relevance,
        rank,
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
  async getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null> {
    const fields = await this.client.get(entityId);
    if (fields === null) return null;
    try {
      return fromVespaFields(fields);
    } catch (err) {
      logDocumentParseFailure('getDocument', err, fields);
      throw err;
    }
  }

  /**
   * @deprecated Use {@link getDocumentsReport} for new callers — it surfaces
   *   `missingIds`, `parseFailures`, and `batchFailures` so silent partial
   *   data loss is observable and policy-actionable. This wrapper is
   *   preserved for backward compatibility with existing callers that only
   *   need the bare `ReadonlyMap` shape; it logs an aggregate warn line
   *   whenever any parse or batch failure occurred.
   */
  async getDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>> {
    const report = await this.getDocumentsReport(entityIds);
    if (report.parseFailures > 0 || report.batchFailures > 0) {
      bootstrapLogger.warn(
        {
          requestedCount: entityIds.length,
          returnedCount: report.docs.size,
          missingCount: report.missingIds.length,
          parseFailures: report.parseFailures,
          batchFailures: report.batchFailures,
        },
        '[VespaSearchIndex] getDocuments: partial hydration — caller using legacy shape cannot see missingIds; consider migrating to getDocumentsReport',
      );
    }
    return report.docs;
  }

  /**
   * Batch-fetch documents and report partial-success diagnostics.
   *
   * Unlike the legacy {@link getDocuments}, the returned shape exposes
   * `missingIds`, `parseFailures`, and `batchFailures` so callers can:
   *  - enforce "all-or-nothing" semantics (fail loud when any id is missing);
   *  - distinguish *malformed hit* (parse failure on a returned hit) from
   *    *whole-batch failure* (Vespa query rejected or timed out);
   *  - attribute downstream silent-skip metrics to the correct bucket.
   *
   * `missingIds` preserves the original `entityIds` order and lists every id
   * for which no valid {@link RetrievalDocument} was produced, regardless of
   * whether the cause was a parse failure, a batch-level failure, or simply
   * "Vespa returned no hit for that id" (e.g. the document has been deleted
   * or never indexed).
   *
   * `docs` preserves the original `entityIds` order, mirroring legacy
   * `getDocuments` semantics for callers that mix-and-match the two APIs.
   */
  async getDocumentsReport(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<GetDocumentsReport> {
    if (entityIds.length === 0) {
      return {
        docs: new Map<CanonicalEntityId, RetrievalDocument>(),
        missingIds: [],
        parseFailures: 0,
        batchFailures: 0,
      };
    }
    if (entityIds.length > MAX_BULK_FETCH_IDS) {
      throw new Error(`getDocuments: too many ids (${entityIds.length} > ${MAX_BULK_FETCH_IDS})`);
    }
    const batches: CanonicalEntityId[][] = [];
    for (let offset = 0; offset < entityIds.length; offset += FETCH_SUMMARY_BATCH_SIZE) {
      batches.push([...entityIds.slice(offset, offset + FETCH_SUMMARY_BATCH_SIZE)]);
    }
    const settled = await Promise.allSettled(batches.map(async (batch) => {
      const idList = batch.map((id) => yqlEscapeString(id)).join(', ');
      const yql = `select * from ${SCHEMA} where entity_id in (${idList}) limit ${batch.length}`;
      // Bulk hydration uses the wider timeout channel — full-summary fetches
      // over 50-id batches routinely exceed the hot-path 3 s ceiling on
      // Vespa Cloud, and a timeout drops the entire batch (silent 0/N
      // hydration). See per-channel-timeouts.ts.
      const response = await this.queryUnderBreaker(
        yql,
        { 'presentation.summary': 'full' },
        undefined,
        undefined,
        VESPA_BULK_HYDRATION_TIMEOUT_MS,
      );
      const children = response.root.children ?? [];
      let parseFailures = 0;
      const docs: RetrievalDocument[] = [];
      for (let index = 0; index < children.length; index += 1) {
        const hit = children[index];
        if (hit === undefined) continue;
        try {
          docs.push(fromVespaFields(hit.fields));
        } catch (err) {
          parseFailures += 1;
          logDocumentParseFailure('getDocuments', err, hit.fields, index + 1);
          bootstrapLogger.warn(
            { batchSize: batch.length, entityIndex: index + 1 },
            '[VespaSearchIndex] getDocuments: skipping malformed hit and continuing',
          );
        }
      }
      return { docs, parseFailures };
    }));
    const docs = new Map<CanonicalEntityId, RetrievalDocument>();
    let parseFailures = 0;
    let batchFailures = 0;
    for (const result of settled) {
      if (result.status === 'rejected') {
        batchFailures += 1;
        bootstrapLogger.warn(
          { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
          '[VespaSearchIndex] getDocuments: batch query failed',
        );
        continue;
      }
      parseFailures += result.value.parseFailures;
      for (const doc of result.value.docs) {
        docs.set(doc.entityId, doc);
      }
    }
    const ordered = new Map<CanonicalEntityId, RetrievalDocument>();
    const missingIds: CanonicalEntityId[] = [];
    for (const entityId of entityIds) {
      const doc = docs.get(entityId);
      if (doc !== undefined) {
        ordered.set(entityId, doc);
      } else {
        missingIds.push(entityId);
      }
    }
    return {
      docs: ordered,
      missingIds,
      parseFailures,
      batchFailures,
    };
  }

  async getDrinkingWindowDocuments(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>> {
    const projections = await this.batchFetchBySummary({
      entityIds,
      callerName: 'getDrinkingWindowDocuments',
      selectFields:
        'entity_id, canonical_label, drinking_window_start,' +
        ' drinking_window_end, drinking_window_model_version',
      summaryName: 'full',
      parseHit: (fields) => parseDrinkingWindowSummary(fields),
      entityIdOf: (proj) => String(proj.entityId),
    });
    const byId = new Map<CanonicalEntityId, RetrievalDrinkingWindowProjection>();
    for (const projection of projections) {
      byId.set(projection.entityId, projection);
    }
    return byId;
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
    entityIds: readonly CanonicalEntityId[],
  ): Promise<readonly RetrievalHitProjection[]> {
    return this.batchFetchBySummary({
      entityIds,
      callerName: 'fetchWithHitSummary',
      selectFields:
        'entity_id, canonical_label, producer, region, appellation,' +
        ' grape_primary, vintage_year, search_text_en, producer_prestige,' +
        ' source_record_refs_json',
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
    entityIds: readonly CanonicalEntityId[],
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
   * emits in input order. Any batch failure fails the whole fetch closed
   * because these summary projections are ranker-critical follow-up reads.
   */
  private async batchFetchBySummary<T>(opts: {
    entityIds: readonly CanonicalEntityId[];
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
    const batches: CanonicalEntityId[][] = [];
    for (let offset = 0; offset < entityIds.length; offset += FETCH_SUMMARY_BATCH_SIZE) {
      batches.push([...entityIds.slice(offset, offset + FETCH_SUMMARY_BATCH_SIZE)]);
    }
    const settled = await Promise.allSettled(batches.map(async (batch) => {
      const idList = batch.map((id) => yqlEscapeString(id)).join(', ');
      const yql =
        `select ${selectFields}` +
        ` from ${SCHEMA} where entity_id in (${idList})` +
        ` limit ${batch.length}`;
      // Bulk hydration timeout channel — see per-channel-timeouts.ts.
      const response = await this.queryUnderBreaker(
        yql,
        { 'presentation.summary': summaryName },
        undefined,
        undefined,
        VESPA_BULK_HYDRATION_TIMEOUT_MS,
      );
      const children = response.root.children ?? [];
      return children.map((hit, index) => {
        try {
          return parseHit(hit.fields);
        } catch (err) {
          logDocumentParseFailure(callerName, err, hit.fields, index + 1);
          return null;
        }
      }).filter((hit): hit is T => hit !== null);
    }));

    // Build Map<entityId, projection> from successful batches.
    // Log failed batches — previously they were silently swallowed, making partial
    // failures invisible in production and causing silent ranking feature data loss.
    const projectionMap = new Map<string, T>();
    const batchFailures: string[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        bootstrapLogger.warn(
          { err: message, callerName },
          `[VespaSearchIndex] ${callerName}: batch query failed — refusing partial results`,
        );
        batchFailures.push(message);
        continue;
      }
      for (const proj of result.value) {
        const eid = entityIdOf(proj);
        if (eid !== undefined) {
          projectionMap.set(eid, proj);
        }
      }
    }

    if (batchFailures.length > 0) {
      throw new Error(
        `Vespa summary batch failed (${callerName}): ${batchFailures.join(' | ')}`,
      );
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
   * Extracts a validated {@link CanonicalEntityId} from a Vespa hit's fields.
   * Then parses the hit `id` URI document id segment (ADR-007: both must satisfy
   * canonical public namespace rules — no source-record `vivino-` ids as public entity_id).
   *
   * @param hit - The Vespa search hit.
   * @returns A valid canonical entity ID.
   * @throws {Error} If no usable entity ID can be found or namespace rules are violated.
   */
  private extractEntityId(hit: VespaHit): CanonicalEntityId {
    // Prefer the indexed `entity_id` field.
    const fromField = hit.fields['entity_id'];
    if (isString(fromField) && fromField.length > 0) {
      return createCanonicalEntityId(fromField);
    }

    // Parse the document ID from the Vespa hit URI.
    // Format: "id:<namespace>:<doctype>::<docid>"
    const parts = hit.id.split('::');
    const docId = parts[parts.length - 1];
    if (isString(docId) && docId.length > 0) {
      return createCanonicalEntityId(docId);
    }

    throw new Error(
      `Vespa: unable to extract CanonicalEntityId from hit id="${hit.id}"`,
    );
  }
}
