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

  it('output length is strictly bounded by maxChars (postcondition)', () => {
    // Key invariant: output must NEVER exceed maxChars. This is now guaranteed:
    // - maxChars >= TRUNCATION_SUFFIX_LEN(20): slice(0, cutAt) + suffix = maxChars chars
    // - maxChars < TRUNCATION_SUFFIX_LEN: raw slice(0, maxChars) = maxChars chars
    for (const maxChars of [0, 1, 5, 10, 15, 16, 17, 19, 20, 21, 50, 100]) {
      const result = truncateObservation('x'.repeat(200), maxChars);
      expect(result.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('handles maxChars < SUFFIX_LEN (postcondition fix: output.length <= maxChars always)', () => {
    // When maxChars < SUFFIX_LEN the suffix alone would exceed maxChars, so
    // the fixed code returns a raw slice capped at maxChars (no suffix appended).
    // The output is still shorter than the original — truncation is visible.
    const result = truncateObservation('hello world', 5);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result).toBe('hello');
  });

  it('handles maxChars = 0', () => {
    const result = truncateObservation('hello', 0);
    // slice(0, 0) = "" — empty string, length 0 satisfies output <= maxChars
    expect(result).toBe('');
    expect(result.length).toBeLessThanOrEqual(0);
  });

  it('handles empty string input', () => {
    expect(truncateObservation('', 100)).toBe('');
    expect(truncateObservation('', 0)).toBe('');
  });

  it('handles exactly SUFFIX_LEN maxChars (< TRUNCATION_SUFFIX_LEN=20: raw slice)', () => {
    // SUFFIX_LEN=16 < TRUNCATION_SUFFIX_LEN=20 → raw slice path, no suffix appended.
    const result = truncateObservation('x'.repeat(100), SUFFIX_LEN);
    expect(result.length).toBeLessThanOrEqual(SUFFIX_LEN);
  });

  it('handles maxChars = TRUNCATION_SUFFIX_LEN (exactly at boundary: suffix fits)', () => {
    // TRUNCATION_SUFFIX_LEN=20: cutAt = 20 - 20 = 0 → "" + suffix = suffix (20 chars)
    const TRUNCATION_SUFFIX_LEN = 20;
    const result = truncateObservation('x'.repeat(100), TRUNCATION_SUFFIX_LEN);
    expect(result.length).toBeLessThanOrEqual(TRUNCATION_SUFFIX_LEN);
    expect(result).toContain('[truncated]');
  });

  it('handles maxChars = TRUNCATION_SUFFIX_LEN + 1 (above boundary: 1 char + suffix)', () => {
    const TRUNCATION_SUFFIX_LEN = 20;
    const result = truncateObservation('x'.repeat(100), TRUNCATION_SUFFIX_LEN + 1);
    expect(result.length).toBeLessThanOrEqual(TRUNCATION_SUFFIX_LEN + 1);
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
