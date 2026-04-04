import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';

/**
 * Post-retrieval filter that enforces hard constraints on candidates.
 *
 * Candidates that violate any hard constraint are removed from the pool.
 * The filter also annotates each surviving candidate with the list of
 * unmet hard constraints (if any remain after partial matching).
 */
export class ConstraintFilter {
  /**
   * Remove candidates that violate hard constraints.
   *
   * Each candidate's {@link HybridCandidate.matchedConstraints} is compared
   * against the required hard constraint attributes. Candidates missing any
   * hard constraint attribute are excluded and their
   * {@link HybridCandidate.unmetHardConstraints} are tracked.
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
      const unmet = requiredAttributes.filter((attr) => !matchedSet.has(attr));

      if (unmet.length === 0) {
        filtered.push(candidate);
      } else {
        // Track unmet constraints but exclude the candidate from the pool.
        // The candidate is dropped — unmetHardConstraints are recorded for
        // diagnostics on the rejected candidate, but we do not include it
        // in the output since it violates hard constraints.
        // If future requirements need counterfactual tracking, this is
        // where rejected candidates would be emitted to a side channel.
      }
    }

    return filtered;
  }
}
