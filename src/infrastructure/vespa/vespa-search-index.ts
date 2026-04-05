/**
 * Vespa implementation of {@link SearchIndexPort}.
 *
 * Handles sparse (BM25) retrieval, dense (ANN) retrieval, single-document
 * fetch, and document upsert / bulk-upsert operations.
 */

import type { EntityId } from '../../domain/shared/types/index.js';
import { isEntityId } from '../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type {
  SearchIndexPort,
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
} from '../../domain/retrieval/port/search-index.port.js';
import { type VespaClient } from './vespa-client.js';
import type { VespaHit } from './vespa-client.js';
import {
  toVespaFields,
  fromVespaFields,
  buildSparseFilters,
  buildDenseFilters,
} from './mapping.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA = 'wine_entity';
const DEFAULT_SPARSE_LIMIT = 100;
const DEFAULT_DENSE_LIMIT = 100;
const BULK_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
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

  // If Vespa did not return matchfeatures, approximate from known text fields.
  if (matched.length === 0) {
    return ['canonical_label', 'search_text_ko', 'search_text_en'];
  }

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
  // Clamp to [0, 1] in case of floating-point rounding.
  return Math.max(0, Math.min(1, score));
}

const RERANK_SUMMARY_SEARCH_TEXT_MAX = 800;

function trimNonEmpty(v: unknown): string | undefined {
  if (!isString(v)) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Pulls summary fields from a Vespa hit for hybrid reranking passages.
 */
function extractHitSummary(fields: Record<string, unknown>): RetrievalHitSummary | undefined {
  const canonicalLabel = trimNonEmpty(fields['canonical_label']);
  const producer = trimNonEmpty(fields['producer']);
  const region = trimNonEmpty(fields['region']);
  let searchTextEn = trimNonEmpty(fields['search_text_en']);
  if (
    searchTextEn !== undefined &&
    searchTextEn.length > RERANK_SUMMARY_SEARCH_TEXT_MAX
  ) {
    searchTextEn = searchTextEn.slice(0, RERANK_SUMMARY_SEARCH_TEXT_MAX);
  }

  const grapePrimary = trimNonEmpty(fields['grape_primary']);

  const summary: RetrievalHitSummary = {
    ...(canonicalLabel !== undefined ? { canonicalLabel } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(searchTextEn !== undefined ? { searchTextEn } : {}),
    ...(grapePrimary !== undefined ? { grapePrimary } : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
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
  constructor(private readonly client: VespaClient) {}

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
  ): Promise<readonly SparseHit[]> {
    const hits = limit ?? DEFAULT_SPARSE_LIMIT;
    const filterClause = buildSparseFilters(filters ?? []);

    // Per-query clause:
    //   userInput(@queryN)          — general multi-term match via WAND
    //   canonical_label contains phrase(@queryN)   — exact phrase for full wine names
    //   aliases_identity_safe contains phrase(@queryN) — exact phrase for identity aliases
    // The OR of phrase operators ensures "Château Margaux 2015" is found even
    // when the tokeniser would split the query differently than WAND expects.
    const queryClauses = queries.map(
      (_, i) =>
        `(userInput(@query${i})` +
        ` OR canonical_label contains phrase(@query${i})` +
        ` OR aliases_identity_safe contains phrase(@query${i}))`,
    );

    const queryUnion =
      queryClauses.length === 1
        ? queryClauses[0]
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
    };
    for (let i = 0; i < queries.length; i++) {
      queryParams[`query${i}`] = queries[i];
    }

    const response = await this.client.query(yql, queryParams);
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
  ): Promise<readonly DenseHit[]> {
    const targetHits = limit ?? DEFAULT_DENSE_LIMIT;
    const filterClause = buildDenseFilters(filters ?? []);

    // hnsw.exploreAdditionalHits raises ef_search beyond targetHits so that
    // the HNSW graph explores more neighbours at query time, improving ANN
    // recall at the cost of a small latency increase.
    // Setting it to min(targetHits, 100) doubles exploration budget while
    // capping it at 100 to avoid tail latency spikes on large corpora.
    const exploreAdditional = Math.min(targetHits, 100);
    const yql =
      `select * from ${SCHEMA} where ` +
      `({targetHits: ${targetHits}, hnsw.exploreAdditionalHits: ${exploreAdditional}}` +
      `nearestNeighbor(embedding, query_embedding))` +
      ` AND availability = true` +
      filterClause +
      ` limit ${targetHits}`;

    const response = await this.client.query(yql, {
      'ranking.profile': rankProfile,
      'presentation.summary': 'default',
      'input.query(query_embedding)': embedding,
    });

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
