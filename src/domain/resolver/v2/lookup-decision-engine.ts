/**
 * Entity Lookup V2 — pure terminal outcome decision engine.
 *
 * Encodes the status / reason-code cascade that was previously inlined in
 * `EntityLookupV2UseCase.finishResult()`: vintage guard, vintage sibling
 * promotion, persisted-ambiguity surfacing, reviewed scope-target authority,
 * reviewed family collision, and recall-only → failed normalization.
 *
 * Domain leaf: no I/O, no ports — registry data is passed as plain inputs.
 */

import type { AnchorCandidate } from '../../query/model/anchor-candidate.js';
import { normalizeForMatch } from '../../alias/service/normalize.js';
import { compactForLookup } from '../../query/service/phonetic-skeleton.js';
import { createCanonicalEntityId, type DecisionStatus } from '../../shared/types/index.js';
import { extractQueryVintageYear } from '../../shared/utils/vintage.js';
import {
  anchorsHaveExactIdentityEvidence,
  classifyResolveEvidenceGrade,
} from './channel-provenance.js';
import type { LookupRetrievalChannel, LookupV2Status } from './lookup-v2-types.js';
import {
  shouldDowngradeForVintageMismatch,
  selectExplicitVintageFamilyMember,
  VINTAGE_MISMATCH_REASON_CODE,
  VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE,
} from './vintage-guard.js';

export {
  VINTAGE_MISMATCH_REASON_CODE,
  VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE,
} from './vintage-guard.js';

export const PERSISTED_AMBIGUITY_SURFACE_REASON_CODE = 'persisted_ambiguity_surface';
export const RECALL_ONLY_NO_MATCH_REASON_CODE = 'recall_only_no_match';
export const REVIEWED_FAMILY_COLLISION_REASON_CODE =
  'reviewed_family_collision_requires_clarification';
export const REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE = 'reviewed_scope_target_resolved';

/** Human-facing hint when the vintage guard downgrades a resolve. */
export const VINTAGE_MISMATCH_DECISION_REASON_HINT =
  'The matched wine is a different vintage than the one requested; clarify which vintage you mean.';

export interface LookupDecisionChannelHit {
  readonly channel: LookupRetrievalChannel;
  readonly matchedView: string;
  readonly matchedAlias?: string | undefined;
  readonly channelScore: number;
  readonly channelRank: number;
}

export interface LookupDecisionCandidate {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly channelAgreement: number;
  readonly channelHits: readonly LookupDecisionChannelHit[];
}

export interface LookupDecisionExactSafeWitness {
  readonly entityId: string;
  readonly lookupVariants: readonly string[] | undefined;
}

export interface LookupDecisionSemanticScopeMatch {
  readonly entityId: string;
}

type TerminalLookupStatus = Exclude<LookupV2Status, 'redirect_discovery'>;

export interface LookupDecisionInput {
  readonly query: string;
  readonly rawQuery: string;
  readonly decisionReasonCode: string;
  readonly forcedStatus?: TerminalLookupStatus | undefined;
  readonly decisionStatus?: TerminalLookupStatus | undefined;
  readonly resolverStatus?: DecisionStatus | undefined;
  readonly topCandidateEntityId?: string | undefined;
  readonly topCandidateCanonicalLabel?: string | undefined;
  readonly exactSafeSingletonWitness?: LookupDecisionExactSafeWitness | undefined;
  readonly anchors: readonly AnchorCandidate[];
  readonly resolveCandidateEntityIds: readonly string[];
  readonly allCandidates: readonly LookupDecisionCandidate[];
  readonly semanticScopeMatches: readonly LookupDecisionSemanticScopeMatch[];
  readonly reviewedTargetEntityIds: ReadonlySet<string>;
  readonly hasPersistedAmbiguity: boolean;
}

export interface LookupDecisionOutcome {
  readonly status: TerminalLookupStatus;
  readonly effectiveDecisionReasonCode: string;
  readonly frontPromotedEntityId: string | undefined;
  readonly vintageMismatch: boolean;
  readonly vintagePromotedEntityId: string | undefined;
  readonly resolvedReviewedScopeTargetEntityId: string | undefined;
  /** When true, the use case should surface {@link VINTAGE_MISMATCH_DECISION_REASON_HINT}. */
  readonly preferVintageMismatchReasonText: boolean;
}

function mapResolverStatusToTerminalStatus(
  status: DecisionStatus,
): TerminalLookupStatus {
  switch (status) {
    case 'resolved':
      return 'resolved';
    case 'ambiguous':
      return 'ambiguous';
    case 'failed':
    default:
      return 'failed';
  }
}

function rawQueryMatchesExactSafeSurface(
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

function hasOnlyRecallOnlyCandidateEvidence(
  candidates: readonly LookupDecisionCandidate[],
): boolean {
  return candidates.length > 0
    && candidates.every((candidate) => {
      const grade = classifyResolveEvidenceGrade(candidate.channelHits);
      return grade === 'recall_only' || grade === 'none';
    });
}

function hasReviewedFamilyCollisionClarificationEvidence(
  candidates: readonly LookupDecisionCandidate[],
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

function hasAnyIdentityBearingEvidence(
  resolveCandidateEntityIds: readonly string[],
  anchors: readonly AnchorCandidate[],
): boolean {
  return resolveCandidateEntityIds.some((entityId) =>
    anchorsHaveExactIdentityEvidence(createCanonicalEntityId(entityId), anchors),
  );
}

function resolveReviewedScopeTargetIdentity(args: {
  readonly query: string;
  readonly allCandidates: readonly LookupDecisionCandidate[];
  readonly reviewedTargetEntityIds: ReadonlySet<string>;
}): string | undefined {
  if (args.reviewedTargetEntityIds.size === 0) {
    return undefined;
  }
  const anchorCandidates = args.allCandidates.filter((c) =>
    args.reviewedTargetEntityIds.has(c.entityId),
  );
  const anchor = anchorCandidates.length === 1 ? anchorCandidates[0] : undefined;
  if (anchor === undefined) {
    return undefined;
  }
  if (anchor.channelAgreement < 2) {
    return undefined;
  }
  if (shouldDowngradeForVintageMismatch(args.query, anchor.canonicalLabel)) {
    return undefined;
  }
  return anchor.entityId;
}

function resolveDirectReviewedScopeTargetIdentity(args: {
  readonly query: string;
  readonly allCandidates: readonly LookupDecisionCandidate[];
  readonly exactSafeWitnessEntityId: string | undefined;
  readonly semanticScopeMatches: readonly LookupDecisionSemanticScopeMatch[];
}): string | undefined {
  const matchedEntityIds = new Set<string>();
  for (const match of args.semanticScopeMatches) {
    if (
      args.exactSafeWitnessEntityId !== undefined
      && match.entityId !== args.exactSafeWitnessEntityId
    ) {
      continue;
    }
    matchedEntityIds.add(match.entityId);
  }
  if (matchedEntityIds.size !== 1) {
    return undefined;
  }
  const [entityId] = [...matchedEntityIds];
  const candidate = args.allCandidates.find((entry) => entry.entityId === entityId);
  if (candidate === undefined) {
    return undefined;
  }
  if (shouldDowngradeForVintageMismatch(args.query, candidate.canonicalLabel)) {
    return undefined;
  }
  return entityId;
}

/**
 * Decide the terminal lookup status, reason code, and front-promoted entity
 * after resolver/calibrated outcomes and candidate projection are known.
 */
export function decideLookupOutcome(input: LookupDecisionInput): LookupDecisionOutcome {
  const {
    query,
    rawQuery,
    decisionReasonCode,
    forcedStatus,
    decisionStatus,
    resolverStatus,
    topCandidateEntityId,
    topCandidateCanonicalLabel,
    exactSafeSingletonWitness,
    anchors,
    resolveCandidateEntityIds,
    allCandidates,
    semanticScopeMatches,
    reviewedTargetEntityIds,
    hasPersistedAmbiguity,
  } = input;

  let status: TerminalLookupStatus = forcedStatus
    ?? decisionStatus
    ?? mapResolverStatusToTerminalStatus(resolverStatus ?? 'failed');

  const shouldBypassVintageMismatchDowngrade =
    exactSafeSingletonWitness !== undefined
    && topCandidateEntityId !== undefined
    && exactSafeSingletonWitness.entityId === topCandidateEntityId
    && rawQueryMatchesExactSafeSurface(rawQuery, exactSafeSingletonWitness.lookupVariants);

  const vintageMismatch =
    status === 'resolved'
    && !shouldBypassVintageMismatchDowngrade
    && shouldDowngradeForVintageMismatch(query, topCandidateCanonicalLabel);

  if (vintageMismatch) {
    status = 'ambiguous';
  }

  let effectiveDecisionReasonCode = vintageMismatch
    ? VINTAGE_MISMATCH_REASON_CODE
    : decisionReasonCode;

  const identityBearingEvidence = hasAnyIdentityBearingEvidence(
    resolveCandidateEntityIds,
    anchors,
  );

  const vintagePromotedEntityId =
    status === 'ambiguous' && identityBearingEvidence
      ? selectExplicitVintageFamilyMember({
          query,
          candidates: allCandidates,
        })
      : undefined;

  if (vintagePromotedEntityId !== undefined) {
    status = 'resolved';
    effectiveDecisionReasonCode = VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE;
  }

  if (
    status === 'failed'
    && forcedStatus === undefined
    && hasPersistedAmbiguity
  ) {
    status = 'ambiguous';
    effectiveDecisionReasonCode = PERSISTED_AMBIGUITY_SURFACE_REASON_CODE;
  }

  const directReviewedScopeTargetEntityId =
    forcedStatus === undefined
    && !hasPersistedAmbiguity
    && !vintageMismatch
      ? resolveDirectReviewedScopeTargetIdentity({
          query,
          allCandidates,
          exactSafeWitnessEntityId: exactSafeSingletonWitness?.entityId,
          semanticScopeMatches,
        })
      : undefined;

  const reviewedScopeTargetEntityId =
    forcedStatus === undefined
    && !hasPersistedAmbiguity
    && directReviewedScopeTargetEntityId === undefined
    && !vintageMismatch
    && status === 'ambiguous'
    && extractQueryVintageYear(query) === null
    && hasReviewedFamilyCollisionClarificationEvidence(allCandidates)
      ? resolveReviewedScopeTargetIdentity({
          query,
          allCandidates,
          reviewedTargetEntityIds,
        })
      : undefined;

  const resolvedReviewedScopeTargetEntityId =
    directReviewedScopeTargetEntityId ?? reviewedScopeTargetEntityId;

  if (resolvedReviewedScopeTargetEntityId !== undefined) {
    status = 'resolved';
    effectiveDecisionReasonCode = REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE;
  }

  if (
    forcedStatus === undefined
    && !hasPersistedAmbiguity
    && resolvedReviewedScopeTargetEntityId === undefined
    && hasReviewedFamilyCollisionClarificationEvidence(allCandidates)
    && !identityBearingEvidence
    && (status === 'failed' || status === 'ambiguous')
  ) {
    status = 'ambiguous';
    effectiveDecisionReasonCode = REVIEWED_FAMILY_COLLISION_REASON_CODE;
  }

  if (
    status === 'ambiguous'
    && forcedStatus === undefined
    && !hasPersistedAmbiguity
    && effectiveDecisionReasonCode !== REVIEWED_FAMILY_COLLISION_REASON_CODE
    && (
      hasOnlyRecallOnlyCandidateEvidence(allCandidates)
      || !identityBearingEvidence
    )
  ) {
    status = 'failed';
    effectiveDecisionReasonCode = RECALL_ONLY_NO_MATCH_REASON_CODE;
  }

  const frontPromotedEntityId = resolvedReviewedScopeTargetEntityId ?? vintagePromotedEntityId;

  return {
    status,
    effectiveDecisionReasonCode,
    frontPromotedEntityId,
    vintageMismatch,
    vintagePromotedEntityId,
    resolvedReviewedScopeTargetEntityId,
    preferVintageMismatchReasonText: vintageMismatch,
  };
}
