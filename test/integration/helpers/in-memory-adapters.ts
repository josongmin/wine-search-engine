/**
 * In-memory stub implementations for all infrastructure ports.
 * Used exclusively in integration and E2E tests — no real DB or network.
 */

import type { EntityId, QueryClass } from '../../../src/domain/shared/types/index.js';
import type { AmbiguityDictionary } from '../../../src/domain/query/port/ambiguity-dictionary.port.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type {
  CalibrationStore,
  CalibrationParams,
} from '../../../src/domain/resolver/port/calibration-store.port.js';
import type {
  SearchIndexPort,
  SparseHit,
  DenseHit,
  RetrievalHitSummary,
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
import type { AnchorProfile } from '../../../src/domain/mixed/model/anchor-profile.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { FeedbackStore, FeedbackFilter, AggregatedFeedbackStats } from '../../../src/domain/learning/port/feedback-store.port.js';
import type { FeedbackSignal } from '../../../src/domain/learning/model/feedback-signal.js';
import type { ProposalStore } from '../../../src/domain/learning/port/proposal-store.port.js';
import type { AliasProposal, AliasProposalStatus } from '../../../src/domain/learning/model/alias-proposal.js';
import type { ThresholdProposal, ThresholdProposalStatus } from '../../../src/domain/learning/model/threshold-proposal.js';
import type { GoldSetStore, GoldSetFilter } from '../../../src/domain/evaluation/port/gold-set-store.port.js';
import type { EvalCase } from '../../../src/domain/evaluation/model/eval-case.js';
import type { EvalResultStore, EvalResultFilter } from '../../../src/domain/evaluation/port/eval-result-store.port.js';
import type { EvalResult } from '../../../src/domain/evaluation/model/eval-result.js';
import type { ExistingAliasChecker } from '../../../src/domain/learning/service/alias-proposer.js';
import type { AdversarialGuardPort } from '../../../src/domain/learning/service/promotion-gate.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

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
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryBlockingAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all stored entity IDs as candidates (100% recall, used in tests).
 */
export class InMemoryBlockingAdapter implements BlockingPort {
  private readonly entityIds: EntityId[] = [];

  addEntityId(id: EntityId): void {
    this.entityIds.push(id);
  }

  addEntityIds(ids: readonly EntityId[]): void {
    this.entityIds.push(...ids);
  }

  async block(
    _query: string,
    _normalizedQuery: string,
    limit?: number,
  ): Promise<readonly EntityId[]> {
    const result = this.entityIds.slice();
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
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemorySearchIndex
// ─────────────────────────────────────────────────────────────────────────────

function hitSummaryFromDoc(doc: RetrievalDocument): RetrievalHitSummary {
  const searchSlice =
    doc.searchTextEn.trim().length > 800
      ? doc.searchTextEn.trim().slice(0, 800)
      : doc.searchTextEn.trim();
  const grapeFromArray = doc.grapes[0]?.trim();
  const grape =
    grapeFromArray !== undefined && grapeFromArray.length > 0
      ? grapeFromArray
      : undefined;
  return {
    canonicalLabel: doc.canonicalLabel,
    ...(doc.producer.trim().length > 0 ? { producer: doc.producer.trim() } : {}),
    ...(doc.region.trim().length > 0 ? { region: doc.region.trim() } : {}),
    ...(searchSlice.length > 0 ? { searchTextEn: searchSlice } : {}),
    ...(grape !== undefined ? { grapePrimary: grape } : {}),
  };
}

/**
 * Stores RetrievalDocuments and returns configurable hits.
 * sparseSearch matches by canonicalLabel / aliases text.
 * denseSearch returns all docs ranked by a fake similarity score.
 */
export class InMemorySearchIndex implements SearchIndexPort {
  private readonly docs = new Map<EntityId, RetrievalDocument>();

  upsertDoc(doc: RetrievalDocument): void {
    this.docs.set(doc.entityId, doc);
  }

  async sparseSearch(
    queries: readonly string[],
    _filters?: readonly string[],
    limit?: number,
  ): Promise<readonly SparseHit[]> {
    const hits: SparseHit[] = [];
    const queryLower = queries.map((q) => q.toLowerCase());

    for (const doc of this.docs.values()) {
      const searchableText = [
        doc.canonicalLabel,
        doc.searchTextEn,
        doc.searchTextKo,
        ...doc.aliasesIdentitySafe,
        ...doc.aliasesNoisyRecall,
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const q of queryLower) {
        const terms = q.split(/\s+/).filter(Boolean);
        for (const term of terms) {
          if (searchableText.includes(term)) score += 1;
        }
      }

      if (score > 0) {
        hits.push({
          entityId: doc.entityId,
          score,
          rank: 0, // will be assigned after sort
          matchedFields: ['searchText'],
          summary: hitSummaryFromDoc(doc),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const limited = limit != null ? hits.slice(0, limit) : hits;
    return limited.map((h, i) => ({ ...h, rank: i + 1 }));
  }

  async denseSearch(
    _embedding: readonly number[],
    _filters?: readonly string[],
    limit?: number,
  ): Promise<readonly DenseHit[]> {
    // Return all docs with a deterministic fake similarity in popularity order
    const docs = Array.from(this.docs.values()).sort(
      (a, b) => b.popularityScore - a.popularityScore,
    );
    const limited = limit != null ? docs.slice(0, limit) : docs;
    return limited.map((doc, i) => ({
      entityId: doc.entityId,
      score: doc.popularityScore,
      rank: i + 1,
      similarity: doc.popularityScore,
      summary: hitSummaryFromDoc(doc),
    }));
  }

  async getDocument(entityId: EntityId): Promise<RetrievalDocument | null> {
    return this.docs.get(entityId) ?? null;
  }

  async upsertDocument(doc: RetrievalDocument): Promise<void> {
    this.docs.set(doc.entityId, doc);
  }

  async bulkUpsert(docs: readonly RetrievalDocument[]): Promise<void> {
    for (const doc of docs) {
      this.docs.set(doc.entityId, doc);
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
  private readonly DIM = 128;

  private hashText(text: string): readonly number[] {
    const vec = new Array<number>(this.DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * (i + 1)) % this.DIM;
      vec[idx] = ((vec[idx] ?? 0) + code / 255) % 1;
    }
    // Normalize to unit vector
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async embed(text: string): Promise<readonly number[]> {
    return this.hashText(text);
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((t) => this.hashText(t));
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
export class InMemoryAliasMatcher implements AliasMatcher {
  // normalized form → list of (entityId, surfaceForm, confidence)
  private readonly aliases = new Map<
    string,
    Array<{ entityId: EntityId; surfaceForm: string; confidence: number }>
  >();

  // entityId → document for smart alias generation
  private readonly documents = new Map<EntityId, RetrievalDocument>();

  /**
   * Register an alias mapping.
   * @param surfaceForm - Original user-facing form (e.g. "오푸스원")
   * @param entityId - The entity this alias maps to
   * @param confidence - Match confidence [0, 1]
   */
  addAlias(surfaceForm: string, entityId: EntityId, confidence = 0.95): void {
    const normalized = this.normalize(surfaceForm);
    const existing = this.aliases.get(normalized) ?? [];
    existing.push({ entityId, surfaceForm, confidence });
    this.aliases.set(normalized, existing);
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
   * Extract all documents currently indexed.
   * Used for testing and introspection.
   */
  getIndexedDocuments(): readonly RetrievalDocument[] {
    return Array.from(this.documents.values());
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    // Stage 1: Exact match from pre-registered aliases
    const exact = this.aliases.get(normalizedQuery);
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
      return Array.from(grouped.entries()).map(([surfaceForm, { entityIds, confidence }]) => ({
        surfaceForm,
        normalizedForm: normalizedQuery,
        entityIds,
        matchConfidence: confidence,
      }));
    }

    // Stage 2: Substring/token match in pre-registered aliases
    // Match when: alias is a substring of query OR query tokens are prefix of alias tokens
    const substringResults: AliasMatchResult[] = [];
    for (const [normalized, entries] of this.aliases) {
      const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
      const aliasTokens = normalized.split(/\s+/).filter(Boolean);

      // Case 1: Query contains the alias as substring
      const isSubstringMatch = normalizedQuery.includes(normalized);

      // Case 2: Query tokens are prefix of alias tokens (e.g., "david arthur" matches "david arthur cabernet sauvignon")
      const isTokenPrefixMatch = queryTokens.length > 0 &&
        queryTokens.length <= aliasTokens.length &&
        queryTokens.every((qt, i) => aliasTokens[i] === qt);

      if (isSubstringMatch || isTokenPrefixMatch) {
        const entityIds = entries.map((e) => e.entityId);
        const maxConfidence = Math.max(...entries.map((e) => e.confidence));
        substringResults.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.85,
        });
      }
    }
    if (substringResults.length > 0) {
      substringResults.sort((a, b) => b.matchConfidence - a.matchConfidence);
      return substringResults;
    }

    // Stage 3: Smart alias generation from indexed documents
    const smartMatches = this.generateSmartAliases(normalizedQuery);
    if (smartMatches.length > 0) {
      return smartMatches;
    }

    return [];
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
    return input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
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
    _limit: number,
  ): Promise<readonly HybridCandidate[]> {
    return this.results.get(anchorProfile.entityId) ?? [];
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
// InMemoryFeedbackStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly signals: FeedbackSignal[] = [];

  async saveFeedback(signal: FeedbackSignal): Promise<void> {
    this.signals.push(signal);
  }

  async getFeedback(filter?: FeedbackFilter): Promise<readonly FeedbackSignal[]> {
    let result = this.signals.slice();
    if (filter?.since) {
      const since = filter.since;
      result = result.filter((s) => s.timestamp >= since);
    }
    if (filter?.queryClass) {
      const qc = filter.queryClass;
      result = result.filter((s) => s.queryClass === qc);
    }
    if (filter?.entityId) {
      const eid = filter.entityId;
      result = result.filter((s) => s.entityId === eid);
    }
    result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return result;
  }

  async getAggregatedStats(entityId: EntityId): Promise<AggregatedFeedbackStats> {
    const entitySignals = this.signals.filter((s) => s.entityId === entityId);
    return {
      clicks: entitySignals.filter((s) => s.type === 'click').length,
      purchases: entitySignals.filter((s) => s.type === 'purchase').length,
      sessionSuccesses: entitySignals.filter((s) => s.type === 'session_success').length,
    };
  }

  getAll(): readonly FeedbackSignal[] {
    return this.signals.slice();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryProposalStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryProposalStore implements ProposalStore {
  private readonly aliasProposals: AliasProposal[] = [];
  private readonly thresholdProposals: ThresholdProposal[] = [];

  async saveAliasProposal(proposal: AliasProposal): Promise<void> {
    this.aliasProposals.push(proposal);
  }

  async saveThresholdProposal(proposal: ThresholdProposal): Promise<void> {
    this.thresholdProposals.push(proposal);
  }

  async getPendingAliasProposals(): Promise<readonly AliasProposal[]> {
    return this.aliasProposals.filter((p) => p.status === 'pending');
  }

  async getPendingThresholdProposals(): Promise<readonly ThresholdProposal[]> {
    return this.thresholdProposals.filter(
      (p) => p.status === 'pending' || p.status === 'shadow_testing',
    );
  }

  async updateProposalStatus(
    proposalId: string,
    status: AliasProposalStatus | ThresholdProposalStatus,
  ): Promise<void> {
    // Find in alias proposals first
    const aliasIdx = this.aliasProposals.findIndex((p) => p.proposalId === proposalId);
    if (aliasIdx >= 0) {
      const existing = this.aliasProposals[aliasIdx]!;
      this.aliasProposals[aliasIdx] = { ...existing, status: status as AliasProposalStatus };
      return;
    }
    // Then threshold proposals
    const threshIdx = this.thresholdProposals.findIndex((p) => p.proposalId === proposalId);
    if (threshIdx >= 0) {
      const existing = this.thresholdProposals[threshIdx]!;
      this.thresholdProposals[threshIdx] = { ...existing, status: status as ThresholdProposalStatus };
    }
  }

  getAllAliasProposals(): readonly AliasProposal[] {
    return this.aliasProposals.slice();
  }

  getAllThresholdProposals(): readonly ThresholdProposal[] {
    return this.thresholdProposals.slice();
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
    if (filter?.since) {
      const since = filter.since;
      result = result.filter((r) => r.decisionSnapshot.policy_rule_version !== '');
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryExistingAliasChecker
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryExistingAliasChecker implements ExistingAliasChecker {
  private readonly existing = new Set<string>();

  addExisting(surfaceForm: string): void {
    this.existing.add(surfaceForm.toLowerCase());
  }

  async aliasExists(surfaceForm: string): Promise<boolean> {
    return this.existing.has(surfaceForm.toLowerCase());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryAdversarialGuard
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryAdversarialGuard implements AdversarialGuardPort {
  private readonly adversarial = new Set<string>();

  markAdversarial(surfaceForm: string): void {
    this.adversarial.add(surfaceForm);
  }

  async isAdversarial(surfaceForm: string): Promise<boolean> {
    return this.adversarial.has(surfaceForm);
  }
}
