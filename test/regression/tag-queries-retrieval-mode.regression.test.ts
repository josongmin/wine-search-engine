/**
 * Regression: classification invariants for retrieval-mode tagging produced by
 * `scripts/etl/tag-queries-retrieval-mode.ts`.
 *
 * Invariants pinned by this file:
 *   1. Named tag constants — every emitted retrieval_mode is one of the
 *      enumerated RETRIEVAL_MODES values (no ad-hoc strings).
 *   2. Schema versioning — tagged records carry
 *      `schema_version = TAG_QUERIES_SCHEMA_VERSION` so downstream consumers
 *      can migrate safely.
 *   3. Determinism — tagging the same query 5x yields identical output.
 *   4. Entity vs non-entity discrimination — exact-entity queries (EN + KO)
 *      tag as `entity_lookup`; comparison / generic / pairing queries do NOT
 *      tag as `entity_lookup`.
 *   5. Korean coverage — Korean entity queries tag as `entity_lookup`;
 *      Korean generic queries tag as constraint/attribute/recommendation
 *      (NOT entity_lookup).
 *   6. Empty / malformed input — graceful skip, no throw.
 *   7. Batch processing — N input records produce N tagged output records
 *      preserving input order.
 *
 * Append-only: never delete this file.
 */

import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_MODES,
  TAG_QUERIES_SCHEMA_VERSION,
  determineRetrievalMode,
  tagQueryRecord,
  tagQueryRecords,
  type RetrievalMode,
  type TaggedGoldenQuery,
} from '../../scripts/etl/tag-queries-retrieval-mode.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface GoldenQueryInput {
  qid: string;
  query: string;
  query_class: string;
  scenario?: string;
  language?: string;
  retrieval_labels?: {
    relevant: Array<{ entity_id: string; grade: number }>;
  };
  decision_labels?: {
    expected_decision_status: string;
    expected_entity_id: string;
    ambiguity_expected: boolean;
    requires_abstain: boolean;
  };
  leakage_keys?: Record<string, unknown>;
  annotation_tier?: string;
  annotated_by?: string[];
  release_gate_eligible?: boolean;
  created_at?: string;
}

function makeQuery(overrides: Partial<GoldenQueryInput> = {}): GoldenQueryInput {
  const base: GoldenQueryInput = {
    qid: 'q-test-1',
    query: 'Opus One',
    query_class: 'exact_entity',
    scenario: 'entity_lookup',
    language: 'en',
    retrieval_labels: { relevant: [{ entity_id: 'opus-one-2018', grade: 3 }] },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: 'opus-one-2018',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {},
    annotation_tier: 'silver',
    annotated_by: ['rule_v1'],
    release_gate_eligible: false,
    created_at: '2025-01-01T00:00:00Z',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Named tag constants + schema version exist (rule 15, rule 33)
// ---------------------------------------------------------------------------

describe('tag-queries-retrieval-mode: named constants', () => {
  it('exposes RETRIEVAL_MODES enum-like list with the 10 canonical modes', () => {
    expect(Array.isArray(RETRIEVAL_MODES)).toBe(true);
    expect(RETRIEVAL_MODES).toContain('entity_lookup');
    expect(RETRIEVAL_MODES).toContain('entity_resolution');
    expect(RETRIEVAL_MODES).toContain('attribute_search');
    expect(RETRIEVAL_MODES).toContain('constraint_filter');
    expect(RETRIEVAL_MODES).toContain('producer_browse');
    expect(RETRIEVAL_MODES).toContain('region_browse');
    expect(RETRIEVAL_MODES).toContain('compare_candidates');
    expect(RETRIEVAL_MODES).toContain('recommendation');
    expect(RETRIEVAL_MODES).toContain('similar_items');
    expect(RETRIEVAL_MODES).toContain('no_match_detection');
  });

  it('TAG_QUERIES_SCHEMA_VERSION is "1"', () => {
    expect(TAG_QUERIES_SCHEMA_VERSION).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 2. determineRetrievalMode — pure classifier
// ---------------------------------------------------------------------------

describe('determineRetrievalMode: entity discrimination', () => {
  it('entity query "Opus One" → entity_lookup', () => {
    const mode = determineRetrievalMode('exact_entity', 'Opus One', false);
    expect(mode).toBe('entity_lookup');
  });

  it('comparison "Opus One vs Sassicaia" → compare_candidates (NOT entity_lookup)', () => {
    const mode = determineRetrievalMode('comparison_query', 'Opus One vs Sassicaia', false);
    expect(mode).toBe('compare_candidates');
    expect(mode).not.toBe('entity_lookup');
  });

  it('comparison via free text "compare opus one and sassicaia" → compare_candidates', () => {
    const mode = determineRetrievalMode('unknown', 'compare opus one and sassicaia', false);
    expect(mode).toBe('compare_candidates');
  });

  it('Korean entity "오푸스 원" → entity_lookup', () => {
    const mode = determineRetrievalMode('exact_entity', '오푸스 원', false);
    expect(mode).toBe('entity_lookup');
  });

  it('generic Korean query "레드 와인 추천" → NOT entity_lookup', () => {
    const mode = determineRetrievalMode('semantic_preference', '레드 와인 추천', false);
    expect(mode).not.toBe('entity_lookup');
    expect(RETRIEVAL_MODES).toContain(mode);
  });

  it('ambiguous short form → entity_resolution', () => {
    const mode = determineRetrievalMode('ambiguous_short_form', 'opus', true);
    expect(mode).toBe('entity_resolution');
  });

  it('pure constraint "red wine under 50" → constraint_filter', () => {
    const mode = determineRetrievalMode('pure_constraint', 'red wine under 50', false);
    expect(mode).toBe('constraint_filter');
  });

  it('region browse "bordeaux wines" → region_browse', () => {
    const mode = determineRetrievalMode('unknown', 'bordeaux wines', false);
    expect(mode).toBe('region_browse');
  });

  it('similar items "wines like opus one" → similar_items', () => {
    const mode = determineRetrievalMode('anchored_similarity', 'wines like opus one', false);
    expect(mode).toBe('similar_items');
  });

  it('pairing "wine to pair with steak" → recommendation', () => {
    const mode = determineRetrievalMode('semantic_preference', 'wine to pair with steak', false);
    expect(mode).toBe('recommendation');
  });

  it('output is always one of RETRIEVAL_MODES (no ad-hoc strings)', () => {
    const cases: Array<[string, string, boolean]> = [
      ['exact_entity', 'Sassicaia', false],
      ['comparison_query', 'A vs B', false],
      ['ambiguous_short_form', 'op', true],
      ['anchored_similarity', 'similar to Opus One', false],
      ['pure_constraint', 'sweet white', false],
      ['semantic_preference', 'pair with lamb', false],
      ['unknown', 'random text', false],
    ];
    for (const [cls, q, amb] of cases) {
      const mode = determineRetrievalMode(cls, q, amb);
      expect(RETRIEVAL_MODES).toContain(mode);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism — same input 5x → same output
// ---------------------------------------------------------------------------

describe('determineRetrievalMode: determinism', () => {
  it('same query tagged 5x → identical mode', () => {
    const results = new Set<RetrievalMode>();
    for (let i = 0; i < 5; i++) {
      results.add(determineRetrievalMode('exact_entity', 'Opus One', false));
    }
    expect(results.size).toBe(1);
  });

  it('Korean query tagged 5x → identical mode', () => {
    const results = new Set<RetrievalMode>();
    for (let i = 0; i < 5; i++) {
      results.add(determineRetrievalMode('exact_entity', '오푸스 원', false));
    }
    expect(results.size).toBe(1);
  });

  it('comparison query tagged 5x → identical mode', () => {
    const results = new Set<RetrievalMode>();
    for (let i = 0; i < 5; i++) {
      results.add(determineRetrievalMode('comparison_query', 'Opus One vs Sassicaia', false));
    }
    expect(results.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. tagQueryRecord — adds retrieval_mode + schema_version
// ---------------------------------------------------------------------------

describe('tagQueryRecord: schema_version + retrieval_mode wiring', () => {
  it('output record carries schema_version = "1"', () => {
    const out = tagQueryRecord(makeQuery());
    expect(out.schema_version).toBe(TAG_QUERIES_SCHEMA_VERSION);
    expect(out.schema_version).toBe('1');
  });

  it('output record carries retrieval_mode from determineRetrievalMode', () => {
    const out = tagQueryRecord(makeQuery({ query: 'Opus One', query_class: 'exact_entity' }));
    expect(out.retrieval_mode).toBe('entity_lookup');
  });

  it('preserves all original fields (qid, query, query_class, etc.)', () => {
    const input = makeQuery({ qid: 'q-7', query: 'Sassicaia' });
    const out = tagQueryRecord(input);
    expect(out.qid).toBe('q-7');
    expect(out.query).toBe('Sassicaia');
    expect(out.query_class).toBe(input.query_class);
  });

  it('preserves schema_version on already-tagged input (idempotent re-tag)', () => {
    const out1 = tagQueryRecord(makeQuery());
    const out2 = tagQueryRecord(out1 as unknown as GoldenQueryInput);
    expect(out2.schema_version).toBe('1');
    expect(out2.retrieval_mode).toBe(out1.retrieval_mode);
  });
});

// ---------------------------------------------------------------------------
// 5. Graceful handling of empty / odd input
// ---------------------------------------------------------------------------

describe('tagQueryRecord: empty / malformed inputs', () => {
  it('empty query string → no throw, retrieval_mode is a valid enum value', () => {
    const out = tagQueryRecord(makeQuery({ query: '', query_class: 'unknown' }));
    expect(RETRIEVAL_MODES).toContain(out.retrieval_mode);
    expect(out.schema_version).toBe('1');
  });

  it('whitespace-only query → no throw', () => {
    expect(() =>
      tagQueryRecord(makeQuery({ query: '   ', query_class: 'unknown' })),
    ).not.toThrow();
  });

  it('missing decision_labels → no throw (defaults applied)', () => {
    const malformed = { qid: 'x', query: 'Opus One', query_class: 'exact_entity' };
    expect(() => tagQueryRecord(malformed as GoldenQueryInput)).not.toThrow();
    const out = tagQueryRecord(malformed as GoldenQueryInput);
    expect(RETRIEVAL_MODES).toContain(out.retrieval_mode);
  });
});

// ---------------------------------------------------------------------------
// 6. Adjacent: Korean particle handling + mixed-language queries
// ---------------------------------------------------------------------------

describe('determineRetrievalMode: Korean adjacent cases', () => {
  it('Korean entity with subject particle "오푸스 원은" → entity_lookup', () => {
    const mode = determineRetrievalMode('exact_entity', '오푸스 원은', false);
    expect(mode).toBe('entity_lookup');
  });

  it('Korean entity with topic particle "오푸스 원이" → entity_lookup', () => {
    const mode = determineRetrievalMode('exact_entity', '오푸스 원이', false);
    expect(mode).toBe('entity_lookup');
  });

  it('mixed Korean+English "Opus One 추천" tags to a valid mode', () => {
    const mode = determineRetrievalMode('semantic_preference', 'Opus One 추천', false);
    expect(RETRIEVAL_MODES).toContain(mode);
  });

  it('Korean pairing "스테이크와 어울리는 와인" → recommendation', () => {
    const mode = determineRetrievalMode('semantic_preference', '스테이크와 어울리는 와인', false);
    expect(mode).toBe('recommendation');
  });

  it('Korean comparison "오푸스 원 vs 사시카이아" → compare_candidates', () => {
    const mode = determineRetrievalMode('comparison_query', '오푸스 원 vs 사시카이아', false);
    expect(mode).toBe('compare_candidates');
  });
});

// ---------------------------------------------------------------------------
// 7. Batch processing: N in → N out, order preserved
// ---------------------------------------------------------------------------

describe('tagQueryRecords: batch invariants', () => {
  it('N input records produce N tagged outputs, order preserved by qid', () => {
    const batch = [
      makeQuery({ qid: 'q-1', query: 'Opus One', query_class: 'exact_entity' }),
      makeQuery({ qid: 'q-2', query: 'Opus One vs Sassicaia', query_class: 'comparison_query' }),
      makeQuery({ qid: 'q-3', query: '오푸스 원', query_class: 'exact_entity' }),
      makeQuery({ qid: 'q-4', query: '레드 와인 추천', query_class: 'semantic_preference' }),
      makeQuery({ qid: 'q-5', query: 'bordeaux wines', query_class: 'unknown' }),
    ];
    const out: TaggedGoldenQuery[] = tagQueryRecords(batch);
    expect(out).toHaveLength(batch.length);
    expect(out.map((r) => r.qid)).toEqual(['q-1', 'q-2', 'q-3', 'q-4', 'q-5']);
    expect(out[0]!.retrieval_mode).toBe('entity_lookup');
    expect(out[1]!.retrieval_mode).toBe('compare_candidates');
    expect(out[2]!.retrieval_mode).toBe('entity_lookup');
    expect(out[3]!.retrieval_mode).not.toBe('entity_lookup');
    expect(out[4]!.retrieval_mode).toBe('region_browse');
    for (const rec of out) {
      expect(rec.schema_version).toBe('1');
    }
  });

  it('empty batch → empty array (no throw)', () => {
    expect(tagQueryRecords([])).toEqual([]);
  });

  it('batch determinism: tagging the same batch 5x → identical outputs', () => {
    const batch = [
      makeQuery({ qid: 'a', query: 'Opus One', query_class: 'exact_entity' }),
      makeQuery({ qid: 'b', query: '오푸스 원 vs 사시카이아', query_class: 'comparison_query' }),
      makeQuery({ qid: 'c', query: 'red wine under 50', query_class: 'pure_constraint' }),
    ];
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(JSON.stringify(tagQueryRecords(batch).map((r) => [r.qid, r.retrieval_mode])));
    }
    expect(new Set(runs).size).toBe(1);
  });
});
