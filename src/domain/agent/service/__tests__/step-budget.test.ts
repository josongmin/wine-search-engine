/**
 * Regression tests for StepBudget loop detection (post-SOTA++ audit).
 *
 * Covers:
 *   - Exact-key loop detection
 *   - Per-tool call cap (3)
 *   - Trigram Jaccard near-duplicate detection (0.7)
 *   - Padding-evasion guard (key allowlist)
 *   - Dry-run pattern (rejected calls do NOT mutate state)
 *   - Bounded perTool history
 *   - Korean (Hangul) bigram fallback
 *   - Whitespace-only normalization
 *   - canProceed step/timeout budgets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StepBudget } from '../step-budget.js';
import type { AgentConfig } from '../../model/agent-config.js';

const baseConfig: AgentConfig = {
  maxSteps: 10,
  agentTimeoutMs: 60_000,
  perStepTimeoutMs: 10_000,
  maxContextChars: 8_000,
};

/** Config with maxSteps=5 → adaptive cap = max(3, ceil(5*0.6)) = 3 (minimum cap). */
const capConfig: AgentConfig = {
  ...baseConfig,
  maxSteps: 5,
};

// ─────────────────────────────────────────────────────────────────────
// canProceed
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget.canProceed', () => {
  it('allows steps within budget', () => {
    const b = new StepBudget(baseConfig);
    expect(b.canProceed().allowed).toBe(true);
  });

  it('blocks once stepCount reaches maxSteps', () => {
    const b = new StepBudget({ ...baseConfig, maxSteps: 2 });
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    const check = b.canProceed();
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('max_steps');
  });

  it('blocks on wall-clock timeout', () => {
    vi.useFakeTimers();
    const b = new StepBudget({ ...baseConfig, agentTimeoutMs: 1_000 });
    vi.advanceTimersByTime(1_500);
    const check = b.canProceed();
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('timeout');
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Exact-key loop dedup
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget exact-key dedup', () => {
  it('blocks identical tool+input call', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'opus one' }).allowed).toBe(true);
    const second = b.recordStep('search_wines', { query: 'opus one' });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('loop_detected');
  });

  it('treats different tools with same input as distinct', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'x' }).allowed).toBe(true);
    expect(b.recordStep('compare_wines', { query: 'x' }).allowed).toBe(true);
  });

  it('canonical key handles key reordering (no evasion)', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'a', limit: 5 }).allowed).toBe(true);
    // Same input, keys in different order — must be the same canonical key.
    const second = b.recordStep('search_wines', { limit: 5, query: 'a' });
    expect(second.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Per-tool call cap
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget per-tool call cap', () => {
  // capConfig: maxSteps=5 → adaptive cap = max(3, ceil(5*0.6)) = 3
  it('allows up to 3 calls to the same tool with distinct queries (maxSteps=5 → cap=3)', () => {
    const b = new StepBudget(capConfig);
    expect(b.recordStep('search_wines', { query: 'opus one' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'screaming eagle' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'lafite rothschild' }).allowed).toBe(true);
  });

  it('blocks the 4th call to the same tool (maxSteps=5 → cap=3)', () => {
    const b = new StepBudget(capConfig);
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    b.recordStep('search_wines', { query: 'c' });
    const fourth = b.recordStep('search_wines', { query: 'd' });
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('loop_detected');
  });

  it('per-tool cap is independent across tools', () => {
    const b = new StepBudget(capConfig);
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    b.recordStep('search_wines', { query: 'c' });
    // search_wines is at cap, but compare_wines is fresh
    const compare = b.recordStep('compare_wines', { query_a: 'x', query_b: 'y' });
    expect(compare.allowed).toBe(true);
  });

  it('adaptive cap: maxSteps=8 → cap=5 allows 5 distinct calls', () => {
    // ceil(8 * 0.6) = 5 → nested_condition scenarios can do 5 search iterations
    const b = new StepBudget({ ...baseConfig, maxSteps: 8 });
    expect(b.recordStep('search_wines', { query: 'a' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'b' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'c' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'd' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'e' }).allowed).toBe(true);
    // 6th call blocked
    const sixth = b.recordStep('search_wines', { query: 'f' });
    expect(sixth.allowed).toBe(false);
    expect(sixth.reason).toBe('loop_detected');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Near-duplicate trigram detection
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget near-duplicate detection', () => {
  it('blocks token-reordered identical query (sort dedup)', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'opus one wine bottle' }).allowed).toBe(true);
    // Token sort makes "wine bottle opus one" identical → trigram J=1.0 → blocked
    const second = b.recordStep('search_wines', { query: 'wine bottle opus one' });
    expect(second.allowed).toBe(false);
  });

  it('allows different vintages of the same wine (legitimately distinct lookups)', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '2018 one opus' }).allowed).toBe(true);
    // Slightly different vintage — Jaccard ~ 0.57 < 0.85 (ASCII threshold) → allowed
    const second = b.recordStep('search_wines', { query: '2019 one opus' });
    expect(second.allowed).toBe(true);
  });

  it('allows semantically distinct queries (no shared trigrams)', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'opus one' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'screaming eagle' }).allowed).toBe(true);
  });

  it('handles whitespace-only query (skipped, no false block)', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '   ' }).allowed).toBe(true);
    // Different whitespace-only → exact-key blocks because canonical JSON differs only by content
    expect(b.recordStep('search_wines', { query: '\t' }).allowed).toBe(true);
  });

  it('allows Korean price-relaxation queries (30만원 → 50만원 constraint change)', () => {
    // "30만원 이하 레드 와인" vs "50만원 이하 레드 와인": only the price prefix differs.
    // Hangul-dominant long strings use threshold=0.92; bigram Jaccard ≈ 0.85–0.90 < 0.92 → allowed.
    // This represents legitimate constraint relaxation (agent broadens price band after NO_MATCH).
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '30만원 이하 레드 와인' }).allowed).toBe(true);
    const relaxed = b.recordStep('search_wines', { query: '50만원 이하 레드 와인' });
    expect(relaxed.allowed).toBe(true);
  });

  it('still blocks truly identical Korean queries even with high Hangul threshold', () => {
    // Exact same query string must be blocked by exact-key dedup (not near-duplicate).
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '30만원 이하 레드 와인' }).allowed).toBe(true);
    const duplicate = b.recordStep('search_wines', { query: '30만원 이하 레드 와인' });
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reason).toBe('loop_detected');
  });

  it('blocks Korean token-reordered identical query (Jaccard=1.0 after token sort)', () => {
    // Token sort makes these identical → Jaccard=1.0 ≥ 0.92 → blocked.
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '레드 와인 이하 30만원' }).allowed).toBe(true);
    const reordered = b.recordStep('search_wines', { query: '30만원 이하 레드 와인' });
    expect(reordered.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Anti-padding key allowlist
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget anti-padding (key allowlist)', () => {
  it('non-allowlisted padding key does not change near-duplicate decision', () => {
    // Two calls that ARE near-duplicates by query content alone — verify the
    // pad key has no effect on the decision (positive direction).
    const b1 = new StepBudget(baseConfig);
    b1.recordStep('search_wines', { query: 'opus one wine bottle' });
    const blockedNoPad = b1.recordStep('search_wines', { query: 'opus one bottle wine' });
    expect(blockedNoPad.allowed).toBe(false);

    const b2 = new StepBudget(baseConfig);
    b2.recordStep('search_wines', { query: 'opus one wine bottle' });
    const blockedWithPad = b2.recordStep('search_wines', {
      query: 'opus one bottle wine',
      _pad: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
    });
    // Same blocking decision — padding key did not bypass detection
    expect(blockedWithPad.allowed).toBe(false);
  });

  it('non-allowlisted padding can NOT make a near-duplicate appear distinct', () => {
    // The dangerous case: an attacker tries to use padding to bypass the dedup.
    // Without the allowlist, large padding would dilute the trigram set so
    // similarity drops below 0.7 and the call is allowed. With the allowlist,
    // padding is ignored and the query-vs-query similarity is what matters.
    const b = new StepBudget(baseConfig);
    b.recordStep('search_wines', { query: 'opus one wine bottle' });
    // Identical query (after token sort) — must always block, regardless of padding
    const padded = b.recordStep('search_wines', {
      query: 'wine bottle opus one',
      _pad: 'a b c d e f g h i j k l m n o p q r s t u v w x y z',
    });
    expect(padded.allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dry-run pattern (no state mutation on rejection)
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget dry-run pattern', () => {
  it('rejected exact-key call does NOT advance stepCount', () => {
    const b = new StepBudget(baseConfig);
    b.recordStep('search_wines', { query: 'a' });
    expect(b.getStepCount()).toBe(1);
    // Repeat same call — should be blocked
    b.recordStep('search_wines', { query: 'a' });
    // stepCount should STILL be 1, not 2
    expect(b.getStepCount()).toBe(1);
  });

  it('rejected per-tool-cap call does NOT advance stepCount', () => {
    // capConfig: maxSteps=5 → cap=3; 4th call is blocked
    const b = new StepBudget(capConfig);
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    b.recordStep('search_wines', { query: 'c' });
    expect(b.getStepCount()).toBe(3);
    const blocked = b.recordStep('search_wines', { query: 'd' });
    expect(blocked.allowed).toBe(false);
    // stepCount should STILL be 3, not 4
    expect(b.getStepCount()).toBe(3);
  });

  it('rejected near-duplicate call does NOT advance stepCount', () => {
    const b = new StepBudget(baseConfig);
    b.recordStep('search_wines', { query: 'opus one wine bottle' });
    expect(b.getStepCount()).toBe(1);
    const blocked = b.recordStep('search_wines', { query: 'opus one bottle wine' });
    expect(blocked.allowed).toBe(false);
    // stepCount should STILL be 1
    expect(b.getStepCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Korean / Hangul handling
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget Korean handling', () => {
  it('allows distinct Korean queries', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '풀바디 레드 와인' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: '드라이 화이트 와인' }).allowed).toBe(true);
  });

  it('blocks identical Korean query exactly', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: '오푸스원 추천' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: '오푸스원 추천' }).allowed).toBe(false);
  });

  it('handles mixed Korean+ASCII without crashing', () => {
    const b = new StepBudget(baseConfig);
    expect(b.recordStep('search_wines', { query: 'Opus One 와인' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: '풀바디 레드' }).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bounded history
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget bounded history', () => {
  it('perTool history bounded to perToolCallCap entries (maxSteps=5 → cap=3)', () => {
    // We can't directly inspect the private map, but we can verify the cap by
    // checking that calls beyond the cap are rejected (history is meaningful only
    // up to the cap). Use capConfig (maxSteps=5 → cap=3).
    const b = new StepBudget(capConfig);
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    b.recordStep('search_wines', { query: 'c' });
    // 4th call to same tool — blocked by cap=3
    expect(b.recordStep('search_wines', { query: 'd' }).allowed).toBe(false);
  });

  it('perTool history bounded to perToolCallCap entries (maxSteps=8 → cap=5)', () => {
    // ceil(8 * 0.6) = 5; 6th call is blocked, 5th is allowed
    const b = new StepBudget({ ...baseConfig, maxSteps: 8 });
    b.recordStep('search_wines', { query: 'a' });
    b.recordStep('search_wines', { query: 'b' });
    b.recordStep('search_wines', { query: 'c' });
    b.recordStep('search_wines', { query: 'd' });
    expect(b.recordStep('search_wines', { query: 'e' }).allowed).toBe(true);
    expect(b.recordStep('search_wines', { query: 'f' }).allowed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────

describe('StepBudget edge cases', () => {
  let b: StepBudget;

  beforeEach(() => {
    b = new StepBudget(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empty input object is allowed', () => {
    expect(b.recordStep('search_wines', {}).allowed).toBe(true);
  });

  it('input with null and undefined values does not crash', () => {
    expect(b.recordStep('search_wines', { query: 'test', limit: null }).allowed).toBe(true);
  });

  it('nested object input is canonicalized deterministically', () => {
    expect(b.recordStep('search_wines', { query: 'x', filters: { a: 1, b: 2 } }).allowed).toBe(true);
    // Same nested data, different key order
    expect(b.recordStep('search_wines', { query: 'x', filters: { b: 2, a: 1 } }).allowed).toBe(false);
  });
});
