/**
 * ADR-013 Phase 1c: graph-aware executor wrapper.
 *
 * Wraps `CandidatePoolPort.execute` to engage the bundle-selector path
 * when the compiled query carries a multi-subquery hybrid graph;
 * trivial graphs pass through byte-identically.
 *
 * **Engagement rule (precise):**
 *  - If `BUNDLE_SELECTOR_ENABLED === 'false'` → pass-through (flag-off
 *    rollback is byte-identical).
 *  - If `graph === undefined` → pass-through.
 *  - If `graph.origin === 'deterministic_from_atoms'` → pass-through
 *    (trivial graph; no cross-subquery structure).
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
  CandidateDropRecord,
  RrfFusionTrace,
} from '../../domain/retrieval/model/candidate-envelope.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../domain/query/model/constraint-graph.js';
import type {
  BundleSelector,
  BundleSelectorOptions,
  AssignmentSolution,
} from '../../domain/retrieval/service/bundle-selector.js';
import {
  CRITIC_RETRY_MAX,
  decideRetry,
  type CriticDecision,
} from '../../domain/retrieval/service/retrieval-critic.js';
import type {
  RetrievalDegradationCode,
  RetrievalDegradationSignal,
} from '../../domain/retrieval/port/retrieval-degradation-observer.port.js';
import type {
  QueryRewriter,
  RewriteTrace,
} from '../../domain/retrieval/service/query-rewriter.js';
import type { BudgetLedger } from '../../domain/retrieval/service/budget-ledger.js';
import { BudgetViolationError } from '../../domain/retrieval/service/budget-ledger.js';
import {
  computeGraphCoverage,
  type GraphCoverageSignals,
} from '../../domain/query/service/compute-graph-coverage.js';
import { globalBundleSelectorCounter } from '../../observability/bundle-selector-counters.js';
import {
  classifyGraphPresence,
  recordGraphPathDecision,
} from '../../observability/graph-path-telemetry.js';
import { globalRetrievalCriticCounter } from '../../observability/retrieval-critic-counters.js';
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
  /**
   * ADR-015 Axis 2: optional query rewriter for the executor-internal
   * critic loop. When `undefined` OR the `RETRIEVAL_EXECUTOR_CRITIC`
   * flag is off, the executor runs one-shot retrieval (byte-identical
   * to pre-PR6 behaviour).
   */
  readonly queryRewriter?: QueryRewriter | undefined;
  /**
   * ADR-013 Phase 1c.x: optional per-request budget ledger. When wired,
   * the executor calls `budgetLedger.reserve(subqueryId, candidate)`
   * exactly once per winning assignment tuple AFTER the solver
   * succeeds — mirroring the PR4 `onReserveAssignment` contract but
   * now backed by a concrete service. When both the ledger and the
   * deprecated `opts.onReserveAssignment` hook are present, the ledger
   * wins and the hook is invoked for parity (legacy test-seam only).
   *
   * On critic-retry paths (ADR-015 Axis 2), the executor calls
   * `release(subqueryId)` BEFORE the retried retrieval runs so the
   * retry does not reserve against stale slots. A single ledger
   * instance is threaded through the entire critic loop; callers MUST
   * NOT share one across requests (race condition).
   */
  readonly budgetLedger?: BudgetLedger | undefined;
}

export interface SubqueryRetriever {
  /**
   * Shared mutable candidate-pool getters (`getLast*`) are not per-call
   * safe under concurrency. Retrievers that wrap a single CandidatePool
   * instance must leave this as the default `'shared_mutable'`, which
   * forces sequential execution in the graph executor.
   */
  readonly stateIsolation?: 'shared_mutable' | 'isolated';
  retrieve(
    base: HybridRetrievalInput,
    subquery: SubqueryNode,
    graph: ConstraintGraph,
  ): Promise<readonly HybridCandidate[] | SubqueryRetrievalResult>;
}

export interface GraphExecutorOptions extends BundleSelectorOptions {
  /**
   * Deprecated post-assignment hook for budget ledger / book-keeping.
   * Invoked exactly once per winning assignment AFTER the solver
   * returns success. Never invoked on pass-through or fail-closed.
   *
   * @deprecated ADR-013 Phase 1c.x landed a concrete
   * {@link BudgetLedger} plumbed through {@link GraphExecutorDeps};
   * production wiring MUST use the ledger dep instead. The callback
   * is kept alive as a test-seam so unit tests that have not yet
   * migrated can still assert reserve ordering without constructing
   * a ledger. When both are supplied the ledger wins (the callback is
   * still invoked for parity, to preserve pre-migration fixture
   * assertions).
   */
  readonly onReserveAssignment?: (assignment: {
    readonly subqueryId: string;
    readonly candidate: HybridCandidate;
  }) => void;
}

export type GraphExecutionMode = 'passthrough' | 'bundle' | 'fail_closed';

export interface GraphRetrievalTelemetry {
  readonly degradationCodes: readonly RetrievalDegradationCode[];
  readonly degradationSignals: readonly RetrievalDegradationSignal[];
  readonly fusionTrace?: RrfFusionTrace | undefined;
  readonly dropLog?: readonly CandidateDropRecord[] | undefined;
}

export interface SubqueryRetrievalResult {
  readonly candidates: readonly HybridCandidate[];
  readonly telemetry: GraphRetrievalTelemetry;
}

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
  readonly retrievalTelemetry?: GraphRetrievalTelemetry | undefined;
  /**
   * ADR-015 Axis 2: trace of critic-driven rewrites performed inside
   * this execution. Present (possibly empty) only when the
   * `RETRIEVAL_EXECUTOR_CRITIC` flag is on. Absent on the one-shot path.
   */
  readonly criticRewrites?: readonly RewriteTrace[] | undefined;
  /**
   * ADR-015 Axis 2: `true` when the retry loop exhausted
   * `CRITIC_RETRY_MAX` iterations without reaching a satisfied coverage
   * decision. The executor hands the last retrieval result to the
   * ranker with `'critic_retries_exhausted'` signalled via
   * `criticDegradationReasons`.
   */
  readonly criticRetriesExhausted?: boolean | undefined;
  /**
   * ADR-015 Axis 2: auxiliary retrieval degradation reasons produced
   * inside the critic loop (e.g. `'critic_retries_exhausted'`). Callers
   * merge these with their own `routeDegradation`.
   */
  readonly criticDegradationReasons?: readonly string[] | undefined;
}

/**
 * ADR-015 Axis 2: feature flag for the executor-internal critic retry
 * loop. Checked once per call — flipping the flag mid-flight cannot
 * produce a partial-loop state.
 *
 * Wave J2: default-on. The critic is deterministic-first — satisfied
 * graph coverage short-circuits immediately, while graphless requests
 * may still retry on typed degradation codes (`no_matches`,
 * `sparse_pool`). The loop remains bounded by `CRITIC_RETRY_MAX`.
 * Rollback via `RETRIEVAL_EXECUTOR_CRITIC=false`.
 *
 * Tests that pin the byte-identity of the one-shot/relaxation path
 * (e.g. the hybrid-ranking-pipeline relaxation test) set the flag
 * explicitly to `'false'` in `beforeEach` so the default-on flip
 * does not alter their call-count contracts.
 */
function isRetrievalCriticEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['RETRIEVAL_EXECUTOR_CRITIC'] !== 'false';
}

function resolveRemainingLatencyBudgetMs(
  input: HybridRetrievalInput,
  nowMs: number = Date.now(),
): number | undefined {
  const maxLatencyMs = input.queryPlan.queryBudget?.maxLatencyMs;
  const requestStartTimeMs = input.requestContext?.requestStartTimeMs;
  if (
    maxLatencyMs === undefined
    || !Number.isFinite(maxLatencyMs)
    || requestStartTimeMs === undefined
    || !Number.isFinite(requestStartTimeMs)
  ) {
    return undefined;
  }

  return maxLatencyMs - Math.max(0, nowMs - requestStartTimeMs);
}

function extractSubqueryNodes(graph: ConstraintGraph): readonly SubqueryNode[] {
  return graph.nodes.filter((n): n is SubqueryNode => n.kind === 'subquery');
}

/**
 * Wave J1: BundleSelector is default-on once Wave F1 (deterministic
 * topology detector) and Wave H (shares_budget edges) landed. The
 * selector is a gated pass-through for trivial / single-subquery
 * graphs (`shouldEngageBundlePath` returns false), so flipping the
 * default only changes behaviour when a graph actually carries ≥2
 * subquery nodes. Rollback via `BUNDLE_SELECTOR_ENABLED=false`.
 */
function isBundleSelectorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['BUNDLE_SELECTOR_ENABLED'] !== 'false';
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
  // The trivial atom graph never carries multi-subquery topology, so it must
  // remain on the passthrough path. In contrast, merged deterministic / LLM
  // topology graphs are emitted as `planner_emitted` or `hybrid` and SHOULD
  // engage the bundle path when they carry >1 subquery nodes.
  if (graph.origin === 'deterministic_from_atoms') return false;
  const subqueryCount = extractSubqueryNodes(graph).length;
  return subqueryCount > 1;
}

/**
 * Inputs the executor-internal critic consults to decide whether to
 * retry. Supplied per-call by the caller (hybrid-candidates wiring)
 * because `computeGraphCoverage` needs graph-native satisfaction
 * signals derived from the execution result — matched slot refs,
 * winning subquery ids, and budget usage are not available on the
 * retrieval input alone.
 */
export interface CriticSignalProbe {
  /** Graph-aware satisfaction signals derived from the latest result. */
  readonly coverageSignalsFor: (
    result: GraphExecutionResult,
  ) => GraphCoverageSignals;
  /** Retrieval-internal degradation reasons surfaced by the candidate
   *  pool. These are structured categories, not free-form log strings. */
  readonly degradationCodesFor: (
    result: GraphExecutionResult,
  ) => readonly RetrievalDegradationCode[];
}

/**
 * Runs the root retrieval through the candidate pool when the graph
 * does not engage the bundle path. Otherwise, retrieves per subquery
 * and hands off to the bundle selector.
 *
 * ADR-015 Axis 2: when `RETRIEVAL_EXECUTOR_CRITIC=true` AND a
 * `queryRewriter` is wired AND a `criticProbe` is supplied, the
 * retrieval is wrapped in a bounded self-critique loop (hard
 * `CRITIC_RETRY_MAX` type-level cap). The loop terminates on:
 *   - critic `retry=false` (coverage satisfied / cap reached / no signal)
 *   - rewriter returning `null` (no actionable rewrite)
 *   - `CRITIC_RETRY_MAX` iterations without success (exhausted)
 */
export async function executeGraphAware(
  input: HybridRetrievalInput,
  graph: ConstraintGraph | undefined,
  deps: GraphExecutorDeps,
  opts: GraphExecutorOptions,
  criticProbe?: CriticSignalProbe,
): Promise<GraphExecutionResult> {
  // Wave I2: emit unified graph-path telemetry for the graph-executor
  // reader. Recorded once per public invocation so retries inside the
  // critic loop do not double-count.
  recordGraphPathDecision({
    reader: 'graph_executor',
    outcome: classifyGraphPresence({
      graphPresent: graph !== undefined,
      ...(graph !== undefined ? { graphOrigin: graph.origin } : {}),
      graphEmitFlagOn: process.env['CONSTRAINT_GRAPH_EMIT'] !== 'false',
    }),
  });
  const rewriter = deps.queryRewriter;
  if (
    !isRetrievalCriticEnabled()
    || rewriter === undefined
    || criticProbe === undefined
  ) {
    // Pre-PR6 one-shot path — byte-identical to the original PR4
    // behaviour. Flag-off rollback falls through here.
    return runRetrievalOnce(input, graph, deps, opts);
  }

  const rewriteTraces: RewriteTrace[] = [];
  let currentInput = input;
  let lastResult: GraphExecutionResult = await runRetrievalOnce(
    currentInput,
    graph,
    deps,
    opts,
  );

  // CRITIC_RETRY_MAX is a module-scope `const` imported from
  // retrieval-critic.ts. `retryCount` is a local `let`; no mutable
  // reference escapes this function. Pre-flight check (rule 20) —
  // the cap is evaluated BEFORE the retrieval call so we never
  // execute a (CRITIC_RETRY_MAX+1)-th retrieval.
  for (let retryCount = 0; retryCount < CRITIC_RETRY_MAX; retryCount += 1) {
    const remainingLatencyBudgetMs = resolveRemainingLatencyBudgetMs(currentInput);
    if (remainingLatencyBudgetMs !== undefined && remainingLatencyBudgetMs <= 0) {
      pipelineDebug(
        {
          step: 'retrieval.critic.budget_exhausted',
          iterations: rewriteTraces.length,
        },
        'pipeline critic retry budget exhausted',
      );
      return {
        ...lastResult,
        criticRewrites: rewriteTraces,
        criticDegradationReasons: [
          ...(lastResult.criticDegradationReasons ?? []),
          'critic_retry_budget_exhausted',
        ],
      };
    }

    const decision: CriticDecision = decideRetry({
      graph,
      coverage:
        graph !== undefined
          ? computeGraphCoverage(
              graph,
              criticProbe.coverageSignalsFor(lastResult),
            )
          : undefined,
      degradationCodes: criticProbe.degradationCodesFor(lastResult),
      retryCount,
    });

    if (!decision.retry) {
      pipelineDebug(
        {
          step: 'retrieval.critic.decision',
          retry: false,
          reason: decision.reason,
          iterations: retryCount,
        },
        'pipeline critic decision',
      );
      return {
        ...lastResult,
        criticRewrites: rewriteTraces,
      };
    }

    const rewritten = await rewriter.apply(currentInput, decision);
    if (rewritten === null) {
      // No actionable rewrite — break out of the loop. The executor
      // will mark this as exhausted below.
      pipelineDebug(
        {
          step: 'retrieval.critic.rewriter_declined',
          rewrite_type: decision.rewriteType,
          iteration: retryCount,
        },
        'pipeline critic rewriter declined',
      );
      break;
    }

    globalRetrievalCriticCounter.incrementRewrite(decision.rewriteType);
    rewriteTraces.push(rewritten.trace);
    currentInput = rewritten.input;
    // ADR-013 Phase 1c.x: release any prior assignment slots on the
    // ledger BEFORE the retried retrieval runs. Without this step the
    // retry would re-reserve against a ledger that still carries the
    // previous attempt's picks, double-counting the budget and potentially
    // tripping `BudgetViolationError` on an otherwise-legal bundle.
    // The release happens pre-flight (rule 20) so we never execute
    // retrieval with a stale ledger.
    releaseLedgerReservations(deps.budgetLedger, lastResult);
    lastResult = await runRetrievalOnce(currentInput, graph, deps, opts);
  }

  // Retries exhausted (either cap reached with unsatisfied coverage,
  // or rewriter declined). Graceful handoff: last retrieval result +
  // exhaustion signal. The ranker receives whatever candidates were
  // produced by the final attempt.
  globalRetrievalCriticCounter.incrementRetriesExhausted();
  pipelineDebug(
    {
      step: 'retrieval.critic.retries_exhausted',
      iterations: rewriteTraces.length,
    },
    'pipeline critic retries exhausted',
  );
  return {
    ...lastResult,
    criticRewrites: rewriteTraces,
    criticRetriesExhausted: true,
    criticDegradationReasons: [
      ...(lastResult.criticDegradationReasons ?? []),
      'critic_retries_exhausted',
    ],
  };
}

/**
 * Single pass through the graph-aware executor — the pre-PR6 behaviour
 * factored out so the critic loop above can call it multiple times
 * without re-expressing the passthrough / bundle / fail-closed tree.
 */
async function runRetrievalOnce(
  input: HybridRetrievalInput,
  graph: ConstraintGraph | undefined,
  deps: GraphExecutorDeps,
  opts: GraphExecutorOptions,
): Promise<GraphExecutionResult> {
  if (!shouldEngageBundlePath(graph)) {
    const flat = await runRootRetrieval(deps.candidatePool, input);
    return {
      mode: 'passthrough',
      candidates: flat.candidates,
      retrievalTelemetry: flat.telemetry,
    };
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

  // Per-subquery retrieval. The executor snapshots telemetry
  // immediately after each call and aggregates it into the result so
  // downstream readers do not consult shared mutable candidate-pool
  // getters after fan-out.
  const pools = new Map<string, readonly HybridCandidate[]>();
  const telemetryParts: GraphRetrievalTelemetry[] = [];
  if (deps.subqueryRetriever !== undefined) {
    const retriever = deps.subqueryRetriever;
    if (retriever.stateIsolation === 'isolated') {
      const rawResults = await Promise.all(
        subqueries.map(async (sq) => retriever.retrieve(input, sq, engagedGraph)),
      );
      for (let i = 0; i < subqueries.length; i += 1) {
        const sq = subqueries[i];
        const result = normalizeSubqueryRetrievalResult(rawResults[i]);
        if (sq === undefined) continue;
        pools.set(sq.nodeId, result.candidates);
        telemetryParts.push(result.telemetry);
      }
    } else {
      for (const sq of subqueries) {
        const result = normalizeSubqueryRetrievalResult(
          await retriever.retrieve(input, sq, engagedGraph),
        );
        pools.set(sq.nodeId, result.candidates);
        telemetryParts.push(result.telemetry);
      }
    }
  } else {
    const fallback = await runRootRetrieval(deps.candidatePool, input);
    for (const sq of subqueries) pools.set(sq.nodeId, fallback.candidates);
    telemetryParts.push(fallback.telemetry);
  }
  const retrievalTelemetry = mergeGraphRetrievalTelemetry(telemetryParts);

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
      retrievalTelemetry,
    };
  }

  // Post-assignment reservation — the P1-C fix call-site.
  //
  // ADR-013 Phase 1c.x: prefer the concrete budget ledger when wired;
  // fall through to the deprecated callback for legacy test seams.
  // When both are present the ledger commits first and the callback
  // is still invoked for parity so pre-migration fixture assertions
  // keep working. A ledger `reserve` violation surfaces as a
  // fail-closed result with the `bundle_selector_fail_closed:budget_infeasible`
  // reason — we do NOT silently swallow the violation.
  const ledger = deps.budgetLedger;
  // TODO(cleanup): remove after pre-PR4 test suites migrate to the
  // ledger dep. Reading the deprecated callback here is the migration
  // fallback — parity invocation so existing fixture assertions keep
  // working until they switch over.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- migration fallback per CLAUDE.md rule 31
  const callback = opts.onReserveAssignment;
  if (ledger !== undefined || callback !== undefined) {
    const reservedIds = new Set<string>();
    try {
      for (const a of solution.assignments) {
        const reservationKey = `${a.subqueryId}:${a.candidate.entityId}`;
        if (ledger !== undefined) {
          ledger.reserve(a.subqueryId, a.candidate);
          reservedIds.add(reservationKey);
        }
        if (callback !== undefined) {
          callback({ subqueryId: a.subqueryId, candidate: a.candidate });
          if (ledger === undefined) {
            reservedIds.add(reservationKey);
          }
        }
      }
    } catch (err) {
      // Roll back any reservations we already committed on this
      // assignment so the ledger state always matches the executor's
      // reported outcome, even when the legacy callback throws.
      if (ledger !== undefined) {
        for (const a of solution.assignments) {
          if (reservedIds.has(`${a.subqueryId}:${a.candidate.entityId}`)) {
            ledger.release(a.subqueryId);
          }
        }
      }
      if (err instanceof BudgetViolationError) {
        pipelineDebug(
          {
            step: 'retrieval.bundle_selector.budget_violation',
            entity_id: err.entityId,
            would_become_krw: err.wouldBecomeKrw,
            ceiling_krw: err.ceilingKrw,
          },
          'pipeline bundle selector budget violation',
        );
        globalBundleSelectorCounter.increment('BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT');
        return {
          mode: 'fail_closed',
          candidates: [],
          assignmentSolution: {
            ...solution,
            assignments: [],
            bundleScore: 0,
            degradationReasons: ['bundle_selector_fail_closed:budget_infeasible'],
          },
          retrievalTelemetry,
        };
      }
      throw err;
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
    retrievalTelemetry,
  };
}

async function runRootRetrieval(
  candidatePool: CandidatePoolPort,
  input: HybridRetrievalInput,
): Promise<SubqueryRetrievalResult> {
  const candidates = candidatePool.execute !== undefined
    ? await candidatePool.execute(input)
    : await candidatePool.generate(input);
  return {
    candidates,
    telemetry: snapshotCandidatePoolTelemetry(candidatePool),
  };
}

function snapshotCandidatePoolTelemetry(
  candidatePool: CandidatePoolPort,
): GraphRetrievalTelemetry {
  const degradationCodes = candidatePool.getLastDegradationCodes?.() ?? [];
  const degradationSignals = candidatePool.getLastDegradationSignals?.() ?? [];
  const fusionTrace = candidatePool.getLastFusionTrace?.();
  const dropLog = candidatePool.getLastDropLog?.();
  return {
    degradationCodes: [...degradationCodes],
    degradationSignals: [...degradationSignals],
    ...(fusionTrace !== undefined ? { fusionTrace } : {}),
    ...(dropLog !== undefined ? { dropLog: [...dropLog] } : {}),
  };
}

function mergeGraphRetrievalTelemetry(
  parts: readonly GraphRetrievalTelemetry[],
): GraphRetrievalTelemetry {
  const degradationCodes = new Set<RetrievalDegradationCode>();
  const degradationSignals: RetrievalDegradationSignal[] = [];
  const dropLog: CandidateDropRecord[] = [];
  let fusionTrace: RrfFusionTrace | undefined;

  for (const part of parts) {
    for (const code of part.degradationCodes) degradationCodes.add(code);
    degradationSignals.push(...part.degradationSignals);
    if (part.dropLog !== undefined) dropLog.push(...part.dropLog);
    if (parts.length === 1 && part.fusionTrace !== undefined) {
      fusionTrace = part.fusionTrace;
    }
  }

  return {
    degradationCodes: [...degradationCodes],
    degradationSignals,
    ...(fusionTrace !== undefined ? { fusionTrace } : {}),
    ...(dropLog.length > 0 ? { dropLog } : {}),
  };
}

function normalizeSubqueryRetrievalResult(
  result: readonly HybridCandidate[] | SubqueryRetrievalResult | undefined,
): SubqueryRetrievalResult {
  if (!isSubqueryRetrievalResult(result)) {
    return {
      candidates: result ?? [],
      telemetry: {
        degradationCodes: [],
        degradationSignals: [],
      },
    };
  }
  return result;
}

function isSubqueryRetrievalResult(
  result: readonly HybridCandidate[] | SubqueryRetrievalResult | undefined,
): result is SubqueryRetrievalResult {
  return result !== undefined && !Array.isArray(result);
}

/**
 * ADR-013 Phase 1c.x: release every ledger slot the previous
 * retrieval result reserved, so a critic retry can start from a clean
 * ledger state. No-op when the ledger is unwired or when the prior
 * result did not engage the bundle path.
 */
function releaseLedgerReservations(
  ledger: BudgetLedger | undefined,
  prior: GraphExecutionResult,
): void {
  if (ledger === undefined) return;
  if (prior.mode !== 'bundle') return;
  const assignments = prior.assignmentSolution?.assignments ?? [];
  for (const a of assignments) {
    ledger.release(a.subqueryId);
  }
}
