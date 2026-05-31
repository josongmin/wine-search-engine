/**
 * Wave B2 — ADR-015 Axis 2: retrieval critic flag-on integration lock.
 *
 * End-to-end proof that `RETRIEVAL_EXECUTOR_CRITIC=true` exercises the full
 * executor-internal self-critique loop with real services (critic +
 * rewriter + budget ledger), faking only the `CandidatePoolPort`. The
 * scenarios here complement the narrow regression tests under
 * `test/regression/retrieval-critic-*` by driving the full
 * `executeGraphAware` call surface with a realistic retriever stub and a
 * live `InMemoryBudgetLedger`.
 *
 * Invariants locked:
 *
 *   1. Flag-on happy path retries exactly once when the first retrieval
 *      returns an empty pool and the second satisfies coverage; the
 *      trace carries a single `rewriteType: 'relax'` entry and the
 *      exhaustion counter stays at zero.
 *   2. Flag-on exhausted path: `CRITIC_RETRY_MAX` rewrites + one extra
 *      retrieval call, `criticRetriesExhausted === true`, and the
 *      `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT` counter ticks exactly
 *      once.
 *   3. Flag-off preserves the byte-identical pre-PR6 one-shot path:
 *      exactly one retrieval call, `criticRewrites === undefined`, no
 *      critic counters move.
 *   4. `CRITIC_RETRY_MAX === 3` at module-load time (type-level lock) —
 *      catches any future PR that tries to env-drive the cap.
 *   5. `ToolCallEvidenceFrame.observationHash` depends on `retryCount`
 *      even when the `observationSnapshot` is byte-identical — the v1.1
 *      schema invariant that keeps retries from colliding.
 *   6. Critic retry on the bundle path releases the budget ledger slots
 *      BEFORE the retried retrieval runs (no stale reservations across
 *      iterations).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeGraphAware,
  type CriticSignalProbe,
  type GraphExecutorDeps,
  type GraphExecutorOptions,
  type SubqueryRetriever,
} from '../../src/application/search/search-usecase-graph-executor.js';
import {
  CRITIC_RETRY_MAX,
} from '../../src/domain/retrieval/service/retrieval-critic.js';
import { createQueryRewriter } from '../../src/domain/retrieval/service/query-rewriter.js';
import { BundleSelectorImpl } from '../../src/domain/retrieval/service/bundle-selector.js';
import { InMemoryBudgetLedger } from '../../src/domain/retrieval/service/budget-ledger.js';
import { globalRetrievalCriticCounter } from '../../src/domain/observability/retrieval-critic-counters.js';
import { globalBundleSelectorCounter } from '../../src/domain/observability/bundle-selector-counters.js';
import { globalBudgetLedgerCounter } from '../../src/domain/observability/budget-ledger-counters.js';
import { buildToolCallEvidenceFrame } from '../../src/domain/agent/service/build-tool-call-evidence-frame.js';
import type { CandidatePoolPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type {
  ConstraintGraph,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type {
  NormalizedConstraint,
  ConstraintBundle,
  CanonicalEntityId,
} from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';

// ─── Fixture builders ───────────────────────────────────────────────────────

/**
 * Constraint bundle with one floor attribute (`color`) that survives
 * relaxation plus one relaxable attribute (`region`) that `relaxOneStep`
 * will remove in the first iteration. This is the minimum shape that
 * lets the real rewriter produce a `relax` result instead of declining.
 */
function mkRelaxableBundle(): ConstraintBundle {
  const color: NormalizedConstraint = {
    attribute: 'color',
    operator: '=',
    value: 'red',
    source_phrase: 'red',
    confidence: 0.95,
  };
  const region: NormalizedConstraint = {
    attribute: 'region',
    operator: '=',
    value: 'Napa Valley',
    source_phrase: 'napa',
    confidence: 0.9,
  };
  return { hard: [color, region], soft: [], inferred: [] };
}

function mkQueryPlan(bundle: ConstraintBundle): QueryPlanV1 {
  return {
    rawQuery: 'red napa',
    normalizedQuery: 'red napa',
    constraints: bundle,
    anchors: [],
    expansions: { fuzzyEntityHypotheses: [] },
  } as unknown as QueryPlanV1;
}

function mkRetrievalInput(): HybridRetrievalInput {
  const bundle = mkRelaxableBundle();
  const plan = mkQueryPlan(bundle);
  return {
    queryPlan: plan,
    route: 'hybrid',
    lexicalQueries: ['red'],
    semanticQueries: ['red napa cabernet'],
    hardConstraints: bundle.hard,
    softConstraints: bundle.soft,
  } as unknown as HybridRetrievalInput;
}

function mkCandidate(id: string, priceUsd?: number): HybridCandidate {
  const entityId: CanonicalEntityId = createEntityId(id);
  return makeHybridCandidate({
    entityId,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    retrievalTrace: {
      retrievalProfile: 'retrieval-critic-it',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    matchedConstraints: [],
  });
}

/**
 * Trivial (non-bundle) graph whose `slot_a` → `color` node carries the
 * single attribute the probe is expected to (un)satisfy. The coverage
 * computer treats this as a one-slot AND group — perfect for forcing
 * critic decisions based on a single signal.
 */
function trivialGraphWithColorSlot(): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: 'root',
    nodes: [
      { kind: 'group_and', nodeId: 'root', children: ['slot_a'] },
      {
        kind: 'slot',
        nodeId: 'slot_a',
        atomRef: '0',
        attribute: 'color',
        operator: '=',
        value: 'red',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
    ],
    edges: [],
    globalBudgets: {},
  } as unknown as ConstraintGraph;
}

/**
 * Hybrid graph with `sqCount` subqueries AND a single `color` slot
 * hanging off the root `group_and`. The slot lets the coverage computer
 * return an unsatisfied signal (when the probe returns an empty
 * satisfiedAttributes set) so the critic can decide to retry — a pure
 * subquery-only graph would evaluate to trivially satisfied and
 * short-circuit the loop.
 */
function hybridGraphWithColorSlot(sqCount: number): ConstraintGraph {
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
      {
        kind: 'group_and',
        nodeId: 'root',
        children: ['slot_a', ...subqueries.map((s) => s.nodeId)],
      },
      {
        kind: 'slot',
        nodeId: 'slot_a',
        atomRef: '0',
        attribute: 'color',
        operator: '=',
        value: 'red',
        sourceTier: 'hard',
        sourceKind: 'explicit_utterance',
        confidence: 1,
      },
      ...subqueries,
    ],
    edges: [],
    globalBudgets: {},
  } as unknown as ConstraintGraph;
}

const noOpOpts: GraphExecutorOptions = {
  scoreFor: () => 1,
  priceFor: () => 0,
};

/**
 * Probe factory: first call reports unsatisfied coverage (coverageRatio=0),
 * subsequent calls report coverage satisfied. Degradation reasons are
 * intentionally left empty so the critic's `no_matches_expand_synonym`
 * branch does not fire — the test wants the deterministic `relax` branch
 * (row 3: zero coverage → relax).
 *
 * NOTE: the executor invokes the probe ONCE per retrieval (inside the
 * loop). The counter below maps iteration → signal so the flag-on
 * happy-path test terminates after exactly one retry.
 */
function coverageAfterNCallsProbe(satisfiedAfter: number): CriticSignalProbe {
  let callCount = 0;
  return {
    coverageSignalsFor: () => {
      const satisfied = callCount >= satisfiedAfter ? new Set(['color']) : new Set<string>();
      callCount += 1;
      return { satisfiedAttributes: satisfied };
    },
    degradationCodesFor: () => [],
  };
}

/** Always-zero-coverage probe used by the exhaustion scenario. */
const alwaysZeroCoverageProbe: CriticSignalProbe = {
  coverageSignalsFor: () => ({
    satisfiedAttributes: new Set<string>(),
  }),
  degradationCodesFor: () => ['no_matches'],
};

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('retrieval critic flag-on integration (ADR-015 Axis 2, Wave B2)', () => {
  beforeEach(() => {
    globalRetrievalCriticCounter.reset();
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
    delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
  });
  afterEach(() => {
    globalRetrievalCriticCounter.reset();
    globalBundleSelectorCounter.reset();
    globalBudgetLedgerCounter.reset();
    delete process.env['BUNDLE_SELECTOR_ENABLED'];
    delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
  });

  it('scenario 1 — happy path: one retry then success surfaces a single relax trace', async () => {
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'true';

    let executeCalls = 0;
    const countingPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        if (executeCalls === 1) return [];
        return [
          mkCandidate('w1'),
          mkCandidate('w2'),
          mkCandidate('w3'),
        ];
      },
      generate: async () => [],
    };
    const deps: GraphExecutorDeps = {
      candidatePool: countingPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: createQueryRewriter(),
    };

    const result = await executeGraphAware(
      mkRetrievalInput(),
      trivialGraphWithColorSlot(),
      deps,
      noOpOpts,
      coverageAfterNCallsProbe(1),
    );

    expect(executeCalls).toBe(2);
    expect(result.mode).toBe('passthrough');
    expect(result.candidates).toHaveLength(3);
    expect(result.criticRewrites).toBeDefined();
    expect(result.criticRewrites).toHaveLength(1);
    expect(result.criticRewrites?.[0]?.rewriteType).toBe('relax');
    expect(result.criticRetriesExhausted).toBeUndefined();
    expect(
      globalRetrievalCriticCounter.snapshot()
        .RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT,
    ).toBe(0);
    expect(
      globalRetrievalCriticCounter.snapshot()
        .RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT,
    ).toBe(1);
  });

  it('scenario 2 — retries exhausted: CRITIC_RETRY_MAX rewrites + exhaustion counter', async () => {
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'true';

    let executeCalls = 0;
    const emptyPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return [];
      },
      generate: async () => [],
    };
    // Real rewriter: first iteration relaxes `region`; the second
    // iteration has nothing left to relax (only `color` floor remains)
    // and will return null, breaking the loop early. To drive the real
    // rewriter all the way to the cap we force `expand_synonym` by
    // wrapping the real rewriter with a re-populating strategy? Simpler:
    // always-succeed stub that mirrors the real rewriter interface. The
    // exhaustion invariant is what we're locking; the rewriter's
    // internal determinism is covered by query-rewriter regression tests.
    const alwaysRelaxRewriter = {
      apply: async (input: HybridRetrievalInput) => ({
        input,
        trace: {
          rewriteType: 'relax' as const,
          subqueryId: 'root',
          relaxedAttributes: ['region'],
        },
      }),
    };
    const deps: GraphExecutorDeps = {
      candidatePool: emptyPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: alwaysRelaxRewriter,
    };

    const result = await executeGraphAware(
      mkRetrievalInput(),
      trivialGraphWithColorSlot(),
      deps,
      noOpOpts,
      alwaysZeroCoverageProbe,
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.criticRewrites).toHaveLength(CRITIC_RETRY_MAX);
    expect(result.criticRetriesExhausted).toBe(true);
    expect(result.criticDegradationReasons).toContain('critic_retries_exhausted');
    // 1 initial retrieval + CRITIC_RETRY_MAX retries.
    expect(executeCalls).toBe(CRITIC_RETRY_MAX + 1);
    expect(
      globalRetrievalCriticCounter.snapshot()
        .RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT,
    ).toBe(1);
  });

  it('scenario 3 — flag off: byte-identical one-shot behaviour preserved', async () => {
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    let executeCalls = 0;
    const emptyPool: CandidatePoolPort = {
      execute: async () => {
        executeCalls += 1;
        return [];
      },
      generate: async () => [],
    };
    const deps: GraphExecutorDeps = {
      candidatePool: emptyPool,
      bundleSelector: new BundleSelectorImpl(),
      queryRewriter: createQueryRewriter(),
    };

    const result = await executeGraphAware(
      mkRetrievalInput(),
      trivialGraphWithColorSlot(),
      deps,
      noOpOpts,
      alwaysZeroCoverageProbe,
    );

    expect(executeCalls).toBe(1);
    expect(result.mode).toBe('passthrough');
    expect(result.candidates).toHaveLength(0);
    expect(result.criticRewrites).toBeUndefined();
    expect(result.criticRetriesExhausted).toBeUndefined();
    expect(result.criticDegradationReasons).toBeUndefined();
    // Counters did NOT move on the flag-off path.
    const snap = globalRetrievalCriticCounter.snapshot();
    expect(snap.RETRIEVAL_CRITIC_RETRIES_EXHAUSTED_COUNT).toBe(0);
    expect(snap.RETRIEVAL_CRITIC_RETRY_COUNT).toBe(0);
    expect(snap.RETRIEVAL_CRITIC_REWRITE_RELAX_COUNT).toBe(0);
  });

  it('scenario 4 — CRITIC_RETRY_MAX type-level lock: === 3', () => {
    // Direct import assertion. Locks the const against any future PR
    // that tries to turn it into an env var; bumping the value requires
    // editing this test alongside the ADR amendment.
    expect(CRITIC_RETRY_MAX).toBe(3);
    // Narrow the type-level assertion too — the const is declared
    // `as const` so TypeScript infers literal 3. This assignment would
    // fail to compile if the type drifted away from literal 3.
    const locked: 3 = CRITIC_RETRY_MAX;
    expect(locked).toBe(3);
  });

  it('scenario 5 — ToolCallEvidenceFrame observationHash includes retryCount', () => {
    const baseInput = {
      toolCallId: 'req-1-s0',
      toolName: 'search_hybrid',
      requestId: 'req-1',
      input: { q: 'red napa' } as Readonly<Record<string, unknown>>,
      structuredOutput: {
        kind: 'search_result_set' as const,
        resultSet: [],
        resultCount: 0,
      },
      observation: 'No wines matched your query.',
      invokedAt: new Date('2026-04-15T00:00:00.000Z'),
      durationMs: 12,
    };

    // Retry 0 (first pass through the critic loop).
    const frameRetry0 = buildToolCallEvidenceFrame({
      ...baseInput,
      retryCount: 0,
    });
    // Retry 1 — byte-identical observationSnapshot, distinct retryCount.
    const frameRetry1 = buildToolCallEvidenceFrame({
      ...baseInput,
      retryCount: 1,
    });
    // Retry 2 — same again, different retry.
    const frameRetry2 = buildToolCallEvidenceFrame({
      ...baseInput,
      retryCount: 2,
    });

    expect(frameRetry0.observationSnapshot).toBe(frameRetry1.observationSnapshot);
    expect(frameRetry1.observationSnapshot).toBe(frameRetry2.observationSnapshot);
    expect(frameRetry0.observationHash).not.toBe(frameRetry1.observationHash);
    expect(frameRetry1.observationHash).not.toBe(frameRetry2.observationHash);
    expect(frameRetry0.observationHash).not.toBe(frameRetry2.observationHash);

    // Sanity: all three are proper 64-char hex digests.
    for (const f of [frameRetry0, frameRetry1, frameRetry2]) {
      expect(f.observationHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // v1.1 schema version is emitted for any retryCount !== undefined.
    expect(frameRetry0.frameSchemaVersion).toBe('tool_evidence_v1_1');
    expect(frameRetry1.frameSchemaVersion).toBe('tool_evidence_v1_1');
  });

  it('scenario 6 — budget ledger releases reservations before each retry on the bundle path', async () => {
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'true';
    process.env['BUNDLE_SELECTOR_ENABLED'] = 'true';

    const ledger = new InMemoryBudgetLedger();
    const ledgerSizeObservedAtRetrieverEntry: number[] = [];
    let retrieverCallCount = 0;

    const subqueryRetriever: SubqueryRetriever = {
      retrieve: async (_base, sq) => {
        // Record the ledger state BEFORE this retriever commits — the
        // executor should have released any prior reservations pre-
        // flight so the ledger is always empty at retriever-entry.
        ledgerSizeObservedAtRetrieverEntry.push(ledger.snapshot().candidateCount);
        retrieverCallCount += 1;
        return [mkCandidate(`${sq.nodeId}:w${retrieverCallCount}`, 10)];
      },
    };

    // Always-succeed rewriter forces the loop to hit the cap so we see
    // multiple retry iterations touching the ledger.
    const alwaysRelaxRewriter = {
      apply: async (input: HybridRetrievalInput) => ({
        input,
        trace: {
          rewriteType: 'relax' as const,
          subqueryId: 'sq_0',
          relaxedAttributes: [],
        },
      }),
    };

    const deps: GraphExecutorDeps = {
      candidatePool: {
        execute: async () => [],
        generate: async () => [],
      },
      bundleSelector: new BundleSelectorImpl(),
      subqueryRetriever,
      queryRewriter: alwaysRelaxRewriter,
      budgetLedger: ledger,
    };

    const result = await executeGraphAware(
      mkRetrievalInput(),
      hybridGraphWithColorSlot(2),
      deps,
      noOpOpts,
      alwaysZeroCoverageProbe,
    );

    // We forced the critic to always retry with unsatisfied coverage,
    // so the loop runs to exhaustion.
    expect(result.criticRetriesExhausted).toBe(true);
    expect(result.criticRewrites).toHaveLength(CRITIC_RETRY_MAX);

    // Each subquery retriever invocation must see an empty ledger:
    // the initial pass finds it empty (nothing reserved yet); every
    // subsequent retry sees it empty because `release()` ran pre-flight.
    // With a 2-subquery graph and (CRITIC_RETRY_MAX + 1) iterations, we
    // expect 2 * (CRITIC_RETRY_MAX + 1) retriever invocations — and
    // every single one must report size 0.
    expect(ledgerSizeObservedAtRetrieverEntry.length).toBe(
      2 * (CRITIC_RETRY_MAX + 1),
    );
    for (const seen of ledgerSizeObservedAtRetrieverEntry) {
      expect(seen).toBe(0);
    }
    // Post-run the final assignment's reservations are still live on
    // the ledger (only pre-retry releases fire). Assert the ledger is
    // in a consistent state with exactly the final assignment slots.
    const finalAssignments =
      result.assignmentSolution?.assignments ?? [];
    expect(ledger.snapshot().candidateCount).toBe(finalAssignments.length);
  });
});
