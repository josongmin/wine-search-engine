/**
 * ADR-011 Phase 1b.3a: shared helper resolving "required / matched / unmet
 * constraint attributes" for any reader that accepts an optional
 * {@link ConstraintGraph}.
 *
 * Single source of truth so `provenance-closure` and `decision-input` cannot
 * drift in XOR / OR semantics against each other. Callers that receive a
 * graph delegate through {@link computeGraphCoverage}; callers without a
 * graph fall back to the flat `plan.constraints.hard` attribute set, matching
 * the pre-Phase-1b.1 behaviour byte-for-byte.
 *
 * Phase 1b.3a scope: hard-tier required attributes only — identical to the
 * legacy flat behaviour. Soft / inferred tier resolution is deferred to
 * Phase 1b.3b along with the ranker migration.
 */

import type { QueryPlanV1 } from '../model/query-plan.js';
import type { ConstraintGraph } from '../model/constraint-graph.js';
import { computeGraphCoverage } from './compute-graph-coverage.js';

interface RequiredAttributeResolution {
  /** Unique required-and-matched attribute names, in deterministic order. */
  readonly matched: readonly string[];
  /** Unique required-but-unmet attribute names, in deterministic order. */
  readonly unmet: readonly string[];
  /**
   * Whether coverage obligations are met.
   *
   * - Graph path: the root group is satisfied under AND / OR / XOR semantics.
   * - Flat path: zero unmet hard attributes AND at least one hard attribute
   *   required (matches the pre-Phase-1b.1 `constraintEvidenceSatisfied`
   *   arithmetic).
   *
   * Callers mapping this into ProvenancePolicy-gated booleans layer the
   * `requireConstraintEvidence` check on top.
   */
  readonly satisfied: boolean;
}

interface ResolveRequiredAttributesInput {
  readonly plan: QueryPlanV1;
  readonly graph?: ConstraintGraph | undefined;
  /**
   * Attributes the retrieval/ranking layer reports as evidenced on the
   * candidates under evaluation (pre-rank: any candidate's matches; post-rank:
   * the top result's matches). The helper does not enforce uniqueness;
   * duplicates are tolerated.
   */
  readonly satisfiedAttributes: readonly string[];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function flatRequiredAttributes(plan: QueryPlanV1): readonly string[] {
  return unique(plan.constraints.hard.map((constraint) => constraint.attribute));
}

export function resolveRequiredAttributes(
  input: ResolveRequiredAttributesInput,
): RequiredAttributeResolution {
  const { plan, graph, satisfiedAttributes } = input;

  if (graph !== undefined) {
    const coverage = computeGraphCoverage(graph, new Set(satisfiedAttributes));
    return {
      matched: coverage.matchedAttributes,
      unmet: coverage.unmetAttributes,
      satisfied: coverage.rootSatisfied,
    };
  }

  const required = flatRequiredAttributes(plan);
  const matched = unique(
    satisfiedAttributes.filter((attribute) => required.includes(attribute)),
  );
  const unmet = required.filter((attribute) => !matched.includes(attribute));
  return {
    matched,
    unmet,
    // Legacy semantics: "satisfied" ≡ some attribute was required AND nothing unmet.
    // A plan with zero hard constraints is considered NOT satisfied here —
    // callers combine this with `ProvenancePolicy.requireConstraintEvidence`
    // to derive the downstream gate.
    satisfied: required.length > 0 && unmet.length === 0,
  };
}
