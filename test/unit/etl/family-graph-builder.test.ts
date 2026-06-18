import { describe, expect, it } from 'vitest';
import {
  buildFamilyGraphRows,
  hasRealProducer,
  mapEntityRowToInput,
  type FamilyGraphInputRecord,
} from '../../../scripts/etl/family-graph-builder.js';

/**
 * T-ELV2-06 Half B: REAL-producer-only family grouping (locked no-heuristic
 * decision). The snapshot builder sets producer = doc.producer ?? canonicalLabel,
 * so label-fallback rows (producer === label) must NOT form families.
 */
function rec(entityId: string, canonicalLabel: string, producer: string): FamilyGraphInputRecord {
  return { entityId, canonicalLabel, producer };
}

describe('hasRealProducer', () => {
  it('accepts a genuine producer distinct from the label', () => {
    expect(hasRealProducer(rec('e1', 'Opus One 2018', 'Opus One Winery'))).toBe(true);
  });
  it('rejects the canonicalLabel fallback (producer === label)', () => {
    expect(hasRealProducer(rec('e1', 'Some Obscure Wine 2015', 'Some Obscure Wine 2015'))).toBe(false);
  });
  it('rejects an empty producer', () => {
    expect(hasRealProducer(rec('e1', 'X', ''))).toBe(false);
  });
});

describe('buildFamilyGraphRows', () => {
  it('groups real-producer entities into a family with edge weight 1 - 1/N', () => {
    const rows = buildFamilyGraphRows([
      rec('a', 'Penfolds Grange 2016', 'Penfolds'),
      rec('b', 'Penfolds Bin 389 2018', 'Penfolds'),
      rec('c', 'Penfolds St Henri 2017', 'Penfolds'),
    ]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows.every((r) => r.familySize === 3)).toBe(true);
    expect(rows[0]?.edgeWeight).toBeCloseTo(1 - 1 / 3);
  });

  it('drops singleton families (a lone producer is not a family)', () => {
    const rows = buildFamilyGraphRows([
      rec('a', 'Opus One 2018', 'Opus One Winery'),
      rec('b', 'Penfolds Grange', 'Penfolds'),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('EXCLUDES label-fallback rows so they never form bogus families (no heuristic)', () => {
    // Two distinct wines whose producer fell back to their (coincidentally equal)
    // label must NOT be grouped — they are not a real producer family.
    const rows = buildFamilyGraphRows([
      rec('a', 'House Red', 'House Red'),
      rec('b', 'House Red', 'House Red'),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('is deterministic + order-independent (stable familyId, sorted members)', () => {
    const recs = [
      rec('z', 'Gaja Barbaresco 2017', 'Gaja'),
      rec('a', 'Gaja Sori Tildin 2016', 'Gaja'),
    ];
    const r1 = buildFamilyGraphRows(recs);
    const r2 = buildFamilyGraphRows([...recs].reverse());
    expect(r1).toEqual(r2);
    expect(r1.map((r) => r.memberEntityId)).toEqual(['a', 'z']);
  });

  it('mapEntityRowToInput maps a runtime entities row (CanonicalEntityId id-space)', () => {
    const r = mapEntityRowToInput({ entity_id: 'wine:opus-one-2018', canonical_label: 'Opus One 2018', producer: 'Opus One Winery' });
    expect(r).toEqual({ entityId: 'wine:opus-one-2018', canonicalLabel: 'Opus One 2018', producer: 'Opus One Winery' });
  });

  it('mapEntityRowToInput handles a null producer + rejects a malformed row', () => {
    expect(mapEntityRowToInput({ entity_id: 'e1', canonical_label: 'X', producer: null })?.producer).toBe('');
    // A silver-shaped row (sourceId, no entity_id) MUST be rejected — it would
    // publish ids that never match runtime anchors (the part-B id-space bug).
    expect(mapEntityRowToInput({ sourceId: 'vivino:123', canonicalLabel: 'X', producer: 'P' })).toBeNull();
    expect(mapEntityRowToInput({ entity_id: '', canonical_label: 'X' })).toBeNull();
  });

  it('dedupes a member that appears twice under the same producer', () => {
    const rows = buildFamilyGraphRows([
      rec('a', 'Gaja X 2017', 'Gaja'),
      rec('a', 'Gaja X 2017', 'Gaja'),
      rec('b', 'Gaja Y 2018', 'Gaja'),
    ]);
    expect(rows.filter((r) => r.memberEntityId === 'a')).toHaveLength(1);
    expect(rows.every((r) => r.familySize === 2)).toBe(true);
  });
});
