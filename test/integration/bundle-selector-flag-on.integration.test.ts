/**
 * ADR-013 Phase 1c — BundleSelector flag-on integration lock (Wave B1).
 *
 * Background
 * ──────────
 * The `BUNDLE_SELECTOR_ENABLED` env flag gates the PR4 BundleSelector
 * path at `src/application/search/search-usecase-graph-executor.ts`.
 * Default off — the selector code exists and is unit-tested but was
 * NEVER exercised end-to-end with a real {@link InMemoryBudgetLedger}
 * wired into {@link GraphExecutorDeps}. This integration test closes
 * that gap with deterministic fake candidates (no real Vespa, no real
 * LLM) so the flag-on path cannot silently regress.
 *
 * What this locks (invariant summary per case)
 * ────────────────────────────────────────────
 * Flag-on, 2 subqueries:
 *   1. `executeGraphAware` returns `mode === 'bundle'`
 *      — proves the selector path was taken, not the passthrough.
 *   2. `AssignmentSolution.assignments.length === 2`
 *      — one winning candidate per subquery (structural K lock).
 *   3. `InMemoryBudgetLedger.snapshot().reservations.size === 2`
 *      — only winning candidates are reserved, not the whole pool.
 *   4. `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT === 0`
 *      — locks P1-C: unselected candidates never burn budget.
 *   5. Assignment consistency: each winning candidate's `entityId`
 *      came from the matching subquery's fake pool (no cross-talk).
 *   6. `BUDGET_LEDGER_RESERVE_SUCCESS === 2`
 *      — the concrete ledger path (not the callback seam) fired.
 * Flag-off, same graph:
 *   7. `mode === 'passthrough'`, ledger receives zero reserve() calls
 *      — the fallback path is byte-identical to pre-PR4 behaviour.
 * K boundary (off-by-one guard):
 *   8a. K=5 (== K_EXACT_LIMIT) still solves, produces 5 reservations,
 *       and the K_EXCEEDS counter stays at 0.
 *   8b. K=6 fail-closes: `mode === 'fail_closed'`, degradationReasons
 *       carries `'bundle_selector_fail_closed:k_exceeds_exact_limit'`,
 *       `BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT === 1`, ledger
 *       untouched.
 *
 * This test MUST use a real {@link InMemoryBudgetLedger} (NOT a mock)
 * and the real {@link BundleSelectorImpl} (NOT a mock). Only the
 * `candidatePool` port and the per-subquery retriever are faked.
 *
 * Never delete this file — it is an append-only regression lock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeGraphAware,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
  type SubqueryRetriever,
} from '../../src/application/search/search-usecase-graph-executor.js';
import { BundleSelectorImpl } from '../../src/domain/retrieval/service/bundle-selector.js';
import { InMemoryBudgetLedger } from '../../src/domain/retrieval/service/budget-ledger.js';
import { globalBundleSelectorCounter } from '../../src/observability/bundle-selector-counters.js';
import { globalBudgetLedgerCounter } from '../../src/observability/budget-ledger-counters.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { CandidatePoolPort } from '../../src/application/search/port/search-pipeline-deps.port.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * Minimum-viable HybridCandidate. The bundle-selector path only reads
 * `entityId` (for distinct-column keying) and `priceUsd` (for the
 * ledger's KRW conversion); the rest of the interface is opaque to
 * this test. We construct a bare object and cast through `unknown`
 * because the full shape requires fields (retrievalTrace, etc.) that
 * are orthogonal to the flag-on invariant being locked.
 */
function mkCandidate(id: string, priceUsd?: number): HybridCandidate {
  return {
    entityId: id as never,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    retrievalTrace: {
      retrievalProfile: 'test',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    matchedConstraints: [],
  } as unknown as HybridCandidate;
}

/** Retrieval input is passed through to the fakes verbatim — no real
 *  retrieval is performed, so the shape only needs to type-check. */
const stubInput = {
  queryPlan: {} as never,
  route: 'hybrid',
  lexicalQueries: [],
  semanticQueries: [],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

/**
 * Build a hybrid-origin graph with `sqCount` subquery nodes. Each
 * subquery carries a distinct `purpose` tag so assignment-consistency
 * checks can verify the solver did not swap pools across slots.
 */
function hybridGraph(sqCount: number): ConstraintGraph {
  const subqueries: SubqueryNode[] = [];
  for (let i = 0; i < sqCount; i += 1) {
    subqueries.push({
      kind: 'subquery',
      nodeId: `sq_${i}`,
      purpose: `purpose_${i}`,
      targetCardinality: 1,
    });
  }
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      {
        kind: 'group_and',
        nodeId: 'root',
        children: subqueries.map((s) => s.nodeId),
      },
      ...subqueries,
    ],
    edges: [],
    globalBudgets: {},
  };
}

/**
 * Fake CandidatePoolPort. Tracks whether `execute()` was called so
 * flag-off and flag-on tests can assert the correct path was taken.
 * Returns a deterministic placeholder pool on the passthrough branch.
 */
function mkCandidatePool(): CandidatePoolPort & { executeCallCount: number } {
  const state = {
    executeCallCount: 0,
    execute: async () => {
      state.executeCallCount += 1;
      // Passthrough pool — consumed only when BUNDLE_SELECTOR_ENABLED
      // is off (or the graph is trivial). Flag-on path ignores it
      // entirely and goes through the subqueryRetriever instead.
      return [mkCandidate('passthrough:w0')];
    },
    generate: async () => [mkCandidate('generate:w0')],
  };
  return state as unknown as CandidatePoolPort & { executeCallCount: number };
}

/**
 * Per-subquery retriever that returns 3 deterministic candidates
 * scoped to the subquery's nodeId. The solver picks exactly 1 per
 * row; the remaining 2 must never reserve budget. Candidates carry a
 * cheap $10 price so the ledger KRW conversion exercises its
 * `priceUsd` path without risking a ceiling violation.
 */
const subqueryRetriever: SubqueryRetriever = {
  retrieve: async (_base, sq) => [
    mkCandidate(`${sq.nodeId}:w1`, 10),
    mkCandidate(`${sq.nodeId}:w2`, 10),
    mkCandidate(`${sq.nodeId}:w3`, 10),
  ],
};

/**
 * Scorer that prefers the first candidate in every subquery pool
 * (local index 0 → highest score). Combined with the lex tie-break
 * rule in the exact solver, this gives a single unique optimum whose
 * assignments are deterministic across runs: every subquery picks its
 * own `:w1` candidate.
 */
const preferFirstScorer: GraphExecutorOptions['scoreFor'] = ({ colIdx }) =>
  colIdx === 0 ? 10 : 1;

const zeroPricer: GraphExecutorOptions['priceFor'] = () => 0;

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('BundleSelector flag-on integration (ADR-013 Phase 1c.x + Wave B1)', () => {
  beforeEach(() => {
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
  });

  afterEach(() => {
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
  });

  describe('flag ON: selector engages and ledger reserves only winners', () => {
    beforeEach(() => {
      process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    });

    it('takes the bundle path (not passthrough) on a 2-subquery hybrid graph', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(2),
        deps,
        opts,
      );

      // Case 1 lock: executor took the selector path, NOT passthrough.
      expect(result.mode).toBe('bundle');
      // candidatePool.execute() is NOT called on the bundle path — the
      // subquery retriever fans out directly from the executor.
      expect(candidatePool.executeCallCount).toBe(0);
    });

    it('returns one assignment per subquery (K=2 structural lock)', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(2),
        deps,
        opts,
      );

      // Case 2 lock: AssignmentSolution carries exactly K=2 winners.
      // (`assignments` is a readonly array — task spec says `.size`
      //  but the type is `readonly BundleAssignment[]`; `.length` is
      //  the semantic equivalent.)
      expect(result.assignmentSolution).toBeDefined();
      expect(result.assignmentSolution?.assignments.length).toBe(2);
      // Flat candidate list matches the assignment winners.
      expect(result.candidates.length).toBe(2);
    });

    it('ledger snapshot holds exactly 2 reservations keyed by subquery id', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      await executeGraphAware(stubInput, hybridGraph(2), deps, opts);

      // Case 3 lock: only the winning candidates reserved — 9 pool
      // members total, 2 winners, 2 reservations.
      const snapshot = ledger.snapshot();
      expect(snapshot.reservations.size).toBe(2);
      expect(snapshot.candidateCount).toBe(2);
      // Keys are the subquery nodeIds, not the candidate entityIds.
      expect([...snapshot.reservations.keys()].sort()).toEqual([
        'sq_0',
        'sq_1',
      ]);
      // Case 6 lock: the concrete ledger path fired (not the legacy
      // `onReserveAssignment` callback seam). Counter increments are
      // the ledger's own observability.
      expect(
        globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
      ).toBe(2);
      expect(
        globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_VIOLATION,
      ).toBe(0);
    });

    it('unselected candidates NEVER reserve budget (P1-C lock)', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      await executeGraphAware(stubInput, hybridGraph(2), deps, opts);

      // Case 4 lock: P1-C invariant — the defensive counter that
      // measures reserve() calls for non-assigned candidates stays at 0.
      expect(
        globalBundleSelectorCounter.snapshot()
          .BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT,
      ).toBe(0);
      // The pool held 3 candidates per subquery × 2 subqueries = 6.
      // Only 2 are reserved. The other 4 must be absent from the
      // ledger snapshot entirely.
      const snapshot = ledger.snapshot();
      const reservedEntityIds = new Set(
        [...snapshot.reservations.values()].map((r) => r.entityId),
      );
      for (const unselected of [
        'sq_0:w2',
        'sq_0:w3',
        'sq_1:w2',
        'sq_1:w3',
      ]) {
        expect(reservedEntityIds.has(unselected)).toBe(false);
      }
    });

    it('each winning entity id comes from its own subquery pool (no cross-talk)', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(2),
        deps,
        opts,
      );

      // Case 5 lock: assignment consistency. Each winning candidate's
      // entityId must be prefixed by the subqueryId that won it — the
      // mkCandidate fakes encode the source pool in the entityId.
      expect(result.assignmentSolution).toBeDefined();
      const byRow = new Map<string, string>();
      for (const a of result.assignmentSolution?.assignments ?? []) {
        byRow.set(a.subqueryId, String(a.candidate.entityId));
      }
      expect(byRow.get('sq_0')).toBe('sq_0:w1');
      expect(byRow.get('sq_1')).toBe('sq_1:w1');
      // Ledger reservation keys align with the assignment map.
      const snapshot = ledger.snapshot();
      expect(snapshot.reservations.get('sq_0')?.entityId).toBe('sq_0:w1');
      expect(snapshot.reservations.get('sq_1')?.entityId).toBe('sq_1:w1');
    });
  });

  describe('flag OFF: passthrough leaves the ledger untouched', () => {
    // Default is now ON; force the explicit rollback token.
    beforeEach(() => {
      process.env['BUNDLE_SELECTOR_ENABLED'] = 'false';
    });

    afterEach(() => {
      delete process.env['BUNDLE_SELECTOR_ENABLED'];
    });

    it('takes the passthrough path, never invokes the selector, never reserves', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(2),
        deps,
        opts,
      );

      // Case 7 lock: flag-off = byte-identical passthrough. The
      // executor calls `candidatePool.execute` exactly once and the
      // ledger stays empty because the reserve loop never runs.
      expect(result.mode).toBe('passthrough');
      expect(candidatePool.executeCallCount).toBe(1);
      expect(result.assignmentSolution).toBeUndefined();
      expect(ledger.snapshot().reservations.size).toBe(0);
      expect(ledger.snapshot().candidateCount).toBe(0);
      expect(
        globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
      ).toBe(0);
      // Selector counters stay untouched — no engagement, no signal.
      expect(
        globalBundleSelectorCounter.snapshot()
          .BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT,
      ).toBe(0);
    });
  });

  describe('K boundary: K=5 still solves, K=6 fail-closes (off-by-one lock)', () => {
    beforeEach(() => {
      process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    });

    it('K=5 is within K_EXACT_LIMIT and produces 5 reservations', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(5),
        deps,
        opts,
      );

      // Boundary lock: K=5 == K_EXACT_LIMIT. The solver must still
      // succeed (120-permutation brute-force is within scope) and the
      // ledger must hold exactly 5 reservations. This case guards the
      // off-by-one cliff next to the K=6 fail-closed case below — if
      // a future refactor flips `>` to `>=`, the K=5 case trips first.
      expect(result.mode).toBe('bundle');
      expect(result.assignmentSolution?.assignments.length).toBe(5);
      expect(ledger.snapshot().reservations.size).toBe(5);
      expect(
        globalBundleSelectorCounter.snapshot()
          .BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT,
      ).toBe(0);
      expect(
        globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
      ).toBe(5);
    });

    it('surfaces k_exceeds_exact_limit degradation + leaves the ledger empty', async () => {
      const candidatePool = mkCandidatePool();
      const ledger = new InMemoryBudgetLedger();
      const deps: GraphExecutorDeps = {
        candidatePool,
        bundleSelector: new BundleSelectorImpl(),
        subqueryRetriever,
        budgetLedger: ledger,
      };
      const opts: GraphExecutorOptions = {
        scoreFor: preferFirstScorer,
        priceFor: zeroPricer,
      };

      const result = await executeGraphAware(
        stubInput,
        hybridGraph(6),
        deps,
        opts,
      );

      // Case 8 lock: the bundle selector fail-closes at K>5 per
      // ADR-013 heuristic policy and the counter increments exactly
      // once. The ledger reserve loop is bypassed because the
      // executor returns `fail_closed` before reaching it.
      expect(result.mode).toBe('fail_closed');
      expect(result.candidates.length).toBe(0);
      expect(result.assignmentSolution?.degradationReasons).toContain(
        'bundle_selector_fail_closed:k_exceeds_exact_limit',
      );
      expect(
        globalBundleSelectorCounter.snapshot()
          .BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT,
      ).toBe(1);
      expect(ledger.snapshot().reservations.size).toBe(0);
      expect(
        globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
      ).toBe(0);
    });
  });
});
