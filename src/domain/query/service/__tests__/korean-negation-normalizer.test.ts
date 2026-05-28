import { describe, expect, it } from 'vitest';
import { normalizeKoreanNegation } from '../korean-negation-normalizer.js';

describe('normalizeKoreanNegation', () => {
  it('keeps 아니다-family canonicalization for exclusion phrases', () => {
    expect(normalizeKoreanNegation('샴페인도 아니고 다른 거')).toBe('샴페인 말고 다른 거');
    expect(normalizeKoreanNegation('이탈리아산도 아닌 화이트')).toBe('이탈리아산 말고 화이트');
  });

  it('does not rewrite 않다-family verbal negation into exclusion', () => {
    expect(normalizeKoreanNegation('존재하지않는 와인 12345')).toBe('존재하지않는 와인 12345');
    expect(normalizeKoreanNegation('존재하지 않는 와인 12345')).toBe('존재하지 않는 와인 12345');
  });
});
