import type { SignalSet, EvidenceItem } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
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

  /** Whether constraint evidence (filter satisfaction) is present. */
  readonly constraintEvidencePresent?: boolean;

  /** Whether anchor evidence (similarity to anchor entity) is present. */
  readonly anchorEvidencePresent?: boolean;

  /** Total count of evidence references across all candidates. */
  readonly evidenceRefCount?: number;
}

/**
 * The complete input to the {@link DecisionEngine}, aggregating signals
 * from the query planner, resolver, and ranking stages, per RFC-007.
 */
export interface DecisionInput {
  /** The query plan that drove the pipeline. */
  readonly queryPlan: QueryPlanV1;

  /** The resolver's result including its suggested status. */
  readonly resolverResult: EntityResolveResult;

  /** Optional ranking signals from the scoring stage. */
  readonly rankingSignals?: SignalSet;

  /** Compiled policy directives. */
  readonly policy: QueryPolicy;

  /** Uncertainty assessment from the planner. */
  readonly uncertainty: QueryUncertainty;

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
}
