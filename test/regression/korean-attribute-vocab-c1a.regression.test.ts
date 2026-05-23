/**
 * Regression — C1a Korean attribute vocab extension.
 *
 * probe-search-quality (2026-05-23) surfaced that two common Korean
 * attribute surfaces were missing from the catalogs:
 *   - 발포성 (sparkling) — wine-type pattern
 *   - 저알콜 / 저알코올 (low-alcohol) — nl-mapper
 *
 * Their absence collapsed user queries to text similarity → generic
 * red wines as top results. This regression pins the new vocab entries
 * so they cannot silently drift back out.
 */

import { describe, it, expect } from 'vitest';
import { WINE_TYPE_RULES, type WineTypeValue } from '../../src/domain/query/model/wine-type-patterns.js';
import { listDefaultMappingEntries } from '../../src/domain/attribute/service/nl-mapper.js';

function matchWineType(query: string): WineTypeValue | undefined {
  for (const [re, type] of WINE_TYPE_RULES) {
    if (re.test(query)) return type;
  }
  return undefined;
}

function nlMap(phrase: string): { readonly mappedAttribute: string; readonly operator: string; readonly value: unknown } | undefined {
  for (const [key, val] of listDefaultMappingEntries()) {
    if (key === phrase) return val;
  }
  return undefined;
}

describe('Korean attribute vocab — sparkling / low-alcohol (C1a)', () => {
  it('classifies "발포성" as sparkling wine type', () => {
    expect(matchWineType('발포성 와인')).toBe('sparkling');
    expect(matchWineType('발포성')).toBe('sparkling');
  });

  it('keeps existing sparkling vocab intact (no regressions)', () => {
    expect(matchWineType('스파클링 와인')).toBe('sparkling');
    expect(matchWineType('샴페인 추천')).toBe('sparkling');
    expect(matchWineType('Champagne')).toBe('sparkling');
  });

  it('maps "저알콜" → alcohol_pct <= 12', () => {
    const r = nlMap('저알콜');
    expect(r?.mappedAttribute).toBe('alcohol_pct');
    expect(r?.operator).toBe('<=');
    expect(r?.value).toBe(12);
  });

  it('maps "저알코올" → alcohol_pct <= 12 (alt spelling)', () => {
    const r = nlMap('저알코올');
    expect(r?.mappedAttribute).toBe('alcohol_pct');
    expect(r?.operator).toBe('<=');
    expect(r?.value).toBe(12);
  });

  it('keeps existing alcohol vocab intact', () => {
    expect(nlMap('도수 낮은')?.mappedAttribute).toBe('alcohol_pct');
    expect(nlMap('low alcohol')?.mappedAttribute).toBe('alcohol_pct');
  });

  it('does NOT false-positive on similar Korean tokens (sparkling)', () => {
    // 발포정 (effervescent tablet) ≠ 발포성. Word-boundary lookarounds
    // should keep them distinct since `정` ≠ `성`.
    expect(matchWineType('소화제 발포정')).not.toBe('sparkling');
  });
});
