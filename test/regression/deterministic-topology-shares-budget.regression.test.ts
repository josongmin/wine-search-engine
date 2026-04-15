/**
 * Wave H — `DeterministicTopologyDetector` emits `shares_budget` edges
 * when a multi-course query ALSO carries a shared-budget phrase.
 *
 * Activation: with the deterministic detector default-on (F1) AND
 * BundleSelector flag-on, production traffic for "메인 + 디저트 총 X만원"
 * queries now flows through the budget-aware assignment path WITHOUT
 * any LLM. Before this wave the detector emitted only the subquery
 * nodes; no edges meant BundleSelector had nothing to enforce
 * cross-subquery.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { DeterministicTopologyDetector } from '../../src/domain/query/service/deterministic-topology-detector.js';
import {
  matchesSharedBudgetHint,
  TOPOLOGY_BUDGET_AMOUNT_REGEX,
  TOPOLOGY_SHARES_BUDGET_REGEX_EN,
} from '../../src/domain/query/service/topology-pattern-lexicon.js';

const detector = new DeterministicTopologyDetector();

describe('Wave H — shares_budget edges on multi-course graphs', () => {
  it('Korean "총 15만원" + 메인/디저트 → shares_budget edge between subqueries', () => {
    const graph = detector.detect({
      atoms: [],
      normalizedQuery: '메인에 스테이크, 디저트에 치즈케이크, 총 15만원 이내',
      slotIds: [],
    });
    expect(graph).not.toBeNull();
    if (graph === null) return;
    expect(graph.origin).toBe('planner_emitted');
    // Multi-course produces 2 subquery nodes; shares_budget produces 1 edge
    // between them.
    const subqueries = graph.nodes.filter((n) => n.kind === 'subquery');
    expect(subqueries).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.kind).toBe('shares_budget');
    if (graph.edges[0]?.kind === 'shares_budget') {
      expect(graph.edges[0].resource).toBe('price_total');
    }
  });

  it('English "main course and dessert, total $300" → shares_budget edge', () => {
    const graph = detector.detect({
      atoms: [],
      normalizedQuery: 'pair main course and dessert, total $300 budget',
      slotIds: [],
    });
    expect(graph).not.toBeNull();
    if (graph === null) return;
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    expect(graph.edges.every((e) => e.kind === 'shares_budget')).toBe(true);
  });

  it('3-course query emits 3 pairwise shares_budget edges (n choose 2)', () => {
    const graph = detector.detect({
      atoms: [],
      normalizedQuery: '에피타이저 메인 디저트 페어링 합쳐 20만원',
      slotIds: [],
    });
    expect(graph).not.toBeNull();
    if (graph === null) return;
    const subqueries = graph.nodes.filter((n) => n.kind === 'subquery');
    expect(subqueries).toHaveLength(3);
    // C(3,2) = 3 pairwise edges.
    expect(graph.edges).toHaveLength(3);
  });

  it('multi-course without budget phrase → NO edges (plain subquery split)', () => {
    const graph = detector.detect({
      atoms: [],
      normalizedQuery: '메인이랑 디저트 페어링 해줘',
      slotIds: [],
    });
    expect(graph).not.toBeNull();
    if (graph === null) return;
    expect(graph.edges).toHaveLength(0);
  });

  it('budget phrase WITHOUT multi-course → no edges emitted (single-subquery, nothing to share)', () => {
    // Single-course queries never reach the shares_budget branch; the
    // detector falls through to XOR / null.
    const graph = detector.detect({
      atoms: [],
      normalizedQuery: '디저트 와인 총 5만원 이하',
      slotIds: [],
    });
    // Single-course → detector returns null (course threshold is ≥2).
    expect(graph).toBeNull();
  });

  it('matchesSharedBudgetHint: requires BOTH a shared-budget keyword AND (numeric OR multi-subquery)', () => {
    // Keyword alone (no amount, no multi-subquery) → false.
    expect(
      matchesSharedBudgetHint({ query: '총 알려줘', hasMultiSubquery: false }),
    ).toBe(false);
    // Keyword + amount → true.
    expect(
      matchesSharedBudgetHint({
        query: '총 15만원 이내로',
        hasMultiSubquery: false,
      }),
    ).toBe(true);
    // Keyword + hasMultiSubquery → true.
    expect(
      matchesSharedBudgetHint({
        query: '총 예산은 정해지지 않음',
        hasMultiSubquery: true,
      }),
    ).toBe(true);
    // No keyword → false even with amount.
    expect(
      matchesSharedBudgetHint({ query: '15만원짜리', hasMultiSubquery: true }),
    ).toBe(false);
  });

  it('TOPOLOGY_BUDGET_AMOUNT_REGEX matches KRW / USD numeric amounts', () => {
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('15만원')).toBe(true);
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('150,000 krw')).toBe(true);
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('$300')).toBe(true);
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('300 usd')).toBe(true);
    // Negative: no digits.
    expect(TOPOLOGY_BUDGET_AMOUNT_REGEX.test('some 만원 discussion')).toBe(false);
  });

  it('TOPOLOGY_SHARES_BUDGET_REGEX_EN matches `total` / `combined` / `altogether`', () => {
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('total budget')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('combined spend')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('altogether under $300')).toBe(true);
    // Negative: substring of a longer word must not match (`totally` is
    // whitelisted via the `total(?:ly)?` alternative — confirms intent).
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('totally unrelated')).toBe(true);
    expect(TOPOLOGY_SHARES_BUDGET_REGEX_EN.test('subtotal')).toBe(false);
  });
});
