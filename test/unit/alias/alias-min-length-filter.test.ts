/**
 * E5-T9: SCAN4-16 — 1-character alias filter
 * Test first (TDD).
 */
import { describe, it, expect } from 'vitest';
import { filterValidAliases, MIN_ALIAS_LENGTH } from '../../../src/domain/alias/service/alias-filter.js';

describe('E5-T9: alias minimum length filter', () => {
  it('rejects single-char alias "A"', () => {
    const result = filterValidAliases(['A', 'ok']);
    expect(result).not.toContain('A');
  });

  it('rejects single whitespace char alias " "', () => {
    const result = filterValidAliases([' ', 'ok']);
    expect(result).not.toContain(' ');
  });

  it('accepts 2-char alias "드라" (Korean two syllables)', () => {
    const result = filterValidAliases(['드라']);
    expect(result).toContain('드라');
  });

  it('rejects single-char Korean syllable "드" (length 1)', () => {
    const result = filterValidAliases(['드']);
    expect(result).not.toContain('드');
  });

  it('accepts empty string as invalid (length 0 < MIN)', () => {
    const result = filterValidAliases(['', 'ok']);
    expect(result).not.toContain('');
    expect(result).toContain('ok');
  });

  it('accepts alias with length exactly MIN_ALIAS_LENGTH (2)', () => {
    expect(MIN_ALIAS_LENGTH).toBe(2);
    const twoChar = 'AB';
    const result = filterValidAliases([twoChar]);
    expect(result).toContain(twoChar);
  });

  it('rejects whitespace-only 2-char " " (trim check)', () => {
    const result = filterValidAliases(['  ']);
    expect(result).not.toContain('  ');
  });

  it('passes through normal multi-word aliases', () => {
    const aliases = ['Chardonnay', 'Pinot Noir', '샤르도네'];
    const result = filterValidAliases(aliases);
    expect(result).toEqual(aliases);
  });
});
