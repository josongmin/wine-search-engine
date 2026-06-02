/**
 * Entity Lookup V2 — producer family graph builder (T-ELV2-06 Half B, pure core).
 *
 * Groups entities that share a normalized PRODUCER key into families, emitting
 * the rows that populate the `entity_family` recall plane (migration 031). Pure
 * + deterministic so the grouping logic is unit-testable without infra; the
 * runnable publisher (run-family-graph-publish.ts) feeds it silver records and
 * writes the rows to PG.
 *
 * NO HEURISTIC (per the locked decision): families are built from REAL producers
 * only. The snapshot builder sets `producer = doc.producer ?? canonicalLabel`, so
 * a null-producer row carries producer === canonicalLabel — grouping those would
 * be fuzzy LABEL grouping, not a producer family. We exclude exactly those rows
 * (producer normalized-equal to the label) so every family is a genuine
 * shared-producer cluster. Singletons (size < 2) are dropped.
 */

import { z } from 'zod';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { ambiguityClusterMembershipScore } from '../../src/domain/resolver/v2/lookup-feature-extractor.js';
import { deterministicHash } from '../../src/domain/shared/utils/hash.js';

export interface FamilyGraphInputRecord {
  readonly entityId: string;
  readonly canonicalLabel: string;
  /** Producer as carried by the snapshot record (may be the canonicalLabel fallback). */
  readonly producer: string;
}

/**
 * Map a runtime `entities` row (entity_id, canonical_label, attributes->>'producer')
 * to a builder input. The runtime entity_id is the CanonicalEntityId the alias
 * substrate/engine anchors use — the family members MUST be in this id-space (NOT
 * silver's source-namespace sourceId, which would never match an anchor). Returns
 * null on a malformed row (shape-guarded, no `as`).
 */
const EntityRowSchema = z.object({
  entity_id: z.string().min(1),
  canonical_label: z.string().min(1),
  producer: z.string().nullable().optional(),
}).passthrough();

export function mapEntityRowToInput(row: unknown): FamilyGraphInputRecord | null {
  const parsed = EntityRowSchema.safeParse(row);
  if (!parsed.success) return null;
  return {
    entityId: parsed.data.entity_id,
    canonicalLabel: parsed.data.canonical_label,
    producer: parsed.data.producer ?? '',
  };
}

export interface FamilyGraphRow {
  readonly familyId: string;
  readonly familyKey: string;
  readonly memberEntityId: string;
  readonly familySize: number;
  readonly edgeWeight: number;
}

/** True iff the record carries a REAL producer (not the canonicalLabel fallback). */
export function hasRealProducer(record: FamilyGraphInputRecord): boolean {
  const producerKey = normalizeForMatch(record.producer);
  if (producerKey.length === 0) return false;
  // The fallback sets producer === canonicalLabel; exclude exactly those rows.
  return producerKey !== normalizeForMatch(record.canonicalLabel);
}

/**
 * Build the family adjacency rows. Deterministic + order-independent:
 *   - group real-producer records by normalizeForMatch(producer)
 *   - drop families of size < 2 (a singleton is not a family)
 *   - edgeWeight = 1 - 1/familySize (SSoT ambiguityClusterMembershipScore — no new const)
 *   - familyId = `family:v1:${deterministicHash(familyKey)}` (stable across runs)
 *   - members sorted by entityId so output ordering is deterministic
 */
export function buildFamilyGraphRows(records: readonly FamilyGraphInputRecord[]): FamilyGraphRow[] {
  const byFamily = new Map<string, string[]>();
  for (const record of records) {
    if (!hasRealProducer(record)) continue;
    const familyKey = normalizeForMatch(record.producer);
    const members = byFamily.get(familyKey);
    if (members === undefined) byFamily.set(familyKey, [record.entityId]);
    else members.push(record.entityId);
  }

  const rows: FamilyGraphRow[] = [];
  for (const [familyKey, rawMembers] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Dedupe members (an entity should appear once per family) + deterministic order.
    const members = [...new Set(rawMembers)].sort((a, b) => a.localeCompare(b));
    if (members.length < 2) continue;
    const familyId = `family:v1:${deterministicHash(familyKey)}`;
    const edgeWeight = ambiguityClusterMembershipScore(true, members.length);
    for (const memberEntityId of members) {
      rows.push({ familyId, familyKey, memberEntityId, familySize: members.length, edgeWeight });
    }
  }
  return rows;
}
