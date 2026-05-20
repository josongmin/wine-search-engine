import { describe, expect, it } from 'vitest';
import {
  computeAnswerSimilarity,
  computeShadowModeDiff,
  tokenizeAnswerForSimilarity,
  toolOrderEqual,
  toolSetsEqual,
} from '../shadow-mode-diff.js';
import {
  SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD,
  type ShadowModeOrchestratorOutcome,
} from '../shadow-mode-schemas.js';

function makeOutcome(
  partial: Partial<ShadowModeOrchestratorOutcome>,
): ShadowModeOrchestratorOutcome {
  return {
    orchestrator: 'legacy_agent',
    status: 'ok',
    answer: '',
    toolCallCount: 0,
    toolNames: [],
    terminationReason: 'answer',
    totalDurationMs: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    ...partial,
  };
}

describe('tokenizeAnswerForSimilarity', () => {
  it('returns empty set on empty input', () => {
    expect(tokenizeAnswerForSimilarity('').size).toBe(0);
  });

  it('tokenizes basic ASCII on whitespace', () => {
    const tokens = tokenizeAnswerForSimilarity('Hello World, foo');
    expect(tokens.has('hello')).toBe(true);
    expect(tokens.has('world')).toBe(true);
    expect(tokens.has('foo')).toBe(true);
  });

  it('NFKC-normalizes Korean composed characters', () => {
    const a = tokenizeAnswerForSimilarity('레드 와인');
    const b = tokenizeAnswerForSimilarity('레드  와인');
    expect(a.size).toBe(b.size);
  });

  it('emits Hangul bigrams for Korean runs ≥ 2 chars', () => {
    const tokens = tokenizeAnswerForSimilarity('추천드립니다');
    // 추천, 천드, 드립, 립니, 니다 — five bigrams + the run as a single token.
    expect(tokens.has('추천')).toBe(true);
    expect(tokens.has('니다')).toBe(true);
    expect(tokens.has('추천드립니다')).toBe(true);
  });

  it('strips punctuation but keeps accented Latin and Hangul', () => {
    const tokens = tokenizeAnswerForSimilarity('Château Margaux — 보르도!');
    expect(tokens.has('château')).toBe(true);
    expect(tokens.has('margaux')).toBe(true);
    expect(tokens.has('보르도')).toBe(true);
  });
});

describe('computeAnswerSimilarity', () => {
  it('identical answers → 1', () => {
    expect(computeAnswerSimilarity('Opus One 2018', 'Opus One 2018')).toBe(1);
  });

  it('both empty → 1', () => {
    expect(computeAnswerSimilarity('', '')).toBe(1);
  });

  it('exactly one empty → 0', () => {
    expect(computeAnswerSimilarity('', 'anything')).toBe(0);
    expect(computeAnswerSimilarity('anything', '')).toBe(0);
  });

  it('completely disjoint answers → low', () => {
    const sim = computeAnswerSimilarity('apple banana', 'truck excavator');
    expect(sim).toBe(0);
  });

  it('Korean paraphrase shares high similarity', () => {
    // Same recommendation, identical vocabulary; only verb form differs in
    // a single suffix character. Token-set Jaccard with Hangul bigrams
    // produces ≥ threshold on this kind of paraphrase.
    const sim = computeAnswerSimilarity(
      '레드 와인 보르도 2018 추천드립니다 잘 어울립니다',
      '레드 와인 보르도 2018 추천드립니다 정말 어울립니다',
    );
    expect(sim).toBeGreaterThanOrEqual(SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD);
  });

  it('Korean: NFKC + bigrams produce non-zero overlap on shared anchors', () => {
    // Smoke test that Korean inputs share *some* similarity even when
    // morphology differs. The exact value depends on the bigram count;
    // we only assert it is well above the disjoint baseline.
    const sim = computeAnswerSimilarity(
      '레드 와인 보르도 2018 추천드립니다',
      '레드 와인 보르도 2018 추천해드립니다',
    );
    expect(sim).toBeGreaterThan(0.5);
  });

  it('value is in [0, 1]', () => {
    const sim = computeAnswerSimilarity('a b c', 'b c d');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('toolSetsEqual / toolOrderEqual', () => {
  it('same multiset, different order → set equal', () => {
    expect(toolSetsEqual(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(toolOrderEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('identical arrays → both equal', () => {
    expect(toolSetsEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(toolOrderEqual(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('different lengths → not equal', () => {
    expect(toolSetsEqual(['a'], ['a', 'a'])).toBe(false);
  });

  it('duplicates respected as multiset', () => {
    expect(toolSetsEqual(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(toolSetsEqual(['a', 'a'], ['a', 'a'])).toBe(true);
  });
});

describe('computeShadowModeDiff', () => {
  it('parity: identical answers + tools → not divergent, similarity=1', () => {
    const legacy = makeOutcome({
      answer: 'Opus One 2018 추천',
      toolNames: ['search_wines'],
      terminationReason: 'answer',
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: 'Opus One 2018 추천',
      toolNames: ['search_wines'],
      terminationReason: 'answer',
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerSimilarity).toBe(1);
    expect(diff.answerEquivalent).toBe(true);
    expect(diff.toolSetEqual).toBe(true);
    expect(diff.toolOrderEqual).toBe(true);
    expect(diff.divergent).toBe(false);
    expect(diff.divergentReasons).toEqual([]);
  });

  it('both legitimately empty (aborted) → not divergent', () => {
    const legacy = makeOutcome({ status: 'aborted', terminationReason: 'aborted' });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      status: 'aborted',
      terminationReason: 'aborted',
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerEquivalent).toBe(true);
    expect(diff.divergent).toBe(false);
  });

  it('one side error, other ok → divergent with one_side_errored', () => {
    const legacy = makeOutcome({
      status: 'error',
      terminationReason: 'error',
      errorMessage: 'kaboom',
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      status: 'ok',
      answer: 'ok answer',
      terminationReason: 'answer',
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.divergent).toBe(true);
    expect(diff.divergentReasons).toContain('one_side_errored');
  });

  it('Korean answer high similarity → not divergent', () => {
    // Same recommendation, identical content — verb form differs by one
    // suffix character ('잘' vs '정말'). Crosses the Jaccard threshold.
    const legacy = makeOutcome({
      answer: '레드 와인 보르도 2018 추천드립니다 잘 어울립니다',
      toolNames: ['search_wines'],
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: '레드 와인 보르도 2018 추천드립니다 정말 어울립니다',
      toolNames: ['search_wines'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerEquivalent).toBe(true);
    expect(diff.divergent).toBe(false);
  });

  it('tool set differs → divergent with tool_set_diff', () => {
    const legacy = makeOutcome({
      answer: 'same answer here',
      toolNames: ['search_wines'],
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: 'same answer here',
      toolNames: ['compare_wines'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.toolSetEqual).toBe(false);
    expect(diff.divergent).toBe(true);
    expect(diff.divergentReasons).toContain('tool_set_diff');
    // tool_order_diff is NOT emitted when set already differs.
    expect(diff.divergentReasons).not.toContain('tool_order_diff');
  });

  it('same tools different order → NOT divergent (parallel reorder ok)', () => {
    const legacy = makeOutcome({
      answer: 'identical answer',
      toolNames: ['search_wines', 'check_drinking_window'],
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: 'identical answer',
      toolNames: ['check_drinking_window', 'search_wines'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.toolSetEqual).toBe(true);
    expect(diff.toolOrderEqual).toBe(false);
    expect(diff.divergent).toBe(false);
    expect(diff.divergentReasons).toContain('tool_order_diff');
  });

  it('termination reasons differ → divergent', () => {
    const legacy = makeOutcome({
      answer: 'identical answer',
      terminationReason: 'answer',
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: 'identical answer',
      terminationReason: 'fallback',
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.terminationReasonEqual).toBe(false);
    expect(diff.divergent).toBe(true);
    expect(diff.divergentReasons).toContain('termination_reason_diff');
  });

  it('boundary: similarity exactly at threshold → equivalent', () => {
    // Construct two strings whose tokens intersection / union equals the
    // threshold exactly. We pick ASCII tokens that produce NO Hangul
    // bigrams, so the token count is deterministic.
    //   A = shared(17) ∪ {a, b}            → 19 unique
    //   B = shared(17) ∪ {c}               → 18 unique
    //   intersection = 17, union = 17 + 2 + 1 = 20
    //   Jaccard = 17 / 20 = 0.85
    const shared = Array.from({ length: 17 }, (_, i) => `tok${i}`).join(' ');
    const legacy = makeOutcome({ answer: `${shared} a b`, toolNames: ['x'] });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: `${shared} c`,
      toolNames: ['x'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerSimilarity).toBeCloseTo(SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD, 5);
    expect(diff.answerEquivalent).toBe(true);
  });

  it('boundary: similarity just below threshold → divergent', () => {
    //   A = shared(16) ∪ {a, b, c}         → 19 unique
    //   B = shared(16) ∪ {d}               → 17 unique
    //   intersection = 16, union = 16 + 3 + 1 = 20
    //   Jaccard = 16 / 20 = 0.80 (< threshold)
    const shared = Array.from({ length: 16 }, (_, i) => `tok${i}`).join(' ');
    const legacy = makeOutcome({ answer: `${shared} a b c`, toolNames: ['x'] });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: `${shared} d`,
      toolNames: ['x'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerSimilarity).toBeLessThan(SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD);
    expect(diff.answerEquivalent).toBe(false);
    expect(diff.divergent).toBe(true);
    expect(diff.divergentReasons).toContain('answer_dissimilar');
  });

  it('token & duration deltas computed as new - old', () => {
    const legacy = makeOutcome({
      answer: 'x',
      totalDurationMs: 1_000,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: 'x',
      totalDurationMs: 1_500,
      tokenUsage: { inputTokens: 80, outputTokens: 60 },
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.durationDeltaMs).toBe(500);
    expect(diff.tokenDeltaInput).toBe(-20);
    expect(diff.tokenDeltaOutput).toBe(10);
  });

  it('adversarial: completely different answers → low similarity, divergent', () => {
    const legacy = makeOutcome({
      answer: 'I recommend a full-bodied red wine from Bordeaux 2018',
      toolNames: ['search_wines'],
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      answer: '죄송합니다, 검색 결과가 없습니다.',
      toolNames: ['search_wines'],
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    expect(diff.answerSimilarity).toBeLessThan(SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD);
    expect(diff.divergent).toBe(true);
  });

  it('both errored same way → still flags via reasons appropriately', () => {
    const legacy = makeOutcome({
      status: 'error',
      terminationReason: 'error',
      errorMessage: 'down',
    });
    const wineSearch = makeOutcome({
      orchestrator: 'wine_search',
      status: 'error',
      terminationReason: 'error',
      errorMessage: 'down',
    });
    const diff = computeShadowModeDiff(legacy, wineSearch);
    // Both empty answers + both errored is parity for similarity, but tool sets equal.
    // The `one_side_errored` reason requires EXACTLY one side errored.
    expect(diff.divergentReasons).not.toContain('one_side_errored');
  });
});
