import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import { liftBundleToAtoms } from '../../shared/types/constraint-atom.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/constraint-bundle.js';
import { regionAncestors } from '../../evaluation/service/wine-ontology.js';

/**
 * E2-T2: ConstraintRelation — semantic relationship between two constraint atoms.
 *
 * Produced by ConstraintReasoner after conflict analysis.
 */
export interface ConstraintRelation {
  /**
   * The type of relationship.
   *
   * - `contradiction`  — a and b cannot simultaneously be satisfied
   *                      (e.g. region=Bordeaux AND region=Burgundy, both hard '=')
   * - `redundancy`     — a and b are identical (same operator+value); the lower-
   *                      authority atom is dropped
   * - `overshadow`     — a and b have the same operator but different authority;
   *                      the lower-authority atom is dropped
   * - `soft_tension`   — a and b are soft constraints that pull in opposite
   *                      directions but don't logically exclude each other
   * - `subsumption`    — a and b are region constraints where one value is an
   *                      ontological ancestor of the other (e.g. Bordeaux ⊃ Pauillac).
   *                      Informative only — neither atom is dropped. The more specific
   *                      constraint (child) is the effective filter; the parent is
   *                      redundant but harmless.
   * - `implication`    — a constraint on attribute X implies a constraint on a
   *                      different attribute Y that is already present in the bundle
   *                      (e.g. region=Pauillac implies country=France, and country=France
   *                      already exists). Informative only — no atom is dropped.
   */
  readonly type: ConstraintRelationType;

  /** Index of the first atom in the atom array. */
  readonly atomIndexA: number;

  /** Index of the second atom. */
  readonly atomIndexB: number;

  /**
   * Which atom "wins" when the relation requires a resolution.
   * Undefined for informative relations (soft_tension, subsumption, implication).
   */
  readonly winner?: 'a' | 'b' | undefined;

  /**
   * Human-readable explanation of the relation for trace/debug output.
   */
  readonly explanation: string;
}

export type ConstraintRelationType =
  | 'contradiction'
  | 'redundancy'
  | 'overshadow'
  | 'soft_tension'
  | 'subsumption'
  | 'implication';

// ─── Reasoner output ─────────────────────────────────────────────────────────

/**
 * Output of ConstraintReasoner.reason() — flat atom list plus detected relations.
 *
 * The `resolvedBundle` is a deduplicated, conflict-resolved ConstraintBundle
 * that replaces the raw bundle for downstream use (retrieval plan, ranker).
 */
export interface ConstraintReasonerOutput {
  /** All atoms lifted from the original bundle. */
  readonly atoms: readonly ConstraintAtom[];

  /** Pairwise semantic relations detected between atoms. */
  readonly relations: readonly ConstraintRelation[];

  /**
   * Resolved bundle — contradictions removed (lower authority loses),
   * redundancies collapsed (one canonical atom per attribute per tier).
   *
   * This is the single bundle the ranker and retrieval plan should use.
   */
  readonly resolvedBundle: ConstraintBundle;

  /**
   * Atoms that were dropped during resolution (contradiction losers,
   * exact duplicates). Retained for trace/audit.
   */
  readonly droppedAtoms: readonly ConstraintAtom[];

  /**
   * Soft tensions detected — pairs of soft constraints that conflict weakly.
   * These are NOT dropped; they are flagged for the decision layer.
   */
  readonly softTensions: readonly ConstraintRelation[];
}

// ─── ConstraintReasoner service ──────────────────────────────────────────────

/**
 * E2-T2: ConstraintReasoner — inserted after Tier 6 (constraint extraction)
 * in the planner pipeline.
 *
 * Responsibilities:
 *  1. Lift all NormalizedConstraints in the bundle to ConstraintAtoms.
 *  2. Detect pairwise semantic relations (contradiction, redundancy, etc.).
 *  3. Resolve contradictions by authority_level (higher wins).
 *  4. Collapse exact redundancies.
 *  5. Return a clean ConstraintBundle + full relation trace.
 *
 * Does NOT modify planner state directly — it returns a new resolved bundle.
 * The planner decides whether to substitute the original bundle.
 */
export class ConstraintReasoner {
  /**
   * Run constraint reasoning on a raw bundle.
   *
   * @param bundle  The raw ConstraintBundle from the planner.
   * @returns ConstraintReasonerOutput with atoms, relations, and resolved bundle.
   */
  reason(bundle: ConstraintBundle): ConstraintReasonerOutput {
    const atoms = liftBundleToAtoms(bundle);
    const relations: ConstraintRelation[] = [];
    const droppedIndices = new Set<number>();

    // Pairwise relation detection — O(n²) over atoms (n typically < 20)
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const a = atoms[i]!;
        const b = atoms[j]!;

        // Same-attribute relations (contradiction, redundancy, overshadow,
        // soft_tension, subsumption)
        const rel = detectRelation(a, b, i, j);
        if (rel !== null) {
          relations.push(rel);
          // Mark contradiction losers for removal
          if (rel.type === 'contradiction') {
            const loserIdx = rel.winner === 'a' ? j : i;
            droppedIndices.add(loserIdx);
          }
          // Mark redundant atom (b is always the redundant one per loop invariant)
          if (rel.type === 'redundancy') {
            const loserIdx = rel.winner === 'a' ? j : i;
            droppedIndices.add(loserIdx);
          }
          // Mark overshadowed (lower-authority) atom for removal
          if (rel.type === 'overshadow') {
            const loserIdx = rel.winner === 'a' ? j : i;
            droppedIndices.add(loserIdx);
          }
          // subsumption and soft_tension are informative — no atom dropped
          continue;
        }

        // Cross-attribute implication (informative only — no atom dropped)
        const impl = detectImplication(a, b, i, j);
        if (impl !== null) {
          relations.push(impl);
        }
      }
    }

    const droppedAtoms: ConstraintAtom[] = [];
    const survivingAtoms: ConstraintAtom[] = [];
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i]!;
      if (droppedIndices.has(i)) {
        droppedAtoms.push(atom);
      } else {
        survivingAtoms.push(atom);
      }
    }

    const softTensions = relations.filter((r) => r.type === 'soft_tension');

    // Rebuild resolved bundle from surviving atoms by tier
    const resolvedBundle = buildBundleFromAtoms(survivingAtoms);

    return {
      atoms,
      relations,
      resolvedBundle,
      droppedAtoms,
      softTensions,
    };
  }
}

// ─── Relation detection ──────────────────────────────────────────────────────

/**
 * Detect the semantic relation between two atoms.
 * Returns null when no meaningful relation exists.
 */
function detectRelation(
  a: ConstraintAtom,
  b: ConstraintAtom,
  idxA: number,
  idxB: number,
): ConstraintRelation | null {
  // Only compare atoms on the same attribute
  if (a.attribute !== b.attribute) {
    return null;
  }

  // Exact same value + operator → redundancy (drop lower authority)
  if (isExactDuplicate(a, b)) {
    const winner = a.authority_level >= b.authority_level ? 'a' : 'b';
    return {
      type: 'redundancy',
      atomIndexA: idxA,
      atomIndexB: idxB,
      winner,
      explanation: `Duplicate constraint on '${a.attribute}': same operator+value, lower authority dropped`,
    };
  }

  // Subsumption MUST be checked before contradiction: two region constraints that
  // stand in an ancestor/descendant relationship are semantically consistent —
  // "Bordeaux AND Pauillac" is valid (Pauillac ⊂ Bordeaux), not a contradiction.
  // Informative only — neither atom is dropped.
  if (
    a.attribute === 'region' &&
    a.operator === '=' &&
    b.operator === '=' &&
    typeof a.value === 'string' &&
    typeof b.value === 'string'
  ) {
    const aVal = a.value.toLowerCase();
    const bVal = b.value.toLowerCase();
    // Check if b is a descendant of a (a subsumes b)
    if (regionAncestors(bVal).includes(aVal)) {
      return {
        type: 'subsumption',
        atomIndexA: idxA,
        atomIndexB: idxB,
        explanation:
          `Subsumption on 'region': '${a.value}' is an ancestor of '${b.value}' ` +
          `(more specific constraint '${b.value}' is the effective filter)`,
      };
    }
    // Check if a is a descendant of b (b subsumes a)
    if (regionAncestors(aVal).includes(bVal)) {
      return {
        type: 'subsumption',
        atomIndexA: idxA,
        atomIndexB: idxB,
        explanation:
          `Subsumption on 'region': '${b.value}' is an ancestor of '${a.value}' ` +
          `(more specific constraint '${a.value}' is the effective filter)`,
      };
    }
  }

  // Both hard-tier '=' constraints with different values → contradiction
  if (
    a.source_tier === 'hard' &&
    b.source_tier === 'hard' &&
    a.operator === '=' &&
    b.operator === '='
  ) {
    if (!valuesEqual(a.value, b.value)) {
      const winner = a.authority_level >= b.authority_level ? 'a' : 'b';
      return {
        type: 'contradiction',
        atomIndexA: idxA,
        atomIndexB: idxB,
        winner,
        explanation:
          `Hard constraint contradiction on '${a.attribute}': ` +
          `'${JSON.stringify(a.value)}' vs '${JSON.stringify(b.value)}'. ` +
          `Higher authority (${winner === 'a' ? a.source_kind : b.source_kind}) wins.`,
      };
    }
  }

  // Higher authority atom with same operator overshadows lower authority
  if (a.operator === b.operator && a.authority_level !== b.authority_level) {
    const winner = a.authority_level > b.authority_level ? 'a' : 'b';
    return {
      type: 'overshadow',
      atomIndexA: idxA,
      atomIndexB: idxB,
      winner,
      explanation:
        `'${a.attribute}' overshadow: ${winner === 'a' ? a.source_kind : b.source_kind} ` +
        `(authority ${winner === 'a' ? a.authority_level : b.authority_level}) ` +
        `overrides ${winner === 'a' ? b.source_kind : a.source_kind}`,
    };
  }

  // Soft constraints on same attribute with opposing operators → soft_tension
  if (a.source_tier === 'soft' && b.source_tier === 'soft') {
    if (areOpposingOperators(a.operator, b.operator)) {
      return {
        type: 'soft_tension',
        atomIndexA: idxA,
        atomIndexB: idxB,
        explanation: `Soft tension on '${a.attribute}': opposing operators '${a.operator}' vs '${b.operator}'`,
      };
    }
  }

  return null;
}

/**
 * Detect cross-attribute implication relations.
 *
 * Called from ConstraintReasoner.reason() after same-attribute detection.
 * Returns null when no implication exists.
 *
 * Currently detected: region=X implies country=Y, when country=Y is already
 * present in the atom list. This documents the derivation for trace consumers
 * without changing the resolved bundle (ontology expansion already added the
 * country constraint upstream).
 */
function detectImplication(
  a: ConstraintAtom,
  b: ConstraintAtom,
  idxA: number,
  idxB: number,
): ConstraintRelation | null {
  // region '=' → country '=' implication
  if (
    a.attribute === 'region' &&
    b.attribute === 'country' &&
    a.operator === '=' &&
    b.operator === '=' &&
    typeof a.value === 'string' &&
    typeof b.value === 'string'
  ) {
    const ancestors = regionAncestors(a.value.toLowerCase());
    const countryVal = b.value.toLowerCase();
    if (ancestors.includes(countryVal)) {
      return {
        type: 'implication',
        atomIndexA: idxA,
        atomIndexB: idxB,
        explanation:
          `Implication: region='${a.value}' entails country='${b.value}' ` +
          `(country constraint already present, no action needed)`,
      };
    }
  }
  // Symmetric: country is atom a, region is atom b
  if (
    a.attribute === 'country' &&
    b.attribute === 'region' &&
    a.operator === '=' &&
    b.operator === '=' &&
    typeof a.value === 'string' &&
    typeof b.value === 'string'
  ) {
    const ancestors = regionAncestors(b.value.toLowerCase());
    const countryVal = a.value.toLowerCase();
    if (ancestors.includes(countryVal)) {
      return {
        type: 'implication',
        atomIndexA: idxA,
        atomIndexB: idxB,
        explanation:
          `Implication: region='${b.value}' entails country='${a.value}' ` +
          `(country constraint already present, no action needed)`,
      };
    }
  }
  return null;
}

/** Check if two constraint values are identical. */
function valuesEqual(
  v1: NormalizedConstraint['value'],
  v2: NormalizedConstraint['value'],
): boolean {
  if (typeof v1 !== typeof v2) return false;
  if (typeof v1 === 'string' || typeof v1 === 'number') {
    return v1 === v2;
  }
  if (Array.isArray(v1) && Array.isArray(v2)) {
    if (v1.length !== v2.length) return false;
    return v1.every((item, i) => item === (v2 as ReadonlyArray<string>)[i]);
  }
  if (typeof v1 === 'object' && typeof v2 === 'object' && !Array.isArray(v1) && !Array.isArray(v2)) {
    const r1 = v1 as { min: number; max: number };
    const r2 = v2 as { min: number; max: number };
    return r1.min === r2.min && r1.max === r2.max;
  }
  return false;
}

/** Check if two atoms have identical attribute + operator + value. */
function isExactDuplicate(a: ConstraintAtom, b: ConstraintAtom): boolean {
  return a.attribute === b.attribute && a.operator === b.operator && valuesEqual(a.value, b.value);
}

/** Operators that logically oppose each other (e.g. >= vs <=). */
function areOpposingOperators(op1: string, op2: string): boolean {
  return (
    (op1 === '>=' && op2 === '<=') ||
    (op1 === '<=' && op2 === '>=') ||
    (op1 === 'in' && op2 === 'not_in') ||
    (op1 === 'not_in' && op2 === 'in') ||
    (op1 === 'exclude' && op2 === '=') ||
    (op1 === '=' && op2 === 'exclude')
  );
}

/** Rebuild a ConstraintBundle from a flat list of resolved atoms. */
function buildBundleFromAtoms(atoms: readonly ConstraintAtom[]): ConstraintBundle {
  const hard: NormalizedConstraint[] = [];
  const soft: NormalizedConstraint[] = [];
  const inferred: NormalizedConstraint[] = [];

  for (const atom of atoms) {
    // Strip atom-only fields to produce a clean NormalizedConstraint
    const base: NormalizedConstraint = {
      attribute: atom.attribute,
      operator: atom.operator,
      value: atom.value,
      source_phrase: atom.source_phrase,
      confidence: atom.confidence,
      ...(atom.mapping_version !== undefined ? { mapping_version: atom.mapping_version } : {}),
    };
    if (atom.source_tier === 'hard') hard.push(base);
    else if (atom.source_tier === 'soft') soft.push(base);
    else inferred.push(base);
  }

  return { hard, soft, inferred };
}
