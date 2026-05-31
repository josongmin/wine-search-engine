import { describe, expect, it } from 'vitest';
import { buildAliasLookupPlan, buildAliasSurfaceLookupPlan } from '../alias-lookup-plan.js';

describe('buildAliasLookupPlan — Korean ↔ Latin transliteration tokenization', () => {
  /**
   * Regression: the structural fix for the entity-route Korean-transliteration
   * gap (memory `project_entity_route_broken`).
   *
   * Before the fix, Korean-mixed queries that contained an exact entity name
   * plus a non-entity Korean tail (e.g. "페트뤼스 어떤 와인이야") produced
   * `lookupVariants` that included the transliterated form "petrus 어떤 와인이야"
   * as a single multi-word string, but `tokenList` was only seeded with words
   * from `views.punctuationStripped` (Korean view), so the bare Latin word
   * "petrus" never appeared in any lookup target. Downstream the PG aliases
   * substrate matches on `normalized_value = ANY(...)`, so the alias row
   * `petrus → w-petrus-*` was never hit.
   *
   * The fix tokenizes every lookup variant into words + bigrams so the
   * transliterated Latin tokens become first-class lookup keys.
   */
  it('emits the bare Latin transliteration as a unigram lookup token (페트뤼스 → petrus)', () => {
    const plan = buildAliasLookupPlan('페트뤼스 어떤 와인이야?');

    expect(plan.tokenList).toContain('petrus');
  });

  it('emits the bare Latin transliteration for 오푸스 (opus one) inside a mixed Korean query', () => {
    const plan = buildAliasLookupPlan('오푸스 원 추천해줘');

    // The single-token "오푸스" maps to "opus" via the curated per-token
    // lexicon. The multi-word identity "오푸스 원" maps to "opus one" via
    // the EXCEPTIONS reverse-romanization path. Both must be lookup keys.
    expect(plan.tokenList).toContain('opus');
    expect(plan.tokenList).toContain('opus one');
  });

  it('emits the bare Latin transliteration for 사씨카이아 mixed with a Korean price tail', () => {
    const plan = buildAliasLookupPlan('사씨카이아 가격 얼마야');

    // korean-wine-aliases corrects 사씨카이아 → 사시카이아 (curated typo),
    // and the EXCEPTIONS dictionary keys 사시카이아 → sassicaia.
    expect(plan.tokenList).toContain('sassicaia');
  });

  it('emits the multi-word Latin identity for 돔 페리뇽 mixed with a Korean info tail', () => {
    const plan = buildAliasLookupPlan('돔 페리뇽 정보 알려줘');

    // EXCEPTIONS keys "dom pérignon" / "dom perignon" → "돔 페리뇽"; the
    // curated reverse-romanization path emits both the accentful and the
    // accent-stripped Latin surfaces (`stripAccents`-aligned with the
    // ETL's `normalizeForMatch`). We do NOT emit "dom" or "perignon" as
    // bare unigrams — those are ambiguous family-prefix tokens that would
    // collide against other wines.
    expect(plan.tokenList).toContain('dom pérignon');
    expect(plan.tokenList).toContain('dom perignon');
  });

  it('does NOT regress: pure entity query still emits the single-word Latin token', () => {
    const plan = buildAliasLookupPlan('페트뤼스');

    expect(plan.tokenList).toContain('petrus');
  });

  it('does NOT inject empty tokens or single-character noise', () => {
    const plan = buildAliasLookupPlan('페트뤼스 어떤 와인이야?');

    for (const token of plan.tokenList) {
      expect(token.trim().length).toBeGreaterThanOrEqual(2);
    }
  });

  it('handles pure-Latin queries idempotently (no Hangul, no regression)', () => {
    const plan = buildAliasLookupPlan('Opus One 2018');

    // Latin tokens come from the punctuation-stripped word loop (Pass 2)
    // and the bigram loop; no Korean reverse-romanization fires.
    expect(plan.tokenList).toEqual(
      expect.arrayContaining(['opus', 'one', 'opus one']),
    );
    for (const token of plan.tokenList) {
      expect(token.length).toBeGreaterThan(0);
    }
  });

  it('surface lookup plan excludes reordered whole-query variants', () => {
    const plan = buildAliasSurfaceLookupPlan('wine for cheese');

    expect(plan.tokenList).not.toContain('cheese for wine');
    expect(plan.tokenList).not.toContain('for wine cheese');
  });

  it('surface lookup plan keeps reordered whole-query variants for short Hangul entity surfaces', () => {
    const plan = buildAliasSurfaceLookupPlan('마고 샤또');

    expect(plan.tokenList).toContain('샤또 마고');
  });
});
