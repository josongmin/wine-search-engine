/**
 * ADR-013 Phase 1c: assignment-solver invariants.
 *
 * Append-only test. Locks:
 *   1. Empty input → empty assignment, solved=true.
 *   2. K=1 → trivial one-slot one-candidate.
 *   3. K=2 → optimal matching on a 2x2 matrix.
 *   4. K=5 → worst-case exact (5! = 120 permutations).
 *   5. K=6 → fail-closed with k_exceeds_exact_limit.
 *   6. Shared-budget binding (optimum forced to cheaper pair).
 *   7. Shared-budget non-binding (optimum matches unconstrained).
 *   8. Tie-breaking is deterministic (lex-smallest) across repeat calls.
 *   9. Empty slot pool → fail-closed with empty_slot_pool reason.
 *  10. Solver is pure — same input, same output across 100 calls.
 *  11. Budget-infeasible (all candidates exceed ceiling) → fail-closed.
 *
 * Never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  solveAssignmentExact,
  K_EXACT_LIMIT,
  type AssignmentBudgetConstraint,
} from '../../src/domain/retrieval/service/assignment-solver.js';

describe('solveAssignmentExact (ADR-013)', () => {
  it('K=0 returns trivial success with empty permutation', () => {
    const r = solveAssignmentExact({ costMatrix: [] });
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.assignedColumns).toEqual([]);
      expect(r.totalCost).toBe(0);
    }
  });

  it('K=1 picks the minimum-cost cell', () => {
    const r = solveAssignmentExact({
      costMatrix: [[5, 3, 9, 2, 7]],
    });
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.assignedColumns).toEqual([3]);
      expect(r.totalCost).toBe(2);
    }
  });

  it('K=2 finds optimal 2x2 assignment (lower triangular optimum)', () => {
    // Optimal assignment: row0->col1 (cost 1) + row1->col0 (cost 2) = 3
    // Alternative: row0->col0 (cost 5) + row1->col1 (cost 4) = 9
    const r = solveAssignmentExact({
      costMatrix: [
        [5, 1],
        [2, 4],
      ],
    });
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.assignedColumns).toEqual([1, 0]);
      expect(r.totalCost).toBe(3);
    }
  });

  it('K=5 solves a worst-case 5x5 exactly (brute-force parity check)', () => {
    // Construct a 5x5 where optimum is the anti-diagonal, cost 0 each,
    // and every other cell costs 100. Optimum = 0, assignment = [4,3,2,1,0].
    const mk = (diag: number) => {
      const row: number[] = [];
      for (let c = 0; c < 5; c += 1) row.push(c === diag ? 0 : 100);
      return row;
    };
    const r = solveAssignmentExact({
      costMatrix: [mk(4), mk(3), mk(2), mk(1), mk(0)],
    });
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.assignedColumns).toEqual([4, 3, 2, 1, 0]);
      expect(r.totalCost).toBe(0);
    }

    // Brute-force parity: solver must match a hand-rolled 5! enumeration.
    const cost = (perm: readonly number[], matrix: readonly (readonly number[])[]): number => {
      let sum = 0;
      for (let i = 0; i < perm.length; i += 1) {
        const col = perm[i] as number;
        const row = matrix[i] as readonly number[];
        sum += row[col] as number;
      }
      return sum;
    };
    const permutations = (arr: readonly number[]): readonly (readonly number[])[] => {
      if (arr.length <= 1) return [arr];
      const out: number[][] = [];
      for (let i = 0; i < arr.length; i += 1) {
        const rest = arr.filter((_, j) => j !== i);
        for (const p of permutations(rest)) out.push([arr[i] as number, ...p]);
      }
      return out;
    };
    const matrix: number[][] = [
      [3, 8, 4, 1, 6],
      [2, 5, 9, 7, 0],
      [6, 3, 1, 4, 8],
      [9, 7, 2, 0, 5],
      [4, 1, 6, 8, 3],
    ];
    const r2 = solveAssignmentExact({ costMatrix: matrix });
    expect(r2.solved).toBe(true);
    let min = Number.POSITIVE_INFINITY;
    for (const perm of permutations([0, 1, 2, 3, 4])) {
      const c = cost(perm, matrix);
      if (c < min) min = c;
    }
    if (r2.solved) expect(r2.totalCost).toBe(min);
  });

  it('K=6 fails closed with k_exceeds_exact_limit (no silent greedy fallback)', () => {
    expect(K_EXACT_LIMIT).toBe(5);
    const row = [0, 0, 0, 0, 0, 0];
    const r = solveAssignmentExact({
      costMatrix: [row, row, row, row, row, row],
    });
    expect(r.solved).toBe(false);
    if (!r.solved) {
      expect(r.reason).toBe('bundle_selector_fail_closed:k_exceeds_exact_limit');
    }
  });

  it('shared-budget binding forces the cheaper pair', () => {
    // Two rows, three candidates each. Unconstrained optimum picks
    // (0,0)+(1,0) — the distinct-column rule plus no budget gives
    // cost 1+3=4 via [0,1]. With a tight budget, [2,1] is forced:
    //   prices: col0=100k, col1=50k, col2=20k. Ceiling: 80k.
    //   Valid distinct perms and budgets:
    //     [0,1]=150k infeasible; [0,2]=120k infeasible;
    //     [1,0]=150k infeasible; [1,2]=70k OK (cost 3+5=8);
    //     [2,0]=120k infeasible; [2,1]=70k OK (cost 5+3=8).
    //   Optimum tied at cost 8; lex-smallest is [1,2].
    const budget: AssignmentBudgetConstraint = {
      label: 'shares_budget:price_total',
      rows: [0, 1],
      cellCost: (_r, c) => (c === 0 ? 100_000 : c === 1 ? 50_000 : 20_000),
      ceiling: 80_000,
    };
    const r = solveAssignmentExact({
      costMatrix: [
        [1, 3, 5],
        [1, 3, 5],
      ],
      budgetConstraints: [budget],
    });
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.assignedColumns).toEqual([1, 2]);
      expect(r.penaltyPaid).toBe(0);
    }
  });

  it('shared-budget non-binding matches the unconstrained optimum', () => {
    const budget: AssignmentBudgetConstraint = {
      label: 'shares_budget:price_total',
      rows: [0, 1],
      cellCost: (_r, c) => (c === 0 ? 10_000 : 10_000),
      ceiling: 1_000_000,
    };
    const r = solveAssignmentExact({
      costMatrix: [
        [1, 3],
        [1, 3],
      ],
      budgetConstraints: [budget],
    });
    expect(r.solved).toBe(true);
    if (r.solved) {
      // Unconstrained optimum: col 0 for both rows (but distinct-column
      // rule forces a permutation: [0,1] or [1,0] each cost 1+3=4).
      expect(r.totalCost).toBe(4);
      expect(r.penaltyPaid).toBe(0);
    }
  });

  it('tie-breaking is deterministic: 100 repeat calls produce identical output', () => {
    // Multiple permutations tie at cost 0 — the solver must always
    // pick the lex-smallest.
    const matrix = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const first = solveAssignmentExact({ costMatrix: matrix });
    expect(first.solved).toBe(true);
    if (first.solved) expect(first.tieBreakReason).toBe('lex_smallest');
    for (let i = 0; i < 100; i += 1) {
      const r = solveAssignmentExact({ costMatrix: matrix });
      expect(r.solved).toBe(true);
      if (r.solved && first.solved) {
        expect(r.assignedColumns).toEqual(first.assignedColumns);
      }
    }
    // Lex smallest 3x3 permutation is [0,1,2].
    if (first.solved) expect(first.assignedColumns).toEqual([0, 1, 2]);
  });

  it('empty slot pool fails closed with empty_slot_pool', () => {
    const r = solveAssignmentExact({
      costMatrix: [[1, 2], []],
    });
    expect(r.solved).toBe(false);
    if (!r.solved) {
      expect(r.reason).toBe('bundle_selector_fail_closed:empty_slot_pool');
    }
  });

  it('budget-infeasible returns fail-closed (no best-effort silent picks)', () => {
    // Every candidate exceeds the ceiling.
    const budget: AssignmentBudgetConstraint = {
      label: 'shares_budget:price_total',
      rows: [0, 1],
      cellCost: () => 1_000_000,
      ceiling: 100,
    };
    const r = solveAssignmentExact({
      costMatrix: [
        [1, 2],
        [3, 4],
      ],
      budgetConstraints: [budget],
    });
    expect(r.solved).toBe(false);
    if (!r.solved) {
      expect(r.reason).toBe('bundle_selector_fail_closed:budget_infeasible');
    }
  });

  it('is pure — same input yields same output across 100 calls', () => {
    const matrix = [
      [3, 8, 4, 1, 6],
      [2, 5, 9, 7, 0],
      [6, 3, 1, 4, 8],
    ];
    const baseline = solveAssignmentExact({ costMatrix: matrix });
    expect(baseline.solved).toBe(true);
    for (let i = 0; i < 100; i += 1) {
      const r = solveAssignmentExact({ costMatrix: matrix });
      expect(r.solved).toBe(true);
      if (r.solved && baseline.solved) {
        expect(r.assignedColumns).toEqual(baseline.assignedColumns);
        expect(r.totalCost).toBe(baseline.totalCost);
      }
    }
  });
});
