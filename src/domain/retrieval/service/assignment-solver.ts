/**
 * ADR-013 Phase 1c: exact assignment solver (Hungarian-style, K≤5).
 *
 * The solver picks one column (candidate) per row (subquery) so as to
 * minimise the sum of per-cell costs. For K ≤ 5 we brute-force all K!
 * permutations — K=5 is 120 evaluations, a negligible cost on the online
 * path and trivially provably correct (no iterative relaxation to get
 * wrong). The result is bit-identical across repeat calls on the same
 * input, which we lock with a regression test.
 *
 * Shared-budget constraints are encoded as subset-sum soft penalties
 * *inside the cost matrix* — the caller supplies a `budgetConstraints`
 * list whose entries declare a subset of row indices and a ceiling; any
 * permutation whose chosen cells sum over the ceiling pays
 * `BUDGET_OVERFLOW_PENALTY` (a dominating additive). If the optimum
 * permutation still pays the penalty — i.e. no feasible assignment
 * exists — the solver returns `{ solved: false, reason:
 * 'bundle_selector_fail_closed:budget_infeasible' }`.
 *
 * K > 5 returns `{ solved: false, reason:
 * 'bundle_selector_fail_closed:k_exceeds_exact_limit' }` per CLAUDE.md
 * heuristic policy: no silent greedy fallback.
 *
 * Tie-breaking: equal-cost permutations are broken by
 * lexicographically smallest (rowIdx, columnIdx) tuple sequence. Locked
 * by regression.
 */

/** K=5 corresponds to a 5x5 matrix with K! = 120 permutations. Pushing
 *  K=6 would cost K! = 720 permutations which is still fast, but ADR-013
 *  deliberately pins K_EXACT_LIMIT at 5 so any K>5 query surfaces as a
 *  fail-closed signal for explicit ADR-level scope review. */
export const K_EXACT_LIMIT = 5;

/** Dominating additive penalty applied to cell costs when a budget
 *  subset overflows. Must exceed `K * MAX_CELL_COST` by a large margin
 *  so a feasible-but-worse assignment is always preferred over an
 *  infeasible-but-cheaper one. 1e12 is safe for any realistic wine
 *  retrieval cost (costs are unit-normalised negatives of `finalScore`
 *  which is in [0, 1]). */
const BUDGET_OVERFLOW_PENALTY = 1e12;

/** Dominating penalty used to represent "unassignable" cells (no
 *  candidate available for (row, col)). Distinct from budget overflow
 *  to keep the trace audit-friendly. */
const UNASSIGNABLE_PENALTY = 1e11;

/** Epsilon for cost equality when breaking ties. Costs are finite
 *  arithmetic; 1e-9 is slack enough to absorb floating-point drift
 *  from three fused sub-scores without over-collapsing distinct
 *  optima. */
const COST_EQUALITY_EPSILON = 1e-9;

export interface AssignmentBudgetConstraint {
  readonly label: string;
  /** Row indices the budget ceiling applies to. */
  readonly rows: readonly number[];
  /** Cost contribution per cell (row, col) under this budget. */
  readonly cellCost: (rowIdx: number, colIdx: number) => number;
  readonly ceiling: number;
}

export interface AssignmentRowSpec {
  readonly label?: string | undefined;
  readonly obligation?: 'required' | 'optional' | undefined;
}

export interface AssignmentGroupConstraint {
  readonly kind: 'at_least_one' | 'exactly_one';
  readonly rows: readonly number[];
  readonly label?: string | undefined;
}

interface AssignmentSolverInput {
  /**
   * K x M cost matrix. `costMatrix[row][col]` is the cost of assigning
   * column `col` to row `row`. `row` indexes a subquery, `col` indexes
   * a candidate in that subquery's pool. K=costMatrix.length. We allow
   * ragged pools per row (each row has its own M_row); in that case
   * the solver operates on padded columns where missing cells cost
   * `UNASSIGNABLE_PENALTY`.
   */
  readonly costMatrix: readonly (readonly number[])[];
  readonly budgetConstraints?: readonly AssignmentBudgetConstraint[];
  readonly rowSpecs?: readonly AssignmentRowSpec[];
  readonly groupConstraints?: readonly AssignmentGroupConstraint[];
  readonly selectionValidator?: ((selectedRows: readonly number[]) => boolean) | undefined;
  readonly selectionUtility?: ((selectedRows: readonly number[]) => number) | undefined;
}

export type AssignmentSolverFailReason =
  | 'bundle_selector_fail_closed:k_exceeds_exact_limit'
  | 'bundle_selector_fail_closed:budget_infeasible'
  | 'bundle_selector_fail_closed:empty_slot_pool'
  | 'bundle_selector_fail_closed:group_obligation_unsatisfied';

interface AssignmentSolverSuccess {
  readonly solved: true;
  /** Original row indices that remained active after optional-row pruning. */
  readonly activeRowIndices: readonly number[];
  /** `assignedColumns[row]` = column index chosen for that row. */
  readonly assignedColumns: readonly number[];
  /** Sum of cell costs over the chosen permutation (excludes penalties). */
  readonly totalCost: number;
  /** Sum of budget-overflow penalties paid (should be 0 on success). */
  readonly penaltyPaid: number;
  /** `'unique'` when the optimum is strictly better than the runner-up;
   *  `'lex_smallest'` when ties were broken by lexicographic rule. */
  readonly tieBreakReason: 'unique' | 'lex_smallest';
}

interface AssignmentSolverFailure {
  readonly solved: false;
  readonly reason: AssignmentSolverFailReason;
}

type AssignmentSolverResult =
  | AssignmentSolverSuccess
  | AssignmentSolverFailure;

/**
 * Solve a K-row assignment exactly for K ≤ K_EXACT_LIMIT.
 *
 * Empty input (`costMatrix.length === 0`) returns a trivial success
 * with an empty permutation — the graph executor treats this as a
 * no-op. Any row with zero columns returns
 * `'bundle_selector_fail_closed:empty_slot_pool'`.
 */
export function solveAssignmentExact(
  input: AssignmentSolverInput,
): AssignmentSolverResult {
  const rowSpecs = input.rowSpecs ?? input.costMatrix.map(() => ({ obligation: 'required' as const }));
  const groupConstraints = input.groupConstraints ?? [];
  const selectionValidator = input.selectionValidator;
  const selectionUtility = input.selectionUtility;
  const requiredRows: number[] = [];
  const optionalRows: number[] = [];
  for (let rowIdx = 0; rowIdx < input.costMatrix.length; rowIdx += 1) {
    if ((rowSpecs[rowIdx]?.obligation ?? 'required') === 'optional') {
      optionalRows.push(rowIdx);
    } else {
      requiredRows.push(rowIdx);
    }
  }

  const validSelections: number[][] = [];
  const currentSelection = new Set<number>(requiredRows);
  const pushSelectionIfValid = (): void => {
    for (const constraint of groupConstraints) {
      const selectedCount = constraint.rows.filter((rowIdx) => currentSelection.has(rowIdx)).length;
      if (constraint.kind === 'at_least_one' && selectedCount < 1) {
        return;
      }
      if (constraint.kind === 'exactly_one' && selectedCount !== 1) {
        return;
      }
    }
    const selectedRows = [...currentSelection].sort((a, b) => a - b);
    if (selectionValidator !== undefined && !selectionValidator(selectedRows)) {
      return;
    }
    validSelections.push(selectedRows);
  };
  const recurseSelections = (index: number): void => {
    if (index >= optionalRows.length) {
      pushSelectionIfValid();
      return;
    }
    const rowIdx = optionalRows[index]!;
    const row = input.costMatrix[rowIdx] ?? [];
    // Optional empty rows can only be excluded.
    recurseSelections(index + 1);
    if (row.length > 0) {
      currentSelection.add(rowIdx);
      recurseSelections(index + 1);
      currentSelection.delete(rowIdx);
    }
  };
  recurseSelections(0);

  if (validSelections.length === 0) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:group_obligation_unsatisfied',
    };
  }

  let sawKLimit = false;
  let sawEmptySlot = false;
  let sawBudgetInfeasible = false;
  let bestSolved:
    | (AssignmentSolverSuccess & {
        readonly activeRowIndices: readonly number[];
        readonly selectionUtility: number;
      })
    | undefined;

  for (const selectedRows of validSelections) {
    const selectedMatrix = selectedRows.map((rowIdx) => input.costMatrix[rowIdx] ?? []);
    const rowIndexByOriginal = new Map<number, number>();
    for (let activeIdx = 0; activeIdx < selectedRows.length; activeIdx += 1) {
      rowIndexByOriginal.set(selectedRows[activeIdx]!, activeIdx);
    }
    const selectedBudgets = (input.budgetConstraints ?? []).flatMap((constraint) => {
      const rows = constraint.rows.flatMap((rowIdx) => {
        const mapped = rowIndexByOriginal.get(rowIdx);
        return mapped === undefined ? [] : [mapped];
      });
      if (rows.length === 0) {
        return [];
      }
      return [{ ...constraint, rows }];
    });
    const fixed = solveAssignmentFixedRows({
      costMatrix: selectedMatrix,
      budgetConstraints: selectedBudgets,
    });
    if (!fixed.solved) {
      if (fixed.reason === 'bundle_selector_fail_closed:k_exceeds_exact_limit') sawKLimit = true;
      if (fixed.reason === 'bundle_selector_fail_closed:empty_slot_pool') sawEmptySlot = true;
      if (fixed.reason === 'bundle_selector_fail_closed:budget_infeasible') sawBudgetInfeasible = true;
      continue;
    }
    const candidate: AssignmentSolverSuccess & {
      readonly activeRowIndices: readonly number[];
      readonly selectionUtility: number;
    } = {
      ...fixed,
      activeRowIndices: selectedRows,
      selectionUtility: selectionUtility?.(selectedRows) ?? 0,
    };
    if (bestSolved === undefined) {
      bestSolved = candidate;
      continue;
    }
    if (candidate.selectionUtility > bestSolved.selectionUtility) {
      bestSolved = candidate;
      continue;
    }
    if (candidate.selectionUtility < bestSolved.selectionUtility) {
      continue;
    }
    if (candidate.totalCost < bestSolved.totalCost - COST_EQUALITY_EPSILON) {
      bestSolved = candidate;
      continue;
    }
    if (Math.abs(candidate.totalCost - bestSolved.totalCost) <= COST_EQUALITY_EPSILON) {
      const candidateLex = JSON.stringify(candidate.activeRowIndices) + JSON.stringify(candidate.assignedColumns);
      const bestLex = JSON.stringify(bestSolved.activeRowIndices) + JSON.stringify(bestSolved.assignedColumns);
      if (candidateLex < bestLex) {
        bestSolved = candidate;
      }
    }
  }

  if (bestSolved !== undefined) {
    return bestSolved;
  }
  if (sawEmptySlot) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:empty_slot_pool',
    };
  }
  if (sawBudgetInfeasible) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:budget_infeasible',
    };
  }
  if (sawKLimit) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:k_exceeds_exact_limit',
    };
  }
  return {
    solved: false,
    reason: 'bundle_selector_fail_closed:group_obligation_unsatisfied',
  };
}

function solveAssignmentFixedRows(
  input: {
    readonly costMatrix: readonly (readonly number[])[];
    readonly budgetConstraints?: readonly AssignmentBudgetConstraint[];
  },
): AssignmentSolverResult {
  const matrix = input.costMatrix;
  const k = matrix.length;
  if (k === 0) {
    return {
      solved: true,
      activeRowIndices: [],
      assignedColumns: [],
      totalCost: 0,
      penaltyPaid: 0,
      tieBreakReason: 'unique',
    };
  }
  if (k > K_EXACT_LIMIT) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:k_exceeds_exact_limit',
    };
  }

  // Unify column width across rows by padding with UNASSIGNABLE_PENALTY.
  let width = 0;
  for (const row of matrix) {
    if (row.length === 0) {
      return {
        solved: false,
        reason: 'bundle_selector_fail_closed:empty_slot_pool',
      };
    }
    if (row.length > width) width = row.length;
  }

  const padded: number[][] = [];
  for (let r = 0; r < k; r += 1) {
    const src = matrix[r] ?? [];
    const padRow: number[] = [];
    for (let c = 0; c < width; c += 1) {
      const cell = src[c];
      padRow.push(
        typeof cell === 'number' && Number.isFinite(cell)
          ? cell
          : UNASSIGNABLE_PENALTY,
      );
    }
    padded.push(padRow);
  }

  // Distinct-column assignment requires columns >= rows. If the pool
  // is too narrow we pad virtual columns (all rows see
  // UNASSIGNABLE_PENALTY for those); the optimum will then be
  // dominated by real columns unless no feasible solution exists at
  // all.
  if (width < k) {
    for (let r = 0; r < k; r += 1) {
      const row = padded[r];
      if (row === undefined) continue;
      while (row.length < k) row.push(UNASSIGNABLE_PENALTY);
    }
    width = k;
  }

  const budgetConstraints = input.budgetConstraints ?? [];

  // Enumerate permutations of k distinct columns out of `width`.
  type Candidate = {
    readonly perm: readonly number[];
    readonly cost: number;
    readonly penalty: number;
    readonly unassignableCount: number;
  };

  let best: Candidate | undefined;
  let tieCount = 0;

  const current: number[] = [];
  const used: boolean[] = [];
  for (let i = 0; i < width; i += 1) used.push(false);

  const evaluate = (perm: readonly number[]): Candidate => {
    let cost = 0;
    let unassignableCount = 0;
    for (let r = 0; r < k; r += 1) {
      const col = perm[r];
      if (col === undefined) continue;
      const row = padded[r];
      if (row === undefined) continue;
      const cell = row[col];
      if (cell === undefined) continue;
      cost += cell;
      if (cell >= UNASSIGNABLE_PENALTY) {
        unassignableCount += 1;
      }
    }
    let penalty = 0;
    for (const budget of budgetConstraints) {
      let subsetSum = 0;
      for (const rowIdx of budget.rows) {
        const col = perm[rowIdx];
        if (col === undefined) continue;
        subsetSum += budget.cellCost(rowIdx, col);
      }
      if (subsetSum > budget.ceiling) {
        penalty += BUDGET_OVERFLOW_PENALTY * (subsetSum - budget.ceiling);
      }
    }
    return { perm, cost, penalty, unassignableCount };
  };

  /**
   * Three-valued comparison — returns negative when `a` strictly beats
   * `b` in total cost, positive when `b` wins, 0 only when the totals
   * are equal (epsilon-bounded). Lex tie-break is applied separately
   * so that the caller can still count cost-equal ties.
   */
  const compareTotals = (a: Candidate, b: Candidate): number => {
    if (a.unassignableCount !== b.unassignableCount) {
      return a.unassignableCount - b.unassignableCount;
    }
    const penaltyDiff = a.penalty - b.penalty;
    if (Math.abs(penaltyDiff) > COST_EQUALITY_EPSILON) {
      return penaltyDiff;
    }
    const diff = a.cost - b.cost;
    if (Math.abs(diff) <= COST_EQUALITY_EPSILON) return 0;
    return diff;
  };

  const compareLex = (a: readonly number[], b: readonly number[]): number => {
    for (let i = 0; i < a.length && i < b.length; i += 1) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      if (ai !== bi) return ai - bi;
    }
    return 0;
  };

  const recurse = (row: number): void => {
    if (row === k) {
      const cand = evaluate([...current]);
      if (best === undefined) {
        best = cand;
        tieCount = 0;
        return;
      }
      const cmp = compareTotals(cand, best);
      if (cmp < 0) {
        best = cand;
        tieCount = 0;
        return;
      }
      if (cmp > 0) return;
      // Cost-equal tie: record the tie and keep the lex-smallest perm.
      tieCount += 1;
      if (compareLex(cand.perm, best.perm) < 0) {
        best = cand;
      }
      return;
    }
    for (let c = 0; c < width; c += 1) {
      if (used[c] === true) continue;
      used[c] = true;
      current[row] = c;
      recurse(row + 1);
      used[c] = false;
    }
  };

  recurse(0);

  if (best === undefined) {
    // Unreachable for k > 0, width >= k; defensive guard retained.
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:empty_slot_pool',
    };
  }

  // Feasibility check — if the best permutation still has any
  // UNASSIGNABLE_PENALTY cell AND budget penalty, the problem is
  // hard-infeasible and we fail closed. UNASSIGNABLE alone means a
  // virtual column was chosen (no real candidate), which is also
  // infeasible in selector terms.
  const hasUnassignable = best.unassignableCount > 0;
  const hasBudgetOverflow = best.penalty > 0;
  if (hasUnassignable) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:empty_slot_pool',
    };
  }
  if (hasBudgetOverflow) {
    return {
      solved: false,
      reason: 'bundle_selector_fail_closed:budget_infeasible',
    };
  }

  return {
    solved: true,
    activeRowIndices: matrix.map((_, index) => index),
    assignedColumns: best.perm,
    totalCost: best.cost,
    penaltyPaid: best.penalty,
    tieBreakReason: tieCount > 0 ? 'lex_smallest' : 'unique',
  };
}
