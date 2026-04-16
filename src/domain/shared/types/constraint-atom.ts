import type { NormalizedConstraint } from './constraint-bundle.js';

/**
 * E2-T1: ConstraintAtom — upgraded intermediate representation for a single
 * constraint, extending {@link NormalizedConstraint} with 5 semantic metadata
 * fields needed for conflict detection, authority ordering, and trace.
 *
 * Design invariants:
 *  - Backwards-compatible: every NormalizedConstraint can be lifted to a
 *    ConstraintAtom via `liftToAtom()` with sensible defaults.
 *  - No parallel truth: ConstraintAtom extends, not replaces, ConstraintBundle.
 *    The bundle (hard/soft/inferred tiers) remains the runtime contract;
 *    atoms are produced by ConstraintReasoner for conflict analysis.
 *  - `source_tier` mirrors bundle membership (hard/soft/inferred) as an atom
 *    field so the reasoner can operate on a flat list without losing tier info.
 */
export interface ConstraintAtom extends NormalizedConstraint {
  /**
   * Which bundle tier this constraint belongs to.
   * Mirrors ConstraintBundle.hard / .soft / .inferred membership.
   */
  readonly source_tier: ConstraintTier;

  /**
   * Where within the planner pipeline this constraint was produced.
   *
   * Tier ordering (RFC-002 §4):
   *   - `explicit_utterance`  — user typed it directly ("red wine", "under $50")
   *   - `implicit_slot`       — slot-filler pattern ("Burgundy" → region=Burgundy)
   *   - `planner_inferred`    — planner heuristics (recent vintage boost, etc.)
   *   - `session_carry`       — carried over from previous turns
   *   - `system_default`      — engine defaults (e.g. availability filter)
   */
  readonly source_kind: ConstraintSourceKind;

  /**
   * Relative authority when two constraints conflict.
   * Higher value wins. Unsigned integer — values defined per source_kind:
   *
   *   explicit_utterance  → 100
   *   implicit_slot       → 80
   *   planner_inferred    → 50
   *   session_carry       → 30
   *   system_default      → 10
   *
   * Same source_kind → authority = confidence (rounded to int).
   */
  readonly authority_level: number;

  /**
   * The attribute domain this constraint applies to.
   *
   * - `intrinsic`  — wine properties that can't change (grape, region, color)
   * - `extrinsic`  — external factors (price, availability, rating)
   * - `temporal`   — vintage year, aging, drinking window
   * - `relational` — similarity / dissimilarity to an anchor entity
   */
  readonly semantic_scope: ConstraintSemanticScope;

  /**
   * How conflicts involving this atom should be resolved.
   *
   * - `strict`      — this atom must win over lower-authority atoms
   * - `prefer`      — prefer this atom but allow soft override by equal-authority
   * - `relaxable`   — can be dropped under backtrack / clarification
   * - `informative` — purely diagnostic; never blocks results
   */
  readonly conflict_policy: ConstraintConflictPolicy;

  /**
   * Downstream execution role for this atom after provenance-aware typing.
   *
   * - `must_satisfy`   — hard execution obligation / evidence required
   * - `prefer`         — ranking prior / soft preference
   * - `contextual_hint`— recall or interpretation hint, not a blocking filter
   * - `exclusion`      — negative hard obligation (`exclude` / `not_in`)
   */
  readonly constraint_role: ConstraintRole;
}

/** Bundle tier that produced this atom. */
export type ConstraintTier = 'hard' | 'soft' | 'inferred';

/** Pipeline stage that originated the constraint. */
export type ConstraintSourceKind =
  | 'explicit_utterance'
  | 'implicit_slot'
  | 'planner_inferred'
  | 'session_carry'
  | 'system_default';

/** Attribute domain classification. */
export type ConstraintSemanticScope =
  | 'intrinsic'
  | 'extrinsic'
  | 'temporal'
  | 'relational';

/** Conflict resolution policy. */
export type ConstraintConflictPolicy =
  | 'strict'
  | 'prefer'
  | 'relaxable'
  | 'informative';

export type ConstraintRole =
  | 'must_satisfy'
  | 'prefer'
  | 'contextual_hint'
  | 'exclusion';

// ─── Authority level constants (SSoT) ────────────────────────────────────────

/** Default authority levels by source_kind (Rule 30: cross-module constants). */
export const CONSTRAINT_AUTHORITY_BY_SOURCE_KIND: Record<ConstraintSourceKind, number> = {
  explicit_utterance: 100,
  implicit_slot: 80,
  planner_inferred: 50,
  session_carry: 30,
  system_default: 10,
};

// ─── Lifting helper ──────────────────────────────────────────────────────────

/**
 * Lift a {@link NormalizedConstraint} to a {@link ConstraintAtom} using a
 * reasonable default for the new metadata fields.
 *
 * Callers that have richer context (e.g. the ConstraintReasoner which knows
 * how the constraint was extracted) should provide explicit values.
 *
 * @param constraint  The base constraint to lift.
 * @param tier        Which bundle tier it belongs to.
 * @param sourceKind  Override — defaults to `'explicit_utterance'` for hard
 *                    constraints, `'planner_inferred'` for inferred.
 */
export function liftToAtom(
  constraint: NormalizedConstraint,
  tier: ConstraintTier,
  sourceKind?: ConstraintSourceKind,
): ConstraintAtom {
  const resolvedKind: ConstraintSourceKind =
    sourceKind ??
    inferSourceKind(constraint, tier);

  const authority = CONSTRAINT_AUTHORITY_BY_SOURCE_KIND[resolvedKind];

  const semanticScope = inferSemanticScope(constraint.attribute);

  const conflictPolicy: ConstraintConflictPolicy =
    tier === 'hard' ? 'strict' : tier === 'soft' ? 'prefer' : 'relaxable';

  const constraintRole: ConstraintRole =
    constraint.operator === 'exclude' || constraint.operator === 'not_in'
      ? 'exclusion'
      : tier === 'hard'
        ? 'must_satisfy'
        : tier === 'soft'
          ? 'prefer'
          : 'contextual_hint';

  return {
    ...constraint,
    source_tier: tier,
    source_kind: resolvedKind,
    authority_level: authority,
    semantic_scope: semanticScope,
    conflict_policy: conflictPolicy,
    constraint_role: constraintRole,
  };
}

/**
 * Lift all constraints in a bundle to atoms, preserving tier information.
 *
 * Used by ConstraintReasoner to build a flat atom list for conflict analysis.
 */
export function liftBundleToAtoms(bundle: {
  readonly hard: ReadonlyArray<NormalizedConstraint>;
  readonly soft: ReadonlyArray<NormalizedConstraint>;
  readonly inferred: ReadonlyArray<NormalizedConstraint>;
}): readonly ConstraintAtom[] {
  const atoms: ConstraintAtom[] = [];
  for (const c of bundle.hard) {
    atoms.push(liftToAtom(c, 'hard'));
  }
  for (const c of bundle.soft) {
    atoms.push(liftToAtom(c, 'soft'));
  }
  for (const c of bundle.inferred) {
    atoms.push(liftToAtom(c, 'inferred'));
  }
  return atoms;
}

// ─── Semantic scope inference ────────────────────────────────────────────────

/** Wine attribute names that are intrinsic (fixed properties). */
const INTRINSIC_ATTRIBUTES = new Set([
  'wine_type',
  'grape_variety',
  'grape_primary',
  'grape_secondary',
  'region',
  'appellation',
  'country',
  'producer',
  'style',
  'color',
  'classification',
  'certifications',
  // Sensory profile attributes — intrinsic to the wine, not price/availability
  'body',
  'sweetness',
  'tannin',
  'acidity',
  'fruit_intensity',
]);

/** Wine attribute names that are temporal. */
const TEMPORAL_ATTRIBUTES = new Set([
  'vintage_year',
  'drinking_window_start',
  'drinking_window_end',
  'release_year',
]);

/** Wine attribute names that are relational. */
const RELATIONAL_ATTRIBUTES = new Set([
  'similar_to',
  'different_from',
  'anchor_entity',
  'compare_to',
]);

/**
 * Infer semantic scope from attribute name.
 * Falls back to 'extrinsic' (price, rating, availability) for unknown attributes.
 */
function inferSemanticScope(attribute: string): ConstraintSemanticScope {
  if (INTRINSIC_ATTRIBUTES.has(attribute)) return 'intrinsic';
  if (TEMPORAL_ATTRIBUTES.has(attribute)) return 'temporal';
  if (RELATIONAL_ATTRIBUTES.has(attribute)) return 'relational';
  return 'extrinsic';
}

function inferSourceKind(
  constraint: NormalizedConstraint,
  tier: ConstraintTier,
): ConstraintSourceKind {
  const rawSourcePhrase = (constraint as { readonly source_phrase?: unknown }).source_phrase;
  const sourcePhrase = typeof rawSourcePhrase === 'string' ? rawSourcePhrase : '';
  if (
    sourcePhrase.startsWith('entity_resolver(') ||
    sourcePhrase.startsWith('entity_shadow(') ||
    sourcePhrase.startsWith('llm_linker(') ||
    constraint.mapping_version?.startsWith('entity-resolver-') === true ||
    constraint.mapping_version?.startsWith('llm-') === true
  ) {
    return 'implicit_slot';
  }
  if (
    sourcePhrase.startsWith('ontology(') ||
    constraint.mapping_version?.startsWith('ontology-') === true ||
    constraint.mapping_version?.startsWith('compositional-') === true
  ) {
    return 'planner_inferred';
  }
  if (tier === 'inferred') {
    return 'planner_inferred';
  }
  if (tier === 'soft') {
    return 'implicit_slot';
  }
  return 'explicit_utterance';
}
