import type { NormalizedConstraint } from '../../shared/types/index.js';
/**
 * Maps planner hard constraints to Vespa sparse filter tokens understood by
 * {@link buildSparseFilters} (`src/infrastructure/vespa/mapping.ts`).
 *
 * Skips attributes that cannot be expressed as index filters or would
 * duplicate lexical intent (e.g. free-text `region` without a schema filter).
 */
export declare function hardConstraintsToSparseFilterTokens(constraints: readonly NormalizedConstraint[]): readonly string[];
//# sourceMappingURL=constraint-to-sparse-filter-tokens.d.ts.map