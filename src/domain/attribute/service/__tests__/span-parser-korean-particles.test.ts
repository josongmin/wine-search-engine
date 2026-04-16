/**
 * Tests for Korean listing particle stripping in span parser.
 *
 * Korean agglutinative particles (조사) attach to the preceding noun:
 * "바롤로랑" = "바롤로" + "랑". The span parser must generate variant
 * spans with particles stripped so the entity resolver can match.
 *
 * Particles covered: 랑, 과, 와, 이랑, 하고
 */

import { describe, it, expect } from 'vitest';
import { parseSpans } from '../span-parser.js';

/**
 * Helper: extract all unique span texts from parseSpans output.
 */
function spanTexts(query: string): string[] {
  return [...new Set(parseSpans(query).map((s) => s.text))];
}

describe('parseSpans — Korean listing particle stripping', () => {
  it('strips 랑 particle: "바롤로랑 바르바레스코" includes "바롤로"', () => {
    const texts = spanTexts('바롤로랑 바르바레스코');
    expect(texts).toContain('바롤로랑');  // original preserved
    expect(texts).toContain('바롤로');    // particle-stripped variant
    expect(texts).toContain('바르바레스코');
  });

  it('strips 와 particle: "보르도와 나파" includes "보르도"', () => {
    const texts = spanTexts('보르도와 나파');
    expect(texts).toContain('보르도와');  // original preserved
    expect(texts).toContain('보르도');    // particle-stripped variant
    expect(texts).toContain('나파');
  });

  it('strips 과 particle: "피노 누아르과 시라" includes "피노 누아르" bigram without 과', () => {
    const texts = spanTexts('피노 누아르과 시라');
    // The bigram "피노 누아르과" gets particle-stripped to "피노 누아르"
    expect(texts).toContain('피노 누아르과');
    expect(texts).toContain('피노 누아르');
    // The unigram "누아르과" → "누아르"
    expect(texts).toContain('누아르과');
    expect(texts).toContain('누아르');
    expect(texts).toContain('시라');
  });

  it('strips 이랑 particle: "와인이랑 치즈" includes "와인"', () => {
    const texts = spanTexts('와인이랑 치즈');
    expect(texts).toContain('와인이랑');  // original preserved
    expect(texts).toContain('와인');      // particle-stripped variant
    expect(texts).toContain('치즈');
  });

  it('strips 하고 particle: "메를로하고 카베르네" includes "메를로"', () => {
    const texts = spanTexts('메를로하고 카베르네');
    expect(texts).toContain('메를로하고');
    expect(texts).toContain('메를로');
    expect(texts).toContain('카베르네');
  });

  it('does not strip particles from English text', () => {
    const texts = spanTexts('barolo vs barbaresco');
    expect(texts).toContain('barolo');
    expect(texts).toContain('barbaresco');
    // No spurious particle-stripped variants for English
    const baroloVariants = texts.filter((t) => t.startsWith('barol') && t !== 'barolo');
    // "barolo" should not produce additional variants (no Korean particles to strip)
    expect(baroloVariants.every((v) => parseSpans('barolo vs barbaresco').some((s) => s.text === v))).toBe(true);
  });

  it('does not modify a bare Korean token without particles', () => {
    const texts = spanTexts('바롤로');
    // Only the original span, no extra variant
    const baroloSpans = texts.filter((t) => t.startsWith('바롤'));
    expect(baroloSpans).toEqual(['바롤로']);
  });

  it('handles multiple particles in one query', () => {
    // "바롤로랑 브루넬로" — scenario id=30
    const texts = spanTexts('바롤로랑 브루넬로');
    expect(texts).toContain('바롤로');
    expect(texts).toContain('브루넬로');
  });

  it('strips particle from multi-word bigram span', () => {
    // "나파 밸리와" as part of "나파 밸리와 보르도"
    const texts = spanTexts('나파 밸리와 보르도');
    // Bigram "나파 밸리와" → stripped to "나파 밸리"
    expect(texts).toContain('나파 밸리와');
    expect(texts).toContain('나파 밸리');
    expect(texts).toContain('보르도');
  });

  it('preserves accented Latin without spurious stripping', () => {
    const texts = spanTexts('côtes du rhône');
    expect(texts).toContain('côtes');
    expect(texts).toContain('rhône');
    // No particle-stripped variants for Latin
    expect(texts.filter((t) => t === 'côte')).toEqual([]);
  });

  it('handles empty and whitespace-only input', () => {
    expect(parseSpans('')).toEqual([]);
    expect(parseSpans('   ')).toEqual([]);
  });

  it('particle-stripped variant shares same startChar/endChar as original', () => {
    const spans = parseSpans('바롤로랑 바르바레스코');
    const original = spans.find((s) => s.text === '바롤로랑');
    const stripped = spans.find((s) => s.text === '바롤로');
    expect(original).toBeDefined();
    expect(stripped).toBeDefined();
    // Same character range — both point to the same raw token
    expect(stripped!.startChar).toBe(original!.startChar);
    expect(stripped!.endChar).toBe(original!.endChar);
    expect(stripped!.tokenCount).toBe(original!.tokenCount);
  });
});
