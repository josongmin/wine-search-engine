/**
 * JSONB Corruption Propagation Integration Test (T-E7-01)
 *
 * Verifies that CorruptedJsonbError from JSONB parsing propagates correctly
 * through all parse functions in the entity load path. Corrupted DB reads
 * must fail loudly — silent degradation is prohibited.
 */
import { describe, it, expect } from 'vitest';
import {
  CorruptedJsonbError,
  parseDecisionSnapshotJsonb,
  parseEvidenceItemsJsonb,
  parseRelationsJsonb,
  parseEntityAttributesJsonb,
} from '../../src/infrastructure/adapter/jsonb-schemas.js';

describe('JSONB corruption propagation (T-E7-01 integration)', () => {
  // -------------------------------------------------------------------------
  // DecisionSnapshot
  // -------------------------------------------------------------------------

  it('corrupted decision_snapshot throws CorruptedJsonbError with column metadata', () => {
    expect(() => parseDecisionSnapshotJsonb({ snapshot_id: '' }, 'test')).toThrow(CorruptedJsonbError);
    try {
      parseDecisionSnapshotJsonb({ snapshot_id: '' }, 'test');
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptedJsonbError);
      expect((e as CorruptedJsonbError).column).toBe('decision_snapshot');
      expect((e as CorruptedJsonbError).caller).toBe('test');
      expect((e as CorruptedJsonbError).issues.length).toBeGreaterThan(0);
    }
  });

  it('completely empty object throws CorruptedJsonbError for decision_snapshot', () => {
    expect(() => parseDecisionSnapshotJsonb({}, 'test')).toThrow(CorruptedJsonbError);
  });

  it('non-object decision_snapshot input (string) throws', () => {
    expect(() => parseDecisionSnapshotJsonb('garbage', 'test')).toThrow(CorruptedJsonbError);
  });

  it('non-object decision_snapshot input (number) throws', () => {
    expect(() => parseDecisionSnapshotJsonb(42, 'test')).toThrow(CorruptedJsonbError);
  });

  // -------------------------------------------------------------------------
  // EvidenceItems
  // -------------------------------------------------------------------------

  it('corrupted evidence_items with non-array input throws', () => {
    expect(() => parseEvidenceItemsJsonb('not-an-array', 'test')).toThrow(CorruptedJsonbError);
  });

  it('evidence_items with one invalid element rejects the entire batch', () => {
    const mixed = [
      { type: 'lexical', source: 'bm25', contribution: 'primary', strength: 'high', provenance: 'sparse' },
      { type: '', source: '', contribution: '', strength: 'invalid', provenance: '' }, // invalid
    ];
    expect(() => parseEvidenceItemsJsonb(mixed, 'test')).toThrow(CorruptedJsonbError);
  });

  it('null evidence_items returns empty array (legitimate: new entity)', () => {
    expect(parseEvidenceItemsJsonb(null, 'test')).toEqual([]);
    expect(parseEvidenceItemsJsonb(undefined, 'test')).toEqual([]);
  });

  it('empty array evidence_items returns empty array', () => {
    expect(parseEvidenceItemsJsonb([], 'test')).toEqual([]);
  });

  it('evidence_items with object input (not array) throws', () => {
    expect(() => parseEvidenceItemsJsonb({ type: 'lexical' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('evidence_items with all valid elements passes', () => {
    const items = [
      { type: 'lexical', source: 'bm25', contribution: 'primary', strength: 'high', provenance: 'sparse' },
      { type: 'semantic', source: 'embedding', contribution: 'supporting', strength: 'medium', provenance: 'dense' },
    ];
    const result = parseEvidenceItemsJsonb(items, 'test');
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('type', 'lexical');
    expect(result[1]).toHaveProperty('type', 'semantic');
  });

  // -------------------------------------------------------------------------
  // Relations
  // -------------------------------------------------------------------------

  it('corrupted relations throws with column metadata', () => {
    // Relations schema requires string min(1) for optional fields — passing number should fail
    expect(() => parseRelationsJsonb({ producedBy: 123 }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('relations with empty string producedBy throws (min(1) violated)', () => {
    expect(() => parseRelationsJsonb({ producedBy: '' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('valid relations pass through without error', () => {
    const result = parseRelationsJsonb({ producedBy: 'producer:123' }, 'test');
    expect(result).toHaveProperty('producedBy', 'producer:123');
  });

  it('empty object relations passes (all fields optional)', () => {
    const result = parseRelationsJsonb({}, 'test');
    expect(result).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // EntityAttributes
  // -------------------------------------------------------------------------

  it('corrupted attributes with NaN body throws', () => {
    expect(() => parseEntityAttributesJsonb({ body: NaN }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('corrupted attributes with Infinity acidity throws', () => {
    expect(() => parseEntityAttributesJsonb({ acidity: Infinity }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('corrupted attributes with -Infinity tannin throws', () => {
    expect(() => parseEntityAttributesJsonb({ tannin: -Infinity }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('corrupted attributes with string body throws', () => {
    expect(() => parseEntityAttributesJsonb({ body: 'high' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('valid attributes pass through without error', () => {
    const result = parseEntityAttributesJsonb({ body: 0.7, sweetness: 0.2 }, 'test');
    expect(result).toHaveProperty('body', 0.7);
    expect(result).toHaveProperty('sweetness', 0.2);
  });

  it('attributes with legitimately zero body passes', () => {
    const result = parseEntityAttributesJsonb({ body: 0 }, 'test');
    expect(result).toHaveProperty('body', 0);
  });

  it('empty object attributes passes (all fields optional)', () => {
    const result = parseEntityAttributesJsonb({}, 'test');
    expect(result).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // CorruptedJsonbError shape
  // -------------------------------------------------------------------------

  it('CorruptedJsonbError is instanceof Error for catch blocks', () => {
    try {
      parseDecisionSnapshotJsonb({}, 'test');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(CorruptedJsonbError);
      expect((e as Error).name).toBe('CorruptedJsonbError');
    }
  });

  it('CorruptedJsonbError message contains column and caller', () => {
    try {
      parseRelationsJsonb({ producedBy: 123 }, 'myService');
    } catch (e) {
      const err = e as CorruptedJsonbError;
      expect(err.message).toContain('relations');
      expect(err.message).toContain('myService');
    }
  });

  it('CorruptedJsonbError preserves all Zod issues in the issues array', () => {
    try {
      // Multiple invalid fields — issues array should have entries for each
      parseDecisionSnapshotJsonb(
        { snapshot_id: '', policy_rule_version: '', threshold_profile_id: '' },
        'test',
      );
    } catch (e) {
      const err = e as CorruptedJsonbError;
      expect(err.issues.length).toBeGreaterThan(0);
      // Each issue should be a Zod issue object
      for (const issue of err.issues) {
        expect(issue).toHaveProperty('message');
      }
    }
  });
});
