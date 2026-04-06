import type { SignalSet, EvidenceItem } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { EntityResolveResult } from '../../resolver/model/resolve-result.js';

/**
 * Summary of ambiguity signals aggregated from multiple pipeline stages.
 */
export interface AmbiguitySummary {
  /** Specific ambiguity types detected across all stages. */
  readonly types: readonly string[];

  /** Overall severity of the ambiguity situation. */
  readonly severity: 'low' | 'medium' | 'high';

  /** Pipeline stages that contributed ambiguity signals. */
  readonly sources: readonly ('planner' | 'resolver' | 'alias')[];

  /**
   * The effect this ambiguity should have on the decision.
   * - `trace_only` — logged but does not change behavior.
   * - `raise_threshold` — resolution threshold is increased.
   * - `force_clarify` — system must ask for clarification.
   * - `block_resolve` — resolution is blocked entirely.
   */
  readonly decisionEffect?: 'trace_only' | 'raise_threshold' | 'force_clarify' | 'block_resolve';
}

/**
 * Summary of evidence availability for decision-layer obligation checks.
 */
export interface EvidenceSummary {
  /** Whether identity evidence (alias match, canonical match) is present. */
  readonly identityEvidencePresent: boolean;

  /**
   * Richer identity evidence details for ranked and resolver-backed routes.
   *
   * This stays optional so older tests/callers that only provide the coarse
   * booleans remain valid.
   */
  readonly identityEvidence?: {
    /** Canonical source that supplied the identity trail. */
    readonly source?: 'resolver' | 'ranked_synthetic' | undefined;

    /** Resolver emitted a topEntity reference. */
    readonly topEntityPresent: boolean;

    /** Resolver emitted a ranked top candidate aligned with topEntity. */
    readonly resolverTopCandidateMatchesTopEntity: boolean;

    /** Count of resolver evidence refs for the top candidate identity trail. */
    readonly resolverEvidenceRefCount: number;

    /**
     * Whether the resolver output was synthesized from ranked-route results
     * rather than emitted by the entity resolver.
     */
    readonly syntheticRankedRoute?: boolean | undefined;

    /** Whether a ranked top result was available for the same decision. */
    readonly rankedTopResultPresent?: boolean | undefined;

    /** Whether the ranked top result agreed with the resolver-selected entity. */
    readonly rankedTopResultMatchesTopEntity?: boolean | undefined;

    /** Count of ranked evidence items carried by the top ranked result. */
    readonly rankedEvidenceItemCount?: number | undefined;

    /**
     * Count of positive ranked corroboration items aligned with the resolver's
     * chosen entity. This is trace/debug detail and does not mint identity on
     * its own.
     */
    readonly rankedCorroborationItemCount?: number | undefined;

    /** Ranked evidence types that corroborated the resolver-selected entity. */
    readonly rankedCorroborationTypes?: readonly string[] | undefined;

    /**
     * Whether the resolver top candidate satisfies exact-match expectations.
     *
     * When present, this is the canonical exact-match signal for ranked
     * routes. It should be derived from the richer identity evidence trail,
     * not from score thresholds.
     */
    readonly exactMatchCandidatePresent?: boolean | undefined;
  };

  /** Whether constraint evidence (filter satisfaction) is present. */
  readonly constraintEvidencePresent?: boolean;

  /** Richer hard-constraint coverage details for ranked routes. */
  readonly constraintEvidence?: {
    /** Required hard-constraint attributes from the query plan. */
    readonly requiredAttributes: readonly string[];

    /** Hard-constraint attributes explicitly matched by the top ranked result. */
    readonly matchedRequiredAttributes: readonly string[];

    /** Hard-constraint attributes still unmet on the top ranked result. */
    readonly unmetRequiredAttributes: readonly string[];

    /** Inferred attributes represented on the ranked result for trace/debugging. */
    readonly inferredAttributes: readonly string[];

    /** Count of required attributes explicitly matched by the ranked result. */
    readonly matchedRequiredAttributeCount?: number | undefined;

    /** Count of required attributes still unmet on the ranked result. */
    readonly unmetRequiredAttributeCount?: number | undefined;
  };

  /** Whether anchor evidence (similarity to anchor entity) is present. */
  readonly anchorEvidencePresent?: boolean;

  /** Anchor-resolution details kept separate from the selected result entity. */
  readonly anchorResolution?: {
    /** Whether the mixed-route anchor entity was explicitly resolved. */
    readonly anchorEntityPresent: boolean;

    /** The resolved anchor entity identifier, when available. */
    readonly anchorEntityId?: string | undefined;

    /** Canonical label for the resolved anchor entity, when available. */
    readonly anchorCanonicalLabel?: string | undefined;

    /** Confidence assigned to the resolved anchor entity. */
    readonly anchorConfidence?: number | undefined;
  };

  /** Richer anchor evidence details for ranked mixed routes. */
  readonly anchorEvidence?: {
    /** Ranked-route selection produced a candidate to validate. */
    readonly topEntityPresent: boolean;

    /** Whether a ranked top result was available for anchor validation. */
    readonly rankedTopResultPresent?: boolean | undefined;

    /** Whether the ranked top result matched the resolver-selected entity. */
    readonly rankedTopResultMatchesTopEntity?: boolean | undefined;

    /** Whether the ranked evidence trail contains an anchor signal. */
    readonly rankedSignalPresent?: boolean | undefined;

    /** Count of ranked anchor-signal evidence items, when available. */
    readonly rankedSignalItemCount?: number | undefined;

    /** Ranked evidence types that contributed anchor support. */
    readonly rankedSignalTypes?: readonly string[] | undefined;
  };

  /** Total count of evidence references across all candidates. */
  readonly evidenceRefCount?: number;
}

/**
 * Returns whether the evidence summary carries sufficient identity evidence.
 *
 * When richer identity details are present, they override the coarse boolean
 * so ranked-route drift cannot silently mark identity evidence as present.
 */
export function hasIdentityEvidence(summary?: EvidenceSummary): boolean {
  if (summary?.identityEvidence !== undefined) {
    const detail = summary.identityEvidence;
    if (detail.source === 'ranked_synthetic') {
      return hasSyntheticRankedIdentityTrail(detail);
    }

    if (!hasResolverIdentityTrail(detail)) {
      return false;
    }

    return !rankedResultContradictsResolver(detail);
  }

  return summary?.identityEvidencePresent === true;
}

/**
 * Returns whether the identity trail supports an exact match.
 *
 * Unlike {@link hasIdentityEvidence}, this helper intentionally does not
 * fall back to the coarse boolean because exact-match policy on ranked
 * routes should only pass when richer evidence is available.
 */
export function hasExactMatchCandidate(summary?: EvidenceSummary): boolean {
  const detail = summary?.identityEvidence;
  if (detail === undefined) {
    return false;
  }

  if (detail.exactMatchCandidatePresent !== undefined) {
    if (detail.source === 'ranked_synthetic') {
      return detail.exactMatchCandidatePresent && hasSyntheticRankedIdentityTrail(detail);
    }

    return (
      detail.exactMatchCandidatePresent &&
      hasResolverIdentityTrail(detail) &&
      !rankedResultContradictsResolver(detail)
    );
  }

  if (detail.source === 'ranked_synthetic') {
    return false;
  }

  if (!hasResolverIdentityTrail(detail)) {
    return false;
  }

  return !rankedResultContradictsResolver(detail);
}

/**
 * Returns whether the evidence summary carries sufficient hard-constraint evidence.
 */
export function hasConstraintEvidence(summary?: EvidenceSummary): boolean {
  if (summary?.constraintEvidence !== undefined) {
    const detail = summary.constraintEvidence;
    return (
      detail.requiredAttributes.every((attribute) =>
        detail.matchedRequiredAttributes.includes(attribute),
      ) &&
      detail.unmetRequiredAttributes.length === 0
    );
  }

  return summary?.constraintEvidencePresent === true;
}

/**
 * Returns whether the evidence summary carries sufficient anchor evidence.
 */
export function hasAnchorEvidence(summary?: EvidenceSummary): boolean {
  if (summary?.anchorEvidence !== undefined) {
    const detail = summary.anchorEvidence;
    const anchorResolution = summary.anchorResolution;
    if (anchorResolution?.anchorEntityPresent === false) {
      return false;
    }

    if (!detail.topEntityPresent) {
      return false;
    }

    if (detail.rankedTopResultPresent === true) {
      return (
        detail.rankedTopResultMatchesTopEntity === true &&
        detail.rankedSignalPresent === true
      );
    }

    return true;
  }

  return summary?.anchorEvidencePresent === true;
}

function hasResolverIdentityTrail(
  detail: NonNullable<EvidenceSummary['identityEvidence']>,
): boolean {
  if (!detail.topEntityPresent || !detail.resolverTopCandidateMatchesTopEntity) {
    return false;
  }

  if (detail.syntheticRankedRoute === true) {
    return true;
  }

  return (
    detail.resolverEvidenceRefCount > 0
  );
}

function rankedResultContradictsResolver(
  detail: NonNullable<EvidenceSummary['identityEvidence']>,
): boolean {
  return detail.rankedTopResultPresent === true && detail.rankedTopResultMatchesTopEntity !== true;
}

function hasSyntheticRankedIdentityTrail(
  detail: NonNullable<EvidenceSummary['identityEvidence']>,
): boolean {
  return (
    detail.topEntityPresent &&
    detail.rankedTopResultPresent === true &&
    detail.rankedTopResultMatchesTopEntity === true &&
    (detail.rankedCorroborationItemCount ?? 0) > 0
  );
}

/**
 * The complete input to the {@link DecisionEngine}, aggregating signals
 * from the query planner, resolver, and ranking stages, per RFC-007.
 */
export interface DecisionInput {
  /** The query plan that drove the pipeline. */
  readonly queryPlan: QueryPlanV1;

  /**
   * The route that actually executed after any API-level override.
   *
   * This can differ from `queryPlan.route` when the caller forces a route
   * via the top-level `retrieval_mode` field.
   */
  readonly effectiveRoute?: QueryRoute | undefined;

  /** The resolver's result including its suggested status. */
  readonly resolverResult: EntityResolveResult;

  /** Optional ranking signals from the scoring stage. */
  readonly rankingSignals?: SignalSet;

  /** Compiled policy directives. */
  readonly policy: QueryPolicy;

  /** Uncertainty assessment from the planner. */
  readonly uncertainty: QueryUncertainty;

  /**
   * Admission/evidence obligations that apply to the executed route.
   *
   * Defaults to `queryPlan.admission_context` when absent.
   */
  readonly admissionContext?: QueryPlanV1['admission_context'] | undefined;

  /** Aggregated ambiguity summary from all pipeline stages. */
  readonly ambiguitySummary?: AmbiguitySummary;

  /** Evidence availability summary for obligation checks. */
  readonly evidenceSummary?: EvidenceSummary;

  /**
   * Conformal prediction set size (P2 signal).
   * When >= 2, indicates the conformal predictor could not narrow
   * the candidate set to a single entity.
   */
  readonly conformalSetSize?: number;

  /**
   * Pre-computed evidence items for the top candidate, populated by the
   * ranking stage (RFC-007 §4). The DecisionEngine includes these verbatim
   * in its output so the full evidence trail reaches API consumers.
   *
   * When absent (e.g. entity-only route with no ranking), the output
   * evidenceItems will be empty.
   */
  readonly evidenceItems?: readonly EvidenceItem[] | undefined;

  /**
   * Optional execution / honesty mode for admission policy (Wave 3).
   * Defaults to `authoritative` when omitted.
   */
  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

  /** When false, admission policy rejects (route unhealthy). Defaults to true. */
  readonly routeHealthy?: boolean;

  /** When true with heuristic execution mode, admission rejects blocking paths. */
  readonly blockingRequested?: boolean;
}
