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
 */
export class InMemoryAliasMatcher implements AliasMatcher {
  // normalized form → list of (entityId, surfaceForm, confidence)
  private readonly aliases = new Map<
    string,
    Array<{ entityId: EntityId; surfaceForm: string; confidence: number }>
  >();

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

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    // Exact match
    const exact = this.aliases.get(normalizedQuery);
    if (exact && exact.length > 0) {
      // Group by surfaceForm
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

    // Substring fallback — find aliases whose normalized form is contained in the query
    const results: AliasMatchResult[] = [];
    for (const [normalized, entries] of this.aliases) {
      if (normalizedQuery.includes(normalized)) {
        const entityIds = entries.map((e) => e.entityId);
        const maxConfidence = Math.max(...entries.map((e) => e.confidence));
        results.push({
          surfaceForm: entries[0]?.surfaceForm ?? normalized,
          normalizedForm: normalized,
          entityIds,
          matchConfidence: maxConfidence * 0.85, // penalty for substring match
        });
      }
    }
    results.sort((a, b) => b.matchConfidence - a.matchConfidence);
    return results;
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
