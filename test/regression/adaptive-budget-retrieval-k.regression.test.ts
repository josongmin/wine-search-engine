/**
 * Adaptive retrieval `k` per intent class — SSoT regression.
 *
 * Locks the values in `RETRIEVAL_K_BY_INTENT` (SSoT —
 * `src/domain/agent/service/adaptive-budget.ts`). Each intent class has a
 * recall/cost trade-off justification documented in the source file; this
 * test fails fast if any value drifts without an accompanying bench
 * measurement.
 *
 * Append-only (CLAUDE.md test discipline): never delete entries.
 */

import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_K_BY_INTENT,
  RETRIEVAL_K_DEFAULT,
  classifyQueryBudget,
  type IntentClass,
} from '../../src/domain/agent/service/adaptive-budget.js';

describe('RETRIEVAL_K_BY_INTENT — SSoT values', () => {
  it('entity_lookup → 20 (specific SKU; deep recall is waste)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('entity_lookup')).toBe(20);
  });

  it('comparative → 20 (per-leg entity_lookup; canonical match per side)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('comparative')).toBe(20);
  });

  it('attribute_search → 200 (diverse pool for downstream reranking)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('attribute_search')).toBe(200);
  });

  it('food_pairing → 150 (color/style filters prune upstream)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('food_pairing')).toBe(150);
  });

  it('exploratory → 500 (widest pool for serendipity)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('exploratory')).toBe(500);
  });

  it('unknown → 100 (fallback matches legacy default)', () => {
    expect(RETRIEVAL_K_BY_INTENT.get('unknown')).toBe(100);
  });

  it('RETRIEVAL_K_DEFAULT mirrors `unknown` mapping (100)', () => {
    expect(RETRIEVAL_K_DEFAULT).toBe(100);
    expect(RETRIEVAL_K_BY_INTENT.get('unknown')).toBe(RETRIEVAL_K_DEFAULT);
  });
});

describe('RETRIEVAL_K_BY_INTENT — snapshot map shape', () => {
  it('contains exactly the 6 declared IntentClass members (no orphaned keys)', () => {
    const expected: ReadonlySet<IntentClass> = new Set([
      'entity_lookup',
      'comparative',
      'attribute_search',
      'food_pairing',
      'exploratory',
      'unknown',
    ]);
    expect(RETRIEVAL_K_BY_INTENT.size).toBe(expected.size);
    for (const key of expected) {
      expect(RETRIEVAL_K_BY_INTENT.has(key)).toBe(true);
    }
  });

  it('full map snapshot — catches any accidental edit', () => {
    const snapshot = Object.fromEntries(RETRIEVAL_K_BY_INTENT.entries());
    expect(snapshot).toEqual({
      entity_lookup: 20,
      comparative: 20,
      attribute_search: 200,
      food_pairing: 150,
      exploratory: 500,
      unknown: 100,
    });
  });

  it('every k value is a finite positive integer', () => {
    for (const [intent, k] of RETRIEVAL_K_BY_INTENT.entries()) {
      expect(Number.isFinite(k), `${intent} k must be finite`).toBe(true);
      expect(Number.isInteger(k), `${intent} k must be integer`).toBe(true);
      expect(k, `${intent} k must be > 0`).toBeGreaterThan(0);
    }
  });

  it('values monotonically widen from entity_lookup → exploratory', () => {
    // Encodes the cost/quality intuition: identity lookups need the smallest
    // pool, attribute searches need a moderate pool, and exploratory queries
    // need the widest. If a future edit accidentally flips this ordering,
    // catch it here.
    const entity = RETRIEVAL_K_BY_INTENT.get('entity_lookup') ?? 0;
    const comparative = RETRIEVAL_K_BY_INTENT.get('comparative') ?? 0;
    const foodPairing = RETRIEVAL_K_BY_INTENT.get('food_pairing') ?? 0;
    const attributeSearch = RETRIEVAL_K_BY_INTENT.get('attribute_search') ?? 0;
    const exploratory = RETRIEVAL_K_BY_INTENT.get('exploratory') ?? 0;
    expect(entity).toBeLessThanOrEqual(comparative);
    expect(comparative).toBeLessThan(foodPairing);
    expect(foodPairing).toBeLessThan(attributeSearch);
    expect(attributeSearch).toBeLessThan(exploratory);
  });
});

describe('classifyQueryBudget — intentClass + retrievalK projection', () => {
  it('specific SKU (Latin proper noun + vintage) → entity_lookup, k=20', () => {
    const r = classifyQueryBudget('Opus One 2018');
    expect(r?.classification).toBe('specific_sku');
    expect(r?.intentClass).toBe('entity_lookup');
    expect(r?.retrievalK).toBe(20);
  });

  it('specific SKU (pure Hangul wine name) → entity_lookup, k=20', () => {
    const r = classifyQueryBudget('오푸스원');
    expect(r?.classification).toBe('specific_sku');
    expect(r?.intentClass).toBe('entity_lookup');
    expect(r?.retrievalK).toBe(20);
  });

  it('compound query (multi-course / vs) → comparative, k=20', () => {
    const r = classifyQueryBudget('레드 와인 vs 화이트 와인 비교해줘');
    expect(r?.classification).toBe('compound');
    expect(r?.intentClass).toBe('comparative');
    expect(r?.retrievalK).toBe(20);
  });

  it('nested-condition query → attribute_search, k=200', () => {
    const r = classifyQueryBudget('이탈리아 레드 카베르네 5만원 이하');
    expect(r?.classification).toBe('nested_condition');
    expect(r?.intentClass).toBe('attribute_search');
    expect(r?.retrievalK).toBe(200);
  });

  it('situation-based query (gift + constraint) → exploratory, k=500', () => {
    const r = classifyQueryBudget('선물용 기념일 와인 5만원 이하 레드 추천');
    expect(r?.classification).toBe('situation_based');
    expect(r?.intentClass).toBe('exploratory');
    expect(r?.retrievalK).toBe(500);
  });

  it('off-domain query → entity_lookup (reject path; tight k)', () => {
    // Reject paths still get a defined IntentClass + k. The retrieval lever
    // is not actually exercised on rejection, but the field must exist
    // so downstream type-narrowing stays happy.
    const r = classifyQueryBudget('보르도 날씨 어때?');
    expect(r?.classification).toBe('off_domain');
    expect(r?.intentClass).toBe('entity_lookup');
    expect(r?.retrievalK).toBe(20);
  });

  it('adversarial → entity_lookup (reject path)', () => {
    const r = classifyQueryBudget('SELECT * FROM users');
    expect(r?.classification).toBe('adversarial');
    expect(r?.intentClass).toBe('entity_lookup');
    expect(r?.retrievalK).toBe(20);
  });

  it('knowledge-only → entity_lookup (reject path)', () => {
    // The classifier requires BOTH a WH-cue (followed by non-letter
    // boundary) AND an explanation-action verb. This phrasing satisfies
    // both anchors and is the canonical bench-#103 case.
    const r = classifyQueryBudget('와인 가격이 왜 이렇게 비싸? 설명해봐');
    expect(r?.classification).toBe('knowledge_only');
    expect(r?.intentClass).toBe('entity_lookup');
    expect(r?.retrievalK).toBe(20);
  });

  it('empty query → unknown / default → k=100', () => {
    const r = classifyQueryBudget('');
    expect(r?.classification).toBe('default');
    expect(r?.intentClass).toBe('unknown');
    expect(r?.retrievalK).toBe(100);
  });
});

describe('classifyQueryBudget — invariants across every classification', () => {
  // For every concrete query that classifies, intentClass + retrievalK MUST
  // be present and the retrievalK MUST equal RETRIEVAL_K_BY_INTENT[intentClass].
  const queries: readonly string[] = [
    'Opus One 2018',
    '오푸스원',
    'Château Margaux',
    '레드 와인 vs 화이트 와인 비교해줘',
    '이탈리아 레드 카베르네 5만원 이하',
    '선물용 기념일 와인 5만원 이하 레드',
    '보르도 날씨 어때?',
    'SELECT * FROM users',
    '와인 가격이 왜 이렇게 비싸? 설명해봐',
    '',
    '   ',
    '맥주 추천해줘',
  ];

  for (const query of queries) {
    it(`"${query}" → intentClass + retrievalK both populated and consistent`, () => {
      const r = classifyQueryBudget(query);
      if (r === undefined) return; // no-classification path is allowed
      expect(r.intentClass, 'intentClass present').toBeDefined();
      expect(r.retrievalK, 'retrievalK present').toBeDefined();
      const expectedK = RETRIEVAL_K_BY_INTENT.get(r.intentClass);
      expect(r.retrievalK, 'retrievalK matches SSoT').toBe(expectedK);
    });
  }
});
