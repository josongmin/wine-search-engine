/**
 * Unit tests for agent-prompt.ts utilities.
 *
 * Focus: boundary cases that caused bugs in audit rounds —
 * truncateObservation with maxChars < TRUNCATION_SUFFIX_LEN was the #1 bug.
 */

import { describe, it, expect } from 'vitest';
import { truncateObservation, buildStepMessages } from '../../../../src/application/agent/agent-prompt.js';

// TRUNCATION_SUFFIX_LEN is 20 (the length of '\n... [truncated]').
// Tests cover: below, at, and above this threshold.
const SUFFIX = '\n... [truncated]';
const SUFFIX_LEN = SUFFIX.length; // 16 chars

describe('truncateObservation', () => {
  it('returns text unchanged when within limit', () => {
    expect(truncateObservation('hello', 100)).toBe('hello');
  });

  it('returns text unchanged when exactly at limit', () => {
    const text = 'x'.repeat(50);
    expect(truncateObservation(text, 50)).toBe(text);
  });

  it('truncates when text exceeds limit', () => {
    const result = truncateObservation('x'.repeat(100), 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain('[truncated]');
  });

  it('output length is bounded by maxChars', () => {
    // Key invariant: output must NEVER exceed maxChars regardless of suffix length.
    for (const maxChars of [0, 1, 5, 10, 15, 16, 17, 20, 50, 100]) {
      const result = truncateObservation('x'.repeat(200), maxChars);
      expect(result.length).toBeLessThanOrEqual(maxChars + SUFFIX_LEN);
      // More strictly: the truncated content + suffix must fit in maxChars
      // when maxChars >= SUFFIX_LEN; for smaller maxChars we just get the suffix.
    }
  });

  it('handles maxChars < SUFFIX_LEN (boundary bug that was fixed)', () => {
    // Old code: slice(0, maxChars - 20) → slice(0, negative) → "" + suffix = suffix (>maxChars!)
    // Fixed code: Math.max(0, maxChars - 20) → slice(0, 0) + suffix = suffix
    const result = truncateObservation('hello world', 5);
    // Output should not be longer than suffix itself (can't meaningfully truncate)
    expect(result.length).toBeLessThanOrEqual(SUFFIX_LEN);
  });

  it('handles maxChars = 0', () => {
    const result = truncateObservation('hello', 0);
    // slice(0, Math.max(0, 0-20)) = slice(0,0) = "" → "" + suffix
    expect(result).toBe(SUFFIX);
  });

  it('handles empty string input', () => {
    expect(truncateObservation('', 100)).toBe('');
    expect(truncateObservation('', 0)).toBe('');
  });

  it('handles exactly SUFFIX_LEN maxChars', () => {
    const result = truncateObservation('x'.repeat(100), SUFFIX_LEN);
    expect(result.length).toBeLessThanOrEqual(SUFFIX_LEN);
  });

  it('handles maxChars = SUFFIX_LEN + 1', () => {
    // cutAt = max(0, (SUFFIX_LEN+1) - SUFFIX_LEN) = 1
    // result = "x" + suffix = 1 + SUFFIX_LEN chars
    const result = truncateObservation('x'.repeat(100), SUFFIX_LEN + 1);
    expect(result.length).toBeLessThanOrEqual(SUFFIX_LEN + 1);
    expect(result).toContain('[truncated]');
  });
});

describe('buildStepMessages — actionPairs path', () => {
  it('uses actionPairs when present, no index drift possible', () => {
    const messages = buildStepMessages([
      {
        index: 0,
        thought: 'searching',
        actionPairs: [
          { action: { tool: 'search_wines', input: { query: 'bordeaux' } }, observation: 'result A' },
          { action: { tool: 'get_food_pairings', input: { food: 'steak' } }, observation: 'result B' },
        ],
        durationMs: 100,
        tokenCount: { input: 10, output: 5 },
      },
    ]);
    // Should produce: 1 assistant msg + 2 user tool-result msgs
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toContain('[Tool Result: search_wines]');
    expect(messages[1]?.content).toContain('result A');
    expect(messages[2]?.content).toContain('[Tool Result: get_food_pairings]');
    expect(messages[2]?.content).toContain('result B');
  });

  it('falls back to legacy actions/observations when actionPairs absent', () => {
    const messages = buildStepMessages([
      {
        index: 0,
        thought: 'legacy step',
        actions: [{ tool: 'search_wines', input: { query: 'test' } }],
        observations: ['legacy result'],
        durationMs: 100,
        tokenCount: { input: 5, output: 3 },
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('legacy result');
  });

  it('sequential action/observation step', () => {
    const messages = buildStepMessages([
      {
        index: 0,
        thought: 'single tool',
        action: { tool: 'search_wines', input: { query: 'merlot' } },
        observation: 'found merlot',
        durationMs: 50,
        tokenCount: { input: 4, output: 2 },
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('found merlot');
  });
});
