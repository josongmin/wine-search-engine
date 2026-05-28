import { describe, expect, it } from 'vitest';
import {
  hasExactEntityVintageToken,
  inferGoldenQueryLanguage,
  selectExactEntityGoldenQuerySurface,
} from '../../../scripts/eval/golden-query-corpus-contract.js';

describe('golden-query-corpus-contract', () => {
  it('infers language from the actual query surface', () => {
    expect(inferGoldenQueryLanguage('Opus One 2018')).toBe('en');
    expect(inferGoldenQueryLanguage('오푸스 원 2018')).toBe('ko');
    expect(inferGoldenQueryLanguage('오푸스 원 Opus One 2018')).toBe('mixed');
  });

  it('requires an explicit vintage token for exact-entity rows', () => {
    expect(hasExactEntityVintageToken('2018 Opus One')).toBe(true);
    expect(hasExactEntityVintageToken('Anne Gros')).toBe(false);
  });

  it('fails closed when the canonical exact-entity surface lacks vintage', () => {
    expect(selectExactEntityGoldenQuerySurface({ canonicalLabel: '2018 Opus One' } as const)).toBe('2018 Opus One');
    expect(selectExactEntityGoldenQuerySurface({ canonicalLabel: 'Anne Gros' } as const)).toBeNull();
  });
});
