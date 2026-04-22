import type { SignalSet, EvidenceItem } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type {
  ExecutionRetrievalMode,
  MissingProvenanceObligation,
  ProvenancePolicy,
} from '../../query/model/engine-execution-contract.js';
import type { QueryPolicy } from '../../query/model/query-policy.js';
import type { QueryUncertainty } from '../../query/model/query-uncertainty.js';
import type { EntityResolveResult } from '../../resolver/model/resolve-result.js';
import type {
  DualLanePresence,
  IdentityExactnessTier,
} from '../../retrieval/model/dual-lane-artifact.js';

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
   * Winner-aligned identity artifact projection used by exact/identity gates.
   */
  readonly identityEvidence?: {
    /** Canonical source that supplied the identity artifact trail. */
    readonly source: 'identity_artifact';

    /** Fused resolve winner exists. */
    readonly resolveTopEntityPresent: boolean;

    /** Identity lane emitted an artifact for the winning entity. */
    readonly winnerIdentityArtifactPresent: boolean;

    /** Identity artifact agrees with the fused resolve winner. */
    readonly winnerIdentityArtifactMatchesResolveResult: boolean;

    /** Dual-lane presence for the winner-aligned identity artifact. */
    readonly lanePresence?: DualLanePresence | undefined;

    /** Identity exactness preserved from the identity lane artifact SSOT. */
    readonly exactnessTier: IdentityExactnessTier;

    /** Count of identity-artifact evidence refs for the winning identity trail. */
    readonly identityEvidenceRefCount: number;

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

export interface AdmissionClosureSummary {
  readonly required: {
    readonly identitySeal: boolean;
    readonly constraintEvidence: boolean;
    readonly anchorEvidence: boolean;
  };
  readonly satisfied: {
    readonly identitySeal: boolean;
    readonly constraintEvidence: boolean;
    readonly anchorEvidence: boolean;
  };
  readonly allSatisfied: boolean;
}

export interface DecisionProvenanceContract {
  readonly policy: ProvenancePolicy;
  readonly observed: {
    readonly identityEvidenceSatisfied: boolean;
    readonly constraintEvidenceSatisfied: boolean;
    readonly anchorEvidenceSatisfied: boolean;
    readonly topEntityPresent: boolean;
    readonly rankedTopResultPresent: boolean;
    readonly rankedTopResultMatchesTopEntity?: boolean | undefined;
    readonly matchedConstraintAttributes: readonly string[];
    readonly unmetConstraintAttributes: readonly string[];
    readonly anchorSignalTypes: readonly string[];
  };
  readonly missing: readonly MissingProvenanceObligation[];
}

/**
 * Returns whether the evidence summary carries sufficient identity evidence.
 *
 * When richer identity details are present, they override the coarse boolean
 * so ranked-route drift cannot silently mark identity evidence as present.
 */
export function hasIdentityEvidence(summary?: EvidenceSummary): boolean {
  const detail = summary?.identityEvidence;
  if (detail === undefined) {
    return false;
  }

  return hasWinnerIdentityArtifact(detail);
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

  if (!hasWinnerIdentityArtifact(detail)) {
    return false;
  }

  return detail.exactnessTier === 'exact' || detail.exactnessTier === 'alias_exact';
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

function hasWinnerIdentityArtifact(
  detail: NonNullable<EvidenceSummary['identityEvidence']>,
): boolean {
  if (
    !detail.resolveTopEntityPresent ||
    !detail.winnerIdentityArtifactPresent ||
    !detail.winnerIdentityArtifactMatchesResolveResult
  ) {
    return false;
  }

  return detail.identityEvidenceRefCount > 0;
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

  /**
   * The retrieval mode that actually executed after compilation / route policy.
   *
   * This can differ from `queryPlan.retrievalMode` when compiled execution
   * semantics override planner-era V1 compatibility fields.
   */
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;

  /**
   * Coarser execution-family contract for route-specific gate semantics.
   *
   * This is distinct from `effectiveRetrievalMode`:
   * - `effectiveRetrievalMode` captures the precise compiled retrieval mode
   * - `retrievalKind` captures the execution family actually run
   */
  readonly retrievalKind?:
    | 'entity_lookup'
    | 'generic_hybrid'
    | 'specialized_hybrid'
    | 'mixed_similarity'
    | undefined;

  /**
   * The fused resolve result that drives numeric gating and final candidate
   * selection.
   */
  readonly resolveResult: EntityResolveResult;

  /**
   * Identity-only resolve artifact used for identity/exact evidence checks.
   *
   * This is intentionally separate from {@link resolveResult}; ranked/fused
   * execution may select a winner without carrying entity-resolver identity
   * provenance.
   */
  readonly identityResolveResult: EntityResolveResult | undefined;

  /** Optional ranking signals from the scoring stage. */
  readonly rankingSignals?: SignalSet;

  /** Compiled policy directives. */
  readonly policy: QueryPolicy;

  /** Uncertainty assessment from the planner. */
  readonly uncertainty: QueryUncertainty;

  /** Compiled-first provenance closure contract consumed by decision gates. */
  readonly provenanceContract: DecisionProvenanceContract;

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

  /** When true, LTR model was loaded but saturated — heuristic fallback is
   *  in effect. The decision engine uses this to bypass conformal set gating
   *  (which is calibrated on LTR scores and meaningless for heuristic). */
  readonly ltrSaturated?: boolean;

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

  /**
   * ADR-015 Axis 2: trace of executor-internal critic rewrites that
   * occurred during retrieval for this decision. Empty (or absent) when
   * the `RETRIEVAL_EXECUTOR_CRITIC` flag is off OR when no retry was
   * needed. Each entry references the subquery the rewrite targeted and
   * a stable trace ref the response builder can use to anchor a claim.
   */
  readonly criticRewrites?: readonly DecisionInputCriticRewrite[] | undefined;
}

/**
 * ADR-015 Axis 2: minimal projection of an executor critic rewrite
 * suitable for inclusion in the decision input. The full rewrite trace
 * (with prompt versions, deltas, etc.) is owned by the retrieval layer.
 */
export interface DecisionInputCriticRewrite {
  readonly subqueryId: string;
  readonly type: 'relax' | 'decompose' | 'expand_synonym' | 'reformulate';
  readonly rewriteTraceRef: string;
}
