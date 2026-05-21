/**
 * Regression: entity-synonym group leakage detection for golden splits
 * (RFC-017 §2.5 extension, SOTA++ maturity push 4→5).
 *
 * The base `verifyGoldenSplitIntegrity` already catches direct entity_id /
 * alias_cluster / temporal / template leaks. This regression locks in the
 * *entity-group level* invariants required to elevate split-integrity to
 * maturity 5:
 *
 *   1. Query-level uniqueness — no qid appears in more than one split
 *      after grouping. This is the existing invariant locked at 100 fc runs.
 *   2. Entity-group leakage (NEW) — queries that share a canonical entity
 *      key (`entity_id`; e.g. "Opus One" vs "Opus One 2018") MUST end up
 *      in the same split. The split assignment is taken at the group level
 *      so vintage / template variants cannot leak across train/val/gate.
 *   3. Split balance — when the input is large enough, no produced split
 *      is smaller than `SPLIT_INTEGRITY_MIN_SPLIT_SIZE` (degenerate splits
 *      cause noisy LTR / eval signals).
 *   4. Determinism — same input + same seed → byte-identical splits.
 *   5. Relabel consistency — mutating a query's gold label MUST NOT shift
 *      the entity → split assignment (label is not part of the group key).
 *
 * Adjacent invariants exercised by explicit cases:
 *   - 2 queries sharing entity_id land in same split (entity-group key).
 *   - Empty `entity_id` (e.g. exploration / `no-match` synthetics) falls
 *     back to query-level grouping (one group per qid) and must not throw.
 *   - Empty input → empty groups, no throw.
 *   - Korean / NFC-sensitive canonical entity_id is preserved verbatim.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the base
 * split-builder behavior; the entity-group helper is additive.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { GoldenQuery } from '../../scripts/etl/types.js';
import {
  groupQueriesByEntity,
  assignSplitsByEntityGroup,
  SPLIT_INTEGRITY_MIN_SPLIT_SIZE,
  SPLIT_INTEGRITY_ENTITY_GROUP_KEY_FN,
  verifyGoldenSplitIntegrity,
} from '../../scripts/eval/split-integrity.js';

const RUNS = 100;

function makeQuery(qid: string, entityId: string): GoldenQuery {
  return {
    qid,
    query: `q-${qid}`,
    query_class: 'exact_entity',
    scenario: 'A',
    language: 'en',
    retrieval_labels: { relevant: [] },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: entityId,
      query_template_id: 'tpl-1',
      generation_run_id: 'run-x',
      alias_cluster_id: entityId === '' ? 'no-match' : `cluster-${entityId}`,
    },
    annotation_tier: 'bronze',
    annotated_by: [],
    release_gate_eligible: false,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Named-const contract
// ────────────────────────────────────────────────────────────────────────────

describe('split-integrity named constants', () => {
  it('exposes a domain-justified minimum split size', () => {
    expect(SPLIT_INTEGRITY_MIN_SPLIT_SIZE).toBe(10);
  });

  it('declares the canonical entity-group key name', () => {
    expect(SPLIT_INTEGRITY_ENTITY_GROUP_KEY_FN).toBe('canonical_entity_id');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// groupQueriesByEntity — explicit cases
// ────────────────────────────────────────────────────────────────────────────

describe('groupQueriesByEntity', () => {
  it('groups two queries with the same canonical entity into one group', () => {
    const queries = [makeQuery('q1', 'opus-one'), makeQuery('q2', 'opus-one')];
    const groups = groupQueriesByEntity(queries);
    expect(groups.size).toBe(1);
    expect(groups.get('opus-one')?.map((q) => q.qid).sort()).toEqual(['q1', 'q2']);
  });

  it('falls back to qid-scoped key when entity_id is empty', () => {
    const queries = [makeQuery('q1', ''), makeQuery('q2', '')];
    const groups = groupQueriesByEntity(queries);
    // Two qid-scoped groups — empty entity_id never collapses distinct queries.
    expect(groups.size).toBe(2);
    for (const queriesInGroup of groups.values()) {
      expect(queriesInGroup.length).toBe(1);
    }
  });

  it('preserves Korean / NFC-sensitive canonical entity ids verbatim', () => {
    const koreanId = 'entity-오퍼스원-2018';
    const queries = [makeQuery('q1', koreanId), makeQuery('q2', koreanId)];
    const groups = groupQueriesByEntity(queries);
    expect(groups.size).toBe(1);
    expect(groups.has(koreanId)).toBe(true);
  });

  it('returns an empty map on empty input without throwing', () => {
    const groups = groupQueriesByEntity([]);
    expect(groups.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property: query-level uniqueness across produced splits
// ────────────────────────────────────────────────────────────────────────────

describe('Property: query-level uniqueness (locked at 100 fc runs)', () => {
  it('no qid appears in more than one of train/val/gate', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qid: fc.string({ minLength: 1, maxLength: 8 }),
            entityId: fc.string({ minLength: 1, maxLength: 8 }),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        (raw, seed) => {
          // Deduplicate qids — fast-check generators can emit duplicates,
          // and uniqueness across splits is only well-defined per unique qid.
          const seen = new Set<string>();
          const queries: GoldenQuery[] = [];
          for (const r of raw) {
            if (seen.has(r.qid)) continue;
            seen.add(r.qid);
            queries.push(makeQuery(r.qid, r.entityId));
          }
          const { train, val, gate } = assignSplitsByEntityGroup(queries, seed);
          const seenQid = new Set<string>();
          for (const q of [...train, ...val, ...gate]) {
            if (seenQid.has(q.qid)) return false;
            seenQid.add(q.qid);
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property: entity-group leakage (NEW)
// ────────────────────────────────────────────────────────────────────────────

describe('Property: entity-group leakage', () => {
  it('queries sharing entity_id always land in the same split', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qid: fc.string({ minLength: 1, maxLength: 8 }),
            entityId: fc.constantFrom('e-a', 'e-b', 'e-c', 'e-d', 'e-e'),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        (raw, seed) => {
          const seen = new Set<string>();
          const queries: GoldenQuery[] = [];
          for (const r of raw) {
            if (seen.has(r.qid)) continue;
            seen.add(r.qid);
            queries.push(makeQuery(r.qid, r.entityId));
          }
          const { train, val, gate } = assignSplitsByEntityGroup(queries, seed);
          const entityToSplit = new Map<string, 'train' | 'val' | 'gate'>();
          const check = (qs: readonly GoldenQuery[], label: 'train' | 'val' | 'gate'): boolean => {
            for (const q of qs) {
              const eid = q.leakage_keys.entity_id;
              if (eid === '') continue; // empty entity falls back to qid-scope
              const prev = entityToSplit.get(eid);
              if (prev !== undefined && prev !== label) return false;
              entityToSplit.set(eid, label);
            }
            return true;
          };
          return check(train, 'train') && check(val, 'val') && check(gate, 'gate');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('verifyGoldenSplitIntegrity flags entity-group leakage between train and val', () => {
    const shared = 'opus-one';
    const train = [makeQuery('t1', shared)];
    const val = [makeQuery('v1', shared)];
    const r = verifyGoldenSplitIntegrity(train, val, []);
    expect(r.valid).toBe(false);
    expect(r.violations.some((v) => v.includes('ENTITY_LEAK'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property: split balance (non-degenerate when input is large)
// ────────────────────────────────────────────────────────────────────────────

describe('Property: split balance', () => {
  it('produces non-degenerate splits when input has enough entity groups', () => {
    fc.assert(
      fc.property(
        // Generate at least 3 * MIN_SPLIT_SIZE distinct entity groups so the
        // balance invariant is well-defined.
        fc.uniqueArray(fc.string({ minLength: 2, maxLength: 6 }), {
          minLength: 3 * SPLIT_INTEGRITY_MIN_SPLIT_SIZE,
          maxLength: 80,
        }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (entityIds, seed) => {
          const queries = entityIds.map((eid, idx) => makeQuery(`q-${idx}`, eid));
          const { train, val, gate } = assignSplitsByEntityGroup(queries, seed);
          return (
            train.length >= SPLIT_INTEGRITY_MIN_SPLIT_SIZE &&
            val.length >= SPLIT_INTEGRITY_MIN_SPLIT_SIZE &&
            gate.length >= SPLIT_INTEGRITY_MIN_SPLIT_SIZE
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property: determinism
// ────────────────────────────────────────────────────────────────────────────

describe('Property: determinism', () => {
  it('same input + same seed yields byte-identical splits', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qid: fc.string({ minLength: 1, maxLength: 8 }),
            entityId: fc.string({ minLength: 1, maxLength: 8 }),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        (raw, seed) => {
          const seen = new Set<string>();
          const queries: GoldenQuery[] = [];
          for (const r of raw) {
            if (seen.has(r.qid)) continue;
            seen.add(r.qid);
            queries.push(makeQuery(r.qid, r.entityId));
          }
          const a = assignSplitsByEntityGroup(queries, seed);
          const b = assignSplitsByEntityGroup(queries, seed);
          const fingerprint = (xs: readonly GoldenQuery[]): string =>
            xs.map((q) => q.qid).join('|');
          return (
            fingerprint(a.train) === fingerprint(b.train) &&
            fingerprint(a.val) === fingerprint(b.val) &&
            fingerprint(a.gate) === fingerprint(b.gate)
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('repeated determinism check over 5 successive runs (explicit case)', () => {
    const queries = Array.from({ length: 30 }, (_, i) =>
      makeQuery(`q-${i}`, `e-${i % 6}`),
    );
    const fingerprints = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { train, val, gate } = assignSplitsByEntityGroup(queries, 42);
      fingerprints.add(
        [train, val, gate]
          .map((s) => s.map((q) => q.qid).join('|'))
          .join('||'),
      );
    }
    expect(fingerprints.size).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property: relabel consistency
// ────────────────────────────────────────────────────────────────────────────

describe('Property: relabel consistency', () => {
  it('mutating gold label does not shift entity → split assignment', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qid: fc.string({ minLength: 1, maxLength: 8 }),
            entityId: fc.string({ minLength: 1, maxLength: 8 }),
          }),
          { minLength: 0, maxLength: 32 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        (raw, seed) => {
          const seen = new Set<string>();
          const base: GoldenQuery[] = [];
          for (const r of raw) {
            if (seen.has(r.qid)) continue;
            seen.add(r.qid);
            base.push(makeQuery(r.qid, r.entityId));
          }
          const relabelled: GoldenQuery[] = base.map((q) => ({
            ...q,
            retrieval_labels: {
              relevant: [{ entity_id: 'arbitrary-relabel', grade: 3 }],
            },
          }));
          const a = assignSplitsByEntityGroup(base, seed);
          const b = assignSplitsByEntityGroup(relabelled, seed);
          const splitOf = (
            res: { train: readonly GoldenQuery[]; val: readonly GoldenQuery[]; gate: readonly GoldenQuery[] },
          ): Map<string, string> => {
            const m = new Map<string, string>();
            for (const q of res.train) m.set(q.qid, 'train');
            for (const q of res.val) m.set(q.qid, 'val');
            for (const q of res.gate) m.set(q.qid, 'gate');
            return m;
          };
          const ma = splitOf(a);
          const mb = splitOf(b);
          if (ma.size !== mb.size) return false;
          for (const [qid, split] of ma) {
            if (mb.get(qid) !== split) return false;
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Adjacent: empty input + Korean entity id
// ────────────────────────────────────────────────────────────────────────────

describe('Adjacent regression', () => {
  it('handles empty input without throwing and returns empty splits', () => {
    const result = assignSplitsByEntityGroup([], 0);
    expect(result.train).toEqual([]);
    expect(result.val).toEqual([]);
    expect(result.gate).toEqual([]);
  });

  it('preserves Korean canonical entity_id end-to-end', () => {
    const koreanId = '엔티티-오퍼스원';
    const queries = [
      makeQuery('q1', koreanId),
      makeQuery('q2', koreanId),
      makeQuery('q3', koreanId),
    ];
    const { train, val, gate } = assignSplitsByEntityGroup(queries, 7);
    const everywhere = [...train, ...val, ...gate];
    expect(everywhere.length).toBe(3);
    // All three queries with the same Korean canonical id must co-locate.
    const splits = new Set<string>();
    if (train.some((q) => q.leakage_keys.entity_id === koreanId)) splits.add('train');
    if (val.some((q) => q.leakage_keys.entity_id === koreanId)) splits.add('val');
    if (gate.some((q) => q.leakage_keys.entity_id === koreanId)) splits.add('gate');
    expect(splits.size).toBe(1);
  });
});
