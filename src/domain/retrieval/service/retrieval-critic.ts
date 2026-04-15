/**
 * ADR-015 Axis 2: executor-internal retrieval critic (deterministic,
 * day-1 LLM-free).
 *
 * Decides whether the graph-aware executor should retry `candidatePool.execute`
 * with a rewritten retrieval input. Inputs are the signals already produced
 * by the pre-rank pipeline — `GraphCoverageResult`, provenance shortfall
 * obligations, and `retrievalDegradationSignals`. No LLM call on this path;
 * the LLM seam lives in the companion `QueryRewriter.reformulate` branch.
 *
 * Pure function — no I/O, no shared mutable state. Deterministic for
 * identical input.
 */

import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { GraphCoverageResult } from '../../query/service/compute-graph-coverage.js';
import type { RetrievalDegradationCode } from '../port/retrieval-degradation-observer.port.js';

/**
 * ADR-015 §2: Type-level retry cap. NOT an env var.
 *
 * A loop without a hard type-level cap is a catastrophic latency risk:
 * env-var-controlled caps can be bumped or disabled in production and
 * drift silently. Regression tests import this constant directly and
 * assert `=== 3` to lock the value at module-load time.
 *
 * Loop contract in the executor:
 *   `for (let i = 0; i < CRITIC_RETRY_MAX; i += 1) { ... }`
 * `retryCount` is a local `let` — not mutable from any other scope.
 */
export const CRITIC_RETRY_MAX = 3 as const;

/**
 * Coverage ratio at-or-above which the critic short-circuits to `retry=false`
 * regardless of other signals. ADR-015 decision table row 2.
 */
const HIGH_COVERAGE_FLOOR = 0.8;

/**
 * Coverage ratio strictly below which `expand_synonym` is preferred when
 * `no_matches` is present. ADR-015 decision table row 4.
 */
const LOW_COVERAGE_CEILING = 0.5;

export type CriticRewriteType =
  | 'relax'
  | 'decompose'
  | 'expand_synonym'
  | 'reformulate';

export type CriticDecision =
  | { readonly retry: false; readonly reason: CriticNoRetryReason }
  | {
      readonly retry: true;
      readonly rewriteType: CriticRewriteType;
      readonly subqueryId: string;
      readonly reason: CriticRetryReason;
    };

export type CriticNoRetryReason =
  | 'coverage_satisfied'
  | 'retry_cap_reached'
  | 'no_signal_to_act_on';

export type CriticRetryReason =
  | 'coverage_zero_relax'
  | 'no_matches_expand_synonym'
  | 'partial_coverage_decompose'
  | 'fallback_reformulate';

export interface CriticInput {
  readonly graph: ConstraintGraph | undefined;
  readonly coverage: GraphCoverageResult | undefined;
  readonly degradationCodes: readonly RetrievalDegradationCode[];
  readonly retryCount: number;
  /** Default `CRITIC_RETRY_MAX`. Parameterised so tests can inject a smaller
   *  cap without touching the module constant. Test-only — production
   *  callers must omit this to inherit the locked value. */
  readonly criticRetryMax?: number;
}

/** Identify a subquery node in the graph; falls back to a sentinel when
 *  the graph is trivial / absent. Decision-input wiring always records
 *  the subquery id in the rewrite trace. */
function pickSubqueryId(graph: ConstraintGraph | undefined): string {
  if (graph === undefined) return 'root';
  const subquery = graph.nodes.find((n) => n.kind === 'subquery');
  return subquery !== undefined ? subquery.nodeId : graph.rootNodeId;
}

function hasMultipleSubqueries(graph: ConstraintGraph | undefined): boolean {
  if (graph === undefined) return false;
  let count = 0;
  for (const node of graph.nodes) {
    if (node.kind === 'subquery') {
      count += 1;
      if (count > 1) return true;
    }
  }
  return false;
}

/**
 * Deterministic critic decision. See ADR-015 §5 decision table.
 */
export function decideRetry(input: CriticInput): CriticDecision {
  const cap = input.criticRetryMax ?? CRITIC_RETRY_MAX;

  // §5 row 7: cap reached — short-circuit.
  if (input.retryCount >= cap) {
    return { retry: false, reason: 'retry_cap_reached' };
  }

  const coverage = input.coverage;
  // No coverage signal and no degradation reasons → nothing actionable.
  if (
    coverage === undefined
    && input.degradationCodes.length === 0
  ) {
    return { retry: false, reason: 'no_signal_to_act_on' };
  }

  // §5 rows 1 + 2: coverage is satisfied enough — no retry.
  if (
    coverage !== undefined
    && coverage.rootSatisfied
    && coverage.coverageRatio >= HIGH_COVERAGE_FLOOR
  ) {
    return { retry: false, reason: 'coverage_satisfied' };
  }

  const subqueryId = pickSubqueryId(input.graph);
  const hasNoMatches = input.degradationCodes.includes('no_matches');
  const hasSparsePool = input.degradationCodes.includes('sparse_pool');

  // §5 row 4: low coverage + no_matches → expand_synonym.
  if (
    (coverage === undefined || coverage.coverageRatio < LOW_COVERAGE_CEILING)
    && hasNoMatches
  ) {
    return {
      retry: true,
      rewriteType: 'expand_synonym',
      subqueryId,
      reason: 'no_matches_expand_synonym',
    };
  }

  // §5 row 3: zero coverage (no signal either way) → relax constraints.
  if (
    coverage !== undefined
    && coverage.coverageRatio === 0
  ) {
    return {
      retry: true,
      rewriteType: 'relax',
      subqueryId,
      reason: 'coverage_zero_relax',
    };
  }

  // Sparse pool with partial coverage — prefer relax (add matches) rather
  // than decompose / reformulate which do not grow the pool.
  if (
    hasSparsePool
    && coverage !== undefined
    && coverage.coverageRatio < 1
  ) {
    return {
      retry: true,
      rewriteType: 'relax',
      subqueryId,
      reason: 'coverage_zero_relax',
    };
  }

  // §5 row 5: mid coverage + multi-subquery → decompose.
  if (
    coverage !== undefined
    && coverage.coverageRatio >= LOW_COVERAGE_CEILING
    && coverage.coverageRatio < HIGH_COVERAGE_FLOOR
    && hasMultipleSubqueries(input.graph)
  ) {
    return {
      retry: true,
      rewriteType: 'decompose',
      subqueryId,
      reason: 'partial_coverage_decompose',
    };
  }

  // §5 row 6: nothing deterministic applied — fall back to LLM reformulate.
  // Only reached when the above branches could not generate a deterministic
  // rewrite (e.g. single-subquery graph with mid-coverage).
  if (coverage !== undefined && !coverage.rootSatisfied) {
    return {
      retry: true,
      rewriteType: 'reformulate',
      subqueryId,
      reason: 'fallback_reformulate',
    };
  }

  return { retry: false, reason: 'no_signal_to_act_on' };
}
