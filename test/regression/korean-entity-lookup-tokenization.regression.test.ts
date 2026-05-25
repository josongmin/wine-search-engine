/**
 * Regression — Korean entity-lookup tokenization (memory
 * `project_entity_route_broken`, follow-up to the anchor-refresh wave-1
 * fix).
 *
 * Background. Even with the entity-route anchor-refresh safety net in
 * place, well-known Korean wine queries continued to silently miss the
 * PG alias substrate when the query mixed an exact entity name with a
 * non-entity Korean tail. Example bench scenario:
 *
 *   query:  "페트뤼스 어떤 와인이야?"
 *   judge:  "Missed: does not resolve '페트뤼스' to Pétrus, no Pomerol/
 *           Bordeaux context"
 *   answer: "현재 검색 결과에서 '페트뤼스'에 해당하는 항목을 찾을 수 없습니다"
 *
 * RCA. The query normalizer's `KOREAN_TRANSLITERATION_COMPONENT_RULES`
 * produced "petrus 어떤 와인이야" as a single multi-word entry in
 * `views.transliterated` / `views.lookupVariants`. `buildAliasLookupPlan`
 * tokenized words only from the Hangul-preserving `punctuationStripped`
 * view, so the bare Latin token "petrus" never became a lookup key. PG's
 * `WHERE normalized_value = ANY(...)` thus missed the canonical alias
 * row `petrus → w-petrus-*` even though it exists in the snapshot.
 *
 * Structural fix. A new SSoT lexicon `korean-wine-token-lexicon.ts`
 * exposes the curated per-Korean-token Latin form. `buildAliasLookupPlan`
 * runs a Pass-3 reverse-romanization over each Hangul unigram / bigram
 * in the query and adds the canonical Latin surface + each Latin word as
 * lookup keys. The Pass-1 full-surface seeding still happens first so
 * the exact-first short-circuit in the anchor extractor fires before any
 * Pass-3 unigram lookup runs (no recall regression against the
 * "샤또 디켐 vs Chateau Cheval Blanc" precedence contract).
 *
 * Coverage: pinned wines drawn from the v14 bench failure cluster +
 * adjacent famous wines that share the same Korean-mixed query shape.
 */

import { describe, expect, it } from 'vitest';
import { buildAliasLookupPlan } from '../../src/domain/query/service/alias-lookup-plan.js';

interface KoreanLookupCase {
  readonly query: string;
  readonly expectedLatinTokens: readonly string[];
  readonly description: string;
}

const CASES: readonly KoreanLookupCase[] = [
  // The v14 bench scenario #202 root cause.
  {
    query: '페트뤼스 어떤 와인이야?',
    expectedLatinTokens: ['petrus'],
    description: 'Pétrus mixed with Korean info tail (bench #202 RCA)',
  },
  {
    query: '페트뤼스',
    expectedLatinTokens: ['petrus'],
    description: 'Pétrus bare Korean surface',
  },
  // Adjacent famous wines from the same Korean-mixed query family.
  {
    query: '오푸스 원 추천해줘',
    expectedLatinTokens: ['opus', 'opus one'],
    description: 'Opus One mixed with Korean recommendation tail',
  },
  {
    query: '사씨카이아 가격 얼마야',
    expectedLatinTokens: ['sassicaia'],
    description: 'Sassicaia mixed with Korean price tail',
  },
  {
    query: '돔 페리뇽 정보 알려줘',
    expectedLatinTokens: ['dom perignon', 'dom pérignon'],
    description: 'Dom Pérignon mixed with Korean info tail',
  },
  // From the user memory list of famously-missed wines.
  {
    query: '마고 어떤 와인이야',
    expectedLatinTokens: ['margaux'],
    description: 'Margaux (마고) bare-token in mixed Korean query',
  },
  {
    query: '라피트 가격',
    expectedLatinTokens: ['lafite'],
    description: 'Lafite (라피트) mixed with Korean price keyword',
  },
  {
    query: '라투르 출시됐어',
    expectedLatinTokens: ['latour'],
    description: 'Latour (라투르) mixed with Korean release-status keyword',
  },
  {
    query: '무통 추천',
    expectedLatinTokens: ['mouton'],
    description: 'Mouton (무통) mixed with Korean recommendation keyword',
  },
  {
    query: '크뤼그 어떤 와인이야',
    expectedLatinTokens: ['krug'],
    description: 'Krug (크뤼그) bare-token in mixed Korean query',
  },
  {
    query: '바롤로 추천해줘',
    expectedLatinTokens: ['barolo'],
    description: 'Barolo (바롤로) mixed with Korean recommendation tail',
  },
];

describe('alias lookup plan — Korean entity tokenization regression', () => {
  it.each(CASES)('emits canonical Latin tokens for: $description', ({ query, expectedLatinTokens }) => {
    const plan = buildAliasLookupPlan(query);
    for (const latin of expectedLatinTokens) {
      expect(plan.tokenList).toContain(latin);
    }
  });

  // Counter-test: the structural fix MUST NOT inject ambiguous family-prefix
  // collisions. The matcher precedence contract for "샤또 디켐" relies on
  // "chateau" not appearing as a unigram lookup key (it would collide
  // against every Chateau-family Latin alias). See
  // `search-snapshot-alias-matcher.test.ts` for the downstream invariant.
  it('does NOT emit ambiguous family-prefix unigrams for 샤또 (chateau)', () => {
    const plan = buildAliasLookupPlan('샤또 디켐');
    expect(plan.tokenList).not.toContain('chateau');
  });

  it('does NOT emit ambiguous family-prefix unigrams for 보졸레 (beaujolais)', () => {
    const plan = buildAliasLookupPlan('보졸레 누보');
    // Multi-word identity "beaujolais nouveau" is fine, but the bare
    // family prefix "beaujolais" must not be an isolated lookup key —
    // otherwise it collides with every Beaujolais cru wine in the index.
    expect(plan.tokenList).not.toContain('beaujolais');
    // The exact multi-word identity should still resolve via the
    // `KOREAN_TRANSLITERATION_RULES` full-phrase path on `transliterated`.
    expect(plan.tokenList).toContain('beaujolais nouveau');
  });
});
