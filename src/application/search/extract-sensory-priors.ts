/**
 * RFC-019 Phase 7 helper: Extract query-level sensory priors from the
 * planner's compositional inference output for RFC-018 drinking-window fallback.
 *
 * Takes the `inferred` bundle and filters to body/tannin/acidity/sweetness
 * entries with concrete numeric values and '>=' operator (composition rules
 * emit '>=' priors like `tannin ≥ 0.55`).
 *
 * Returned values are floor values — the predictor treats them as "at least
 * this value, fall back to neutral=0.5 if even the floor is unknown".
 */

import type { ConstraintBundle } from '../../domain/shared/types/index.js';
import { SENSORY_PRIOR_ATTRIBUTES } from '../../domain/shared/constants/constraint-attributes.js';
import type { RetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import type { QueryLevelSensoryPriors } from './search-usecase-map-result-items.js';

export function extractSensoryPriorsFromConstraints(
  constraints: ConstraintBundle,
): QueryLevelSensoryPriors | undefined {
  const out: { -readonly [K in keyof QueryLevelSensoryPriors]: number } = {};
  let found = false;
  for (const c of constraints.inferred) {
    if (!SENSORY_PRIOR_ATTRIBUTES.has(c.attribute)) continue;
    if (typeof c.value !== 'number') continue;
    if (c.operator !== '>=' && c.operator !== '=') continue;
    const key = c.attribute as keyof QueryLevelSensoryPriors;
    // First-writer wins for a given attribute (priors are deterministic).
    if (out[key] !== undefined) continue;
    out[key] = c.value;
    found = true;
  }
  return found ? (out as QueryLevelSensoryPriors) : undefined;
}

export function extractSensoryPriorsFromRetrievalPlan(
  retrievalPlan: RetrievalPlan | undefined,
): QueryLevelSensoryPriors | undefined {
  if (retrievalPlan === undefined || retrievalPlan.sensoryPriors.length === 0) {
    return undefined;
  }
  const out: { -readonly [K in keyof QueryLevelSensoryPriors]: number } = {};
  let found = false;
  for (const prior of retrievalPlan.sensoryPriors) {
    if (out[prior.attribute] !== undefined) continue;
    out[prior.attribute] = prior.value;
    found = true;
  }
  return found ? (out as QueryLevelSensoryPriors) : undefined;
}
