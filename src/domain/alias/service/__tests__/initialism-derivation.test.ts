import { describe, expect, it } from 'vitest';
import { deriveInitialisms } from '../initialism-derivation.js';

function surfaces(input: string): readonly string[] {
  return deriveInitialisms(input).map((d) => d.surface);
}

describe('deriveInitialisms — deterministic caps-initialism rule', () => {
  it('emits two-letter prefix and full initialism for a two-word label', () => {
    // "Château Margaux" → CM (length 2, also the full initialism).
    expect(surfaces('Château Margaux')).toEqual(['CM']);
  });

  it('emits full + prefix initialisms for a three-word label', () => {
    // "Domaine Romanée Conti" → significant=['Domaine','Romanée','Conti']
    // → letters=['D','R','C']; emit 'DR' (prefix) and 'DRC' (full).
    expect(surfaces('Domaine Romanée Conti')).toEqual(['DR', 'DRC']);
  });

  it('skips Romance / English stop words ("Pavillon Rouge du Château Margaux" → PR, PRC, PRCM)', () => {
    expect(surfaces('Pavillon Rouge du Château Margaux')).toEqual(['PR', 'PRC', 'PRCM']);
  });

  it('strips 4-digit vintages before tokenization (vintage is a separate constraint axis)', () => {
    expect(surfaces('Château Margaux 2015')).toEqual(['CM']);
    expect(surfaces('Opus One 2018')).toEqual(['OO']);
  });

  it('handles apostrophe-bound French articles ("Château d\'Yquem" → CY, not CDY)', () => {
    // "d'" is a stop word; the apostrophe is also a token separator, so
    // the bare 'd' token would be filtered as a stop word regardless.
    expect(surfaces("Château d'Yquem")).toEqual(['CY']);
  });

  it('handles hyphenated multi-word producer names', () => {
    // "Saint-Émilion Grand Cru" → significant=['Saint','Émilion','Grand','Cru']
    // → letters=['S','É'/E,'G','C']; prefixes 'SE', 'SEG', 'SEGC' + full 'SEGC'.
    const out = surfaces('Saint-Émilion Grand Cru');
    expect(out).toContain('SE');
    expect(out).toContain('SEGC');
  });

  it('emits empty array for single-significant-token labels', () => {
    // Single token (after stripping) cannot form a meaningful initialism.
    expect(surfaces('Sassicaia')).toEqual([]);
    expect(surfaces('The Sassicaia')).toEqual([]);  // 'the' stripped → only 'Sassicaia'
  });

  it('emits empty array for the empty string', () => {
    expect(surfaces('')).toEqual([]);
  });

  it('returns empty for pure-Hangul labels (Latin initialisms not applicable)', () => {
    expect(surfaces('샤또 마고')).toEqual([]);
  });

  it('handles mixed Hangul + Latin (only Latin tokens contribute)', () => {
    // "샤또 Margaux" → only 'Margaux' qualifies → empty (single significant)
    expect(surfaces('샤또 Margaux')).toEqual([]);
  });

  it('confidencePrior is constant 0.5 (RFC-003 § derived-alias trust tier, below misspelling)', () => {
    const derived = deriveInitialisms('Château Margaux');
    expect(derived.every((d) => d.confidencePrior === 0.5)).toBe(true);
  });

  it('is deterministic — same input → identical ordered output across calls', () => {
    const a = deriveInitialisms('Pavillon Rouge du Château Margaux');
    const b = deriveInitialisms('Pavillon Rouge du Château Margaux');
    expect(a).toEqual(b);
  });

  it('strips diacritics on leading characters consistently ("Étoile" → E)', () => {
    expect(surfaces('Étoile Brillante')).toEqual(['EB']);
  });

  it('caps prefix initialisms at four letters (memorability bound)', () => {
    // 6-word label: significant tokens 6 (assuming no stop words) → letters 6.
    // We emit prefixes 2..4 plus full → 5 variants max (2,3,4,full).
    const out = surfaces('Alpha Bravo Charlie Delta Echo Foxtrot');
    // expected variants: 'AB', 'ABC', 'ABCD', 'ABCDEF' (full)
    expect(out).toContain('AB');
    expect(out).toContain('ABC');
    expect(out).toContain('ABCD');
    expect(out).toContain('ABCDEF');
    // Does NOT emit 'ABCDE' (length 5 prefix would exceed MAX_PREFIX_LENGTH=4)
    expect(out).not.toContain('ABCDE');
  });

  it('output is sorted ascending (stable hash for ETL artifact reproducibility)', () => {
    const out = surfaces('Pavillon Rouge du Château Margaux');
    const sorted = [...out].sort();
    expect(out).toEqual(sorted);
  });
});
