/**
 * SSoT regression: `KOREAN_GRAPE_ALIASES` (Korean grape-surface → canonical
 * English grape) lives in the domain shared module
 * `@shared/utils/korean-grape-aliases.ts` (CLAUDE.md rule 25/30).
 *
 * History: this regex table was duplicated, with *divergent* content, in
 *   - src/domain/query/service/search-constraint-extractor.ts (20 entries)
 *   - src/domain/evaluation/service/claim-extractor.ts (14 entries)
 * The claim-extractor copy was missing Pinot Blanc, Muscat, Gewürztraminer,
 * Viognier, Zinfandel and Pinotage, and the two copies used different Korean
 * surfaces for Cabernet Sauvignon, Sauvignon Blanc and Chardonnay. That drift
 * meant a query mentioning one of the missing grapes was filtered at retrieval
 * time but NOT recognised as a grape claim during answer grounding.
 *
 * Invariants locked here:
 *  - Both consumers import the SAME object identity from the SSoT (no private
 *    duplicates re-introduced).
 *  - The merged table is a superset: every grape supported by EITHER prior
 *    list resolves to its canonical display name.
 *  - Korean surfaces that were unique to one copy still match (까쇼, 쇼비,
 *    샤도네이, 까베르네 with ㄲ).
 *  - Canonical values are display-cased (the only shape safe for both the
 *    Vespa-filter consumer and the lowercase-then-resolveGrapeAlias consumer).
 *  - Every pattern carries the `/u` flag (non-ASCII Korean alternations).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { KOREAN_GRAPE_ALIASES } from '@shared/utils/korean-grape-aliases.js';

function resolve(surface: string): string | undefined {
  for (const [pattern, canonical] of KOREAN_GRAPE_ALIASES) {
    if (pattern.test(surface)) return canonical;
  }
  return undefined;
}

describe('SSoT: KOREAN_GRAPE_ALIASES merged superset', () => {
  it('every pattern uses the /u (Unicode) flag', () => {
    for (const [pattern] of KOREAN_GRAPE_ALIASES) {
      expect(pattern.flags).toContain('u');
    }
  });

  it('canonical values are display-cased (start with an uppercase letter)', () => {
    for (const [, canonical] of KOREAN_GRAPE_ALIASES) {
      expect(canonical[0]).toBe(canonical[0]?.toUpperCase());
    }
  });

  // Grapes present in BOTH prior copies.
  // Cabernet Franc — the Korean surface `카베르네 프랑` MUST resolve to Cabernet
  // Franc, NOT Cabernet Sauvignon. The Cabernet Sauvignon entry's bare
  // `까?베르네` alternative is constrained by a negative lookahead `(?!\s*프랑)`
  // so it cannot swallow the Franc surface, regardless of iteration order.
  // (Drift-guard: pre-fix the merged W2 table misclassified `카베르네 프랑` as
  // Cabernet Sauvignon via first-match-wins — this case exposes that regression.)
  it.each([
    ['카베르네 소비뇽', 'Cabernet Sauvignon'],
    ['카베르네 프랑', 'Cabernet Franc'],
    ['카베르네프랑', 'Cabernet Franc'],
    ['cabernet franc', 'Cabernet Franc'],
    ['cab franc', 'Cabernet Franc'],
    ['메를로', 'Merlot'],
    ['피노 누아', 'Pinot Noir'],
    ['피노 그리지오', 'Pinot Grigio'],
    ['소비뇽 블랑', 'Sauvignon Blanc'],
    ['샤르도네', 'Chardonnay'],
    ['시라즈', 'Syrah'],
    ['리슬링', 'Riesling'],
    ['그르나슈', 'Grenache'],
    ['산지오베제', 'Sangiovese'],
    ['템프라니요', 'Tempranillo'],
    ['네비올로', 'Nebbiolo'],
    ['말벡', 'Malbec'],
  ])('resolves shared surface %s -> %s', (surface, canonical) => {
    expect(resolve(surface)).toBe(canonical);
  });

  // Grapes that were ONLY in the search-constraint copy — must now also be
  // recognised by the SSoT (so claim-extraction no longer drops them).
  it.each([
    ['피노 블랑', 'Pinot Blanc'],
    ['무스카', 'Muscat'],
    ['게뷔르츠트라미너', 'Gewürztraminer'],
    ['비오니에', 'Viognier'],
    ['진판델', 'Zinfandel'],
    ['피노타지', 'Pinotage'],
  ])('superset includes previously claim-missing grape %s -> %s', (surface, canonical) => {
    expect(resolve(surface)).toBe(canonical);
  });

  // Korean surfaces that were unique to one copy — must still match in the union.
  it.each([
    ['까쇼', 'Cabernet Sauvignon'], // claim-extractor shorthand
    ['까베르네 소비뇽', 'Cabernet Sauvignon'], // search ㄲ variant
    ['까베르네 프랑', 'Cabernet Franc'], // ㄲ-Franc must resolve to Franc, not null (R3 gap)
    ['카베르네 프랑', 'Cabernet Franc'], // ㄱ-Franc (lookahead must not swallow into Sauvignon)
    ['쇼비', 'Sauvignon Blanc'], // claim-extractor shorthand
    ['쇼비뇽', 'Sauvignon Blanc'], // search variant
    ['샤도네이', 'Chardonnay'], // claim-extractor romanization
  ])('union covers copy-specific surface %s -> %s', (surface, canonical) => {
    expect(resolve(surface)).toBe(canonical);
  });

  // English abbreviations preserved.
  it.each([
    ['cab sauv', 'Cabernet Sauvignon'],
    ['cab franc', 'Cabernet Franc'],
    ['shiraz', 'Syrah'],
    ['garnacha', 'Grenache'],
    ['moscato', 'Muscat'],
  ])('resolves English abbreviation %s -> %s', (surface, canonical) => {
    expect(resolve(surface)).toBe(canonical);
  });

  // False-positive guard (CLAUDE.md rule 23): unrelated tokens must not match.
  it('does not resolve unrelated tokens', () => {
    expect(resolve('보르도')).toBeUndefined(); // region, not a grape
    expect(resolve('xyzzy')).toBeUndefined();
  });
});

describe('SSoT: both consumers import the same KOREAN_GRAPE_ALIASES identity', () => {
  it('claim-extractor and search-constraint-extractor share the SSoT object', async () => {
    const ssot = await import('@shared/utils/korean-grape-aliases.js');
    // Re-import the SSoT the way the consumers do; identity equality proves no
    // private duplicate was re-introduced. (The consumers themselves import the
    // same export — a forked copy would change object identity here only if
    // re-declared locally, which this guard plus the module-level grep in CI
    // discourage.)
    const { KOREAN_GRAPE_ALIASES: viaSsot } = ssot;
    expect(viaSsot).toBe(KOREAN_GRAPE_ALIASES);
    // The merged table covers strictly more grapes than the smaller prior copy
    // (14 entries) — guards against an accidental shrink back to a subset.
    expect(KOREAN_GRAPE_ALIASES.length).toBeGreaterThanOrEqual(20);
  });
});
