import { describe, it, expect } from 'vitest';
import { stripNoiseTokens, isPromotionalText } from '../service/noise-stripper.js';

describe('stripNoiseTokens', () => {
  it('1. returns unchanged title and empty noiseFlags when no noise is present', () => {
    const result = stripNoiseTokens('Château Margaux 2015');
    expect(result.cleaned).toBe('Château Margaux 2015');
    expect(result.noiseFlags).toEqual([]);
  });

  it('2. strips a single noise token', () => {
    const result = stripNoiseTokens('Château Margaux sale');
    expect(result.cleaned).toBe('Château Margaux');
    expect(result.noiseFlags).toEqual(['sale']);
  });

  it('3. strips multi-word noise token', () => {
    const result = stripNoiseTokens('Wine gift box 2020');
    expect(result.cleaned).toBe('Wine 2020');
    expect(result.noiseFlags).toEqual(['gift box']);
  });

  it('4. strips Korean noise token', () => {
    const result = stripNoiseTokens('오푸스원 특가 2020');
    expect(result.cleaned).toBe('오푸스원 2020');
    expect(result.noiseFlags).toEqual(['특가']);
  });

  it('5. strips multiple noise tokens', () => {
    const result = stripNoiseTokens('Premium Wine sale set');
    expect(result.noiseFlags).toContain('premium');
    expect(result.noiseFlags).toContain('sale');
    expect(result.noiseFlags).toContain('set');
    expect(result.noiseFlags).toHaveLength(3);
  });

  it('6. matches noise tokens case-insensitively', () => {
    const result = stripNoiseTokens('PREMIUM Wine SALE');
    expect(result.noiseFlags).toContain('premium');
    expect(result.noiseFlags).toContain('sale');
  });

  it('7. strips noise tokens at string boundaries', () => {
    const result = stripNoiseTokens('sale Wine import');
    expect(result.cleaned).toBe('Wine');
    expect(result.noiseFlags).toContain('sale');
    expect(result.noiseFlags).toContain('import');
  });

  it('8. does NOT strip "best" when it is part of a possessive (Best\'s Great Western)', () => {
    const result = stripNoiseTokens("Best's Great Western");
    expect(result.cleaned).toBe("Best's Great Western");
    expect(result.noiseFlags).not.toContain('best');
  });

  it('9. does NOT strip "import" when it is a substring of "Important"', () => {
    const result = stripNoiseTokens('Important Wine');
    expect(result.cleaned).toBe('Important Wine');
    expect(result.noiseFlags).not.toContain('import');
  });

  it('10. strips 750ml token', () => {
    const result = stripNoiseTokens('Wine 750ml Red');
    expect(result.cleaned).toBe('Wine Red');
    expect(result.noiseFlags).toContain('750ml');
  });

  it('11. falls back to original title when all tokens are noise', () => {
    const result = stripNoiseTokens('sale set bundle');
    expect(result.cleaned).toBe('sale set bundle');
    expect(result.noiseFlags.length).toBeGreaterThan(0);
  });

  it('12. falls back to trimmed original when all tokens are noise with extra spaces', () => {
    const result = stripNoiseTokens('  sale   set  ');
    expect(result.cleaned).toBe('sale set');
    expect(result.noiseFlags.length).toBeGreaterThan(0);
  });
});

describe('isPromotionalText', () => {
  it('11. detects discount pattern (50% off)', () => {
    expect(isPromotionalText('50% off')).toBe(true);
  });

  it('12. detects Korean discount (30% 할인)', () => {
    expect(isPromotionalText('30% 할인')).toBe(true);
  });

  it('13. detects free shipping', () => {
    expect(isPromotionalText('free shipping included')).toBe(true);
  });

  it('14. detects Korean free shipping (무료 배송)', () => {
    expect(isPromotionalText('무료 배송')).toBe(true);
  });

  it('15. detects limited edition', () => {
    expect(isPromotionalText('limited edition')).toBe(true);
  });

  it('16. detects double exclamation marks', () => {
    expect(isPromotionalText('Great Wine!!')).toBe(true);
  });

  it('17. detects star characters', () => {
    expect(isPromotionalText('★★★ Wine')).toBe(true);
  });

  it('18. returns false for clean wine text', () => {
    expect(isPromotionalText('Château Margaux 2015')).toBe(false);
  });

  it('19. detects Korean promotional keyword (추천)', () => {
    expect(isPromotionalText('추천 와인')).toBe(true);
  });

  it('20. detects buy N get pattern', () => {
    expect(isPromotionalText('buy 2 get 1')).toBe(true);
  });
});
