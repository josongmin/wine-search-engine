import type {
  ConstraintBundle,
  NormalizedConstraint,
  EntityId,
} from '../../shared/types/index.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';
import { toFiniteNumber } from '../../shared/utils/safe-number.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';
import { compareScoreWithTiebreaker } from '../../shared/utils/stable-comparator.js';

/**
 * Weight multiplier for inferred constraints (lower than explicit constraints).
 */
const INFERRED_CONSTRAINT_WEIGHT = 0.5;

/**
 * Score penalty per unmet soft constraint, scaled by constraint confidence.
 */
const SOFT_PENALTY_FACTOR = 0.1;

/**
 * Applies user constraints on top of anchor-similarity ranked results.
 *
 * The constraint overlay performs three operations in sequence:
 * 1. **Hard constraint gate**: removes candidates that violate any hard constraint.
 * 2. **Exclude constraint filter**: removes candidates matching "exclude" operator
 *    constraints (RFC-005 section 5.1.1 "~말고" pattern).
 * 3. **Soft/inferred constraint adjustment**: adjusts scores based on
 *    soft and inferred constraint satisfaction.
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class ConstraintOverlay {
  /**
   * Applies all constraint overlays to ranked results.
   *
   * @param results - Ranked results from the anchor-similarity ranking pass.
   * @param constraints - The constraint bundle to overlay.
   * @param candidateAttributes - Map from entity ID to attribute key-value pairs.
   * @returns Filtered and score-adjusted ranked results.
   */
  apply(
    results: readonly RankedResult[],
    constraints: ConstraintBundle,
    candidateAttributes: ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>,
  ): readonly RankedResult[] {
    let filtered = [...results];

    // Step 1: Hard constraint gate — remove violators
    filtered = this.applyHardConstraints(
      filtered,
      constraints.hard,
      candidateAttributes,
    );

    // Step 2: Exclude constraints — remove matching candidates
    filtered = this.applyExcludeConstraints(
      filtered,
      [...constraints.hard, ...constraints.soft, ...constraints.inferred],
      candidateAttributes,
    );

    // Step 3: Soft constraint score adjustment
    filtered = this.applySoftConstraints(
      filtered,
      constraints.soft,
      candidateAttributes,
    );

    // Step 4: Inferred constraint adjustment (additive, lower weight)
    filtered = this.applyInferredConstraints(
      filtered,
      constraints.inferred,
      candidateAttributes,
    );

    // Re-sort by adjusted score with NaN-safe + deterministic tiebreaker
    // (entityId). Previously raw `b.finalScore - a.finalScore` propagated NaN
    // and produced order-dependent ties. (Bugbash R19)
    filtered.sort(
      compareScoreWithTiebreaker<RankedResult>(
        (r) => r.finalScore,
        (r) => String(r.entityId),
      ),
    );

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  /**
   * Filters out candidates that violate any hard constraint.
   * Hard constraints are gates: violate → removal.
   */
  private applyHardConstraints(
    results: readonly RankedResult[],
    hardConstraints: readonly NormalizedConstraint[],
    candidateAttributes: ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>,
  ): RankedResult[] {
    if (hardConstraints.length === 0) {
      return [...results];
    }

    return results.filter((result) => {
      const attrs = candidateAttributes.get(result.entityId);
      if (attrs === undefined) {
        return false;
      }

      return hardConstraints.every((constraint) =>
        this.evaluateConstraint(attrs, constraint),
      );
    });
  }

  /**
   * Removes candidates that match "exclude" operator constraints.
   * Implements RFC-005 section 5.1.1 "~말고" (except/exclude) pattern.
   */
  private applyExcludeConstraints(
    results: readonly RankedResult[],
    allConstraints: readonly NormalizedConstraint[],
    candidateAttributes: ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>,
  ): RankedResult[] {
    const excludeConstraints = allConstraints.filter(
      (c) => c.operator === 'exclude',
    );

    if (excludeConstraints.length === 0) {
      return [...results];
    }

    return results.filter((result) => {
      const attrs = candidateAttributes.get(result.entityId);
      if (attrs === undefined) {
        return false;
      }

      // If ANY exclude constraint matches, remove the candidate
      return !excludeConstraints.some((constraint) => {
        const attrValue = attrs[constraint.attribute];
        if (attrValue === undefined) {
          return false;
        }
        return this.matchesExclude(attrValue, constraint.value);
      });
    });
  }

  /**
   * Adjusts scores based on soft constraint satisfaction.
   * Each unmet soft constraint reduces the score proportionally.
   */
  private applySoftConstraints(
    results: readonly RankedResult[],
    softConstraints: readonly NormalizedConstraint[],
    candidateAttributes: ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>,
  ): RankedResult[] {
    if (softConstraints.length === 0) {
      return [...results];
    }

    return results.map((result) => {
      const attrs = candidateAttributes.get(result.entityId);
      if (attrs === undefined) {
        return result;
      }

      let penalty = 0;
      for (const constraint of softConstraints) {
        if (!this.evaluateConstraint(attrs, constraint)) {
          penalty += SOFT_PENALTY_FACTOR * constraint.confidence;
        }
      }

      if (penalty === 0) {
        return result;
      }

      return {
        ...result,
        finalScore: Math.max(0, result.finalScore - penalty),
      };
    });
  }

  /**
   * Applies inferred constraints at reduced weight.
   * Inferred constraints are additive bonuses rather than penalties.
   */
  private applyInferredConstraints(
    results: readonly RankedResult[],
    inferredConstraints: readonly NormalizedConstraint[],
    candidateAttributes: ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>,
  ): RankedResult[] {
    if (inferredConstraints.length === 0) {
      return [...results];
    }

    return results.map((result) => {
      const attrs = candidateAttributes.get(result.entityId);
      if (attrs === undefined) {
        return result;
      }

      let bonus = 0;
      for (const constraint of inferredConstraints) {
        if (
          constraint.operator !== 'exclude' &&
          this.evaluateConstraint(attrs, constraint)
        ) {
          bonus +=
            SOFT_PENALTY_FACTOR *
            constraint.confidence *
            INFERRED_CONSTRAINT_WEIGHT;
        }
      }

      if (bonus === 0) {
        return result;
      }

      return {
        ...result,
        finalScore: Math.min(1, result.finalScore + bonus),
      };
    });
  }

  /**
   * Evaluates whether a candidate's attributes satisfy a single constraint.
   */
  private evaluateConstraint(
    attrs: Readonly<Record<string, unknown>>,
    constraint: NormalizedConstraint,
  ): boolean {
    const value = attrs[constraint.attribute];
    if (value === undefined) {
      return false; // Missing attribute → constraint not satisfied
    }

    switch (constraint.operator) {
      case '=':
        return (
          ConstraintOverlay.toComparableString(value).toLowerCase() ===
          ConstraintOverlay.toComparableString(constraint.value).toLowerCase()
        );

      case '<=': {
        if (typeof value !== 'number') return false;
        const bound = toFiniteNumber(constraint.value);
        if (bound === null) return false;
        return value <= bound;
      }

      case '>=': {
        if (typeof value !== 'number') return false;
        const bound = toFiniteNumber(constraint.value);
        if (bound === null) return false;
        return value >= bound;
      }

      case 'range': {
        if (typeof value !== 'number') return false;
        const rv: unknown = constraint.value;
        if (typeof rv !== 'object' || rv === null || Array.isArray(rv)) return false;
        const range = rv as Record<string, unknown>;
        if (typeof range['min'] !== 'number' || typeof range['max'] !== 'number') return false;
        return value >= range['min'] && value <= range['max'];
      }

      case 'in': {
        if (!Array.isArray(constraint.value)) return false;
        const allowed = constraint.value as readonly string[];
        return allowed.some(
          (a) =>
            ConstraintOverlay.toComparableString(a).toLowerCase() ===
            ConstraintOverlay.toComparableString(value).toLowerCase(),
        );
      }

      case 'exclude':
        // Returns true when value does NOT match the exclusion (constraint satisfied).
        // Returns false when value matches the exclusion (constraint violated → penalty).
        return !this.matchesExclude(value, constraint.value);

      default:
        return false;
    }
  }

  /**
   * Checks if a candidate attribute value matches an exclude constraint value.
   */
  private matchesExclude(
    attrValue: unknown,
    constraintValue: string | number | { min: number; max: number } | ReadonlyArray<string>,
  ): boolean {
    if (Array.isArray(constraintValue)) {
      return constraintValue.some(
        (v) =>
          ConstraintOverlay.toComparableString(v).toLowerCase() ===
          ConstraintOverlay.toComparableString(attrValue).toLowerCase(),
      );
    }
    return (
      ConstraintOverlay.toComparableString(attrValue).toLowerCase() ===
      ConstraintOverlay.toComparableString(constraintValue).toLowerCase()
    );
  }

  /** Safe string form for comparing constraint operands (avoids `[object Object]`).
   *  Uses canonicalJsonStringify so {min,max} and {max,min} compare equal. */
  private static toComparableString(v: unknown): string {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
    return canonicalJsonStringify(v);
  }
}
