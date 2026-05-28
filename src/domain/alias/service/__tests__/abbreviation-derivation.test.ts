import { describe, expect, it } from 'vitest';
import {
  DERIVED_ABBREVIATION_CONFIDENCE,
  MIN_PRODUCER_TOKEN_LENGTH,
  deriveAbbreviations,
} from '../abbreviation-derivation.js';

function surfaces(label: string, vintageYear?: number, nowYear = 2026): readonly string[] {
  return deriveAbbreviations({ canonicalLabel: label, vintageYear, nowYear })
    .map((d) => d.surface);
}

describe('deriveAbbreviations — deterministic wine-community shorthand', () => {
  it('emits the bare initialism (R1) without a vintage', () => {
    // "Château Margaux" alone → just the CM initialism, no compound forms.
    expect(surfaces('Château Margaux')).toEqual(['CM']);
  });

  it('emits all five initialism×vintage compounds when vintage is present (R2-R5)', () => {
    // "Château Margaux 2015" → CM + CM15 family.
    const out = surfaces('Château Margaux 2015');
    expect(out).toContain('CM');           // R1
    expect(out).toContain('CM 15');        // R2 space + 2digit
    expect(out).toContain('CM15');         // R3 tight
    expect(out).toContain("CM '15");       // R4 apostrophe
    expect(out).toContain('CM ’15');       // R4 Unicode apostrophe
    expect(out).toContain('CM 2015');      // R5 4-digit space
  });

  it('emits both the prefix and full initialism compounds for 3-word producers', () => {
    // "Domaine Romanée Conti 2019" → initialisms ['DR', 'DRC'] × vintage 19 family.
    const out = surfaces('Domaine Romanée Conti 2019');
    expect(out).toContain('DR');
    expect(out).toContain('DRC');
    expect(out).toContain('DRC 19');
    expect(out).toContain('DRC19');
    expect(out).toContain("DRC '19");
    expect(out).toContain('DRC 2019');
  });

  it('suppresses truncated prefix initialisms when the label already starts with an explicit acronym', () => {
    // "DRC Romanée-Conti 2015" already exposes the community acronym "DRC".
    // Emitting shorter prefixes like "DR" creates noise, not recall lift.
    const out = surfaces('DRC Romanée-Conti 2015');
    expect(out).toContain('DRC');
    expect(out).toContain('DRC 15');
    expect(out).toContain('DRC15');
    expect(out).not.toContain('DR');
    expect(out).not.toContain('DR 15');
    expect(out).not.toContain('DR15');
  });

  it('emits a "<word> <YY>" compound for every significant word (R6/R7), not just the first', () => {
    // "Penfolds Grange 2017" — both "Penfolds" and "Grange" clear the
    // length floor (≥ MIN_PRODUCER_TOKEN_LENGTH=4) and neither is a stop
    // word, so the deterministic rule emits compound forms for both.
    // This covers the producer-leading convention ("Penfolds 17") AND
    // the iconic-name convention ("Grange 17") without LLM assistance.
    const out = surfaces('Penfolds Grange 2017');
    expect(out).toContain('Penfolds 17');
    expect(out).toContain('penfolds 17');
    expect(out).toContain('Grange 17');
    expect(out).toContain('grange 17');
  });

  it("emits 'Yquem 15' for d'Yquem 2015 (strips the d' elided article)", () => {
    // "Château d'Yquem Sauternes 2015" — Château is a stop word; the
    // significant-word extractor strips the leading "d'" elided article
    // from "d'Yquem" → "Yquem" (length 5, clears floor); "Sauternes"
    // clears the floor too. Both should be present, plus the lower-cased
    // variants.
    const out = surfaces("Château d'Yquem Sauternes 2015");
    // CY is the initialism (d' stop-word; Y kept).
    expect(out).toContain('CY');
    expect(out).toContain('CY 15');
    expect(out).toContain('Yquem 15');
    expect(out).toContain('yquem 15');
    expect(out).toContain('Sauternes 15');
    expect(out).toContain('sauternes 15');
  });

  it('does NOT emit the producer-first-word compound when the first significant word is too short', () => {
    // "El Bro 2020" → "El" is a stop word, "Bro" is only 3 chars < MIN_PRODUCER_TOKEN_LENGTH.
    // No "Bro 20" should be emitted.
    expect(MIN_PRODUCER_TOKEN_LENGTH).toBe(4);
    const out = surfaces('El Bro 2020');
    expect(out.some((s) => /\bbro 20\b/iu.test(s))).toBe(false);
  });

  it('returns empty for an empty canonical label', () => {
    expect(deriveAbbreviations({ canonicalLabel: '', nowYear: 2026 })).toEqual([]);
  });

  it('returns empty initialism set for a 1-word label (cannot form a 2-letter initialism)', () => {
    // "Sassicaia" alone — single token, deriveInitialisms returns []. No
    // vintage either → no compounds. Producer-first-word emits nothing
    // because there's no vintage anchor.
    expect(surfaces('Sassicaia')).toEqual([]);
  });

  it('uses explicit vintageYear when provided, overriding any year extracted from the label', () => {
    const out = surfaces('Château Margaux', 2015, 2026);
    expect(out).toContain('CM 15');
    expect(out).toContain('CM 2015');
  });

  it('rejects implausible vintages (year < 1900 or year > nowYear+5)', () => {
    // Year 1850 is below MIN_VINTAGE_YEAR; only R1 should fire.
    expect(surfaces('Château Margaux 1850')).toEqual(['CM']);
    // Year 2050 is too far in the future (nowYear 2026 + 5 = 2031); only R1.
    expect(surfaces('Château Margaux', 2050, 2026)).toEqual(['CM']);
  });

  it('handles 2-digit vintage padding correctly (2005 → "05", not "5")', () => {
    const out = surfaces('Château Margaux 2005');
    expect(out).toContain('CM 05');
    expect(out).toContain('CM05');
    expect(out).toContain("CM '05");
  });

  it('handles Korean producer first word verbatim (no jamo-level truncation)', () => {
    // "샤토 마고 2015" — Korean producer name. "샤토" is 2 syllables (each
    // a full Hangul grapheme). MIN_PRODUCER_TOKEN_LENGTH counts characters
    // (UTF-16 code units may differ but `.length` on Hangul syllables ≈
    // grapheme count). "샤토" length=2 < 4 → skip. "마고" length=2 < 4 →
    // skip. Should NOT emit anything from R6/R7 because no first word
    // clears the length floor. R1 also returns [] because tokens are
    // non-Latin. So we expect [].
    const out = surfaces('샤토 마고 2015');
    expect(out).toEqual([]);
  });

  it('handles longer Korean producer name as a verbatim first-word', () => {
    // "도멘 그레인지 2017" — "도멘" length=2 < floor; "그레인지" length=4
    // clears floor=4. Producer-first-word rule emits "그레인지 17" verbatim
    // (no jamo-level truncation; whole-syllable grapheme preserved). R1
    // returns [] because tokens are non-Latin.
    const out = surfaces('도멘 그레인지 2017');
    expect(out).toEqual(['그레인지 17']);
  });

  it('handles hyphenated producer names ("Côte-Rôtie") — hyphen is NOT a whitespace split for first-word', () => {
    // Hyphen is not whitespace, so "Côte-Rôtie" stays a single token of
    // length 10 → clears the floor. First-word rule emits "Côte-Rôtie 18"
    // and "côte-rôtie 18".
    const out = surfaces('Côte-Rôtie 2018');
    expect(out).toContain('Côte-Rôtie 18');
    expect(out).toContain('côte-rôtie 18');
  });

  it('deduplicates surface forms across rules (no duplicate "CM 15" entries)', () => {
    const list = deriveAbbreviations({
      canonicalLabel: 'Château Margaux 2015',
      nowYear: 2026,
    });
    const surfacesArr = list.map((d) => d.surface);
    expect(new Set(surfacesArr).size).toBe(surfacesArr.length);
  });

  it('returns a stable sorted-by-surface list (idempotent ETL artifacts)', () => {
    const a = deriveAbbreviations({ canonicalLabel: 'Château Margaux 2015', nowYear: 2026 });
    const b = deriveAbbreviations({ canonicalLabel: 'Château Margaux 2015', nowYear: 2026 });
    expect(a.map((d) => d.surface)).toEqual(b.map((d) => d.surface));
    const sorted = [...a.map((d) => d.surface)].sort();
    expect(a.map((d) => d.surface)).toEqual(sorted);
  });

  it('assigns DERIVED_ABBREVIATION_CONFIDENCE (0.65) to every emitted entry', () => {
    const list = deriveAbbreviations({
      canonicalLabel: 'Château Margaux 2015',
      nowYear: 2026,
    });
    for (const entry of list) {
      expect(entry.confidencePrior).toBe(DERIVED_ABBREVIATION_CONFIDENCE);
    }
  });
});
