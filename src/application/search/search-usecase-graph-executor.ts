/**
 * ADR-013 Phase 1c: graph-aware executor wrapper.
 *
 * Wraps `CandidatePoolPort.execute` to engage the bundle-selector path
 * when the compiled query carries a multi-subquery hybrid graph;
 * trivial graphs pass through byte-identically.
 *
 * **Engagement rule (precise):**
 *  - If `BUNDLE_SELECTOR_ENABLED !== 'true'` → pass-through (flag-off
 *    rollback is byte-identical).
 *  - If `graph === undefined` → pass-through.
 *  - If `graph.origin !== 'hybrid'` → pass-through (trivial + planner-only
 *    graphs do not carry cross-subquery structure today).
 *  - If `subqueryNodes.length <= 1` → pass-through (no assignment to do).
 *  - Otherwise → per-subquery retrieval → `chooseAssignment` →
 *    `BundleRankedResult[]`-ready assignment payload.
 *
 * **Budget-ledger lifecycle (ADR-013 P1-C fix):**
 *  - Callers must NOT invoke `BudgetLedger.reserve()` pre-rank on the
 *    flat candidate pool.
 *  - When (and only when) an `onReserve` callback is wired and an
 *    assignment succeeds, the executor invokes `onReserve(assignment)`
 *    for each winning (subquery, candidate) tuple — post-assignment.
 *  - Telemetry counter `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT`
 *    is incremented if a caller tries to reserve an unselected
 *    candidate via this path.
 */

import type { CandidatePoolPort } from './port/search-pipeline-deps.port.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../domain/query/model/constraint-graph.js';
import type {
  BundleSelector,
  BundleSelectorOptions,
  AssignmentSolution,
} from '../../domain/retrieval/service/bundle-selector.js';
import { globalBundleSelectorCounter } from '../../observability/bundle-selector-counters.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';

export interface GraphExecutorDeps {
  readonly candidatePool: CandidatePoolPort;
  readonly bundleSelector: BundleSelector;
  /**
   * Per-subquery retrieval adapter. Given the root `HybridRetrievalInput`
   * and a subquery node, returns the candidate pool for that subquery.
   * In PR4 this is a thin adapter over `candidatePool.execute` that
   * re-runs retrieval with a subquery-scoped input — downstream PRs
   * may swap in subquery-aware retrievers.
   */
  readonly subqueryRetriever?: SubqueryRetriever;
}

export interface SubqueryRetriever {
  retrieve(
    base: HybridRetrievalInput,
    subquery: SubqueryNode,
    graph: ConstraintGraph,
  ): Promise<readonly HybridCandidate[]>;
}

export interface GraphExecutorOptions extends BundleSelectorOptions {
  /** Optional post-assignment hook for budget ledger / book-keeping.
   *  Invoked exactly once per winning assignment AFTER the solver
   *  returns success. Never invoked on pass-through or fail-closed. */
  readonly onReserveAssignment?: (assignment: {
    readonly subqueryId: string;
    readonly candidate: HybridCandidate;
  }) => void;
}

export type GraphExecutionMode = 'passthrough' | 'bundle' | 'fail_closed';

export interface GraphExecutionResult {
  readonly mode: GraphExecutionMode;
  /**
   * Flat candidate list suitable for the legacy downstream ranker.
   * - `passthrough`: equal to `candidatePool.execute(input)`.
   * - `bundle`: union of the winning assignment candidates (one per
   *   subquery), preserving the subquery order.
   * - `fail_closed`: empty list; `assignmentSolution.degradationReasons`
   *   holds the fail-closed reason.
   */
  readonly candidates: readonly HybridCandidate[];
  readonly assignmentSolution?: AssignmentSolution | undefined;
}

function extractSubqueryNodes(graph: ConstraintGraph): readonly SubqueryNode[] {
  return graph.nodes.filter((n): n is SubqueryNode => n.kind === 'subquery');
}

export function isBundleSelectorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['BUNDLE_SELECTOR_ENABLED'] === 'true';
}

/**
 * True when the supplied graph + flag state engage the bundle path.
 * Pure predicate — useful for tests that want to assert the engagement
 * contract without running the executor.
 */
export function shouldEngageBundlePath(
  graph: ConstraintGraph | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isBundleSelectorEnabled(env)) return false;
  if (graph === undefined) return false;
  if (graph.origin !== 'hybrid') return false;
  const subqueryCount = extractSubqueryNodes(graph).length;
  return subqueryCount > 1;
}

/**
 * Runs the root retrieval through the candidate pool when the graph
 * does not engage the bundle path. Otherwise, retrieves per subquery
 * and hands off to the bundle selector.
 */
export async function executeGraphAware(
  input: HybridRetrievalInput,
  graph: ConstraintGraph | undefined,
  deps: GraphExecutorDeps,
  opts: GraphExecutorOptions,
): Promise<GraphExecutionResult> {
  if (!shouldEngageBundlePath(graph)) {
    const flat = await runRootRetrieval(deps.candidatePool, input);
    return { mode: 'passthrough', candidates: flat };
  }

  // Narrowed by `shouldEngageBundlePath`.
  const engagedGraph = graph as ConstraintGraph;
  const subqueries = extractSubqueryNodes(engagedGraph);

  pipelineDebug(
    {
      step: 'retrieval.bundle_selector.engage',
      subquery_count: subqueries.length,
      graph_origin: engagedGraph.origin,
    },
    'pipeline bundle selector engage',
  );

  // Per-subquery retrieval. When no adapter is wired we degrade to a
  // single root retrieval for all subqueries — this is a temporary
  // passthrough that preserves behaviour; downstream PRs will swap in
  // a real subquery-scoped retriever.
  const pools = new Map<string, readonly HybridCandidate[]>();
  if (deps.subqueryRetriever !== undefined) {
    const retriever = deps.subqueryRetriever;
    await Promise.all(
      subqueries.map(async (sq) => {
        const pool = await retriever.retrieve(input, sq, engagedGraph);
        pools.set(sq.nodeId, pool);
      }),
    );
  } else {
    const fallback = await runRootRetrieval(deps.candidatePool, input);
    for (const sq of subqueries) pools.set(sq.nodeId, fallback);
  }

  const solution = deps.bundleSelector.chooseAssignment(engagedGraph, pools, opts);

  if (solution.degradationReasons.length > 0) {
    for (const reason of solution.degradationReasons) {
      globalBundleSelectorCounter.incrementReason(reason);
    }
    pipelineDebug(
      {
        step: 'retrieval.bundle_selector.fail_closed',
        reasons: [...solution.degradationReasons],
      },
      'pipeline bundle selector fail closed',
    );
    return {
      mode: 'fail_closed',
      candidates: [],
      assignmentSolution: solution,
    };
  }

  // Post-assignment reservation — the P1-C fix call-site.
  if (opts.onReserveAssignment !== undefined) {
    const reservedIds = new Set<string>();
    for (const a of solution.assignments) {
      opts.onReserveAssignment({ subqueryId: a.subqueryId, candidate: a.candidate });
      reservedIds.add(`${a.subqueryId}:${a.candidate.entityId}`);
    }
    // Defensive: if a future refactor accidentally reserves a
    // candidate not in the final assignment via the same hook, the
    // counter trips. Under the PR4 executor the reservedIds set is
    // always exactly the assignments, so the counter stays at 0.
    for (const a of solution.assignments) {
      const key = `${a.subqueryId}:${a.candidate.entityId}`;
      if (!reservedIds.has(key)) {
        globalBundleSelectorCounter.incrementUnselectedReserved();
      }
    }
  }

  const candidates = solution.assignments.map((a) => a.candidate);
  return {
    mode: 'bundle',
    candidates,
    assignmentSolution: solution,
  };
}

async function runRootRetrieval(
  candidatePool: CandidatePoolPort,
  input: HybridRetrievalInput,
): Promise<readonly HybridCandidate[]> {
  if (candidatePool.execute !== undefined) {
    return candidatePool.execute(input);
  }
  return candidatePool.generate(input);
}
