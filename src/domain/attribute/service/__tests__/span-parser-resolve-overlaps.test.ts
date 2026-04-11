/**
 * Regression tests for resolveOverlaps determinism (Bug 3).
 *
 * resolveOverlaps must produce the same output regardless of input order
 * when spans share start position, token count, and resolved status.
 * The sort must use: tokenCount desc → startChar asc → endChar desc → text asc.
 */

import { describe, it, expect } from 'vitest';
import { resolveOverlaps, type Span } from '../span-parser.js';

function makeSpan(text: string, startChar: number, endChar: number, tokenCount = 1): Span {
  return { text, startChar, endChar, tokenCount };
}

describe('resolveOverlaps — deterministic sort', () => {
  it('produces stable output when two resolved spans share tokenCount and startChar', () => {
    // Two 1-token resolved spans starting at 0, different endChars and texts.
    // Longer endChar (longer raw span) should win.
    const spanA = makeSpan('abc', 0, 3, 1);
    const spanB = makeSpan('ab', 0, 2, 1);
    const annotated = [
      { span: spanA, resolved: 'A' as const },
      { span: spanB, resolved: 'B' as const },
    ] as const;

    const result1 = resolveOverlaps([...annotated]);
    const result2 = resolveOverlaps([...annotated].reverse());

    // Both orderings should produce the same winner (longer span wins)
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0]?.span.text).toBe('abc');
    expect(result2[0]?.span.text).toBe('abc');
  });

  it('uses lexicographic text order as final tie-breaker when endChar also ties', () => {
    // Two resolved spans with identical startChar, endChar, and tokenCount.
    // Lexicographically earlier text should win.
    const spanA = makeSpan('cab', 0, 3, 1);
    const spanB = makeSpan('abc', 0, 3, 1);
    const annotated = [
      { span: spanA, resolved: 'A' as const },
      { span: spanB, resolved: 'B' as const },
    ] as const;

    const result1 = resolveOverlaps([...annotated]);
    const result2 = resolveOverlaps([...annotated].reverse());

    // Deterministic: same winner regardless of input order
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0]?.span.text).toBe(result2[0]?.span.text);
    // 'abc' < 'cab' lexicographically → 'abc' wins
    expect(result1[0]?.span.text).toBe('abc');
  });

  it('prefers longer spans over shorter overlapping spans', () => {
    // 2-token span should beat 1-token span when they overlap
    const span2tok = makeSpan('bordeaux france', 0, 15, 2);
    const span1tok = makeSpan('bordeaux', 0, 8, 1);
    const annotated = [
      { span: span2tok, resolved: 'region' as const },
      { span: span1tok, resolved: 'region' as const },
    ] as const;

    const result = resolveOverlaps([...annotated]);
    expect(result).toHaveLength(1);
    expect(result[0]?.span.text).toBe('bordeaux france');
  });

  it('keeps non-overlapping spans from different positions', () => {
    const spanA = makeSpan('bordeaux', 0, 8, 1);
    const spanB = makeSpan('france', 10, 16, 1);
    const annotated = [
      { span: spanA, resolved: 'region' as const },
      { span: spanB, resolved: 'country' as const },
    ] as const;

    const result = resolveOverlaps([...annotated]);
    expect(result).toHaveLength(2);
    // Output is sorted by startChar
    expect(result[0]?.span.text).toBe('bordeaux');
    expect(result[1]?.span.text).toBe('france');
  });

  it('drops unresolved spans when they overlap a resolved span', () => {
    const resolvedSpan = makeSpan('bordeaux', 0, 8, 1);
    const unresolvedOverlap = makeSpan('bord', 0, 4, 1);
    const annotated = [
      { span: resolvedSpan, resolved: 'region' as const },
      { span: unresolvedOverlap, resolved: null },
    ] as const;

    const result = resolveOverlaps([...annotated]);
    expect(result).toHaveLength(1);
    expect(result[0]?.span.text).toBe('bordeaux');
  });

  it('is deterministic for empty input', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  it('is deterministic for a single span', () => {
    const span = makeSpan('burgundy', 0, 8, 1);
    const result = resolveOverlaps([{ span, resolved: 'region' as const }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.span.text).toBe('burgundy');
  });
});
