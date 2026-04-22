/**
 * ADR-013 Phase 1c.x: graph executor ↔ BudgetLedger integration.
 *
 * Locks the wiring between `executeGraphAware` and the per-request
 * `InMemoryBudgetLedger`. This is the integration surface that
 * replaces PR4's `onReserveAssignment` callback stub. Key invariants:
 *
 *   - `ledger.reserve` is called exactly once per winning assignment.
 *   - Unselected pool candidates never touch the ledger.
 *   - `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT` stays at 0
 *     post-run (the P1-C verification).
 *   - Critic-retry path releases prior slots BEFORE re-running
 *     retrieval (otherwise the retry double-counts).
 *   - A ledger violation surfaces as fail-closed `budget_infeasible`.
 *
 * Never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeGraphAware,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
  type SubqueryRetriever,
} from '../../src/application/search/search-usecase-graph-executor.js';
import { BundleSelectorImpl } from '../../src/domain/retrieval/service/bundle-selector.js';
import {
  InMemoryBudgetLedger,
} from '../../src/domain/retrieval/service/budget-ledger.js';
import { globalBundleSelectorCounter } from '../../src/observability/bundle-selector-counters.js';
import { globalBudgetLedgerCounter } from '../../src/observability/budget-ledger-counters.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { CandidatePoolPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import { KRW_PER_USD_APPROXIMATE } from '../../src/domain/shared/constants.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';

function mkCandidate(id: string, priceUsd?: number): HybridCandidate {
  return makeHybridCandidate({
    entityId: createEntityId(id),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
  });
}

const stubInput = {
  queryPlan: {} as never,
  route: 'hybrid',
  lexicalQueries: [],
  semanticQueries: [],
  hardConstraints: [],
  softConstraints: [],
} as unknown as HybridRetrievalInput;

function hybridGraph(sqCount: number): ConstraintGraph {
  const subqueries: SubqueryNode[] = [];
  for (let i = 0; i < sqCount; i += 1) {
    subqueries.push({
      kind: 'subquery',
      nodeId: `sq_${i}`,
      purpose: `p_${i}`,
      targetCardinality: 1,
    });
  }
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: subqueries.map((s) => s.nodeId) },
      ...subqueries,
    ],
    edges: [],
    globalBudgets: {},
  };
}

const candidatePool: CandidatePoolPort = {
  execute: async () => [],
  generate: async () => [],
};

describe('graph executor ↔ BudgetLedger integration (ADR-013 P1-C.x)', () => {
  beforeEach(() => {
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
  });
  afterEach(() => {
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
    delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
  });

  it('ledger.reserve fires exactly once per winning slot — not per pool candidate', async () => {
    const ledger = new InMemoryBudgetLedger();
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [
        mkCandidate(`${sq.nodeId}:w1`, 30),
        mkCandidate(`${sq.nodeId}:w2`, 80),
        mkCandidate(`${sq.nodeId}:w3`, 200),
      ],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: ({ colIdx }) => (colIdx === 0 ? 10 : 1),
      priceFor: () => 0,
    };
    const r = await executeGraphAware(stubInput, hybridGraph(3), deps, opts);
    expect(r.mode).toBe('bundle');
    // 3 subqueries, 9 pool candidates, 3 winners. The ledger should
    // carry exactly 3 reservations — NOT 9.
    const snap = ledger.snapshot();
    expect(snap.candidateCount).toBe(3);
    // And each winning slot holds the `w1` entity because `scoreFor`
    // prefers colIdx=0.
    for (const [key, record] of snap.reservations) {
      expect(record.entityId).toBe(`${key}:w1`);
    }
    // P1-C verification: the unselected-reserved counter is still 0.
    expect(
      globalBundleSelectorCounter.snapshot()
        .BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT,
    ).toBe(0);
    // Success counter tracked exactly the committed reservations.
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
    ).toBe(3);
  });

  it('ledger is never mutated on fail-closed (empty slot pool)', async () => {
    const ledger = new InMemoryBudgetLedger();
    const emptyRetriever: SubqueryRetriever = { retrieve: async () => [] };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever: emptyRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = { scoreFor: () => 1, priceFor: () => 0 };
    const r = await executeGraphAware(stubInput, hybridGraph(2), deps, opts);
    expect(r.mode).toBe('fail_closed');
    expect(ledger.snapshot().candidateCount).toBe(0);
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_SUCCESS,
    ).toBe(0);
  });

  it('both ledger + callback: ledger wins, callback also invoked for parity', async () => {
    const ledger = new InMemoryBudgetLedger();
    const callbackSeen: string[] = [];
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [mkCandidate(`${sq.nodeId}:w1`, 25)],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        callbackSeen.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    await executeGraphAware(stubInput, hybridGraph(2), deps, opts);
    // Callback parity: every ledger reservation is also seen by the
    // callback (legacy test-seam).
    expect(callbackSeen).toHaveLength(2);
    expect(ledger.snapshot().candidateCount).toBe(2);
  });

  it('callback throw rolls back prior ledger reservations before rethrowing', async () => {
    const ledger = new InMemoryBudgetLedger();
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [mkCandidate(`${sq.nodeId}:w1`, 25)],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId }) => {
        if (subqueryId === 'sq_1') {
          throw new Error('legacy callback exploded');
        }
      },
    };

    await expect(
      executeGraphAware(stubInput, hybridGraph(2), deps, opts),
    ).rejects.toThrow('legacy callback exploded');
    expect(ledger.snapshot().candidateCount).toBe(0);
  });

  it('ledger violation surfaces as fail_closed budget_infeasible and rolls back reservations', async () => {
    // Ceiling = 50 000 KRW ≈ 37 USD at the SSoT FX. Three w1 picks
    // at 20 USD each would accumulate to 81 000 KRW > 50 000 and
    // trip the violation on the second or third reserve.
    const ledger = new InMemoryBudgetLedger({ priceTotalKrw: 50_000 });
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [mkCandidate(`${sq.nodeId}:w1`, 20)],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = { scoreFor: () => 1, priceFor: () => 0 };
    const r = await executeGraphAware(stubInput, hybridGraph(3), deps, opts);
    expect(r.mode).toBe('fail_closed');
    expect(
      r.assignmentSolution?.degradationReasons.includes(
        'bundle_selector_fail_closed:budget_infeasible',
      ),
    ).toBe(true);
    // Rollback: any reservations committed pre-violation must be
    // released, leaving the ledger empty.
    expect(ledger.snapshot().candidateCount).toBe(0);
    // Violation counter ticked once for the rejected reservation.
    expect(
      globalBudgetLedgerCounter.snapshot().BUDGET_LEDGER_RESERVE_VIOLATION,
    ).toBeGreaterThan(0);
  });

  it('ledger stays at 0 reservations on pass-through (single-subquery graph)', async () => {
    const ledger = new InMemoryBudgetLedger();
    const deps: GraphExecutorDeps = {
      candidatePool: {
        ...candidatePool,
        execute: async () => [mkCandidate('flat:w1', 100)],
      },
      bundleSelector: new BundleSelectorImpl(),
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = { scoreFor: () => 1, priceFor: () => 0 };
    // Single-subquery graph should NOT engage the bundle path; the
    // ledger must remain untouched.
    const r = await executeGraphAware(stubInput, hybridGraph(1), deps, opts);
    expect(r.mode).toBe('passthrough');
    expect(ledger.snapshot().candidateCount).toBe(0);
  });

  it('critic retry releases prior ledger slots BEFORE re-running retrieval', async () => {
    // Setup: enable the critic loop with a stub that always requests
    // a retry until the cap, then validate the ledger never accumulates
    // stale reservations across iterations.
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'true';
    const ledger = new InMemoryBudgetLedger();
    const ledgerMaxSeenBetweenIterations: number[] = [];

    let iteration = 0;
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => {
        // Record the ledger size BEFORE this retriever commits — the
        // executor should have released prior reservations before the
        // retry-retrieval runs. On the first iteration the ledger is
        // empty; on subsequent iterations it should still be empty
        // because `release()` is called pre-flight.
        ledgerMaxSeenBetweenIterations.push(ledger.snapshot().candidateCount);
        iteration += 1;
        return [mkCandidate(`${sq.nodeId}:w${iteration}`, 10)];
      },
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
      queryRewriter: {
        apply: async (input, _decision) => ({
          input,
          trace: {
            rewriteType: 'relax',
            subqueryId: 'sq_0',
            relaxedAttributes: [],
          },
        }),
      },
    };
    const opts: GraphExecutorOptions = { scoreFor: () => 1, priceFor: () => 0 };
    await executeGraphAware(
      stubInput,
      hybridGraph(2),
      deps,
      opts,
      {
        // Stub probe: always report unsatisfied coverage so the critic
        // recommends a retry until the cap.
        coverageSignalsFor: () => ({
          satisfiedAttributes: new Set(),
        }),
        degradationCodesFor: () => ['no_matches'],
      },
    );
    // Pre-flight release contract: every retriever invocation saw an
    // empty ledger. Without the release, iteration >= 1 would see the
    // prior iteration's reservations.
    for (const seen of ledgerMaxSeenBetweenIterations) {
      expect(seen).toBe(0);
    }
  });

  it('USD priced candidates convert to KRW via the SSoT FX constant', async () => {
    const ledger = new InMemoryBudgetLedger();
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [mkCandidate(`${sq.nodeId}:w1`, 100)],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      budgetLedger: ledger,
    };
    const opts: GraphExecutorOptions = { scoreFor: () => 1, priceFor: () => 0 };
    await executeGraphAware(stubInput, hybridGraph(2), deps, opts);
    // 2 × 100 USD → 2 × KRW_PER_USD_APPROXIMATE.
    expect(ledger.snapshot().priceTotalKrw).toBe(2 * 100 * KRW_PER_USD_APPROXIMATE);
  });

  it('no ledger supplied: executor falls through to callback-only path (backwards compat)', async () => {
    const reservedViaCallback: string[] = [];
    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => [mkCandidate(`${sq.nodeId}:w1`)],
    };
    const deps: GraphExecutorDeps = {
      candidatePool,
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
    };
    const opts: GraphExecutorOptions = {
      scoreFor: () => 1,
      priceFor: () => 0,
      onReserveAssignment: ({ subqueryId, candidate }) => {
        reservedViaCallback.push(`${subqueryId}:${String(candidate.entityId)}`);
      },
    };
    const r = await executeGraphAware(stubInput, hybridGraph(2), deps, opts);
    expect(r.mode).toBe('bundle');
    expect(reservedViaCallback).toHaveLength(2);
    // Unselected-reserved counter stays 0 under the legacy path.
    expect(
      globalBundleSelectorCounter.snapshot()
        .BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT,
    ).toBe(0);
  });
});
