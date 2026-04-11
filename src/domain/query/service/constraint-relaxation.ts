/**
 * Progressive constraint relaxation — no-result recovery.
 *
 * When a query with hard constraints returns zero results, this module
 * computes a sequence of relaxed constraint bundles to retry with.
 *
 * Relaxation ladder (ordered by specificity — most specific removed first):
 *   Tier 1 — appellation  (narrowest geography)
 *   Tier 2 — region       (mid geography)
 *   Tier 3 — country      (broadest geography)
 *   Tier 4 — vintage_year (temporal)
 *   Tier 5 — alcohol_pct  (physical spec)
 *   Tier 6 — grape_primary (variety)
 *   [wine_type, classification are never relaxed — semantically load-bearing]
 *
 * The caller (pipeline layer) decides how many tiers to attempt and whether
 * to surface the degradation reason to the response builder.
 *
 * Design goals:
 *   - Pure: no I/O, no side effects, deterministic output for a given input.
 *   - Auditable: every relaxed plan carries a `relaxedAttributes` list so
 *     downstream can attach a "results may not match all criteria" banner.
 *   - Conservative: wine_type and classification are NEVER relaxed — a user
 *     asking for red wine must not receive champagne.
 */

import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';

/**
 * Attributes that are NEVER removed during relaxation.
 * Relaxing these would produce semantically wrong results (e.g. red → sparkling).
 */
const HARD_FLOOR_ATTRIBUTES = new Set([
  'wine_type',
  'color',
  'classification',
]);

/**
 * Priority order for relaxation: first element is removed first.
 * Attributes not in this list are removed last (after all listed ones).
 */
const RELAXATION_PRIORITY: readonly string[] = [
  'appellation',
  'region',
  'country',
  'vintage_year',
  'vintage',
  'alcohol_pct',
  'alcohol',
  'grape_primary',
];

export interface RelaxedConstraintPlan {
  /** Relaxed constraint bundle to retry with. */
  readonly constraints: ConstraintBundle;
  /** Attributes removed from the hard list in this relaxation step. */
  readonly relaxedAttributes: ReadonlyArray<string>;
}

/**
 * Build the full relaxation ladder for a given constraint bundle.
 *
 * Returns an ordered array of progressively relaxed plans.
 * Each plan removes one more attribute from the hard constraints.
 * The last plan (if all relaxable constraints are removed) may have an empty
 * hard list — effectively a semantic-only search.
 *
 * @example
 * const ladder = buildRelaxationLadder(bundle);
 * // ladder[0] removes appellation only
 * // ladder[1] removes appellation + region
 * // ...
 */
export function buildRelaxationLadder(
  bundle: ConstraintBundle,
): ReadonlyArray<RelaxedConstraintPlan> {
  // Split hard constraints into floor (never relaxed) and relaxable sets.
  const floorConstraints: NormalizedConstraint[] = [];
  const relaxableConstraints: NormalizedConstraint[] = [];

  for (const c of bundle.hard) {
    if (HARD_FLOOR_ATTRIBUTES.has(c.attribute)) {
      floorConstraints.push(c);
    } else {
      relaxableConstraints.push(c);
    }
  }

  // Nothing to relax — return empty ladder.
  if (relaxableConstraints.length === 0) {
    return [];
  }

  // Deduplicate by attribute: multiple constraints on the same attribute
  // (e.g. vintage_year >= 2018 AND vintage_year <= 2022) are treated as a
  // single relaxation unit — removing the attribute removes ALL constraints
  // on it simultaneously. This prevents duplicate entries in relaxedAttributes
  // (e.g. ['vintage_year', 'vintage_year']) and ensures each ladder step
  // represents exactly one semantic relaxation decision.
  const seenAttributes = new Set<string>();
  const uniqueRelaxableAttributes: string[] = [];
  for (const c of relaxableConstraints) {
    if (!seenAttributes.has(c.attribute)) {
      seenAttributes.add(c.attribute);
      uniqueRelaxableAttributes.push(c.attribute);
    }
  }

  // Sort unique relaxable attributes by relaxation priority.
  // Attributes in RELAXATION_PRIORITY come first (index ascending),
  // then remaining attributes in original insertion order (stable sort).
  const sortedAttributes = [...uniqueRelaxableAttributes].sort((a, b) => {
    const ai = RELAXATION_PRIORITY.indexOf(a);
    const bi = RELAXATION_PRIORITY.indexOf(b);
    const aNorm = ai === -1 ? RELAXATION_PRIORITY.length : ai;
    const bNorm = bi === -1 ? RELAXATION_PRIORITY.length : bi;
    return aNorm - bNorm;
  });

  // Build ladder: each step removes one more attribute (and ALL its constraints)
  // from the hard list.
  const ladder: RelaxedConstraintPlan[] = [];
  const removedAttributesSoFar = new Set<string>();

  for (const attrToRemove of sortedAttributes) {
    removedAttributesSoFar.add(attrToRemove);

    // New hard list: floor constraints + relaxable constraints whose attribute
    // has not yet been removed.
    const newHard = [
      ...floorConstraints,
      ...relaxableConstraints.filter((c) => !removedAttributesSoFar.has(c.attribute)),
    ];

    // Also filter inferred constraints on relaxed attributes: inferred constraints
    // share the same attribute namespace as hard constraints. If we relax 'appellation'
    // from hard but leave 'appellation' in inferred, the browse path
    // (extractRegionBrowseSeed) may re-introduce it, defeating the relaxation.
    const newInferred = bundle.inferred.filter(
      (c) => !removedAttributesSoFar.has(c.attribute),
    );

    ladder.push({
      constraints: {
        hard: newHard,
        soft: bundle.soft,
        inferred: newInferred,
      },
      relaxedAttributes: [...removedAttributesSoFar],
    });
  }

  return ladder;
}

/**
 * Return the single next relaxation step from the current constraint bundle.
 *
 * Useful when the caller wants to retry once (not build the full ladder).
 * Returns `undefined` if no further relaxation is possible.
 */
export function relaxOneStep(
  bundle: ConstraintBundle,
): RelaxedConstraintPlan | undefined {
  const ladder = buildRelaxationLadder(bundle);
  return ladder[0];
}
