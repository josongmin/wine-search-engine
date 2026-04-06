import type { QueryClass, ConstraintBundle } from '../../shared/types/index.js';
import type { QueryIntent } from './query-intent.js';
import type { AnchorCandidate } from './anchor-candidate.js';
import type { QueryUncertainty } from './query-uncertainty.js';
import type { ExpansionBundle } from './constraint-bundle.js';
import type { SessionContext } from './session-context.js';
import type { QueryBudget } from './query-budget.js';
import type { QueryTargetType } from './query-target-type.js';
import type { NormalizedQueryViews } from './query-views.js';

/**
 * The understanding portion of a query plan — everything the planner
 * learned about the query, excluding execution decisions.
 *
 * This is the stable contract that downstream consumers (resolver, scorer,
 * abstention layer) read. Execution decisions (route, retrievalMode) are
 * compiled separately by ExecutionCompiler into EngineExecutionContract.
 */
export interface QueryUnderstandingSnapshot {
  /** The original user query string, unmodified. */
  readonly rawQuery: string;

  /** Lowercased, whitespace-collapsed, accent-stripped query. */
  readonly normalizedQuery: string;

  /**
   * Multi-view normalization snapshot used for noisy entity lookup.
   *
   * Surfaced for debugging and provenance only; downstream logic
   * should continue to rely on normalizedQuery for deterministic behavior.
   */
  readonly normalizedQueryViews?: NormalizedQueryViews;

  /** Primary intent classification for this query. */
  readonly intent: QueryIntent;

  /** Additional intents detected (RFC-005 section 3.2.1 multi-intent). */
  readonly secondaryIntents?: readonly QueryIntent[];

  /** Anchor entities extracted from the query surface form. */
  readonly anchors: readonly AnchorCandidate[];

  /** Hard, soft, and inferred constraints parsed from the query. */
  readonly constraints: ConstraintBundle;

  /** Lexical and semantic expansion terms. */
  readonly expansions: ExpansionBundle;

  /** Uncertainty assessment across parsing, anchoring, and constraints. */
  readonly uncertainty: QueryUncertainty;

  /** Query class label used to select thresholds from the threshold profile. */
  readonly queryClass: QueryClass;

  /** Inferred target entity type for result grouping (Epic 8). */
  readonly targetEntityType?: QueryTargetType;

  /** Semantic version of the planner that produced this plan. */
  readonly plannerVersion: string;

  /** Semantic version of the policy rules used during compilation. */
  readonly policyRuleVersion: string;

  /** ID of the threshold profile referenced by this plan. */
  readonly thresholdProfileId: string;

  /** Optional session context for multi-turn queries. */
  readonly sessionContext?: SessionContext;

  /** Optional resource budget constraints. */
  readonly queryBudget?: QueryBudget;
}
