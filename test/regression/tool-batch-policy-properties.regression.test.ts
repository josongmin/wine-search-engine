/**
 * Property-based regression tests for TOOL_BATCH_POLICY / evaluateBatchPolicy.
 *
 * Audit gap closed by this file (feature: agent.tool-batch-policy):
 *  - canRunWith symmetry across the declared policy graph is now enforced
 *    as an invariant — previously only spot-checked.
 *  - mustRunAlone, maxPerBatch, and unknown-tool rejection are exhaustively
 *    explored via fast-check over arbitrary tool batches.
 *  - Empty / single-call short-circuits remain allowed under all shapes.
 *
 * Append-only.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  TOOL_BATCH_POLICY,
  evaluateBatchPolicy,
} from '../../src/application/agent/tool-batch-policy.js';
import { KNOWN_AGENT_TOOL_NAMES } from '../../src/domain/agent/model/agent-tool-attempt-schema.js';

const KNOWN_TOOLS = KNOWN_AGENT_TOOL_NAMES;

// Build a call envelope shape expected by evaluateBatchPolicy.
const makeCall = (tool: string) => ({ tool, input: {} as Record<string, unknown> });

// ─── Symmetry invariant ───────────────────────────────────────────────────────

describe('Property: TOOL_BATCH_POLICY canRunWith symmetry', () => {
  it('for every (A, B) pair: A.canRunWith[B] iff B.canRunWith[A] (mustRunAlone exempt)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_TOOLS),
        fc.constantFrom(...KNOWN_TOOLS),
        (a, b) => {
          const pa = TOOL_BATCH_POLICY[a];
          const pb = TOOL_BATCH_POLICY[b];
          // mustRunAlone tools are excluded from symmetric co-batching by
          // construction — evaluateBatchPolicy rejects them earlier.
          if (pa.mustRunAlone || pb.mustRunAlone) return true;
          const aAllowsB = (pa.canRunWith as readonly string[]).includes(b);
          const bAllowsA = (pb.canRunWith as readonly string[]).includes(a);
          return aAllowsB === bAllowsA;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('symmetric pair {A,B} actually evaluates allowed when both have maxPerBatch >= 1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_TOOLS),
        fc.constantFrom(...KNOWN_TOOLS),
        (a, b) => {
          if (a === b) return true; // self-batch covered by another property
          const pa = TOOL_BATCH_POLICY[a];
          const pb = TOOL_BATCH_POLICY[b];
          if (pa.mustRunAlone || pb.mustRunAlone) return true;
          const aAllowsB = (pa.canRunWith as readonly string[]).includes(b);
          if (!aAllowsB) return true; // not a compatible pair — skip
          const res = evaluateBatchPolicy([makeCall(a), makeCall(b)]);
          return res.allowed;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── mustRunAlone enforcement ─────────────────────────────────────────────────

describe('Property: mustRunAlone tools reject any co-batched tool', () => {
  it('for every mustRunAlone tool T and every other tool X: batch{T,X} is rejected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_TOOLS),
        fc.constantFrom(...KNOWN_TOOLS),
        (t, x) => {
          const pt = TOOL_BATCH_POLICY[t];
          if (!pt.mustRunAlone) return true;
          if (t === x) {
            // self+self also forbidden because mustRunAlone => batch>1 disallowed
            const res = evaluateBatchPolicy([makeCall(t), makeCall(t)]);
            return !res.allowed && res.reason.includes('must run alone');
          }
          const res = evaluateBatchPolicy([makeCall(t), makeCall(x)]);
          if (res.allowed) return false;
          // The mustRunAlone violation must be cited (it is checked before
          // canRunWith / maxPerBatch in evaluateBatchPolicy).
          return res.reason.includes('must run alone') || res.reason.includes(t);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── maxPerBatch enforcement ──────────────────────────────────────────────────

describe('Property: maxPerBatch enforcement (N copies of one tool)', () => {
  it('N copies of tool T allowed iff N <= maxPerBatch (T not mustRunAlone)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_TOOLS),
        fc.integer({ min: 1, max: 8 }),
        (t, n) => {
          const pt = TOOL_BATCH_POLICY[t];
          const calls = Array.from({ length: n }, () => makeCall(t));
          const res = evaluateBatchPolicy(calls);

          if (pt.mustRunAlone) {
            // n=1 always allowed (single-call short-circuit);
            // n>1 must be rejected.
            return n === 1 ? res.allowed : !res.allowed;
          }
          // self must be in canRunWith for any n > 1 to be allowed
          const selfPermitted = (pt.canRunWith as readonly string[]).includes(t);
          if (!selfPermitted && n > 1) {
            return !res.allowed;
          }
          if (n <= pt.maxPerBatch) {
            return res.allowed;
          }
          return !res.allowed && res.reason.includes('maxPerBatch');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Unknown tool rejection ───────────────────────────────────────────────────

describe('Property: unknown tool names are rejected with a reason', () => {
  it('any tool name not in TOOL_BATCH_POLICY + a known tool => not allowed', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 24 })
          .filter((s) => !(KNOWN_TOOLS as readonly string[]).includes(s)),
        fc.constantFrom(...KNOWN_TOOLS),
        (unknown, known) => {
          const res = evaluateBatchPolicy([makeCall(unknown), makeCall(known)]);
          if (res.allowed) return false;
          return res.reason.length > 0 && res.violatingTools.length > 0;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('unknown tool alone in single-call batch is allowed (short-circuit invariant)', () => {
    // Single-call batches are never validated against the policy graph —
    // the orchestrator gates unknown tools elsewhere.
    const res = evaluateBatchPolicy([makeCall('definitely_not_a_tool_xyz')]);
    expect(res.allowed).toBe(true);
  });
});

// ─── Empty / single-call invariants ───────────────────────────────────────────

describe('Property: empty and single-call batches are always allowed', () => {
  it('empty batch is allowed', () => {
    expect(evaluateBatchPolicy([]).allowed).toBe(true);
  });

  it('any single-call batch over any known tool is allowed', () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_TOOLS), (t) => {
        return evaluateBatchPolicy([makeCall(t)]).allowed;
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Mixed batches — canRunWith honored ───────────────────────────────────────

describe('Property: canRunWith governs mixed-tool batches', () => {
  it('search_wines x4 + get_food_pairings x1 is allowed (declared compatible)', () => {
    const calls = [
      makeCall('search_wines'),
      makeCall('search_wines'),
      makeCall('search_wines'),
      makeCall('search_wines'),
      makeCall('get_food_pairings'),
    ];
    const res = evaluateBatchPolicy(calls);
    expect(res.allowed).toBe(true);
  });

  it('search_wines + check_drinking_window is rejected (incompatible pair)', () => {
    const res = evaluateBatchPolicy([
      makeCall('search_wines'),
      makeCall('check_drinking_window'),
    ]);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.reason).toMatch(/cannot run in the same batch/);
    }
  });
});

// ─── Boundary regression cases (audit checklist) ──────────────────────────────

describe('Boundary regression: explicit cases from the SOTA++ audit', () => {
  it('compare_wines + any other tool => rejected (mustRunAlone)', () => {
    for (const other of KNOWN_TOOLS) {
      if (other === 'compare_wines') continue;
      const res = evaluateBatchPolicy([
        makeCall('compare_wines'),
        makeCall(other),
      ]);
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain('must run alone');
        expect(res.violatingTools).toContain('compare_wines');
      }
    }
  });

  it('check_drinking_window x5 => rejected (maxPerBatch=4)', () => {
    const calls = Array.from({ length: 5 }, () => makeCall('check_drinking_window'));
    const res = evaluateBatchPolicy(calls);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.reason).toContain('maxPerBatch');
      expect(res.reason).toContain('check_drinking_window');
    }
  });

  it('search_wines x4 => allowed (maxPerBatch=4, self in canRunWith)', () => {
    const calls = Array.from({ length: 4 }, () => makeCall('search_wines'));
    const res = evaluateBatchPolicy(calls);
    expect(res.allowed).toBe(true);
  });

  it('search_wines x5 => rejected (maxPerBatch=4)', () => {
    const calls = Array.from({ length: 5 }, () => makeCall('search_wines'));
    const res = evaluateBatchPolicy(calls);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.reason).toContain('maxPerBatch');
    }
  });

  it('empty list => allowed', () => {
    expect(evaluateBatchPolicy([]).allowed).toBe(true);
  });
});

// ─── SSOT parity: every known tool has a policy entry ─────────────────────────

describe('Structural invariant: every KNOWN_AGENT_TOOL_NAMES entry has a policy', () => {
  it('TOOL_BATCH_POLICY covers every known agent tool name', () => {
    for (const t of KNOWN_TOOLS) {
      expect(TOOL_BATCH_POLICY[t]).toBeDefined();
      expect(TOOL_BATCH_POLICY[t].maxPerBatch).toBeGreaterThanOrEqual(1);
    }
  });
});
