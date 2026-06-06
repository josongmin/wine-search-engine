/**
 * Entity Lookup V2 — domain pipeline contract (SSoT).
 *
 * This module is the *frozen seam* between the V2 lookup stages. Every stage
 * (admission gate, multi-channel retrieval, learned rerank, calibrated
 * abstain) depends on these types and NOTHING ELSE about each other. Keeping
 * the contract here lets each stage be implemented and tested in isolation
 * while the orchestrator (`EntityLookupV2UseCase`) wires them together.
 *
 * Design principles (RFC entity-lookup-v2 §4):
 *   1. lookup is NOT search — this is an entity-resolution task with its own
 *      4-state outcome (`resolved | ambiguous | failed | redirect_discovery`).
 *   2. the 1st-class KPI is *precision with calibrated abstain*, not recall —
 *      so the decision layer biases toward `ambiguous`/`failed` over a
 *      wrong-positive.
 *   3. candidate recall is a multi-channel UNION; the final resolve authority
 *      is the reranker + calibrator, never a single channel's top-1.
 *
 * This file is pure domain (no I/O, no infra imports) so it stays a composite
 * leaf-safe dependency for `src/domain/resolver`.
 */

import type { CanonicalEntityId, QueryClass } from '../../shared/types/index.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';
import type { StageTimer } from '../../shared/stage-timer.js';

// ───────────────────────────────────────────────────────────────────────────
// Public outcome contract
// ───────────────────────────────────────────────────────────────────────────

/**
 * Terminal status of a V2 entity lookup.
 *
 * - `resolved`           — exactly one entity is confidently identified.
 * - `ambiguous`          — multiple plausible entities; caller must clarify.
 * - `failed`             — the query looks like an entity reference but no
 *                          confident match exists (incl. noisy-typo dead ends
 *                          like `opu one` that must NOT wrong-resolve).
 * - `redirect_discovery` — the query is a concept/facet query (e.g. `까쇼`,
 *                          "full bodied red") that should never enter entity
 *                          resolution; the caller is redirected to discovery
 *                          search.
 */
export const LOOKUP_V2_STATUSES = [
  'resolved',
  'ambiguous',
  'failed',
  'redirect_discovery',
] as const;

export type LookupV2Status = (typeof LOOKUP_V2_STATUSES)[number];

// ───────────────────────────────────────────────────────────────────────────
// Stage 1 — admission / concept gate (T-ELV2-02)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Admission verdict produced by the front-door gate BEFORE any retrieval runs.
 *
 * `admit`              — proceed into the retrieval + resolve pipeline.
 * `redirect_discovery` — concept/facet query; do not attempt entity resolve.
 * `reject`             — under-specified / empty / non-entity input; resolve
 *                        is not meaningful and would only invite wrong-positives.
 */
export const LOOKUP_ADMISSION_DECISIONS = ['admit', 'redirect_discovery', 'reject'] as const;
export type LookupAdmissionDecision = (typeof LOOKUP_ADMISSION_DECISIONS)[number];

export interface LookupAdmissionVerdict {
  readonly decision: LookupAdmissionDecision;
  /** Stable machine code, e.g. `admitted_entity_reference`, `concept_query`. */
  readonly reasonCode: string;
  /** Human-facing explanation (safe to surface in `decision_reason`). */
  readonly detail: string;
  /** Concept/facet lexicon terms that fired, when `decision !== 'admit'`. */
  readonly conceptTermsMatched?: readonly string[] | undefined;
}

export interface LookupConceptRedirectInfo {
  readonly conceptClass: 'grape' | 'region' | 'style' | 'recommendation' | 'pairing' | 'generic';
  readonly redirectReason: 'concept_query' | 'generic_non_entity_query';
  readonly sourceEvidence: string;
}

export interface LookupConceptRedirectRegistryPort {
  get(surfaceForm: string): LookupConceptRedirectInfo | null;
}

export interface LookupExactSafeMatch {
  readonly entityId: CanonicalEntityId;
  readonly locale: 'ko' | 'global';
  readonly kind: 'exact_safe' | 'compact_exact_safe';
  readonly normalizedSurface: string;
  readonly compactSurface?: string | undefined;
}

export interface LookupExactSafeRegistryPort {
  match(views: NormalizedQueryViews): LookupExactSafeMatch | null;
}

/**
 * Front-door admission classifier port.
 *
 * MUST decide using the normalized views + concept lexicon, NOT by running the
 * resolver and inspecting the result (RFC §forbidden: "resolver 실행 후 concept
 * query를 되돌려 reject하는 것").
 */
export interface LookupAdmissionGatePort {
  classify(input: LookupAdmissionInput): LookupAdmissionVerdict;
}

export interface LookupAdmissionInput {
  readonly rawQuery: string;
  readonly views: NormalizedQueryViews;
  readonly locale?: string | undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Stage 2 — multi-channel candidate retrieval (T-ELV2-04)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Independent recall channels (RFC §5.4). Each channel is a distinct recall
 * strategy whose hits are UNIONed; channels never collapse into one matcher.
 */
export const LOOKUP_RETRIEVAL_CHANNELS = [
  'exact_alias', // normalized exact alias match
  'compact_exact', // whitespace/punctuation-folded exact match
  'transliteration_exact', // transliterated-view exact match
  'jamo_phonetic', // jamo / phonetic-skeleton near-exact match
  // fuzzy_alias: recall/expansion strategies the WIRED substrate emits —
  // transliterated_fuzzy / lexical_exact / prefix_exact (NOT trigram/edit-distance,
  // which require the unwired PgAliasMatcher).
  'fuzzy_alias',
  // family_graph: producer family recall (T-ELV2-06 Half B). The engine walks
  // alias-recalled anchors to their persisted producer family (PgFamilyGraph) and
  // emits co-producer siblings. Fires when the entity_family substrate is
  // populated (operator ETL); dormant otherwise.
  'family_graph',
  // same producer, different line/cuvee siblings from the snapshot-published
  // scope graph. Used to surface reviewed scope-local alternatives without
  // widening to the whole producer family.
  'line_graph',
  // same producer+line, different vintages from the snapshot-published scope
  // graph. Lets the reranker see vintage-local alternatives explicitly.
  'vintage_graph',
  // dense: RESERVED — no dense/late-interaction index in the lookup lane. Emitted
  // ONLY by the reuse-path blocker-seed projection (BLOCKER_SEED_CHANNEL).
  'dense',
] as const;

export type LookupRetrievalChannel = (typeof LOOKUP_RETRIEVAL_CHANNELS)[number];

/** One channel's contribution to a candidate (per-channel recall evidence). */
export interface LookupChannelHit {
  readonly channel: LookupRetrievalChannel;
  /** The normalized view (or surface) that produced the match. */
  readonly matchedView: string;
  /** The alias surface form that matched, when channel is alias-based. */
  readonly matchedAlias?: string | undefined;
  /** Channel-native recall score in [0, 1] (NOT calibrated). */
  readonly channelScore: number;
  /** 1-based rank of this entity within this channel's hit list. */
  readonly channelRank: number;
}

/**
 * A candidate after the channel UNION + dedupe, before scoring/rerank.
 * The `channelHits` array is the multi-channel provenance: it records EVERY
 * channel that recalled this entity (a candidate found by exact + fuzzy +
 * dense carries three hits).
 */
export interface LookupCandidate {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly entityType: string;
  readonly channelHits: readonly LookupChannelHit[];
  readonly scopeFeatureHints?: {
    readonly lineGraphProximity?: number | undefined;
    readonly vintageGraphProximity?: number | undefined;
    readonly scopeQualifierAgreement?: number | undefined;
    readonly scopeAxisAgreement?: number | undefined;
  } | undefined;
}

export interface LookupRetrievalInput {
  readonly rawQuery: string;
  readonly views: NormalizedQueryViews;
  readonly queryClass: QueryClass;
  readonly maxCandidates: number;
  readonly locale?: string | undefined;
  readonly suppressFamilyGraphExpansion?: boolean | undefined;
  readonly stageTimer?: StageTimer | undefined;
}

/** Per-channel coverage rail (latency + hit counts) for observability. */
export interface LookupChannelCoverage {
  readonly channel: LookupRetrievalChannel;
  readonly firing: boolean;
  readonly hitCount: number;
  readonly latencyMs: number;
}

export interface LookupRetrievalResult {
  /** UNIONed, deduped candidate pool. */
  readonly candidates: readonly LookupCandidate[];
  /** Per-channel rail, one entry per channel that was attempted. */
  readonly coverage: readonly LookupChannelCoverage[];
}

/** Multi-channel candidate retrieval engine port. */
export interface LookupCandidateRetrievalPort {
  retrieve(input: LookupRetrievalInput, signal?: AbortSignal): Promise<LookupRetrievalResult>;
}

// ───────────────────────────────────────────────────────────────────────────
// Stage 3 — learned rerank + calibrated abstain (T-ELV2-05)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-candidate feature vector consumed by the learned reranker (RFC §5.5).
 * Every feature is deterministic and bounded; the reranker is the authority,
 * not any single feature.
 */
export interface LookupCandidateFeatures {
  readonly exactAliasEvidence: number;
  readonly normalizedAliasEvidence: number;
  readonly transliterationConsistency: number;
  readonly editDistanceScore: number;
  readonly phoneticConsistency: number;
  readonly familyGraphProximity: number;
  readonly lineGraphProximity: number;
  readonly vintageGraphProximity: number;
  readonly scopeQualifierAgreement: number;
  readonly scopeAxisAgreement: number;
  readonly popularityPrior: number;
  readonly scriptLanguageConsistency: number;
  readonly ambiguityClusterMembership: number;
  /** Count of distinct channels that recalled this candidate (union breadth). */
  readonly channelAgreement: number;
}

export interface LookupScoredCandidate {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly entityType: string;
  /** Calibrated probability in [0, 1] that this is the intended entity. */
  readonly calibratedScore: number;
  /** 1-based rank after rerank (1 = best). */
  readonly rank: number;
  readonly features: LookupCandidateFeatures;
  readonly channelHits: readonly LookupChannelHit[];
}

/**
 * Calibrated decision over the reranked candidate set. The decision layer is
 * the SOLE authority for the terminal status (RFC §5.5):
 *   - learned scorer / reranker ordering
 *   - calibrated confidence
 *   - top1-top2 margin
 *   - class-aware abstain thresholds
 */
export interface LookupDecision {
  readonly status: Exclude<LookupV2Status, 'redirect_discovery'>;
  readonly reasonCode: string;
  readonly detail: string;
  readonly topConfidence: number;
  readonly top1Top2Margin?: number | undefined;
  readonly calibrationTrusted: boolean;
}

export interface LookupDecisionInput {
  readonly queryClass: QueryClass;
  readonly scored: readonly LookupScoredCandidate[];
}

/** Learned rerank + calibrated abstain decision port. */
export interface LookupRerankDecisionPort {
  decide(input: LookupDecisionInput, signal?: AbortSignal): Promise<LookupDecision>;
}
