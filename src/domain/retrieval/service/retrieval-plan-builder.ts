/**
 * RFC-019 Stage 6: Retrieval Plan Builder
 *
 * Converts a ConstraintBundle into a structured RetrievalPlan with three
 * distinct tiers:
 *
 *   1. HARD filter tokens (Vespa YQL WHERE clauses) — gating
 *   2. SOFT boost tokens (post-retrieval ranking features) — scoring
 *   3. INFERRED expansion tokens (ranking features + sensory priors) — priors
 *
 * The existing pipeline conflates soft and inferred: both flow to
 * `computeSoftConstraint()` with inferred at INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER
 * (currently 0.7x) weight. This module separates
 * them structurally so the ranker can weight them independently and so the
 * downstream RFC-018 drinking window predictor can consume inferred sensory
 * priors as fallbacks for missing index values.
 *
 * Design contract (RFC-019 §6.6):
 *   - Hard filters are UNCHANGED (same tokens as hardConstraintsToSparseFilterTokens)
 *   - Soft boosts are a new STRUCTURED list — not flat YQL, stay in memory
 *   - Inferred expansions are SEPARATED from soft and can include sensory
 *     priors (tannin/body/acidity/sweetness) for Phase 7 integration
 */

import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';

/** A scoring boost/expansion signal derived from a constraint. */
export interface BoostSignal {
  /** The attribute name (e.g. 'grape_family', 'tannin'). */
  readonly attribute: string;
  /** The target value for matching. */
  readonly value: NormalizedConstraint['value'];
  /** Operator for matching (e.g. '=', 'in', '>='). */
  readonly operator: NormalizedConstraint['operator'];
  /** Score contribution weight in [0,1]. Higher = stronger boost. */
  readonly weight: number;
  /** Provenance (source constraint's mapping_version). */
  readonly source: string;
}

/** Inferred sensory prior — fallback for missing index values (RFC-018 integration). */
export interface SensoryPrior {
  readonly attribute: 'body' | 'tannin' | 'acidity' | 'sweetness';
  /** Target value on normalized [0,1] scale. */
  readonly value: number;
  /** Confidence of the prior (originating constraint's confidence). */
  readonly confidence: number;
  /** Source — which composition rule or ontology edge produced this. */
  readonly source: string;
}

/** Structured retrieval plan — three tiers. */
export interface RetrievalPlan {
  /** Hard YQL filter tokens — gating. */
  readonly hardFilterTokens: readonly string[];
  /** Soft boost signals — applied post-retrieval by ranker. */
  readonly softBoosts: readonly BoostSignal[];
  /** Inferred expansion boosts — independent weight from soft. */
  readonly inferredBoosts: readonly BoostSignal[];
  /** Sensory priors for RFC-018 fallback (body/tannin/acidity/sweetness). */
  readonly sensoryPriors: readonly SensoryPrior[];
  /** Plan version for replay parity. */
  readonly planVersion: string;
}

const PLAN_VERSION = 'retrieval-plan-v1.0';
const INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER = 0.7;

/** Sensory attribute keys that flow to RFC-018 drinking window. */
const SENSORY_KEYS: ReadonlySet<string> = new Set(['body', 'tannin', 'acidity', 'sweetness']);

/**
 * Build a structured retrieval plan from a constraint bundle.
 *
 * Hard constraints → existing filter tokens (unchanged path).
 * Soft constraints → boost signals with weight proportional to confidence.
 * Inferred constraints → boost signals AND sensory priors (if applicable).
 */
export function buildRetrievalPlan(bundle: ConstraintBundle): RetrievalPlan {
  const hardFilterTokens = [...hardConstraintsToSparseFilterTokens(bundle.hard)];

  const softBoosts: BoostSignal[] = bundle.soft.map((c) => ({
    attribute: c.attribute,
    value: c.value,
    operator: c.operator,
    weight: c.confidence,
    source: c.mapping_version ?? 'unknown',
  }));

  const inferredBoosts: BoostSignal[] = [];
  const sensoryPriors: SensoryPrior[] = [];

  for (const c of bundle.inferred) {
    // Sensory attributes with numeric value → also produce SensoryPrior.
    if (SENSORY_KEYS.has(c.attribute) && typeof c.value === 'number') {
      sensoryPriors.push({
        attribute: c.attribute as SensoryPrior['attribute'],
        value: c.value,
        confidence: c.confidence,
        source: c.mapping_version ?? 'unknown',
      });
    }
    // All inferred constraints contribute a boost (same boost semantics).
    inferredBoosts.push({
      attribute: c.attribute,
      value: c.value,
      operator: c.operator,
      // Inferred is weaker than soft by design — reduce weight by 0.7x.
      // This replaces the 0.5x hard-coded factor buried in signal-computer,
      // making the relationship explicit and tunable.
      weight: c.confidence * INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER,
      source: c.mapping_version ?? 'unknown',
    });
  }

  return {
    hardFilterTokens,
    softBoosts,
    inferredBoosts,
    sensoryPriors,
    planVersion: PLAN_VERSION,
  };
}

/** Plan version constant (for trace). */
export function retrievalPlanVersion(): string {
  return PLAN_VERSION;
}
