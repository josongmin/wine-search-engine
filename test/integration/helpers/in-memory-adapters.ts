/**
 * In-memory stub implementations for all infrastructure ports.
 * Used exclusively in integration and E2E tests — no real DB or network.
 */

import type { EntityId, QueryClass } from '../../../src/domain/shared/types/index.js';
import type { AliasType } from '../../../src/domain/alias/model/alias.js';
import type { AmbiguityDictionary } from '../../../src/domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type {
  CalibrationStore,
  CalibrationParams,
  FreshCalibrationLoadResult,
} from '../../../src/domain/resolver/port/calibration-store.port.js';
import type {
  SearchIndexPort,
  SparseHit,
  DenseHit,
} from '../../../src/domain/retrieval/port/search-index.port.js';
import type { EmbeddingServicePort } from '../../../src/domain/retrieval/port/embedding-service.port.js';
import type { ThresholdStore } from '../../../src/domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../../src/domain/query/model/threshold-profile.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../../src/domain/query/model/threshold-profile.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import type { AliasMatcher, AliasMatchResult } from '../../../src/domain/query/service/anchor-extractor.js';
import type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../../../src/domain/mixed/service/mixed-solver.js';
import type { AnchorEntityData } from '../../../src/domain/mixed/service/anchor-profiler.js';
import type { SimilarityCandidate } from '../../../src/domain/mixed/service/similarity-scorer.js';
import { FUZZY_IDENTITY_TRUST_MIN_SIMILARITY } from '../../../src/domain/resolver/model/fuzzy-identity-trust.js';
import type { AnchorProfile } from '../../../src/domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { GoldSetStore, GoldSetFilter } from '../../../src/domain/evaluation/port/gold-set-store.port.js';
import type { EvalCase } from '../../../src/domain/evaluation/model/eval-case.js';
import type { EvalResultStore, EvalResultFilter } from '../../../src/domain/evaluation/port/eval-result-store.port.js';
import type { EvalResult } from '../../../src/domain/evaluation/model/eval-result.js';
import { Transliterator } from '../../../src/domain/alias/service/transliterator.js';
import {
  buildAliasPrefixTerms,
  isEligiblePrefixQuery,
  isDisallowedWholeLeadingTokenExpansion,
  matchesAliasPrefixTerm,
} from '../../../src/domain/query/service/alias-prefix-terms.js';
import { buildNormalizedQueryViews } from '../../../src/domain/query/service/query-normalizer.js';
import { doubleMetaphoneKeys } from '../../../src/domain/alias/service/double-metaphone.js';
import { buildHangulJamoKey } from '../../../src/domain/shared/utils/hangul.js';
import { pickHigherTrustAliasType } from '../../../src/domain/alias/service/conflict-resolver.js';
import {
  damerauLevenshteinOsa,
  editDistanceSimilarity,
} from '../../../src/domain/alias/service/edit-distance.js';
import { retrievalDocumentToHitSummary } from '../../../src/domain/retrieval/service/hybrid-candidate-summary.js';
import { hardConstraintsToSparseFilterTokens } from '../../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import {
  buildFilterPredicate,
  hybridCandidateToFilterableDoc,
} from './in-memory-retrieval-helpers.js';

/**
 * Fuzzy-stage tuning for {@link InMemoryAliasMatcher.findFuzzyMatches}.
 *
 * Single-signal Damerau-OSA, in contrast to production `pg-alias-matcher`'s
 * multi-signal (Damerau + Jaro-Winkler + char-trigram + bigram + Double
 * Metaphone) max-fused score. The in-memory matcher trades coverage for
 * determinism: tests need a stable, easy-to-reason-about fuzzy gate.
 *
 *  - `FUZZY_MIN_KEY_LENGTH = 5` matches pg-alias-matcher's
 *    `MIN_FUZZY_QUERY_LENGTH = 5` so a Latin query like "opus" (4) does NOT
 *    enter the fuzzy stage in either substrate. Hangul side uses jamo
 *    length, so "오푸스" (jamo len 6) clears; "마고" (jamo len 4) does not
 *    — that's intentional, matching production's policy of refusing
 *    fuzzy on very short surfaces.
 *  - `FUZZY_SIMILARITY_THRESHOLD` (= {@link FUZZY_IDENTITY_TRUST_MIN_SIMILARITY},
 *    0.8) is tighter than pg's effective threshold (multi-signal `max` rarely
 *    drops below ~0.85 on real typos), so the in-memory side is *stricter*, not
 *    looser. It is the SSoT shared with the decision-layer fuzzy-identity trust
 *    predicate (CLAUDE.md rule 30) so the matcher gate and the trust gate cannot
 *    drift. The in-memory stage is documented as a recall channel for tests, not
 *    a behavioral parity claim for production.
 *  - `FUZZY_MATCH_CONFIDENCE_FACTOR = 0.8` is the haircut applied so a
 *    fuzzy candidate doesn't outscore an exact one. (production pg
 *    doesn't apply this factor explicitly — it relies on the Jaro-Winkler
 *    prefix bonus instead. The numerical asymmetry is documented; do not
 *    use the in-memory matcher's confidence as a proxy for production's.)
 */
const FUZZY_SIMILARITY_THRESHOLD = FUZZY_IDENTITY_TRUST_MIN_SIMILARITY;
const FUZZY_MIN_KEY_LENGTH = 5;
const FUZZY_MATCH_CONFIDENCE_FACTOR = 0.8;

/**
 * Max `.confidence` over entries via a loop. Rule 9: never `Math.max(...spread)`
 * — spreading a large array onto the call stack overflows past ~65K elements.
 */
function maxConfidenceOf(entries: readonly { readonly confidence: number }[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    if (e.confidence > max) max = e.confidence;
  }
  return max;
}
import type { NormalizedConstraint } from '../../../src/domain/shared/types/index.js';

const IN_MEMORY_EMBEDDING_DIM = 1024;

function hashTextToUnitVector(text: string, dim = IN_MEMORY_EMBEDDING_DIM): readonly number[] {
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const idx = (code * (i + 1)) % dim;
    vec[idx] = ((vec[idx] ?? 0) + code / 255) % 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function dotProduct(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

function buildDenseSearchDocumentText(doc: RetrievalDocument): string {
  return [
    doc.canonicalLabel,
    doc.searchTextKo,
    doc.searchTextEn,
    doc.semanticSummary,
    ...doc.aliasesIdentitySafe,
    ...doc.aliasesNoisyRecall,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryAmbiguityDictionary
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryAmbiguityDictionary implements AmbiguityDictionary {
  private readonly ambiguous = new Map<string, { types: string[]; severity: 'low' | 'medium' | 'high' }>();

  setAmbiguous(term: string, types: string[], severity: 'low' | 'medium' | 'high' = 'medium'): void {
    this.ambiguous.set(term.toLowerCase(), { types, severity });
  }

  async isKnownAmbiguous(term: string): Promise<boolean> {
    return this.ambiguous.has(term.toLowerCase());
  }

  async getAmbiguityInfo(
    term: string,
  ): Promise<{ types: string[]; severity: 'low' | 'medium' | 'high' } | null> {
    return this.ambiguous.get(term.toLowerCase()) ?? null;
  }

  async getAmbiguityInfoBatch(
    surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, { types: string[]; severity: 'low' | 'medium' | 'high' }>> {
    const out = new Map<string, { types: string[]; severity: 'low' | 'medium' | 'high' }>();
    for (const form of surfaceForms) {
      const hit = this.ambiguous.get(form.toLowerCase());
      if (hit !== undefined) {
        out.set(form, hit);
      }
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryBlockingAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all stored entity IDs as candidates (100% recall, used in tests).
 */
export class InMemoryBlockingAdapter implements BlockingPort {
  private readonly entityIds = new Set<EntityId>();

  addEntityId(id: EntityId): void {
    this.entityIds.add(id);
  }

  addEntityIds(ids: readonly EntityId[]): void {
    for (const id of ids) {
      this.entityIds.add(id);
    }
  }

  async block(
    _query: string,
    _normalizedQuery: string,
    limit?: number,
  ): Promise<readonly EntityId[]> {
    const result = Array.from(this.entityIds);
    return limit != null ? result.slice(0, limit) : result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryCalibrationStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryCalibrationStore implements CalibrationStore {
  private readonly params = new Map<QueryClass, CalibrationParams>();

  async getCalibrationParams(queryClass: QueryClass): Promise<CalibrationParams | null> {
    return this.params.get(queryClass) ?? null;
  }

  async save(queryClass: QueryClass, params: CalibrationParams): Promise<void> {
    this.params.set(queryClass, params);
  }

  async loadIfFresh(
    queryClass: QueryClass,
    ttlDays: number,
    now: Date = new Date(),
  ): Promise<FreshCalibrationLoadResult> {
    const params = this.params.get(queryClass) ?? null;
    if (params === null) {
      return { trusted: false, reason: 'missing', params: null };
    }
    if (params.fittedAt === undefined) {
      return { trusted: false, reason: 'never_fitted', params };
    }
    const ageMs = now.getTime() - params.fittedAt.getTime();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (ageMs > ttlMs) {
      return { trusted: false, reason: 'stale', params };
    }
    return { trusted: true, params };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemorySearchIndex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores RetrievalDocuments and returns configurable hits.
 * sparseSearch matches by canonicalLabel / aliases text.
 * denseSearch returns all docs ranked by a fake similarity score.
 */
export class InMemorySearchIndex implements SearchIndexPort {
  private readonly docs = new Map<EntityId, RetrievalDocument>();
  private readonly denseVectors = new Map<EntityId, readonly number[]>();

  upsertDoc(doc: RetrievalDocument): void {
    this.docs.set(doc.entityId, doc);
    this.denseVectors.set(doc.entityId, hashTextToUnitVector(buildDenseSearchDocumentText(doc)));
  }

  async sparseSearch(
    queries: readonly string[],
    filters?: readonly string[],
    limit?: number,
    _rankProfile?: string,
  ): Promise<readonly SparseHit[]> {
    const hits: SparseHit[] = [];
    const queryLower = queries.map((q) => q.toLowerCase());
    const prefixQueries = queries
      .map((q) => buildNormalizedQueryViews(q).strict)
      .filter((q) => isEligiblePrefixQuery(q));
    // Filter parity with denseSearch: hard-constraint filter tokens must be
    // honored here too, otherwise a sparse-lane match (BM25 phrase hit) can
    // bypass a hard constraint that the dense lane correctly excluded —
    // letting a non-red wine survive a `wine_type:red` constraint.
    const filterPredicate = buildFilterPredicate(filters);

    for (const doc of this.docs.values()) {
      if (!filterPredicate(doc)) continue;
      const searchableText = [
        doc.canonicalLabel,
        doc.searchTextEn,
        doc.searchTextKo,
        ...doc.aliasesIdentitySafe,
        ...doc.aliasesNoisyRecall,
      ]
        .join(' ')
        .toLowerCase();
      const prefixTerms = doc.aliasPrefixTerms ?? buildAliasPrefixTerms([
        doc.canonicalLabel,
        doc.producer,
        ...doc.aliasesIdentitySafe,
        ...doc.aliasesNoisyRecall,
      ]);

      let score = 0;
      const matchedFields = new Set<string>();
      for (const q of queryLower) {
        const terms = q.split(/\s+/).filter(Boolean);
        for (const term of terms) {
          if (searchableText.includes(term)) {
            score += 1;
            matchedFields.add('searchText');
          }
        }
      }
      for (const prefixQuery of prefixQueries) {
        if (prefixTerms.some((term) => matchesAliasPrefixTerm(prefixQuery, term))) {
          score += 1;
          matchedFields.add('alias_prefix_terms');
        }
      }

      if (score > 0) {
        hits.push({
          entityId: doc.entityId,
          score,
          rank: 0, // will be assigned after sort
          matchedFields: [...matchedFields],
          summary: retrievalDocumentToHitSummary(doc),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const limited = limit != null ? hits.slice(0, limit) : hits;
    return limited.map((h, i) => ({ ...h, rank: i + 1 }));
  }

  async denseSearch(
    embedding: readonly number[],
    filters?: readonly string[],
    limit?: number,
    _rankProfile?: string,
  ): Promise<readonly DenseHit[]> {
    // Honor hard-constraint filter tokens (wine_type:red, region:Burgundy,
    // style_matches:bold, …) — production VespaSearchIndex applies them at
    // the Vespa WHERE layer, so the stub must too. Without this, mixed-route
    // `similar_items` with a `wine_type` constraint silently returned every
    // wine type (the constraint overlay then dropped them all, leaving 0
    // candidates — the 마고 비슷한 레드 zero-result class).
    //
    const filterPredicate = buildFilterPredicate(filters);
    const docs = Array.from(this.docs.values())
      .filter(filterPredicate)
      .map((doc) => {
        const vector = this.denseVectors.get(doc.entityId) ?? hashTextToUnitVector(buildDenseSearchDocumentText(doc));
        const semanticScore = dotProduct(embedding, vector);
        const popularityTieBreak = doc.popularityScore * 0.01;
        return {
          doc,
          score: semanticScore + popularityTieBreak,
          similarity: semanticScore,
        };
      })
      .sort((left, right) => right.score - left.score);
    const limited = limit != null ? docs.slice(0, limit) : docs;
    return limited.map(({ doc, similarity }, i) => ({
      entityId: doc.entityId,
      score: similarity,
      rank: i + 1,
      similarity,
      summary: retrievalDocumentToHitSummary(doc),
    }));
  }

  async searchLearnedSparse(
    _queryWeights: readonly { token: string; weight: number }[],
    filters?: readonly string[],
    limit?: number,
  ): Promise<readonly DenseHit[]> {
    // Wave 1 compatibility: in-memory integration lanes reuse deterministic
    // dense-style ranking until a dedicated learned-sparse in-memory index exists.
    return this.denseSearch([], filters, limit);
  }

  async getDocument(entityId: EntityId): Promise<RetrievalDocument | null> {
    return this.docs.get(entityId) ?? null;
  }

  async getDocuments(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, RetrievalDocument>> {
    const docs = new Map<EntityId, RetrievalDocument>();
    for (const entityId of entityIds) {
      const doc = this.docs.get(entityId);
      if (doc !== undefined) {
        docs.set(entityId, doc);
      }
    }
    return docs;
  }

  async upsertDocument(doc: RetrievalDocument): Promise<void> {
    this.upsertDoc(doc);
  }

  async bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    for (const doc of docs) {
      this.upsertDoc(doc);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryEmbeddingService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns deterministic hash-based fake vectors — always the same for the same text.
 */
export class InMemoryEmbeddingService implements EmbeddingServicePort {
  async embed(text: string): Promise<readonly number[]> {
    return hashTextToUnitVector(text);
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((t) => hashTextToUnitVector(t));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryThresholdStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryThresholdStore implements ThresholdStore {
  private readonly profiles = new Map<string, ThresholdProfileV1>();
  private defaultProfile: ThresholdProfileV1 = DEFAULT_THRESHOLD_PROFILE;

  async getProfile(id: string): Promise<ThresholdProfileV1 | null> {
    return this.profiles.get(id) ?? null;
  }

  async getDefault(): Promise<ThresholdProfileV1> {
    return this.defaultProfile;
  }

  async save(profile: ThresholdProfileV1): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  setDefault(profile: ThresholdProfileV1): void {
    this.defaultProfile = profile;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryAliasMatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores alias→entityId mappings, supports exact and normalized lookups.
 * Enhanced with smart alias generation from indexed documents.
 */
/**
 * Provenance tag for alias entries in {@link InMemoryAliasMatcher}.
 *
 * Mirrors the production `aliases.alias_type` column at a coarser tier:
 * - `curated`            — hand-authored aliases (downstream {@link AliasType}
 *                          is `'canonical'`)
 * - `derived_initialism` — deterministic ETL-style caps initialism, eligible
 *                          for the resolver scorer's DERIVED_INITIALISM_CAP
 * - `abbreviation`       — curated/LLM-proposed wine-community shorthand
 *                          (e.g. "CM 15", "DRC 19"), eligible for the
 *                          resolver scorer's ABBREVIATION_CAP. Lands in the
 *                          production `aliases` table via the
 *                          `scripts/etl/generate-abbreviation-aliases.ts`
 *                          ETL after a review-gate workflow.
 *
 * The matcher emits the resolved {@link AliasType} on every
 * {@link AliasMatchResult} so the resolver scorer can apply type-specific
 * caps without parsing strategy strings.
 */
export type InMemoryAliasProvenance = 'curated' | 'derived_initialism' | 'abbreviation';

/**
 * SSoT for the provenance → {@link AliasType} mapping used by the in-memory
 * matcher. Production matchers read `alias_type` directly from PG; this
 * lookup mirrors that shape for the in-process test substrate.
 */
const PROVENANCE_TO_ALIAS_TYPE: Readonly<Record<InMemoryAliasProvenance, AliasType>> = {
  curated: 'canonical',
  derived_initialism: 'derived_initialism',
  abbreviation: 'abbreviation',
};

export class InMemoryAliasMatcher implements AliasMatcher {
  // normalized form → list of (entityId, surfaceForm, confidence, provenance)
  private readonly aliases = new Map<
    string,
    Array<{
      entityId: EntityId;
      surfaceForm: string;
      confidence: number;
      provenance: InMemoryAliasProvenance;
    }>
  >();
  private readonly hangulCompletionPrefixIndex = new Map<
    string,
    Array<{
      entityId: EntityId;
      surfaceForm: string;
      normalizedForm: string;
      confidence: number;
      jamoKey: string;
      syllableBoundaryOffsets: ReadonlySet<number>;
    }>
  >();
  private readonly doubleMetaphoneIndex = new Map<
    string,
    Array<{
      entityId: EntityId;
      surfaceForm: string;
      normalizedForm: string;
      confidence: number;
      provenance: InMemoryAliasProvenance;
    }>
  >();

  // entityId → document for smart alias generation
  private readonly documents = new Map<EntityId, RetrievalDocument>();

  /**
   * Register an alias mapping.
   * @param surfaceForm - Original user-facing form (e.g. "오푸스원")
   * @param entityId - The entity this alias maps to
   * @param confidence - Match confidence [0, 1]
   * @param provenance - Origin of the alias: 'curated' (default) for
   *   hand-authored entries, 'derived_initialism' for deterministic ETL
   *   derivations. The match results inherit this so the downstream
   *   resolver scorer can apply type-specific caps.
   */
  addAlias(
    surfaceForm: string,
    entityId: EntityId,
    confidence = 0.95,
    provenance: InMemoryAliasProvenance = 'curated',
  ): void {
    const normalized = this.normalize(surfaceForm);
    const existing = this.aliases.get(normalized) ?? [];
    if (
      existing.some(
        (entry) =>
          entry.surfaceForm === surfaceForm &&
          entry.entityId === entityId &&
          entry.confidence === confidence &&
          entry.provenance === provenance,
      )
    ) {
      return;
    }
    existing.push({ entityId, surfaceForm, confidence, provenance });
    this.aliases.set(normalized, existing);
    this.indexHangulCompletionSurface(surfaceForm, normalized, entityId, confidence);
    this.indexDoubleMetaphoneSurface(surfaceForm, normalized, entityId, confidence, provenance);
  }

  private indexDoubleMetaphoneSurface(
    surfaceForm: string,
    normalizedForm: string,
    entityId: EntityId,
    confidence: number,
    provenance: InMemoryAliasProvenance,
  ): void {
    const surfacesToIndex = [
      surfaceForm,
      normalizedForm,
      ...buildNormalizedQueryViews(surfaceForm).lookupVariants,
    ];
    const seenKeys = new Set<string>();
    for (const surface of surfacesToIndex) {
      for (const dmKey of doubleMetaphoneKeys(surface)) {
        if (dmKey.length === 0 || seenKeys.has(dmKey)) {
          continue;
        }
        seenKeys.add(dmKey);
        const bucket = this.doubleMetaphoneIndex.get(dmKey) ?? [];
        bucket.push({
          entityId,
          surfaceForm,
          normalizedForm,
          confidence,
          provenance,
        });
        this.doubleMetaphoneIndex.set(dmKey, bucket);
      }
      for (const token of surface.split(/\s+/).filter((part) => part.length > 0)) {
        for (const dmKey of doubleMetaphoneKeys(token)) {
          if (dmKey.length === 0 || seenKeys.has(dmKey)) {
            continue;
          }
          seenKeys.add(dmKey);
          const bucket = this.doubleMetaphoneIndex.get(dmKey) ?? [];
          bucket.push({
            entityId,
            surfaceForm,
            normalizedForm,
            confidence,
            provenance,
          });
          this.doubleMetaphoneIndex.set(dmKey, bucket);
        }
      }
    }
  }

  /**
   * Index a document for smart alias generation.
   * Called when documents are added to the search index.
   * @param doc - The retrieval document to index
   */
  indexDocument(doc: RetrievalDocument): void {
    this.documents.set(doc.entityId, doc);
  }

  /**
   * Resolves the {@link AliasType} for a bucket of entries that all share
   * the same normalized-form key in {@link aliases}.
   *
   * When entries are mixed-provenance under a single key (rare but
   * possible — e.g. a hand-authored 'CM' alias coexisting with a derived
   * 'CM' for a different entity), the higher-trust type wins. This mirrors
   * the AnchorExtractor merger's policy and keeps cap-firing semantics
   * consistent across the pipeline.
   *
   * Returns `undefined` only when the bucket is empty (defensive — never
   * occurs for an alias that we just looked up).
   */
  private pickAliasTypeForEntries(
    entries: ReadonlyArray<{ readonly provenance: InMemoryAliasProvenance }>,
  ): AliasType | undefined {
    if (entries.length === 0) return undefined;
    let best: AliasType | undefined;
    for (const entry of entries) {
      const candidate = PROVENANCE_TO_ALIAS_TYPE[entry.provenance];
      best = pickHigherTrustAliasType(best, candidate);
    }
    return best;
  }

  /**
   * Extract all documents currently indexed.
   * Used for testing and introspection.
   */
  getIndexedDocuments(): readonly RetrievalDocument[] {
    return Array.from(this.documents.values());
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const views = buildNormalizedQueryViews(normalizedQuery);

    // Stage 1: Exact match from pre-registered aliases
    const exact = this.aliases.get(views.strict);
    if (exact && exact.length > 0) {
      const grouped = new Map<string, { entityIds: EntityId[]; confidence: number }>();
      for (const entry of exact) {
        const existing = grouped.get(entry.surfaceForm);
        if (existing) {
          existing.entityIds.push(entry.entityId);
        } else {
          grouped.set(entry.surfaceForm, {
            entityIds: [entry.entityId],
            confidence: entry.confidence,
          });
        }
      }
      return Array.from(grouped.entries()).map(([surfaceForm, { entityIds, confidence }]) => {
        const matchedEntries = exact.filter((e) => e.surfaceForm === surfaceForm);
        const aliasType = this.pickAliasTypeForEntries(matchedEntries);
        return {
          surfaceForm,
          normalizedForm: views.strict,
          entityIds,
          matchConfidence: confidence,
          lookupStrategy: 'exact',
          ...(aliasType !== undefined ? { aliasType } : {}),
        };
      });
    }

    // Stage 1.5: compact normalization match for 붙여쓰기/구두점 noise
    const compactResults: AliasMatchResult[] = [];
    for (const [normalized, entries] of this.aliases) {
      if (this.compact(normalized) !== views.compact) {
        continue;
      }

      const entityIds = entries.map((entry) => entry.entityId);
      const maxConfidence = maxConfidenceOf(entries);
      const aliasType = this.pickAliasTypeForEntries(entries);
      compactResults.push({
        surfaceForm: entries[0]?.surfaceForm ?? normalized,
        normalizedForm: normalized,
        entityIds,
        matchConfidence: maxConfidence * 0.93,
        lookupStrategy: 'compact_exact',
        ...(aliasType !== undefined ? { aliasType } : {}),
      });
    }
    if (compactResults.length > 0) {
      compactResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return compactResults;
    }

    // Stage 1.75: transliterated exact normalization match for Korean/Latin mixed queries
    if (views.transliterated !== undefined) {
      const transliteratedResults: AliasMatchResult[] = [];
      for (const [normalized, entries] of this.aliases) {
        if (
          normalized !== views.transliterated &&
          this.compact(normalized) !== this.compact(views.transliterated)
        ) {
          continue;
        }

        const entityIds = entries.map((entry) => entry.entityId);
        const maxConfidence = maxConfidenceOf(entries);
        const aliasType = this.pickAliasTypeForEntries(entries);
        transliteratedResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.91,
          lookupStrategy: 'transliterated_exact',
          ...(aliasType !== undefined ? { aliasType } : {}),
        });
      }
      if (transliteratedResults.length > 0) {
        transliteratedResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
        return transliteratedResults;
      }
    }

    // Stage 1.8: IME-aware Hangul completion match for curated Korean exception surfaces
    const hangulCompletionResults = this.findHangulCompletionMatches(views.strict);
    if (hangulCompletionResults.length > 0) {
      hangulCompletionResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return hangulCompletionResults;
    }

    // Stage 1.85: dedicated prefix substrate parity with production alias matchers
    const queryPrefixTerms = isEligiblePrefixQuery(views.strict)
      ? buildAliasPrefixTerms([views.strict])
      : [];
    const transliteratedPrefixTerms =
      views.transliterated !== undefined && isEligiblePrefixQuery(views.transliterated)
        ? buildAliasPrefixTerms([views.transliterated])
        : [];
    const transliteratedPrefixResults: AliasMatchResult[] = [];
    const prefixResults: AliasMatchResult[] = [];

    for (const [normalized, entries] of this.aliases) {
      const candidatePrefixTerms = buildAliasPrefixTerms([
        normalized,
        ...entries.map((entry) => entry.surfaceForm),
      ]);
      const entityIds = entries.map((entry) => entry.entityId);
      const maxConfidence = maxConfidenceOf(entries);
      const aliasType = this.pickAliasTypeForEntries(entries);

      if (
        transliteratedPrefixTerms.some((term) =>
          candidatePrefixTerms.some((candidateTerm) => matchesAliasPrefixTerm(term, candidateTerm))
        )
      ) {
        transliteratedPrefixResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.89,
          lookupStrategy: 'transliterated_prefix',
          ...(aliasType !== undefined ? { aliasType } : {}),
        });
        continue;
      }

      if (
        queryPrefixTerms.some((term) =>
          candidatePrefixTerms.some((candidateTerm) => matchesAliasPrefixTerm(term, candidateTerm))
        )
      ) {
        prefixResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.9,
          lookupStrategy: 'prefix_exact',
          ...(aliasType !== undefined ? { aliasType } : {}),
        });
      }
    }

    if (transliteratedPrefixResults.length > 0) {
      transliteratedPrefixResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return transliteratedPrefixResults;
    }

    if (prefixResults.length > 0) {
      prefixResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return prefixResults;
    }

    // Stage 1.9: phonetic compact match for consonant-skeleton / digraph noise
    if (views.phoneticCompact !== undefined) {
      const phoneticResults: AliasMatchResult[] = [];
      for (const [normalized, entries] of this.aliases) {
        const aliasViews = buildNormalizedQueryViews(normalized);
        if (aliasViews.phoneticCompact !== views.phoneticCompact) {
          continue;
        }

        const entityIds = entries.map((entry) => entry.entityId);
        const maxConfidence = maxConfidenceOf(entries);
        const aliasType = this.pickAliasTypeForEntries(entries);
        phoneticResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.88,
          lookupStrategy: 'phonetic_exact',
          ...(aliasType !== undefined ? { aliasType } : {}),
        });
      }
      if (phoneticResults.length > 0) {
        phoneticResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
        return phoneticResults;
      }
    }

    const doubleMetaphoneResults: AliasMatchResult[] = [];
    const queryDmKeys = new Set<string>();
    for (const variant of views.lookupVariants) {
      for (const dmKey of doubleMetaphoneKeys(variant)) {
        queryDmKeys.add(dmKey);
      }
    }
    for (const token of views.punctuationStripped.split(/\s+/).filter(Boolean)) {
      for (const dmKey of doubleMetaphoneKeys(token)) {
        queryDmKeys.add(dmKey);
      }
    }
    for (const dmKey of queryDmKeys) {
      const entries = this.doubleMetaphoneIndex.get(dmKey);
      if (entries === undefined) {
        continue;
      }
      for (const entry of entries) {
        const entityIds = [entry.entityId];
        doubleMetaphoneResults.push({
          surfaceForm: entry.surfaceForm,
          normalizedForm: entry.normalizedForm,
          entityIds,
          matchConfidence: entry.confidence * 0.86,
          lookupStrategy: 'phonetic_exact',
          ...(this.pickAliasTypeForEntries([entry]) !== undefined
            ? { aliasType: this.pickAliasTypeForEntries([entry]) }
            : {}),
        });
      }
    }
    if (doubleMetaphoneResults.length > 0) {
      doubleMetaphoneResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return doubleMetaphoneResults;
    }

    // Stage 2: Substring/token match in pre-registered aliases
    // Match when: alias is a substring of query OR query tokens are prefix of alias tokens
    const substringResults: AliasMatchResult[] = [];
    for (const [normalized, entries] of this.aliases) {
      const queryTokens = views.punctuationStripped.split(/\s+/).filter(Boolean);
      const aliasTokens = this.punctuationStripped(normalized).split(/\s+/).filter(Boolean);
      const queryWholePhrase = ` ${views.punctuationStripped.trim()} `;
      const aliasWholePhrase = ` ${this.punctuationStripped(normalized).trim()} `;

      // Case 1: Query contains the alias as a whole phrase, not an arbitrary
      // character substring ("ma" inside "margaux" must not fire).
      const isSubstringMatch =
        queryWholePhrase.includes(aliasWholePhrase);

      // Case 2: Query tokens are prefix of alias tokens (e.g., "david arthur" matches "david arthur cabernet sauvignon")
      const isTokenPrefixMatch = queryTokens.length > 0 &&
        queryTokens.length <= aliasTokens.length &&
        queryTokens.every((qt, i) => aliasTokens[i] === qt) &&
        !isDisallowedWholeLeadingTokenExpansion(
          views.punctuationStripped,
          this.punctuationStripped(normalized),
        );

      if (isSubstringMatch || isTokenPrefixMatch) {
        const entityIds = entries.map((e) => e.entityId);
        const maxConfidence = maxConfidenceOf(entries);
        const aliasType = this.pickAliasTypeForEntries(entries);
        substringResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.85,
          lookupStrategy: 'substring',
          ...(aliasType !== undefined ? { aliasType } : {}),
        });
      }
    }
    if (substringResults.length > 0) {
      substringResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return substringResults;
    }

    // Stage 2.5: fuzzy edit-distance recall (last resort before smart docs).
    // Mirrors production (pg-alias-matcher) which runs a Damerau/charNgram
    // fuzzy channel; the in-memory matcher previously lacked it, so Korean
    // jamo-level typos ("몬데스"→"몬테스", "케이무스"→"케이머스") could not
    // recover. Hangul-aware: compares jamo-decomposed keys so a single
    // consonant/vowel slip is a small edit distance. Tightly gated by a high
    // similarity threshold + min length so it never steals from the exact-ish
    // stages above or fabricates matches for genuinely ambiguous short terms.
    const fuzzyResults = this.findFuzzyMatches(views.punctuationStripped);
    if (fuzzyResults.length > 0) {
      return fuzzyResults;
    }

    // Stage 3: Smart alias generation from indexed documents
    const smartMatches = this.generateSmartAliases(views.punctuationStripped);
    if (smartMatches.length > 0) {
      return smartMatches;
    }

    return [];
  }

  /**
   * Fuzzy edit-distance matcher (Stage 2.5). Returns near-typo matches only.
   *
   * Strategy: build a script-appropriate "fuzzy key" for the query (Hangul →
   * jamo-decomposed string; otherwise compact Latin) and compare it against
   * each alias's same-script fuzzy key via Damerau-Levenshtein (OSA)
   * similarity. Cross-script pairs are skipped (jamo vs Latin is meaningless).
   *
   * Emits `lookupStrategy: 'fuzzy_char_ngram'` with
   * `aliasType: 'misspelling'`.
   *
   * The canonical server path is now fail-closed on missing aliasType, so the
   * in-memory matcher must emit the semantic tier directly instead of
   * relying on downstream strategy inference.
   */
  private findFuzzyMatches(normalizedQuery: string): AliasMatchResult[] {
    // Script-aware fuzzy key: Hangul → jamo-decomposed string (a single
    // consonant/vowel slip is one edit); Latin → compact lowercased string.
    // KIL typo recovery is a *string* problem (Damerau edit distance), not a
    // semantic one — this is the same lexical mechanism for both scripts.
    //
    // Emits `lookupStrategy: 'fuzzy_char_ngram'` with
    // `aliasType: 'misspelling'`. Decision-engine behaviour on the resulting
    // match is calibrated, not absolute: a single unambiguous typo (one
    // in-fixture candidate
    // within similarity threshold, large gap to the next) can saturate
    // `C → 1.0` and bypass `NOISY_SHORT_QUERY_GUARD` via the explicit
    // `NOISY_SHORT_QUERY_GUARD_BYPASSED_HIGH_CONFIDENCE` rule
    // (decision-engine.ts ~ line 760); a multi-candidate fuzzy match keeps
    // the gap narrow and stays ambiguous. Both regimes are pinned by
    // tests in `noisy-runtime-execution-contract.regression.test.ts`.
    const queryJamo = buildHangulJamoKey(normalizedQuery);
    const queryIsHangul = queryJamo.containsHangul;
    const queryKey = queryIsHangul ? queryJamo.key : this.compact(normalizedQuery);
    if (queryKey.length < FUZZY_MIN_KEY_LENGTH) {
      return [];
    }

    const results: AliasMatchResult[] = [];
    for (const [normalized, entries] of this.aliases) {
      const aliasJamo = buildHangulJamoKey(normalized);
      if (aliasJamo.containsHangul !== queryIsHangul) {
        continue; // cross-script comparison is meaningless
      }
      const aliasKey = queryIsHangul ? aliasJamo.key : this.compact(normalized);
      if (aliasKey.length < FUZZY_MIN_KEY_LENGTH) {
        continue;
      }

      const distance = damerauLevenshteinOsa(queryKey, aliasKey);
      const similarity = editDistanceSimilarity(queryKey, aliasKey, distance);
      if (similarity < FUZZY_SIMILARITY_THRESHOLD) {
        continue;
      }

      const entityIds = entries.map((entry) => entry.entityId);
      const maxConfidence = maxConfidenceOf(entries);
      results.push({
        surfaceForm: entries[0]?.surfaceForm ?? normalized,
        normalizedForm: normalized,
        entityIds,
        matchConfidence: maxConfidence * similarity * FUZZY_MATCH_CONFIDENCE_FACTOR,
        lookupStrategy: 'fuzzy_char_ngram',
        aliasType: 'misspelling',
      });
    }

    results.sort((a, b) => b.matchConfidence - a.matchConfidence);
    return results;
  }

  /**
   * Generates aliases on-the-fly from indexed documents by extracting:
   * - Producer name
   * - Wine type
   * - Vintage year
   * - Region keywords
   *
   * Matches multi-term queries like "David Arthur Cabernet 2014" by finding
   * documents where producer, wine type, and vintage all appear.
   *
   * @param normalizedQuery - The normalized query string
   * @returns Matched alias results with confidence scores
   */
  private generateSmartAliases(normalizedQuery: string): AliasMatchResult[] {
    const queryTerms = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
    if (queryTerms.length === 0) {
      return [];
    }

    // Extract potential vintage year from query
    const vintageMatch = /\b(19|20)\d{2}\b/.exec(normalizedQuery);
    const potentialVintage = vintageMatch ? parseInt(vintageMatch[0], 10) : undefined;

    const matches: Map<EntityId, { doc: RetrievalDocument; matchedTerms: Set<string>; score: number }> = new Map();

    for (const doc of this.documents.values()) {
      const docProducer = doc.producer.toLowerCase();
      const docWineType = doc.wineType?.toLowerCase() ?? '';
      const docRegion = doc.region.toLowerCase();
      const docCanonical = doc.canonicalLabel.toLowerCase();
      const docSearchText = (doc.searchTextEn + ' ' + doc.searchTextKo).toLowerCase();
      const docVintage = doc.vintageYear;

      const matchedTerms = new Set<string>();
      let score = 0;
      let productorMatch = false;

      // Match each query term against document attributes
      for (const term of queryTerms) {
        const termLower = term.toLowerCase();

        // Producer exact or substring match (highest confidence)
        if (docProducer.includes(termLower)) {
          matchedTerms.add(term);
          score += 0.4;
          productorMatch = true;
          continue;
        }

        // Wine type match (e.g., "Cabernet", "Pinot", "red")
        if (
          docWineType === termLower ||
          docWineType.includes(termLower) ||
          this.isGrapeVariety(termLower, doc.grapePrimary ?? '')
        ) {
          matchedTerms.add(term);
          score += 0.25;
          continue;
        }

        // Region keyword match
        if (docRegion.includes(termLower)) {
          matchedTerms.add(term);
          score += 0.2;
          continue;
        }

        // Canonical label match (but not if already matched via producer)
        if (docCanonical.includes(termLower) && !productorMatch) {
          matchedTerms.add(term);
          score += 0.25;
          continue;
        }

        // Full-text search match (lowest confidence)
        if (docSearchText.includes(termLower) && !matchedTerms.has(term)) {
          matchedTerms.add(term);
          score += 0.1;
        }
      }

      // Bonus: vintage year match
      if (potentialVintage !== undefined && docVintage === potentialVintage) {
        score += 0.15;
        matchedTerms.add(potentialVintage.toString());
      }

      // Only consider matches with sufficient term coverage
      // Require at least 50% of query terms matched OR 2+ matched
      const minMatches = Math.max(2, Math.ceil(queryTerms.length * 0.5));
      const hasEnoughMatches = matchedTerms.size >= minMatches;

      if (hasEnoughMatches && score > 0.35) {
        // Normalize score to [0, 0.8] for smart matches (lower than pre-registered aliases)
        const normalizedScore = Math.min(0.8, score);
        matches.set(doc.entityId, {
          doc,
          matchedTerms,
          score: normalizedScore,
        });
      }
    }

    // Sort by score descending and convert to AliasMatchResult
    const sorted = Array.from(matches.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10); // Limit to top 10

    return sorted.map((match) => ({
      surfaceForm: this.extractSmartAliasForm(match.doc),
      normalizedForm: normalizedQuery,
      entityIds: [match.doc.entityId],
      matchConfidence: match.score,
      lookupStrategy: 'smart_document',
      aliasType: 'catalog_noise_alias',
    }));
  }

  /**
   * Determines the best surface form for a smart-matched document.
   * Prefers: canonicalLabel > producer + wineType > producer alone
   */
  private extractSmartAliasForm(doc: RetrievalDocument): string {
    // Prefer the full canonical label if it's reasonably short
    if (doc.canonicalLabel.length <= 100) {
      return doc.canonicalLabel;
    }

    // Fall back to producer + primary grape
    if (doc.grapePrimary && doc.grapePrimary.length > 0) {
      return `${doc.producer} ${doc.grapePrimary}`;
    }

    // Finally, just producer
    return doc.producer;
  }

  /**
   * Checks if a term is a known grape variety by substring match.
   * Common grapes: Cabernet, Merlot, Pinot, Chardonnay, Sauvignon, Riesling, etc.
   */
  private isGrapeVariety(term: string, grapePrimary: string): boolean {
    const commonGrapes = [
      'cabernet',
      'merlot',
      'pinot',
      'chardonnay',
      'sauvignon',
      'riesling',
      'syrah',
      'grenache',
      'nebbiolo',
      'sangiovese',
      'tempranillo',
      'gamay',
      'barbera',
      'zinfandel',
      'petit verdot',
      'mourvedre',
      'carmenere',
    ];

    const termLower = term.toLowerCase();
    const grapeLower = grapePrimary.toLowerCase();

    // Direct match in common grapes
    if (commonGrapes.some((g) => g.includes(termLower) || termLower.includes(g))) {
      return true;
    }

    // Match against the actual grape primary
    if (grapeLower.includes(termLower) || termLower.includes(grapeLower)) {
      return true;
    }

    return false;
  }

  private normalize(input: string): string {
    return buildNormalizedQueryViews(input).strict;
  }

  private indexHangulCompletionSurface(
    surfaceForm: string,
    normalizedForm: string,
    entityId: EntityId,
    confidence: number,
  ): void {
    for (const surface of this.buildHangulCompletionSurfaces(surfaceForm, normalizedForm)) {
      const key = buildHangulJamoKey(surface);
      if (!key.containsHangul || key.key.length === 0) {
        continue;
      }

      const record = {
        entityId,
        surfaceForm,
        normalizedForm,
        confidence,
        jamoKey: key.key,
        syllableBoundaryOffsets: key.syllableBoundaryOffsets,
      };

      for (let prefixLength = 1; prefixLength < key.key.length; prefixLength += 1) {
        if (key.syllableBoundaryOffsets.has(prefixLength)) {
          continue;
        }
        const prefix = key.key.slice(0, prefixLength);
        const existing = this.hangulCompletionPrefixIndex.get(prefix) ?? [];
        if (
          existing.some(
            (entry) =>
              entry.entityId === entityId &&
              entry.surfaceForm === surfaceForm &&
              entry.jamoKey === key.key,
          )
        ) {
          continue;
        }
        existing.push(record);
        this.hangulCompletionPrefixIndex.set(prefix, existing);
      }
    }
  }

  private buildHangulCompletionSurfaces(
    surfaceForm: string,
    normalizedForm: string,
  ): readonly string[] {
    const surfaces = new Set<string>();
    for (const value of [surfaceForm, normalizedForm]) {
      const key = buildHangulJamoKey(value);
      if (key.containsHangul && key.key.length > 0) {
        surfaces.add(value);
      }

      const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(value);
      if (exceptionSurface !== undefined) {
        surfaces.add(exceptionSurface);
      }
    }
    return [...surfaces];
  }

  private findHangulCompletionMatches(normalizedQuery: string): AliasMatchResult[] {
    const queryKey = buildHangulJamoKey(normalizedQuery);
    if (
      !queryKey.containsHangul ||
      queryKey.key.length === 0 ||
      queryKey.syllableCount < 2
    ) {
      return [];
    }

    const grouped = new Map<
      string,
      {
        surfaceForm: string;
        normalizedForm: string;
        entityIds: Set<EntityId>;
        matchConfidence: number;
      }
    >();

    for (const entry of this.hangulCompletionPrefixIndex.get(queryKey.key) ?? []) {
      if (!entry.jamoKey.startsWith(queryKey.key)) {
        continue;
      }
      if (
        entry.syllableBoundaryOffsets.has(queryKey.key.length) &&
        !queryKey.containsStandaloneJamo
      ) {
        continue;
      }

      const key = `${entry.surfaceForm}\u0000${entry.normalizedForm}`;
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          surfaceForm: entry.surfaceForm,
          normalizedForm: entry.normalizedForm,
          entityIds: new Set([entry.entityId]),
          matchConfidence: entry.confidence,
        });
        continue;
      }

      existing.entityIds.add(entry.entityId);
      if (entry.confidence > existing.matchConfidence) {
        existing.matchConfidence = entry.confidence;
      }
    }

    return [...grouped.values()].map((match) => ({
      surfaceForm: match.surfaceForm,
      normalizedForm: match.normalizedForm,
      entityIds: [...match.entityIds],
      matchConfidence: match.matchConfidence,
      lookupStrategy: 'hangul_ime_completion+transliterated_fuzzy',
      aliasType: 'misspelling',
    }));
  }

  private punctuationStripped(input: string): string {
    return buildNormalizedQueryViews(input).punctuationStripped;
  }

  private compact(input: string): string {
    return buildNormalizedQueryViews(input).compact;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory Mixed-solver ports
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryAnchorResolver implements AnchorResolverPort {
  private readonly entities = new Map<EntityId, AnchorEntityData>();

  addEntity(id: EntityId, data: AnchorEntityData): void {
    this.entities.set(id, data);
  }

  async resolve(entityId: EntityId): Promise<AnchorEntityData | undefined> {
    return this.entities.get(entityId);
  }
}

export class InMemorySimilarRetrieval implements SimilarRetrievalPort {
  private readonly results = new Map<string, readonly HybridCandidate[]>();

  setResults(anchorId: EntityId, candidates: readonly HybridCandidate[]): void {
    this.results.set(anchorId, candidates);
  }

  async retrieveSimilar(
    anchorProfile: AnchorProfile,
    limit: number,
    hardConstraints?: readonly NormalizedConstraint[],
  ): Promise<readonly HybridCandidate[]> {
    // Apply hard-constraint filtering on the seeded neighborhood so the
    // mixed route's `similar_items` retrieval honors structural intent.
    // Without this filter, `마고 비슷한 레드` ("red wines similar to
    // Margaux") returned the seeded all-red neighborhood unmodified — but
    // the downstream `applySetConstraintsForSimilarItems` filter then
    // dropped any candidate whose attributes didn't match the wine_type
    // constraint, frequently to ZERO. Production's `VespaSimilarRetrieval`
    // applies these constraints at the Vespa query layer (via
    // `hardConstraintsToSparseFilterTokens`); the in-memory stub must
    // match that semantics or e2e tests cannot exercise the constraint
    // path realistically.
    const seeded = this.results.get(anchorProfile.entityId) ?? [];
    if (hardConstraints === undefined || hardConstraints.length === 0) {
      return limit > 0 ? seeded.slice(0, limit) : seeded;
    }
    const filterTokens = hardConstraintsToSparseFilterTokens(hardConstraints);
    if (filterTokens.length === 0) {
      return limit > 0 ? seeded.slice(0, limit) : seeded;
    }
    const filterPredicate = buildFilterPredicate(filterTokens);
    const filtered = seeded.filter((candidate) =>
      filterPredicate(hybridCandidateToFilterableDoc(candidate)),
    );
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  }
}

export class InMemoryCandidateAttributes implements CandidateAttributePort {
  private readonly attributes = new Map<EntityId, Readonly<Record<string, unknown>>>();
  private readonly similarities = new Map<EntityId, SimilarityCandidate>();

  setAttribute(id: EntityId, attrs: Readonly<Record<string, unknown>>): void {
    this.attributes.set(id, attrs);
  }

  setSimilarity(id: EntityId, candidate: SimilarityCandidate): void {
    this.similarities.set(id, candidate);
  }

  async loadAttributes(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>> {
    const result = new Map<EntityId, Readonly<Record<string, unknown>>>();
    for (const id of entityIds) {
      const attrs = this.attributes.get(id);
      if (attrs) result.set(id, attrs);
    }
    return result;
  }

  async loadSimilarityCandidate(entityId: EntityId): Promise<SimilarityCandidate | undefined> {
    return this.similarities.get(entityId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryGoldSetStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryGoldSetStore implements GoldSetStore {
  private readonly cases: EvalCase[] = [];

  async getCases(filter?: GoldSetFilter): Promise<readonly EvalCase[]> {
    let result = this.cases.slice();
    if (filter?.queryClass) {
      const qc = filter.queryClass;
      result = result.filter((c) => c.queryClass === qc);
    }
    if (filter?.sliceTag) {
      const tag = filter.sliceTag;
      result = result.filter((c) => c.sliceTags.includes(tag));
    }
    if (filter?.labelTier) {
      const tier = filter.labelTier;
      result = result.filter((c) => c.labelTier === tier);
    }
    if (filter?.since) {
      const since = filter.since;
      result = result.filter((c) => c.timestamp >= since);
    }
    result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return result;
  }

  async addCase(evalCase: EvalCase): Promise<void> {
    this.cases.push(evalCase);
  }

  async getIAAScore(_sliceTag?: string): Promise<number> {
    // Return a fixed high IAA for tests
    return 0.85;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryEvalResultStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryEvalResultStore implements EvalResultStore {
  private readonly results: EvalResult[] = [];

  async saveResult(result: EvalResult): Promise<void> {
    this.results.push(result);
  }

  async getResults(filter?: EvalResultFilter): Promise<readonly EvalResult[]> {
    let result = this.results.slice();
    if (filter?.snapshotId) {
      const sid = filter.snapshotId;
      result = result.filter((r) => r.decisionSnapshot.threshold_profile_id === sid);
    }
    return result;
  }

  getAll(): readonly EvalResult[] {
    return this.results.slice();
  }
}
