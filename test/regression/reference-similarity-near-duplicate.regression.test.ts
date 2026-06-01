/**
 * RFC-021 T-PSA-01 invariant — near-duplicate suppression on the
 * `similar_to_entity` (similar_items) path.
 *
 * Same-entity exclusion + entity-id dedup do NOT collapse the same wine across
 * vintages (distinct entityIds), so "wines like Opus One 2018" would otherwise
 * be dominated by every Opus One vintage. This rail locks the deterministic
 * product-line collapse and guards against over-collapsing genuinely different
 * wines.
 *
 * Append-only (CLAUDE.md): never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import {
  nearDuplicateProductLineKey,
  suppressNearDuplicateProductLines,
} from '../../src/domain/mixed/service/mixed-solver.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';

function candidate(
  entityId: string,
  fields: { producer?: string; canonicalLabel?: string; score?: number },
): HybridCandidate {
  return {
    entityId: createCanonicalEntityId(entityId),
    ...(fields.canonicalLabel !== undefined ? { canonicalLabel: fields.canonicalLabel } : {}),
    ...(fields.producer !== undefined ? { producer: fields.producer } : {}),
    ...(fields.score !== undefined ? { fusionRrfTotal: fields.score } : {}),
  } as HybridCandidate;
}

describe('nearDuplicateProductLineKey', () => {
  it('produces an equal key for the same wine across vintages', () => {
    const a = candidate('opus-one-2017', { producer: 'Opus One Winery', canonicalLabel: 'Opus One 2017' });
    const b = candidate('opus-one-2018', { producer: 'Opus One Winery', canonicalLabel: 'Opus One 2018' });
    expect(nearDuplicateProductLineKey(a)).toBe(nearDuplicateProductLineKey(b));
  });

  it('is case-insensitive on producer casing drift', () => {
    const a = candidate('a', { producer: 'Château Margaux', canonicalLabel: 'Château Margaux 2015' });
    const b = candidate('b', { producer: 'château margaux', canonicalLabel: 'château margaux 2016' });
    expect(nearDuplicateProductLineKey(a)).toBe(nearDuplicateProductLineKey(b));
  });

  it('differs for genuinely different wines from the same producer', () => {
    const grand = candidate('a', { producer: 'CVNE', canonicalLabel: 'Imperial Gran Reserva 2016' });
    const crianza = candidate('b', { producer: 'CVNE', canonicalLabel: 'Cune Crianza 2016' });
    expect(nearDuplicateProductLineKey(grand)).not.toBe(nearDuplicateProductLineKey(crianza));
  });

  it('returns undefined (do-not-dedup) when producer OR label is missing', () => {
    expect(nearDuplicateProductLineKey(candidate('a', { canonicalLabel: 'Opus One 2018' }))).toBeUndefined();
    expect(nearDuplicateProductLineKey(candidate('a', { producer: 'Opus One Winery' }))).toBeUndefined();
    expect(nearDuplicateProductLineKey(candidate('a', {}))).toBeUndefined();
  });
});

describe('suppressNearDuplicateProductLines', () => {
  it('keeps only the top-scored vintage of a product line and drops the rest', () => {
    // Caller passes a score-sorted list; 2018 outscores 2017.
    const sorted = [
      candidate('opus-one-2018', { producer: 'Opus One Winery', canonicalLabel: 'Opus One 2018', score: 0.9 }),
      candidate('opus-one-2017', { producer: 'Opus One Winery', canonicalLabel: 'Opus One 2017', score: 0.7 }),
      candidate('almaviva-2019', { producer: 'Viña Almaviva', canonicalLabel: 'Almaviva 2019', score: 0.6 }),
    ];
    const out = suppressNearDuplicateProductLines(sorted);
    expect(out.map((c) => String(c.entityId))).toEqual(['opus-one-2018', 'almaviva-2019']);
  });

  it('does NOT collapse two different wines from the same producer', () => {
    const sorted = [
      candidate('imperial', { producer: 'CVNE', canonicalLabel: 'Imperial Gran Reserva 2016', score: 0.9 }),
      candidate('crianza', { producer: 'CVNE', canonicalLabel: 'Cune Crianza 2016', score: 0.8 }),
    ];
    expect(suppressNearDuplicateProductLines(sorted)).toHaveLength(2);
  });

  it('keeps all metadata-less candidates (never over-collapses by a missing key)', () => {
    const sorted = [
      candidate('x', { score: 0.9 }),
      candidate('y', { score: 0.8 }),
    ];
    expect(suppressNearDuplicateProductLines(sorted)).toHaveLength(2);
  });

  it('is order-preserving for the survivors', () => {
    const sorted = [
      candidate('a', { producer: 'P1', canonicalLabel: 'Wine A 2020', score: 0.9 }),
      candidate('b', { producer: 'P2', canonicalLabel: 'Wine B 2020', score: 0.8 }),
      candidate('a2', { producer: 'P1', canonicalLabel: 'Wine A 2019', score: 0.5 }),
    ];
    expect(suppressNearDuplicateProductLines(sorted).map((c) => String(c.entityId))).toEqual(['a', 'b']);
  });
});
