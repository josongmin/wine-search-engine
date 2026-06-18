import { describe, expect, it } from 'vitest';
import {
  classifyConcept,
  type ConceptClassification,
} from '../../../src/domain/resolver/v2/concept-lexicon.js';
import { stripAccents } from '../../../src/domain/shared/utils/unicode-normalize.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';

/**
 * Build NormalizedQueryViews the way concept-lexicon consumes them: the
 * classifier reads ONLY `views.vintageStripped` (accent-stripped, lower-cased,
 * vintage years removed, punctuation folded, whitespace collapsed). We mirror
 * the real normalizer so each test's assertion is grounded in the same surface
 * the production gate would see.
 */
function makeViews(query: string): NormalizedQueryViews {
  const lower = query.toLowerCase();
  // accent-stripped + lower, matching the `vintageStripped` contract that
  // concept-lexicon.normalizeConceptTerm() aligns its vocab against.
  const accentless = stripAccents(lower)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  // Strip 4-digit vintage years (19xx / 20xx), like the real normalizer.
  const vintageStripped = accentless
    .replace(/(?:^|[^\p{L}\p{N}])(?:19|20)\d{2}(?=$|[^\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return {
    raw: query,
    strict: lower,
    accentless,
    collapsedWhitespace: accentless,
    punctuationStripped: accentless,
    compact: lower.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: lower,
    vintageStripped,
    semanticVariants: [lower],
    lookupVariants: [lower],
  };
}

describe('concept-lexicon — classifyConcept (T-ELV2-02)', () => {
  // ── shape / contract ───────────────────────────────────────────────────────
  describe('return shape', () => {
    it('returns the full ConceptClassification contract', () => {
      const c: ConceptClassification = classifyConcept(makeViews('까쇼'));
      expect(typeof c.isConceptOnly).toBe('boolean');
      expect(typeof c.hasConceptTerm).toBe('boolean');
      expect(Array.isArray(c.terms)).toBe(true);
      expect(typeof c.residual).toBe('string');
    });
  });

  // ── happy path: bare grape concepts (Korean + English shorthand) ────────────
  describe('grape concepts → concept-only', () => {
    it.each<[string, string]>([
      ['까쇼', 'Cabernet Sauvignon'], // Korean shorthand (DoD §3)
      ['까베르네 소비뇽', 'Cabernet Sauvignon'], // Korean full
      ['Cabernet Sauvignon', 'Cabernet Sauvignon'], // English full
      ['메를로', 'Merlot'], // Korean
      ['merlot', 'Merlot'], // English
      ['Pinot Noir', 'Pinot Noir'],
      ['피노 누아', 'Pinot Noir'],
      ['시라', 'Syrah'], // Korean Syrah — must not leak as substring (bounded)
      ['샤르도네', 'Chardonnay'],
      ['리슬링', 'Riesling'],
    ])('classifies bare grape %s as concept-only (%s)', (query, grape) => {
      const c = classifyConcept(makeViews(query));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
      expect(c.terms).toContain(grape);
      expect(c.residual).toBe('');
    });
  });

  // ── region / country concepts (incl. ACCENTED Latin) ────────────────────────
  describe('region / country concepts → concept-only', () => {
    it.each<string>([
      'Napa Valley',
      'Bordeaux',
      'Burgundy',
      'France',
      'Italy',
    ])('classifies bare region/country %s as concept-only', (query) => {
      const c = classifyConcept(makeViews(query));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
      expect(c.residual).toBe('');
    });

    it('matches an ACCENTED Latin region after accent-stripping (Châteauneuf-du-Pape)', () => {
      // The vocab term carries accents + hyphens; the classifier must
      // accent-strip + punctuation-fold to align with the stripped view.
      const c = classifyConcept(makeViews('Châteauneuf-du-Pape'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
      expect(c.residual).toBe('');
    });

    it('matches an accented one-word region (Rhône → rhone)', () => {
      const c = classifyConcept(makeViews('Rhône Valley'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });
  });

  // ── style / occasion facet descriptors (EN + KO) ────────────────────────────
  describe('facet descriptors → concept-only', () => {
    it.each<string>([
      'full bodied red',
      'dry white',
      'sparkling',
      '달콤한 화이트', // sweet white (KO)
      '레드 와인', // red wine (KO) — descriptor + generic stopword
      'cheap red wine',
      '가성비 와인', // value wine (KO)
    ])('classifies facet/occasion query %s as concept-only', (query) => {
      const c = classifyConcept(makeViews(query));
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });

    it('flags hasConceptTerm for a style descriptor', () => {
      const c = classifyConcept(makeViews('sparkling rose'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
    });
  });

  // ── generic stopwords: concept-only but NO concept term ─────────────────────
  describe('generic stopwords → concept-only, no concept term', () => {
    it.each<string>([
      'wine',
      'wines',
      '와인', // KO "wine"
      'the wine',
      'recommend me a good wine', // recommend(occasion) + stopwords
    ])('classifies generic query %s as concept-only', (query) => {
      const c = classifyConcept(makeViews(query));
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });

    it('a bare generic stopword has NO concept term (generic, not concept)', () => {
      const c = classifyConcept(makeViews('wine'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(false);
      expect(c.terms).toEqual([]);
    });

    it('a bare Korean generic stopword has NO concept term', () => {
      const c = classifyConcept(makeViews('와인'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(false);
    });
  });

  // ── entity-bearing: producer / proper-name residual must NOT be swept up ─────
  describe('entity-bearing queries → NOT concept-only (residual proper name)', () => {
    it('keeps a producer token as residual alongside a grape concept', () => {
      const c = classifyConcept(makeViews('Caymus Cabernet Sauvignon'));
      expect(c.isConceptOnly).toBe(false);
      expect(c.residual).toContain('caymus');
      // the grape still fires as a concept term
      expect(c.hasConceptTerm).toBe(true);
      expect(c.terms).toContain('Cabernet Sauvignon');
    });

    it.each<string>([
      'Opus One',
      'Penfolds Grange',
      'Sassicaia',
    ])('admits famous producer/entity %s (residual remains)', (query) => {
      const c = classifyConcept(makeViews(query));
      expect(c.isConceptOnly).toBe(false);
      expect(c.residual.length).toBeGreaterThan(0);
    });

    it('admits a Korean producer name with no concept token (오푸스원)', () => {
      const c = classifyConcept(makeViews('오푸스원'));
      expect(c.isConceptOnly).toBe(false);
      expect(c.hasConceptTerm).toBe(false);
      expect(c.residual).toContain('오푸스원');
    });

    it('does NOT substring-strip a Latin grape out of a producer word (bounded regex)', () => {
      // "merlot" must not be stripped from "merlotation" — boundary guard.
      const c = classifyConcept(makeViews('Merlotation Estate'));
      expect(c.isConceptOnly).toBe(false);
      expect(c.residual).toContain('merlotation');
      // The concept "Merlot" should NOT have fired.
      expect(c.terms).not.toContain('Merlot');
    });
  });

  // ── residual-token dropping rules (josa + numeric) ──────────────────────────
  describe('residual token dropping', () => {
    it('drops a bare Korean particle (josa) left after stripping an agglutinated grape', () => {
      // "까쇼는" → 까쇼 stripped → "는" josa dropped → concept-only
      const c = classifyConcept(makeViews('까쇼는'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
      expect(c.terms).toContain('Cabernet Sauvignon');
    });

    it('treats a stray vintage as concept (grape + year → concept-only)', () => {
      const c = classifyConcept(makeViews('Cabernet Sauvignon 2018'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(true);
    });

    it('drops a bare 1-2 digit count residual (까쇼 3 → concept-only)', () => {
      const c = classifyConcept(makeViews('까쇼 3'));
      expect(c.isConceptOnly).toBe(true);
    });

    it('KEEPS a 3-digit numeric brand as residual (707 is an entity reference)', () => {
      const c = classifyConcept(makeViews('707'));
      expect(c.isConceptOnly).toBe(false);
      expect(c.residual).toContain('707');
    });

    it('KEEPS a 4-digit numeric brand that is not a vintage year (1865)', () => {
      // 1865 is NOT a 19xx/20xx vintage so the vintage stripper leaves it;
      // the classifier must keep a 3-4 digit numeric token as an entity signal.
      const c = classifyConcept(makeViews('1865'));
      expect(c.isConceptOnly).toBe(false);
      expect(c.residual).toContain('1865');
    });
  });

  // ── edge cases: empty / whitespace / emoji / boundary ───────────────────────
  describe('edge cases', () => {
    it('empty string → concept-only with no terms (nothing to admit)', () => {
      const c = classifyConcept(makeViews(''));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(false);
      expect(c.residual).toBe('');
      expect(c.terms).toEqual([]);
    });

    it('whitespace-only string → concept-only with no terms', () => {
      const c = classifyConcept(makeViews('     '));
      expect(c.isConceptOnly).toBe(true);
      expect(c.hasConceptTerm).toBe(false);
      expect(c.residual).toBe('');
    });

    it('emoji-only query → no concept term, no residual (emoji folded out upstream)', () => {
      // 🍷 is not a letter/digit, so the vintageStripped view (which folds every
      // non-alphanumeric to a space) carries no emoji into the classifier. The
      // classifier therefore sees an empty surface — concept-only, no term.
      // (Unicode-safe regex must not crash on emoji input.)
      const c = classifyConcept(makeViews('🍷'));
      expect(c.hasConceptTerm).toBe(false);
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });

    it('grape concept followed by an emoji → grape fires, emoji leaves no residual', () => {
      // The emoji is folded out by the normalized view, so only the grape
      // concept remains → concept-only.
      const c = classifyConcept(makeViews('메를로 🍷'));
      expect(c.hasConceptTerm).toBe(true);
      expect(c.terms).toContain('Merlot');
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });

    it('does not throw on mixed-script + punctuation + emoji input', () => {
      expect(() => classifyConcept(makeViews('레드 wine!! 🍷 Caymus'))).not.toThrow();
    });

    it('is idempotent — re-running the global boundary regexes is stable', () => {
      const views = makeViews('Cabernet Sauvignon');
      const a = classifyConcept(views);
      const b = classifyConcept(views);
      expect(a).toEqual(b);
    });

    it('the same concept-only verdict holds across repeated calls (no global-regex lastIndex leak)', () => {
      // Stateful /g regexes can leak lastIndex between calls; verify the second
      // call still fires the strip.
      for (let i = 0; i < 3; i += 1) {
        const c = classifyConcept(makeViews('까쇼'));
        expect(c.isConceptOnly).toBe(true);
        expect(c.terms).toContain('Cabernet Sauvignon');
      }
    });
  });

  // ── classification path: longest-first stopword wins over concept prefix ─────
  describe('longest-first strip ordering', () => {
    it('agglutinated stopword 추천해줘 strips before the shorter concept 추천 (no verb residual)', () => {
      // "와인 추천해줘" → all stopwords/occasion → concept-only, no residual verb.
      const c = classifyConcept(makeViews('와인 추천해줘'));
      expect(c.isConceptOnly).toBe(true);
      expect(c.residual).toBe('');
    });
  });
});
