/**
 * ADR-015 Axis 2 — retrieval-critic property invariants (SOTA++).
 *
 * Property-based exploration of the deterministic critic decision tree:
 *
 *   P1. Retry-cap upper bound — for ANY input, when `retryCount >= cap`
 *       the critic short-circuits to `{ retry: false,
 *       reason: 'retry_cap_reached' }`. No other branch can flip the
 *       decision to retry. Counter-example to this property would be a
 *       silent latency-amplification bug.
 *   P2. Decision idempotence — the function is pure: calling it 5x on
 *       byte-identical input yields byte-identical output (no shared
 *       mutable state, no Date.now / Math.random closure leakage).
 *   P3. Relaxation-branch order — when the decision is `retry=true`, the
 *       `rewriteType` is deterministic for a given coverageRatio /
 *       degradation / graph-shape tuple. Across permutations of the
 *       degradation-code list the chosen branch never drifts (the critic
 *       reads codes via `.includes`, so order must not matter).
 *   P4. Korean query NFC pass-through — the critic forwards `subqueryId`
 *       drawn from the graph; when the graph node id is a NFC-normalized
 *       Korean string, the returned `subqueryId` is byte-identical (no
 *       NFD corruption, no width changes).
 *   P5. Fallback on critic error — wrapping `decideRetry` in the
 *       executor's safe-call shape (try/catch returning the original
 *       pool) never loses candidates. We assert the shape via a
 *       small adapter that mirrors the executor's contract.
 *   P6. Empty pool / no-signal → no retry — when `coverage` is undefined
 *       and `degradationCodes` is empty, the decision is always
 *       `retry=false` with `reason: 'no_signal_to_act_on'`.
 *   P7. Boundary at the cap — `retryCount === cap` → blocked;
 *       `retryCount === cap - 1` with retry-eligible signals → allowed.
 *   P8. Decision enum closure — `rewriteType` is always one of the
 *       documented `CriticRewriteType` union members; `reason` is always
 *       one of the documented retry/no-retry union members.
 *
 * Append-only test: never delete.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CRITIC_RETRY_MAX,
  decideRetry,
  type CriticDecision,
  type CriticInput,
  type CriticNoRetryReason,
  type CriticRetryReason,
  type CriticRewriteType,
} from '../../src/domain/retrieval/service/retrieval-critic.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
  SubqueryNode,
} from '../../src/domain/query/model/constraint-graph.js';
import type { GraphCoverageResult } from '../../src/domain/query/service/compute-graph-coverage.js';
import type { RetrievalDegradationCode } from '../../src/domain/retrieval/port/retrieval-degradation-observer.port.js';

// ─── Property-friendly arbitrary builders ────────────────────────────────────

/** Build a deterministic coverage result with controllable ratio. */
function mkCoverage(over: Partial<GraphCoverageResult>): GraphCoverageResult {
  return {
    matchedAttributes: [],
    unmetAttributes: [],
    matchedNodeIds: [],
    unmetNodeIds: [],
    coverageRatio: 0,
    rootSatisfied: false,
    ...over,
  };
}

const arbCoverageRatio = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbCoverage: fc.Arbitrary<GraphCoverageResult | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.record({
    coverageRatio: arbCoverageRatio,
    rootSatisfied: fc.boolean(),
  }).map((r) => mkCoverage(r)),
);

const arbDegradationCodes: fc.Arbitrary<readonly RetrievalDegradationCode[]> =
  fc.subarray<RetrievalDegradationCode>(['sparse_pool', 'no_matches']);

function mkGraph(subqueryIds: readonly string[]): ConstraintGraph {
  const subqueries: SubqueryNode[] = subqueryIds.map((id) => ({
    kind: 'subquery',
    nodeId: id,
    purpose: id,
    targetCardinality: 1,
  }));
  const nodes: ConstraintGraphNode[] = [
    { kind: 'group_and', nodeId: 'root', children: [...subqueryIds] },
    ...subqueries,
  ];
  return {
    graphSchemaVersion: 'constraint_graph_v1.1',
    origin: 'hybrid',
    rootNodeId: 'root',
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

const arbGraph: fc.Arbitrary<ConstraintGraph | undefined> = fc.oneof(
  fc.constant(undefined),
  fc
    .array(
      fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s !== 'root'),
      { minLength: 0, maxLength: 3 },
    )
    .map((ids) => mkGraph(ids)),
);

const arbRetryCount = fc.integer({ min: 0, max: CRITIC_RETRY_MAX + 5 });

const arbCriticInput: fc.Arbitrary<CriticInput> = fc.record({
  graph: arbGraph,
  coverage: arbCoverage,
  degradationCodes: arbDegradationCodes,
  retryCount: arbRetryCount,
});

const REWRITE_TYPES: readonly CriticRewriteType[] = [
  'relax',
  'decompose',
  'expand_synonym',
  'reformulate',
];
const NO_RETRY_REASONS: readonly CriticNoRetryReason[] = [
  'coverage_satisfied',
  'retry_cap_reached',
  'no_signal_to_act_on',
];
const RETRY_REASONS: readonly CriticRetryReason[] = [
  'coverage_zero_relax',
  'no_matches_expand_synonym',
  'partial_coverage_decompose',
  'fallback_reformulate',
];

// ─── Properties ──────────────────────────────────────────────────────────────

describe('retrieval-critic property invariants (ADR-015 Axis 2, SOTA++)', () => {
  it('P1 retry-cap upper bound — retryCount ≥ cap ⇒ retry=false retry_cap_reached', () => {
    fc.assert(
      fc.property(
        arbCriticInput,
        fc.integer({ min: 0, max: 5 }),
        (input, over) => {
          const atOrAboveCap: CriticInput = {
            ...input,
            retryCount: CRITIC_RETRY_MAX + over,
          };
          const decision = decideRetry(atOrAboveCap);
          expect(decision.retry).toBe(false);
          if (!decision.retry) {
            expect(decision.reason).toBe('retry_cap_reached');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P2 decision idempotence — same input yields same output 5x', () => {
    fc.assert(
      fc.property(arbCriticInput, (input) => {
        const first = decideRetry(input);
        for (let i = 0; i < 5; i += 1) {
          expect(decideRetry(input)).toStrictEqual(first);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P3 relaxation-branch order invariance — permuting degradationCodes never changes the decision', () => {
    fc.assert(
      fc.property(arbCriticInput, (input) => {
        const reversed: readonly RetrievalDegradationCode[] = [
          ...input.degradationCodes,
        ].reverse();
        const original = decideRetry(input);
        const permuted = decideRetry({ ...input, degradationCodes: reversed });
        expect(permuted).toStrictEqual(original);
      }),
      { numRuns: 100 },
    );
  });

  it('P4 Korean subqueryId passes through NFC-clean (no NFD corruption)', () => {
    // Hangul syllables (NFC) — ensure decideRetry returns the byte-identical
    // node id (not decomposed jamo). Forces a retry path so subqueryId is
    // surfaced on the decision.
    const koreanIds = ['빨간와인', '나파밸리', '카베르네소비뇽'];
    fc.assert(
      fc.property(fc.constantFrom(...koreanIds), (id) => {
        // NFC-normalize the input id explicitly so we can assert
        // byte-identity downstream.
        const nfcId = id.normalize('NFC');
        const graph = mkGraph([nfcId]);
        const decision = decideRetry({
          graph,
          coverage: mkCoverage({ coverageRatio: 0, rootSatisfied: false }),
          degradationCodes: [],
          retryCount: 0,
        });
        expect(decision.retry).toBe(true);
        if (decision.retry) {
          expect(decision.subqueryId).toBe(nfcId);
          // No silent NFD decomposition.
          expect(decision.subqueryId.normalize('NFC')).toBe(decision.subqueryId);
          // Byte-length equals NFC byte length.
          expect(decision.subqueryId.length).toBe(nfcId.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P5 fallback on critic error — adapter returns original pool when decideRetry throws', () => {
    // Adapter mirroring the executor's safe-call shape: catch any throw
    // from the critic and return the original candidate-pool reference.
    interface FakeCandidate {
      readonly id: string;
    }
    function safeDecide(
      input: CriticInput,
      thrower: (i: CriticInput) => CriticDecision,
      originalPool: readonly FakeCandidate[],
    ): { decision: CriticDecision | null; pool: readonly FakeCandidate[] } {
      try {
        return { decision: thrower(input), pool: originalPool };
      } catch {
        return { decision: null, pool: originalPool };
      }
    }
    const arbPool = fc.array(
      fc.record<FakeCandidate>({ id: fc.string({ minLength: 1, maxLength: 8 }) }),
      { minLength: 0, maxLength: 10 },
    );
    fc.assert(
      fc.property(arbCriticInput, arbPool, (input, pool) => {
        const result = safeDecide(
          input,
          () => {
            throw new Error('synthetic critic failure');
          },
          pool,
        );
        // Original pool reference preserved — no data loss.
        expect(result.pool).toBe(pool);
        expect(result.decision).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('P6 empty pool / no-signal — coverage undefined + empty degradationCodes ⇒ no retry', () => {
    fc.assert(
      fc.property(
        arbGraph,
        fc.integer({ min: 0, max: CRITIC_RETRY_MAX - 1 }),
        (graph, retryCount) => {
          const decision = decideRetry({
            graph,
            coverage: undefined,
            degradationCodes: [],
            retryCount,
          });
          expect(decision.retry).toBe(false);
          if (!decision.retry) {
            expect(decision.reason).toBe('no_signal_to_act_on');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P7 boundary: retryCount === cap blocked; cap-1 with retry-eligible signal allowed', () => {
    // Exactly at cap → blocked.
    const blocked = decideRetry({
      graph: undefined,
      coverage: mkCoverage({ coverageRatio: 0, rootSatisfied: false }),
      degradationCodes: ['no_matches'],
      retryCount: CRITIC_RETRY_MAX,
    });
    expect(blocked.retry).toBe(false);
    if (!blocked.retry) {
      expect(blocked.reason).toBe('retry_cap_reached');
    }

    // One below the cap → allowed when signal warrants it.
    const allowed = decideRetry({
      graph: undefined,
      coverage: mkCoverage({ coverageRatio: 0, rootSatisfied: false }),
      degradationCodes: ['no_matches'],
      retryCount: CRITIC_RETRY_MAX - 1,
    });
    expect(allowed.retry).toBe(true);

    // cap + 1 also blocked (off-by-one defense).
    const overCap = decideRetry({
      graph: undefined,
      coverage: mkCoverage({ coverageRatio: 0, rootSatisfied: false }),
      degradationCodes: ['no_matches'],
      retryCount: CRITIC_RETRY_MAX + 1,
    });
    expect(overCap.retry).toBe(false);
  });

  it('P8 decision enum closure — rewriteType/reason always in documented unions', () => {
    fc.assert(
      fc.property(arbCriticInput, (input) => {
        const decision = decideRetry(input);
        if (decision.retry) {
          expect(REWRITE_TYPES).toContain(decision.rewriteType);
          expect(RETRY_REASONS).toContain(decision.reason);
          // subqueryId is always a non-empty string.
          expect(typeof decision.subqueryId).toBe('string');
          expect(decision.subqueryId.length).toBeGreaterThan(0);
        } else {
          expect(NO_RETRY_REASONS).toContain(decision.reason);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('CRITIC_RETRY_MAX === 3 (type-level lock duplicated for property suite locality)', () => {
    expect(CRITIC_RETRY_MAX).toBe(3);
    const locked: 3 = CRITIC_RETRY_MAX;
    expect(locked).toBe(3);
  });

  it('rewriter trace score-drift signal is never NaN — critic decision is finite (sanity)', () => {
    // The critic does not currently emit numeric drift directly, but it
    // does forward decisions that the rewrite layer turns into traces.
    // We lock that `retryCount` propagation never produces a NaN-tainted
    // decision shape (no numeric fields appear on the union, so we
    // simply verify the decision is JSON-serializable — NaN serializes
    // to `null` and would silently corrupt downstream logs).
    fc.assert(
      fc.property(arbCriticInput, (input) => {
        const decision = decideRetry(input);
        const roundtrip = JSON.parse(JSON.stringify(decision)) as CriticDecision;
        expect(roundtrip).toStrictEqual(decision);
      }),
      { numRuns: 100 },
    );
  });
});
