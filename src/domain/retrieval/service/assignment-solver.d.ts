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
export declare const K_EXACT_LIMIT = 5;
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
export type AssignmentSolverFailReason = 'bundle_selector_fail_closed:k_exceeds_exact_limit' | 'bundle_selector_fail_closed:budget_infeasible' | 'bundle_selector_fail_closed:empty_slot_pool' | 'bundle_selector_fail_closed:group_obligation_unsatisfied';
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
type AssignmentSolverResult = AssignmentSolverSuccess | AssignmentSolverFailure;
/**
 * Solve a K-row assignment exactly for K ≤ K_EXACT_LIMIT.
 *
 * Empty input (`costMatrix.length === 0`) returns a trivial success
 * with an empty permutation — the graph executor treats this as a
 * no-op. Any row with zero columns returns
 * `'bundle_selector_fail_closed:empty_slot_pool'`.
 */
export declare function solveAssignmentExact(input: AssignmentSolverInput): AssignmentSolverResult;
export {};
//# sourceMappingURL=assignment-solver.d.ts.map