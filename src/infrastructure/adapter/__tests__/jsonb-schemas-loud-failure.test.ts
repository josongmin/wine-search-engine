/**
 * T-E7-01: JSONB parse functions throw CorruptedJsonbError on validation failure.
 *
 * Covers all four parse functions:
 *   - parseDecisionSnapshotJsonb
 *   - parseEvidenceItemsJsonb
 *   - parseRelationsJsonb
 *   - parseEntityAttributesJsonb
 *
 * Verifies:
 *   - Valid input: returns parsed data
 *   - Corrupted input: throws CorruptedJsonbError with correct metadata
 *   - Null/undefined input: correct behavior per function contract
 *   - Edge cases: empty objects, wrong types, NaN values
 */
import { describe, it, expect } from 'vitest';
import {
  CorruptedJsonbError,
  parseDecisionSnapshotJsonb,
  parseEvidenceItemsJsonb,
  parseRelationsJsonb,
  parseEntityAttributesJsonb,
} from '../jsonb-schemas.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_SNAPSHOT = {
  snapshot_id: 'snap-test-001',
  policy_rule_version: 'v1.0',
  threshold_profile_id: 'default',
  planner_version: 'v1.0',
  response_contract_version: 'search_response_v1',
  model_versions: { embedding: 'test-v1' },
  index_versions: { wine_content: '2026-01-01' },
  feature_flags: { test: true },
};

const VALID_EVIDENCE_ITEM = {
  type: 'constraint_match',
  source: 'llm_extraction',
  contribution: 'matched region constraint',
  strength: 'high' as const,
  provenance: 'query_plan',
};

const VALID_RELATIONS = {
  producedBy: 'entity:producer:abc',
  locatedIn: 'entity:region:xyz',
};

const VALID_ATTRIBUTES = {
  grapes: ['Pinot Noir'],
  style: 'red',
  body: 0.8,
  vintage: 2018,
};

// ── CorruptedJsonbError class ────────────────────────────────────────────────

describe('CorruptedJsonbError', () => {
  it('has correct name, column, caller, and issues', () => {
    const err = new CorruptedJsonbError('test_col', 'TestCaller', [{ code: 'invalid' }]);
    expect(err.name).toBe('CorruptedJsonbError');
    expect(err.column).toBe('test_col');
    expect(err.caller).toBe('TestCaller');
    expect(err.issues).toEqual([{ code: 'invalid' }]);
    expect(err.message).toContain('test_col');
    expect(err.message).toContain('TestCaller');
    expect(err.message).toContain('1 validation issue');
  });

  it('is instanceof Error', () => {
    const err = new CorruptedJsonbError('col', 'caller', []);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CorruptedJsonbError);
  });
});

// ── parseDecisionSnapshotJsonb ───────────────────────────────────────────────

describe('parseDecisionSnapshotJsonb — loud failure', () => {
  it('returns valid snapshot on well-formed input', () => {
    const result = parseDecisionSnapshotJsonb(VALID_SNAPSHOT, 'test');
    expect(result.snapshot_id).toBe('snap-test-001');
  });

  it('throws CorruptedJsonbError on null', () => {
    expect(() => parseDecisionSnapshotJsonb(null, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on undefined', () => {
    expect(() => parseDecisionSnapshotJsonb(undefined, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on empty object', () => {
    expect(() => parseDecisionSnapshotJsonb({}, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on string input', () => {
    expect(() => parseDecisionSnapshotJsonb('not-json', 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on missing required field', () => {
    const { snapshot_id: _dropped, ...partial } = VALID_SNAPSHOT;
    expect(() => parseDecisionSnapshotJsonb(partial, 'test')).toThrow(CorruptedJsonbError);
  });

  it('error metadata includes column and caller', () => {
    try {
      parseDecisionSnapshotJsonb(null, 'MyCaller');
      expect.fail('should throw');
    } catch (err) {
      const typed = err as CorruptedJsonbError;
      expect(typed.column).toBe('decision_snapshot');
      expect(typed.caller).toBe('MyCaller');
    }
  });
});

// ── parseEvidenceItemsJsonb ──────────────────────────────────────────────────

describe('parseEvidenceItemsJsonb — loud failure', () => {
  it('returns empty array for null (legitimate — no evidence yet)', () => {
    const result = parseEvidenceItemsJsonb(null, 'test');
    expect(result).toEqual([]);
  });

  it('returns empty array for undefined (legitimate — no evidence yet)', () => {
    const result = parseEvidenceItemsJsonb(undefined, 'test');
    expect(result).toEqual([]);
  });

  it('returns parsed items for valid array', () => {
    const result = parseEvidenceItemsJsonb([VALID_EVIDENCE_ITEM], 'test');
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('constraint_match');
  });

  it('throws CorruptedJsonbError for non-array non-null input (string)', () => {
    expect(() => parseEvidenceItemsJsonb('bad', 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError for non-array non-null input (object)', () => {
    expect(() => parseEvidenceItemsJsonb({ type: 'bad' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError for non-array non-null input (number)', () => {
    expect(() => parseEvidenceItemsJsonb(42, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError when ANY element is invalid', () => {
    const items = [
      VALID_EVIDENCE_ITEM,
      { type: '', source: 'bad', contribution: '', strength: 'invalid', provenance: '' }, // invalid
    ];
    expect(() => parseEvidenceItemsJsonb(items, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError when single element is invalid', () => {
    const items = [{ garbage: true }];
    expect(() => parseEvidenceItemsJsonb(items, 'test')).toThrow(CorruptedJsonbError);
  });

  it('returns valid items when all elements pass validation', () => {
    const items = [VALID_EVIDENCE_ITEM, { ...VALID_EVIDENCE_ITEM, type: 'entity_match' }];
    const result = parseEvidenceItemsJsonb(items, 'test');
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty array input (legitimate)', () => {
    const result = parseEvidenceItemsJsonb([], 'test');
    expect(result).toEqual([]);
  });

  it('error metadata for non-array includes column name', () => {
    try {
      parseEvidenceItemsJsonb('bad', 'EvalStore');
      expect.fail('should throw');
    } catch (err) {
      const typed = err as CorruptedJsonbError;
      expect(typed.column).toBe('evidence_items');
      expect(typed.caller).toBe('EvalStore');
    }
  });
});

// ── parseRelationsJsonb ──────────────────────────────────────────────────────

describe('parseRelationsJsonb — loud failure', () => {
  it('returns valid relations on well-formed input', () => {
    const result = parseRelationsJsonb(VALID_RELATIONS, 'test');
    expect(result).toEqual(VALID_RELATIONS);
  });

  it('accepts empty object (all relation fields are optional)', () => {
    const result = parseRelationsJsonb({}, 'test');
    expect(result).toEqual({});
  });

  it('throws CorruptedJsonbError on null', () => {
    expect(() => parseRelationsJsonb(null, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on string', () => {
    expect(() => parseRelationsJsonb('garbage', 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on number', () => {
    expect(() => parseRelationsJsonb(42, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on array', () => {
    expect(() => parseRelationsJsonb([], 'test')).toThrow(CorruptedJsonbError);
  });
});

// ── parseEntityAttributesJsonb ───────────────────────────────────────────────

describe('parseEntityAttributesJsonb — loud failure', () => {
  it('returns valid attributes on well-formed input', () => {
    const result = parseEntityAttributesJsonb(VALID_ATTRIBUTES, 'test');
    expect(result.grapes).toEqual(['Pinot Noir']);
    expect(result.body).toBe(0.8);
    expect(result.vintage).toBe(2018);
  });

  it('accepts empty object (all attribute fields are optional)', () => {
    const result = parseEntityAttributesJsonb({}, 'test');
    expect(result).toEqual({});
  });

  it('throws CorruptedJsonbError on null', () => {
    expect(() => parseEntityAttributesJsonb(null, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on string', () => {
    expect(() => parseEntityAttributesJsonb('bad', 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on wrong-type numeric field (body as string)', () => {
    expect(() => parseEntityAttributesJsonb({ body: 'not-a-number' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on NaN in numeric field', () => {
    expect(() => parseEntityAttributesJsonb({ body: NaN }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on Infinity in numeric field', () => {
    expect(() => parseEntityAttributesJsonb({ sweetness: Infinity }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError on non-integer vintage', () => {
    expect(() => parseEntityAttributesJsonb({ vintage: 2018.5 }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('accepts zero as a valid numeric field value', () => {
    const result = parseEntityAttributesJsonb({ body: 0, sweetness: 0, tannin: 0 }, 'test');
    expect(result.body).toBe(0);
    expect(result.sweetness).toBe(0);
    expect(result.tannin).toBe(0);
  });
});
