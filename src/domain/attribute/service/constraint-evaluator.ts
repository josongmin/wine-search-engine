import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { AttributeSpace } from '../model/attributes.js';
import type { ConstraintEvaluationResult } from '../model/constraint.js';

/** Soft constraint treated as "met" at or above this score. */
const SOFT_CONSTRAINT_MATCH_THRESHOLD = 0.5;
/** Partial credit when attribute missing (soft/inferred only). */
const SOFT_SCORE_MISSING_ATTRIBUTE = 0.3;

/**
 * Evaluates a {@link ConstraintBundle} against a candidate's attribute space.
 * Implements RFC-004 §5.
 *
 * - **Hard constraints**: All must be satisfied; if any fails, `hardPass` is false.
 * - **Soft constraints**: Penalty-based scoring; each unmet soft constraint reduces the score.
 * - **Inferred constraints**: Treated like soft constraints but tracked separately.
 */
export class ConstraintEvaluator {
  /**
   * Evaluates all constraints in the bundle against the candidate's attributes.
   *
   * @param constraints - The constraint bundle (hard, soft, inferred).
   * @param candidateAttributes - The candidate wine's attribute space.
   * @returns Evaluation result with pass/fail, score, and detailed match info.
   */
  evaluate(
    constraints: ConstraintBundle,
    candidateAttributes: AttributeSpace,
  ): ConstraintEvaluationResult {
    const matched: string[] = [];
    const unmet: string[] = [];
    const inferred: string[] = [];

    // Evaluate hard constraints — all must pass
    let hardPass = true;
    for (const c of constraints.hard) {
      if (this.satisfiesConstraint(c, candidateAttributes)) {
        matched.push(c.attribute);
      } else {
        hardPass = false;
        unmet.push(c.attribute);
      }
    }

    // Evaluate soft constraints — penalty-based scoring
    let softTotal = 0;
    let softCount = 0;
    for (const c of constraints.soft) {
      softCount++;
      const score = this.scoreConstraint(c, candidateAttributes);
      softTotal += score;
      if (score >= SOFT_CONSTRAINT_MATCH_THRESHOLD) {
        matched.push(c.attribute);
      } else {
        unmet.push(c.attribute);
      }
    }

    // Evaluate inferred constraints — same as soft but tracked separately
    for (const c of constraints.inferred) {
      softCount++;
      const score = this.scoreConstraint(c, candidateAttributes);
      softTotal += score;
      inferred.push(c.attribute);
      if (score < SOFT_CONSTRAINT_MATCH_THRESHOLD) {
        unmet.push(c.attribute);
      }
    }

    const softScore = softCount > 0 ? softTotal / softCount : 1.0;

    return {
      hardPass,
      softScore,
      matched,
      unmet,
      inferred,
    };
  }

  /**
   * Checks if a single constraint is satisfied (binary).
   * Used for hard constraints.
   */
  private satisfiesConstraint(
    constraint: NormalizedConstraint,
    attrs: AttributeSpace,
  ): boolean {
    const attrValue = this.getAttributeValue(constraint.attribute, attrs);

    // If the attribute is missing, the constraint cannot be satisfied
    if (attrValue === undefined) {
      return false;
    }

    return this.evaluateOperator(constraint.operator, attrValue, constraint.value);
  }

  /**
   * Scores how well a single constraint is satisfied (continuous [0, 1]).
   * Used for soft and inferred constraints.
   */
  private scoreConstraint(
    constraint: NormalizedConstraint,
    attrs: AttributeSpace,
  ): number {
    const attrValue = this.getAttributeValue(constraint.attribute, attrs);

    // Missing attribute: partial penalty (0.3) rather than full fail
    if (attrValue === undefined) {
      return SOFT_SCORE_MISSING_ATTRIBUTE;
    }

    if (this.evaluateOperator(constraint.operator, attrValue, constraint.value)) {
      return 1.0;
    }

    // Compute penalty based on distance from threshold
    if (typeof attrValue === 'number' && typeof constraint.value === 'number') {
      const distance = Math.abs(attrValue - constraint.value);
      return Math.max(0, 1.0 - distance * 2);
    }

    if (
      typeof attrValue === 'number' &&
      typeof constraint.value === 'object' &&
      !Array.isArray(constraint.value) &&
      'min' in constraint.value
    ) {
      const rangeValue = constraint.value as { min: number; max: number };
      if (attrValue < rangeValue.min) {
        const distance = rangeValue.min - attrValue;
        return Math.max(0, 1.0 - distance * 2);
      }
      if (attrValue > rangeValue.max) {
        const distance = attrValue - rangeValue.max;
        return Math.max(0, 1.0 - distance * 2);
      }
    }

    // Non-numeric mismatch: full penalty
    return 0;
  }

  /**
   * Evaluates an operator against an attribute value.
   */
  private evaluateOperator(
    operator: NormalizedConstraint['operator'],
    attrValue: string | number | readonly string[],
    constraintValue: NormalizedConstraint['value'],
  ): boolean {
    switch (operator) {
      case '=':
        return attrValue === constraintValue;

      case '<=':
        return typeof attrValue === 'number' &&
          typeof constraintValue === 'number' &&
          attrValue <= constraintValue;

      case '>=':
        return typeof attrValue === 'number' &&
          typeof constraintValue === 'number' &&
          attrValue >= constraintValue;

      case 'range': {
        if (
          typeof attrValue !== 'number' ||
          typeof constraintValue !== 'object' ||
          Array.isArray(constraintValue) ||
          !('min' in constraintValue)
        ) {
          return false;
        }
        const rangeVal = constraintValue as { min: number; max: number };
        return attrValue >= rangeVal.min && attrValue <= rangeVal.max;
      }

      case 'in': {
        if (Array.isArray(attrValue)) {
          // Attribute is an array (e.g. occasion, pairing); check overlap
          if (Array.isArray(constraintValue)) {
            return (constraintValue as readonly string[]).some(
              (v) => (attrValue as readonly string[]).includes(v),
            );
          }
          return (attrValue as readonly string[]).includes(constraintValue as string);
        }
        if (Array.isArray(constraintValue)) {
          return (constraintValue as readonly string[]).includes(attrValue as string);
        }
        return attrValue === constraintValue;
      }

      case 'exclude':
        return attrValue !== constraintValue;

      default:
        return false;
    }
  }

  /**
   * Retrieves an attribute value from the {@link AttributeSpace} by name.
   * Returns `undefined` if the attribute is not present.
   */
  private getAttributeValue(
    attribute: string,
    attrs: AttributeSpace,
  ): string | number | readonly string[] | undefined {
    switch (attribute) {
      case 'body':
        return attrs.body;
      case 'sweetness':
        return attrs.sweetness;
      case 'acidity':
        return attrs.acidity;
      case 'tannin':
        return attrs.tannin;
      case 'style':
        return attrs.style;
      case 'price_band':
        return attrs.priceBand;
      case 'pairing':
        return attrs.pairing;
      case 'occasion':
        return attrs.occasion;
      default:
        return undefined;
    }
  }
}
