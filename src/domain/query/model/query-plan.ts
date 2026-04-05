import type { QueryClass, ConstraintBundle } from '../../shared/types/index.js';
import type { QueryIntent } from './query-intent.js';
import type { QueryRoute } from './query-route.js';
import type { AnchorCandidate } from './anchor-candidate.js';
import type { QueryPolicy } from './query-policy.js';
import type { QueryUncertainty } from './query-uncertainty.js';
import type { ExpansionBundle } from './constraint-bundle.js';
import type { SessionContext } from './session-context.js';
import type { QueryBudget } from './query-budget.js';

/**
 * Version 1 of the Query Plan -- the single source of truth (SSOT) output
 * of the Query Planner domain.
 *
 * A QueryPlanV1 is an immutable, deterministic snapshot: given the same input
 * query, planner version, and policy rule version, the plan is identical.
 *
 * Downstream consumers (resolver, scorer, abstention layer) read only from
 * the query plan and never re-derive planning decisions.
 */
export interface QueryPlanV1 {
  /** The original user query string, unmodified. */
  readonly rawQuery: string;

  /** Lowercased, whitespace-collapsed, accent-stripped query. */
  readonly normalizedQuery: string;

  /** Primary intent classification for this query. */
  readonly intent: QueryIntent;

  /** Additional intents detected (RFC-005 section 3.2.1 multi-intent). */
  readonly secondaryIntents?: readonly QueryIntent[] | undefined;

  /** Routing target for downstream execution. */
  readonly route: QueryRoute;

  /** Query class label used to select thresholds from the threshold profile. */
  readonly queryClass: QueryClass;

  /** Anchor entities extracted from the query surface form. */
  readonly anchors: readonly AnchorCandidate[];

  /** Hard, soft, and inferred constraints parsed from the query. */
  readonly constraints: ConstraintBundle;

  /** Lexical and semantic expansion terms. */
  readonly expansions: ExpansionBundle;

  /** Compiled policy directives for downstream resolvers. */
  readonly policy: QueryPolicy;

  /** Uncertainty assessment across parsing, anchoring, and constraints. */
  readonly uncertainty: QueryUncertainty;

  /** Semantic version of the planner that produced this plan. */
  readonly plannerVersion: string;

  /** Semantic version of the policy rules used during compilation. */
  readonly policyRuleVersion: string;

  /** ID of the threshold profile referenced by this plan. */
  readonly thresholdProfileId: string;

  /**
   * Surfaces what evidence/sealing the Admission Gate requires for this query
   * (RFC-005 §3.1, RFC-016 §2). Populated by the Planner; consumed by AdmissionGate.
   */
  readonly admission_context?: {
    /** True for entity_exact / entity_fuzzy / comparison / mixed routes. */
    readonly requires_identity_seal: boolean;
    /** True when hard constraints are present (constraint evidence required). */
    readonly requires_constraint_evidence: boolean;
    /** True for mixed-query route with anchors (anchor evidence required). */
    readonly requires_anchor_evidence: boolean;
  } | undefined;

  /** Optional session context for multi-turn queries. */
  readonly sessionContext?: SessionContext | undefined;

  /** Optional resource budget constraints. */
  readonly queryBudget?: QueryBudget | undefined;
}
