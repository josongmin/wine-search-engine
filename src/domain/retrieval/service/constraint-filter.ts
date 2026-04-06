import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';

/**
 * Post-retrieval filter that enforces hard constraints on candidates.
 *
 * Candidates that violate any hard constraint are removed from the pool.
 * Constraint evidence is expected to be precomputed on the candidate
 * (`matchedConstraints`, `unmetHardConstraints`) before this filter runs.
 */
export class ConstraintFilter {
  /**
   * Remove candidates that violate hard constraints.
   *
   * Each candidate's precomputed hard-constraint evidence is compared against
   * the required hard constraint attributes. Candidates missing any hard
   * constraint attribute are excluded.
   *
   * @param candidates - The candidate pool to filter.
   * @param constraints - Hard constraints that must be satisfied.
   * @returns Candidates that satisfy all hard constraints.
   */
  applyHardFilters(
    candidates: readonly HybridCandidate[],
    constraints: readonly NormalizedConstraint[],
  ): readonly HybridCandidate[] {
    if (constraints.length === 0) {
      return candidates;
    }

    const requiredAttributes = constraints.map((c) => c.attribute);

    const filtered: HybridCandidate[] = [];

    for (const candidate of candidates) {
      const matchedSet = new Set(candidate.matchedConstraints);
      const unmet = candidate.unmetHardConstraints
        ?? requiredAttributes.filter((attr) => !matchedSet.has(attr));

      if (unmet.length === 0) {
        filtered.push(candidate);
      }
    }

    return filtered;
  }
}
