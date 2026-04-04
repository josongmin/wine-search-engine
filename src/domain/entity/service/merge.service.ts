import type { EntityId } from '../../shared/types/index.js';
import type { Entity } from '../model/entity.js';
import type { Relations } from '../model/relations.js';
import type { EntityAttributes } from '../model/attributes.js';

/**
 * Result of evaluating whether two entities can be merged.
 */
export interface MergeDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly conflicts?: readonly string[];
}

/**
 * Evaluates whether two entities can be merged (RFC-001 §4).
 *
 * Merge rules:
 * 1. Entities must have the same type.
 * 2. Identity signatures must be equal (they represent the same real-world thing).
 * 3. No conflicting vintage year, producer, or region relations.
 *
 * @param a - First entity.
 * @param b - Second entity.
 * @returns A MergeDecision indicating whether the merge is allowed.
 */
export function canMerge(a: Entity, b: Entity): MergeDecision {
  if (a.type !== b.type) {
    return {
      allowed: false,
      reason: `Type mismatch: cannot merge '${a.type}' with '${b.type}'`,
    };
  }

  if (a.identitySignature !== b.identitySignature) {
    return {
      allowed: false,
      reason: 'Identity signatures do not match — entities represent different things',
    };
  }

  const conflicts: string[] = [];

  // Check relation conflicts
  if (a.relations.producedBy && b.relations.producedBy && a.relations.producedBy !== b.relations.producedBy) {
    conflicts.push(`producedBy conflict: ${a.relations.producedBy} vs ${b.relations.producedBy}`);
  }
  if (a.relations.locatedIn && b.relations.locatedIn && a.relations.locatedIn !== b.relations.locatedIn) {
    conflicts.push(`locatedIn conflict: ${a.relations.locatedIn} vs ${b.relations.locatedIn}`);
  }
  if (a.relations.variantOf && b.relations.variantOf && a.relations.variantOf !== b.relations.variantOf) {
    conflicts.push(`variantOf conflict: ${a.relations.variantOf} vs ${b.relations.variantOf}`);
  }

  // Check vintage year conflict for vintage entities
  if (a.type === 'vintage' && a.attributes.vintage != null && b.attributes.vintage != null) {
    if (a.attributes.vintage !== b.attributes.vintage) {
      conflicts.push(`vintage year conflict: ${String(a.attributes.vintage)} vs ${String(b.attributes.vintage)}`);
    }
  }

  if (conflicts.length > 0) {
    return {
      allowed: false,
      reason: 'Conflicting relations or attributes detected',
      conflicts,
    };
  }

  return {
    allowed: true,
    reason: 'Entities are compatible for merge',
  };
}

/**
 * Merges two entities into one, combining their relations and attributes.
 * Entity `a` is considered the "survivor" — its id and label are preserved.
 *
 * @param a - The surviving entity.
 * @param b - The entity being absorbed.
 * @param _reason - Human-readable reason for the merge (for audit trail).
 * @returns A new merged Entity.
 * @throws If canMerge returns disallowed.
 */
export function merge(a: Entity, b: Entity, _reason: string): Entity {
  const decision = canMerge(a, b);
  if (!decision.allowed) {
    throw new Error(`Merge not allowed: ${decision.reason}`);
  }

  const mergedRelations = buildRelations(
    a.relations.producedBy ?? b.relations.producedBy,
    a.relations.variantOf ?? b.relations.variantOf,
    a.relations.locatedIn ?? b.relations.locatedIn,
  );

  const mergedAttributes = mergeAttributes(a.attributes, b.attributes);

  const mergedSource = a.metadata.source ?? b.metadata.source;
  const mergedTrust = higherTrust(a.metadata.trustTier, b.metadata.trustTier);

  return {
    id: a.id,
    type: a.type,
    canonicalLabel: a.canonicalLabel,
    identitySignature: a.identitySignature,
    relations: mergedRelations,
    attributes: mergedAttributes,
    metadata: {
      createdAt: a.metadata.createdAt < b.metadata.createdAt ? a.metadata.createdAt : b.metadata.createdAt,
      updatedAt: new Date(),
      ...(mergedSource !== undefined ? { source: mergedSource } : {}),
      ...(mergedTrust !== undefined ? { trustTier: mergedTrust } : {}),
    },
  };
}

/**
 * Determines whether an entity can be split.
 * Splitting is allowed when there is a documented reason and the entity
 * is not a grape (grapes are atomic).
 *
 * @param entity - The entity to evaluate.
 * @param reason - The reason for the split.
 * @returns True if the split is permissible.
 */
export function canSplit(entity: Entity, reason: string): boolean {
  if (!reason.trim()) {
    return false;
  }
  // Grapes are atomic — cannot be split
  if (entity.type === 'grape') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildRelations(
  producedBy: EntityId | undefined,
  variantOf: EntityId | undefined,
  locatedIn: EntityId | undefined,
): Relations {
  return {
    ...(producedBy !== undefined ? { producedBy } : {}),
    ...(variantOf !== undefined ? { variantOf } : {}),
    ...(locatedIn !== undefined ? { locatedIn } : {}),
  };
}

function mergeAttributes(a: EntityAttributes, b: EntityAttributes): EntityAttributes {
  const grapes = mergeStringArrays(a.grapes, b.grapes);
  const style = a.style ?? b.style;
  const body = a.body ?? b.body;
  const sweetness = a.sweetness ?? b.sweetness;
  const acidity = a.acidity ?? b.acidity;
  const tannin = a.tannin ?? b.tannin;
  const region = a.region ?? b.region;
  const priceBand = a.priceBand ?? b.priceBand;
  const vintage = a.vintage ?? b.vintage;
  const pairing = mergeStringArrays(a.pairing, b.pairing);
  const occasion = mergeStringArrays(a.occasion, b.occasion);

  return {
    ...(grapes !== undefined ? { grapes } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(sweetness !== undefined ? { sweetness } : {}),
    ...(acidity !== undefined ? { acidity } : {}),
    ...(tannin !== undefined ? { tannin } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(priceBand !== undefined ? { priceBand } : {}),
    ...(vintage !== undefined ? { vintage } : {}),
    ...(pairing !== undefined ? { pairing } : {}),
    ...(occasion !== undefined ? { occasion } : {}),
  };
}

function mergeStringArrays(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!a && !b) return undefined;
  const combined = new Set([...(a ?? []), ...(b ?? [])]);
  return [...combined];
}

const TRUST_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function higherTrust(
  a: 'high' | 'medium' | 'low' | undefined,
  b: 'high' | 'medium' | 'low' | undefined,
): 'high' | 'medium' | 'low' | undefined {
  if (!a) return b;
  if (!b) return a;
  return (TRUST_RANK[a] ?? 0) >= (TRUST_RANK[b] ?? 0) ? a : b;
}
