/**
 * Pure decision/projection helpers for the Entity Lookup V2 use case.
 *
 * Extracted from `entity-lookup-v2.usecase.ts` (which had grown past 1100 LOC):
 * every function here is a PURE module function (no `this`, no I/O) over the
 * resolver/retrieval value types, so it is independently unit-testable and keeps
 * the orchestrator focused on wiring. Behaviour is unchanged — this is a
 * mechanical move. See the use case for how each is sequenced.
 */

import { normalizeForMatch } from '../../../domain/alias/service/normalize.js';
import { compactForLookup } from '../../../domain/query/service/phonetic-skeleton.js';
import {
  anchorsHaveExactIdentityEvidence,
  classifyResolveEvidenceGrade,
  EXACT_IDENTITY_MIN_CONFIDENCE,
} from '../../../domain/resolver/v2/channel-provenance.js';
import { isExactLikeLookupStrategy } from '../../../domain/query/service/lookup-strategy-taxonomy.js';
import { extractLookupFeatures } from '../../../domain/resolver/v2/lookup-feature-extractor.js';
import {
  LOOKUP_RETRIEVAL_CHANNELS,
  type LookupChannelHit,
  type LookupDecision,
  type LookupRetrievalChannel,
  type LookupRetrievalResult,
  type LookupScoredCandidate,
  type LookupV2Status,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { LookupQueryPlan } from './lookup-query-plan.js';
import type { LookupV2CandidateView, LookupV2ChannelCoverageView } from './entity-lookup-v2.dto.js';

const NON_IDENTITY_STRATEGY_MARKER = /fuzzy|ngram|trigram|edit|prefix|inexact|lexical|phonetic|fallback/u;

/** True when the raw query matches one of an exact-safe witness's lookup variants (normalized or compact). */
export function rawQueryMatchesExactSafeSurface(
  rawQuery: string,
  lookupVariants: readonly string[] | undefined,
): boolean {
  if (lookupVariants === undefined || lookupVariants.length === 0) {
    return false;
  }
  const normalizedRawQuery = normalizeForMatch(rawQuery);
  const compactRawQuery = compactForLookup(rawQuery);
  return lookupVariants.some((surface) => (
    normalizedRawQuery.length > 0 && normalizeForMatch(surface) === normalizedRawQuery
  ) || (
    compactRawQuery.length > 0 && compactForLookup(surface) === compactRawQuery
  ));
}

export function hasHighConfidenceStrictExactSingletonAnchor(
  anchors: LookupQueryPlan['anchors'],
): boolean {
  return anchors.some((anchor) => {
    if (anchor.source !== 'alias' || anchor.candidateEntityIds.length !== 1) {
      return false;
    }
    if (anchor.confidence < EXACT_IDENTITY_MIN_CONFIDENCE) {
      return false;
    }
    const strategies = anchor.lookupStrategies ?? [];
    if (!strategies.some((strategy) => isExactLikeLookupStrategy(strategy))) {
      return false;
    }
    if (strategies.some((strategy) => NON_IDENTITY_STRATEGY_MARKER.test(strategy.toLowerCase()))) {
      return false;
    }
    return true;
  });
}

/**
 * Build the learned-reranker input from the resolver candidates + the engine's
 * per-entity channel provenance (features derived from real channel hits).
 */
export function buildScoredCandidates(
  result: EntityResolveResult,
  retrieval: LookupRetrievalResult | undefined,
  /** Persisted ambiguity-cluster membership signal per entity (0 when unknown). */
  clusterMembership: (entityId: string) => number = () => 0,
): readonly LookupScoredCandidate[] {
  const hitsByEntity = new Map<string, {
    readonly hits: readonly LookupChannelHit[];
    readonly entityType: string;
    readonly scopeFeatureHints?: {
      readonly lineGraphProximity?: number | undefined;
      readonly vintageGraphProximity?: number | undefined;
      readonly scopeQualifierAgreement?: number | undefined;
      readonly scopeAxisAgreement?: number | undefined;
    } | undefined;
  }>();
  if (retrieval !== undefined) {
    for (const rc of retrieval.candidates) {
      hitsByEntity.set(String(rc.entityId), {
        hits: rc.channelHits,
        entityType: rc.entityType,
        ...(rc.scopeFeatureHints !== undefined ? { scopeFeatureHints: rc.scopeFeatureHints } : {}),
      });
    }
  }
  return result.candidates.map((c) => {
    const engine = hitsByEntity.get(String(c.entityId));
    const channelHits = engine?.hits ?? [];
    return {
      entityId: c.entityId,
      canonicalLabel: c.canonicalLabel,
      entityType: engine?.entityType ?? 'unknown',
      calibratedScore: c.calibratedScore,
      rank: c.rank,
      features: extractLookupFeatures(
        channelHits,
        c.calibratedScore,
        clusterMembership(String(c.entityId)),
        engine?.scopeFeatureHints,
      ),
      channelHits,
    };
  });
}

/** Conservatism rank — lower is more conservative (failed < ambiguous < resolved). */
const DECISION_CONSERVATISM: Readonly<Record<Exclude<LookupV2Status, 'redirect_discovery'>, number>> = {
  failed: 0,
  ambiguous: 1,
  resolved: 2,
};

/**
 * Combine the calibrated and learned decisions — the MORE conservative status
 * wins (downgrade-only over both), so the learned reranker can only tighten the
 * audit-hardened calibrated outcome, never relax it.
 *
 * On a STATUS TIE we surface the learned decision's reason/scores (visibility),
 * but PRESERVE the stronger calibration trust: the learned decider always emits
 * calibrationTrusted=false, so naively returning it would silently downgrade a
 * calibrated trusted resolve's trust flag for precision-first consumers. A tie
 * must never downgrade trust — only a strictly-more-conservative learned status
 * may change the decision. (DECISION_CONSERVATISM and LookupDecision.status are
 * the same `Exclude<LookupV2Status,'redirect_discovery'>` type, so the rank
 * lookup can never be undefined — no runtime guard needed; do not widen the type
 * without re-checking.)
 */
export function combineDecisions(calibrated: LookupDecision, learned: LookupDecision): LookupDecision {
  const calRank = DECISION_CONSERVATISM[calibrated.status];
  const learnedRank = DECISION_CONSERVATISM[learned.status];
  if (learnedRank < calRank) return learned;
  if (calRank < learnedRank) return calibrated;
  // Tie: surface learned, but trust is the OR (a tie cannot downgrade trust).
  return { ...learned, calibrationTrusted: calibrated.calibrationTrusted || learned.calibrationTrusted };
}

/**
 * Aggregate the per-candidate channel hits into the per-channel coverage rail.
 * Emits one row per channel that actually contributed at least one candidate,
 * in declared-channel order. `latencyMs` is 0 on the reuse path (channels are
 * decomposed from anchor recall, not run as independent timed retrievers — the
 * timed independent runtime lands behind the LookupCandidateRetrievalPort seam).
 */
export function buildChannelCoverage(
  candidates: readonly LookupV2CandidateView[],
): readonly LookupV2ChannelCoverageView[] {
  const counts = new Map<LookupRetrievalChannel, number>();
  for (const candidate of candidates) {
    for (const hit of candidate.channelHits) {
      counts.set(hit.channel, (counts.get(hit.channel) ?? 0) + 1);
    }
  }
  const rows: LookupV2ChannelCoverageView[] = [];
  for (const channel of LOOKUP_RETRIEVAL_CHANNELS) {
    const hitCount = counts.get(channel);
    if (hitCount !== undefined && hitCount > 0) {
      rows.push({ channel, firing: true, hitCount, latencyMs: 0 });
    }
  }
  return rows;
}

export function hasOnlyRecallOnlyCandidateEvidence(
  candidates: readonly LookupV2CandidateView[],
): boolean {
  return candidates.length > 0
    && candidates.every((candidate) => {
      const grade = classifyResolveEvidenceGrade(candidate.channelHits);
      return grade === 'recall_only' || grade === 'none';
    });
}

export function hasReviewedFamilyCollisionClarificationEvidence(
  candidates: readonly LookupV2CandidateView[],
): boolean {
  if (candidates.length < 2) {
    return false;
  }
  const matchedAliases = new Set<string>();
  for (const candidate of candidates) {
    const reviewedFamilyHits = candidate.channelHits.filter((hit) =>
      hit.channel === 'dense'
      && hit.matchedView === 'reviewed_family_recall'
      && typeof hit.matchedAlias === 'string'
      && hit.matchedAlias.trim().length > 0,
    );
    if (reviewedFamilyHits.length === 0) {
      return false;
    }
    for (const hit of reviewedFamilyHits) {
      const matchedAlias = hit.matchedAlias;
      if (matchedAlias === undefined) {
        return false;
      }
      matchedAliases.add(matchedAlias.trim().toLowerCase());
    }
  }
  return matchedAliases.size === 1;
}

export function hasAnyIdentityBearingEvidence(
  result: EntityResolveResult | undefined,
  plan: LookupQueryPlan,
): boolean {
  if (result === undefined) {
    return false;
  }

  return result.candidates.some((candidate) =>
    anchorsHaveExactIdentityEvidence(candidate.entityId, plan.anchors),
  );
}
