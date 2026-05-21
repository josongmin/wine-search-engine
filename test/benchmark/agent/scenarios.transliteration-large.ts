import type {
  AgentBenchmarkScenario,
  ExactLookupPhenomenon,
} from './scenario.js';

type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * Scenario ID bases for the large transliteration lookup set.
 *
 * Each generator (positive / negative) allocates a contiguous block starting
 * at its base + index. Picking widely-spaced bases (600 / 700) keeps the
 * ranges disjoint from neighbour benchmark files (500-599 robustness,
 * 800+ reserved for future lookup batches).
 */
const LARGE_TRANSLITERATION_POSITIVE_SCENARIO_ID_BASE = 600;
const LARGE_TRANSLITERATION_NEGATIVE_SCENARIO_ID_BASE = 700;

type PositiveExactLookupRow = readonly [
  query: string,
  expectedEntityId: string,
  canonicalKo: string,
  canonicalEn: string,
  phenomena: readonly ExactLookupPhenomenon[],
  difficulty: Difficulty,
  mustNotReturnEntityIds: readonly string[],
];

type NegativeExactLookupRow = readonly [
  query: string,
  mustNotReturnEntityIds: readonly string[],
  reason: string,
  phenomena: readonly ExactLookupPhenomenon[],
  difficulty: Difficulty,
];

const GUARDED_CANONICAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'wine.petrus': ['Pétrus', 'Petrus', 'Château Pétrus', 'Chateau Petrus', '샤또 페트뤼스', '샤토 페트뤼스', '페트뤼스', '페트루스'],
  'wine.chateau_petrus_wrong_family': ['Château Pétrus', 'Chateau Petrus', '샤또 페트뤼스'],
  'wine.generic_pomerol_red': ['Pomerol', 'Pomerol Red', '포므롤'],
  'wine.dom_perignon': ['Dom Pérignon', 'Dom Perignon', '돔 페리뇽', '돔페리뇽'],
  'wine.moet_chandon_brut_imperial': ['Moët & Chandon Brut Impérial', 'Moet & Chandon Brut Imperial', '모엣 샹동 브뤼 임페리얼'],
  'wine.generic_champagne': ['Champagne', '샴페인'],
  'wine.moet_chandon_rose_imperial': ['Moët & Chandon Rosé Impérial', 'Moet & Chandon Rose Imperial', '모엣 샹동 로제 임페리얼', '모엣샹동 로제 임페리얼'],
  'wine.chandon_rose': ['Chandon Rosé', 'Chandon Rose', '샹동 로제'],
  'wine.generic_rose_sparkling': ['Rosé Sparkling', 'Rose Sparkling', '로제 스파클링'],
  'wine.chateau_margaux': ['Château Margaux', 'Chateau Margaux', '샤또 마고', '샤토 마고'],
  'wine.margaux_du_chateau_margaux': ['Margaux du Château Margaux', 'Margaux du Chateau Margaux'],
  'wine.generic_margaux_red': ['Margaux', '마고'],
  'wine.sassicaia': ['Sassicaia', '사씨카이아', '사시카이아', '사시까이아', '사씨까이아'],
  'wine.guidalberto': ['Guidalberto', '구이달베르토'],
  'wine.generic_bolgheri_red': ['Bolgheri Red', '볼게리 레드'],
  'wine.other_super_tuscan': ['Super Tuscan', '수퍼 투스칸', '슈퍼 투스칸'],
};

const POSITIVE_ROWS = [
  ['페트뤼스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['headless-brand', 'alias'], 'easy', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트뤼스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['canonical-ko'], 'easy', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또페트뤼스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['space-collapse'], 'easy', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤토 페트뤼스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['transliteration-variant'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤토페트뤼스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['space-collapse', 'transliteration-variant'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트루스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['common-korean-variant'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트루스 와인', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['suffix-noise', 'common-korean-variant'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트뤼스 와인', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['suffix-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트루스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['transliteration-variant', 'common-korean-variant'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤토 페트루스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['transliteration-variant', 'common-korean-variant'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트뤼스 2018', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['vintage-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트뤼스 2018', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['headless-brand', 'vintage-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트뤼스 레드', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['type-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트뤼스 보르도', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['region-noise', 'headless-brand'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또페트루스 2016', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['space-collapse', 'common-korean-variant', 'vintage-noise'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트뤼스 프랑스', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['country-noise', 'headless-brand'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트뤼스 프랑스 와인', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['country-noise', 'suffix-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트루스 보르도', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['common-korean-variant', 'region-noise'], 'hard', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['샤또 페트뤼스 메를로', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['grape-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['페트뤼스 메를로', 'wine.petrus', '샤또 페트뤼스', 'Petrus', ['headless-brand', 'grape-noise'], 'medium', ['wine.generic_pomerol_red', 'wine.chateau_petrus_wrong_family']],
  ['돔페리뇽', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['space-collapse', 'alias'], 'easy', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['canonical-ko'], 'easy', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 샴페인', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 샴페인', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 빈티지', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['suffix-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 빈티지', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['suffix-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 2013', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['vintage-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 2013', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['vintage-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리농', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['common-korean-variant'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리농', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['common-korean-variant'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 프랑스', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['country-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 프랑스', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['country-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 브뤼', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['style-noise'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 브뤼', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['style-noise'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 화이트', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 화이트', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 모엣', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['brand-parent-noise'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 모엣', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['brand-parent-noise'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔페리뇽 프랑스 샴페인', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['country-noise', 'type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['돔 페리뇽 프랑스 샴페인', 'wine.dom_perignon', '돔 페리뇽', 'Dom Perignon', ['country-noise', 'type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.generic_champagne']],
  ['모엣샹동 로제 임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['space-collapse'], 'easy', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제 임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['canonical-ko'], 'easy', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['truncated-popular-name'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['truncated-popular-name'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동로제임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['space-collapse'], 'easy', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['spacing-variant'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['spacing-variant', 'space-collapse'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제 임페리얼 750ml', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['size-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제 임페리얼 750ml', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['size-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제 임페리얼 프랑스', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['country-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제 임페리얼 프랑스', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['country-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 핑크', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['common-korean-variant'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 핑크', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['common-korean-variant'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣로제 임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['space-collapse', 'brand-shortening'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 로제 임페리얼', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['brand-shortening'], 'hard', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제 샴페인', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제 샴페인', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제 프랑스 샴페인', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['country-noise', 'type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣 샹동 로제 프랑스 샴페인', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['country-noise', 'type-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['모엣샹동 로제 임페리얼 NV', 'wine.moet_chandon_rose_imperial', '모엣 샹동 로제 임페리얼', 'Moet & Chandon Rose Imperial', ['vintage-noise'], 'medium', ['wine.moet_chandon_brut_imperial', 'wine.chandon_rose', 'wine.generic_rose_sparkling']],
  ['샤또 마고', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['canonical-ko'], 'easy', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또마고', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['space-collapse'], 'easy', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['transliteration-variant'], 'easy', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토마고', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['space-collapse', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['마고 샤또', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['token-order-variant'], 'hard', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 2015', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['vintage-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 2015', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['vintage-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 보르도', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['region-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 보르도', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['region-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 프랑스', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['country-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 프랑스', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['country-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 레드', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['type-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 레드', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['type-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 카베르네', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['grape-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 카베르네', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['grape-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또마고 2018', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['space-collapse', 'vintage-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토마고 2018', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['space-collapse', 'transliteration-variant', 'vintage-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 와인', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['suffix-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤토 마고 와인', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['suffix-noise', 'transliteration-variant'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['샤또 마고 프랑스 와인', 'wine.chateau_margaux', '샤또 마고', 'Chateau Margaux', ['country-noise', 'suffix-noise'], 'medium', ['wine.margaux_du_chateau_margaux', 'wine.generic_margaux_red']],
  ['사시카이아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['common-korean-variant'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['canonical-ko'], 'easy', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨까이아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['transliteration-variant'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시까이아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['transliteration-variant'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이야', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['final-vowel-variation'], 'hard', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이야', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['final-vowel-variation'], 'hard', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 2020', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['vintage-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 2020', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['vintage-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨까이아 2020', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['vintage-noise', 'transliteration-variant'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시까이아 2020', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['vintage-noise', 'transliteration-variant'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 이탈리아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['country-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 이탈리아', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['country-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 토스카나', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['region-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 토스카나', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['region-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 레드', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['type-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 레드', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['type-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 카베르네', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['grape-noise'], 'hard', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 카베르네', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['grape-noise'], 'hard', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사시카이아 와인', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['suffix-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
  ['사씨카이아 와인', 'wine.sassicaia', '사씨카이아', 'Sassicaia', ['suffix-noise'], 'medium', ['wine.guidalberto', 'wine.generic_bolgheri_red', 'wine.other_super_tuscan']],
] as const satisfies readonly PositiveExactLookupRow[];

const NEGATIVE_ROWS = [
  ['포므롤', ['wine.petrus'], 'region/appellation only; not exact entity', ['category-not-entity', 'region-only'], 'easy'],
  ['포므롤 와인', ['wine.petrus'], 'region/category query; underspecified', ['category-not-entity', 'suffix-noise'], 'easy'],
  ['보르도 메를로', ['wine.petrus'], 'style/grape query; not exact entity', ['grape-style-not-entity'], 'easy'],
  ['페트뤼스급', ['wine.petrus'], 'comparative phrase, not entity lookup', ['comparative-phrase'], 'medium'],
  ['페트뤼스 스타일', ['wine.petrus'], 'style phrase, not exact entity', ['style-not-entity'], 'medium'],
  ['샤또 페트뤼스급', ['wine.petrus'], 'comparative modifier makes it non-entity', ['comparative-phrase'], 'medium'],
  ['페트뤼스 같은 와인', ['wine.petrus'], 'recommendation-like phrase, not exact lookup', ['recommendation-like'], 'medium'],
  ['페트뤼스 대체', ['wine.petrus'], 'substitute query, not entity', ['recommendation-like'], 'medium'],
  ['샤또 포므롤', ['wine.petrus'], 'non-canonical malformed phrase; should fail closed', ['malformed-near-match'], 'hard'],
  ['페트로스', ['wine.petrus'], 'too-far transliteration; avoid overmatching', ['far-variant'], 'hard'],
  ['페트러스', ['wine.petrus'], 'variant may be tempting but should be rejected in strict negative set', ['strict-fail-closed'], 'hard'],
  ['페트로루스', ['wine.petrus'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['피트뤼스', ['wine.petrus'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['페트뤼스 느낌', ['wine.petrus'], 'impression query, not entity', ['style-not-entity'], 'medium'],
  ['페트뤼스 추천', ['wine.petrus'], 'intent is recommendation', ['recommendation-like'], 'easy'],
  ['페트뤼스 비교', ['wine.petrus'], 'comparison query, not lookup', ['comparison-like'], 'easy'],
  ['페트뤼스 와인 추천', ['wine.petrus'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['메를로 명작', ['wine.petrus'], 'descriptive category query', ['descriptive-category'], 'easy'],
  ['포므롤 최고급', ['wine.petrus'], 'descriptive category query', ['descriptive-category'], 'easy'],
  ['샤또 페트뤼스급 와인', ['wine.petrus'], 'recommendation/comparison query', ['comparative-phrase'], 'medium'],
  ['샴페인', ['wine.dom_perignon'], 'generic type query', ['category-not-entity'], 'easy'],
  ['프랑스 샴페인', ['wine.dom_perignon'], 'generic category query', ['category-not-entity'], 'easy'],
  ['모엣 샴페인', ['wine.dom_perignon'], 'brand-level family query', ['brand-family-ambiguous'], 'medium'],
  ['모엣샹동', ['wine.dom_perignon'], 'producer brand query, not cuvee', ['brand-family-ambiguous'], 'medium'],
  ['돔페리뇽급', ['wine.dom_perignon'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['돔페리뇽 스타일', ['wine.dom_perignon'], 'style phrase', ['style-not-entity'], 'medium'],
  ['돔 페리뇽 같은 샴페인', ['wine.dom_perignon'], 'recommendation query', ['recommendation-like'], 'medium'],
  ['돔페리뇽 대체', ['wine.dom_perignon'], 'substitute query', ['recommendation-like'], 'medium'],
  ['돔 페리뇽 추천', ['wine.dom_perignon'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['돔페리용', ['wine.dom_perignon'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['돔베리뇽', ['wine.dom_perignon'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['돔페리뇬', ['wine.dom_perignon'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['돔 페리뇽급 샴페인', ['wine.dom_perignon'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['럭셔리 샴페인', ['wine.dom_perignon'], 'descriptive category', ['descriptive-category'], 'easy'],
  ['샴페인 추천', ['wine.dom_perignon'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['빈티지 샴페인', ['wine.dom_perignon'], 'style/category query', ['category-not-entity'], 'easy'],
  ['모엣 임페리얼', ['wine.dom_perignon'], 'different Moet cuvee family', ['wrong-brand-nearby'], 'medium'],
  ['모엣 브뤼', ['wine.dom_perignon'], 'different Moet cuvee family', ['wrong-brand-nearby'], 'medium'],
  ['돔페리뇽 느낌', ['wine.dom_perignon'], 'impression query', ['style-not-entity'], 'medium'],
  ['모엣샹동 샴페인', ['wine.dom_perignon'], 'producer family only', ['brand-family-ambiguous'], 'medium'],
  ['모엣', ['wine.moet_chandon_rose_imperial'], 'brand only; not exact cuvee', ['brand-family-ambiguous'], 'easy'],
  ['모엣샹동', ['wine.moet_chandon_rose_imperial'], 'brand only; not exact cuvee', ['brand-family-ambiguous'], 'easy'],
  ['모엣 로제', ['wine.moet_chandon_rose_imperial'], 'family/sku ambiguous', ['brand-family-ambiguous'], 'medium'],
  ['모엣샹동 로제 와인', ['wine.moet_chandon_rose_imperial'], 'family query plus generic suffix', ['brand-family-ambiguous', 'suffix-noise'], 'medium'],
  ['로제 샴페인', ['wine.moet_chandon_rose_imperial'], 'generic category', ['category-not-entity'], 'easy'],
  ['핑크 샴페인', ['wine.moet_chandon_rose_imperial'], 'generic category', ['category-not-entity'], 'easy'],
  ['모엣샹동 핑크', ['wine.moet_chandon_rose_imperial'], 'common phrase but underspecified', ['brand-family-ambiguous'], 'medium'],
  ['모엣 핑크', ['wine.moet_chandon_rose_imperial'], 'underspecified brand phrase', ['brand-family-ambiguous'], 'medium'],
  ['모엣 로제 추천', ['wine.moet_chandon_rose_imperial'], 'recommendation/underspecified', ['recommendation-like', 'brand-family-ambiguous'], 'medium'],
  ['모엣샹동 로제 추천', ['wine.moet_chandon_rose_imperial'], 'recommendation/underspecified', ['recommendation-like', 'brand-family-ambiguous'], 'medium'],
  ['모엣샹동 로제급', ['wine.moet_chandon_rose_imperial'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['모엣 로제 느낌', ['wine.moet_chandon_rose_imperial'], 'style phrase', ['style-not-entity'], 'medium'],
  ['샹동 로제', ['wine.moet_chandon_rose_imperial'], 'wrong nearby brand', ['wrong-brand-nearby'], 'medium'],
  ['샹동 핑크', ['wine.moet_chandon_rose_imperial'], 'wrong nearby brand', ['wrong-brand-nearby'], 'medium'],
  ['모엣 임페리얼', ['wine.moet_chandon_rose_imperial'], 'different cuvee', ['wrong-brand-nearby'], 'medium'],
  ['모엣샹동 임페리얼', ['wine.moet_chandon_rose_imperial'], 'different cuvee / ambiguous family', ['wrong-brand-nearby'], 'medium'],
  ['로제 스파클링', ['wine.moet_chandon_rose_imperial'], 'generic type query', ['category-not-entity'], 'easy'],
  ['샴페인 로제', ['wine.moet_chandon_rose_imperial'], 'generic type query', ['category-not-entity'], 'easy'],
  ['모엣 로제 임페리얼급', ['wine.moet_chandon_rose_imperial'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['모에샹동 로제', ['wine.moet_chandon_rose_imperial'], 'garbled transliteration in strict negative set', ['garbled-transliteration'], 'hard'],
  ['마고', ['wine.chateau_margaux'], 'single token too underspecified', ['underspecified'], 'easy'],
  ['마고 와인', ['wine.chateau_margaux'], 'underspecified category phrase', ['underspecified'], 'easy'],
  ['마고 추천', ['wine.chateau_margaux'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['마고급', ['wine.chateau_margaux'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['마고 스타일', ['wine.chateau_margaux'], 'style phrase', ['style-not-entity'], 'medium'],
  ['보르도 퍼스트그로스', ['wine.chateau_margaux'], 'category/classification query', ['category-not-entity'], 'easy'],
  ['메독 레드', ['wine.chateau_margaux'], 'region category query', ['category-not-entity'], 'easy'],
  ['마고 아펠라시옹', ['wine.chateau_margaux'], 'region/appellation, not estate entity', ['category-not-entity'], 'medium'],
  ['마고 AOC', ['wine.chateau_margaux'], 'appellation query', ['category-not-entity'], 'medium'],
  ['샤또 마고급', ['wine.chateau_margaux'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['샤또마고 추천', ['wine.chateau_margaux'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['샤또 마고 느낌', ['wine.chateau_margaux'], 'style phrase', ['style-not-entity'], 'medium'],
  ['샤토 마르고', ['wine.chateau_margaux'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['샤또 마르고', ['wine.chateau_margaux'], 'near variant but strict fail-closed in this set', ['strict-fail-closed'], 'hard'],
  ['샤토 마르고', ['wine.chateau_margaux'], 'near variant but strict fail-closed in this set', ['strict-fail-closed'], 'hard'],
  ['마고 와이너리', ['wine.chateau_margaux'], 'non-canonical object phrasing', ['object-type-mismatch'], 'medium'],
  ['프랑스 명문 레드', ['wine.chateau_margaux'], 'descriptive category query', ['descriptive-category'], 'easy'],
  ['카베르네 명작', ['wine.chateau_margaux'], 'descriptive category query', ['descriptive-category'], 'easy'],
  ['샤또 마고 같은 와인', ['wine.chateau_margaux'], 'recommendation-like phrase', ['recommendation-like'], 'medium'],
  ['마고 비교', ['wine.chateau_margaux'], 'comparison query', ['comparison-like'], 'easy'],
  ['볼게리', ['wine.sassicaia'], 'region only', ['category-not-entity', 'region-only'], 'easy'],
  ['볼게리 레드', ['wine.sassicaia'], 'region/category query', ['category-not-entity'], 'easy'],
  ['수퍼 투스칸', ['wine.sassicaia'], 'style/class query', ['category-not-entity'], 'easy'],
  ['슈퍼 투스칸', ['wine.sassicaia'], 'style/class query', ['category-not-entity'], 'easy'],
  ['토스카나 레드', ['wine.sassicaia'], 'region category query', ['category-not-entity'], 'easy'],
  ['사시카이아급', ['wine.sassicaia'], 'comparative phrase', ['comparative-phrase'], 'medium'],
  ['사씨카이아 느낌', ['wine.sassicaia'], 'style phrase', ['style-not-entity'], 'medium'],
  ['사시카이아 추천', ['wine.sassicaia'], 'recommendation query', ['recommendation-like'], 'easy'],
  ['사씨카이아 대체', ['wine.sassicaia'], 'substitute query', ['recommendation-like'], 'medium'],
  ['사시까이야', ['wine.sassicaia'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['사시카야', ['wine.sassicaia'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['사씨카야', ['wine.sassicaia'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['사시가이아', ['wine.sassicaia'], 'garbled transliteration', ['garbled-transliteration'], 'hard'],
  ['구이달베르토', ['wine.sassicaia'], 'related but different wine', ['wrong-brand-nearby'], 'medium'],
  ['볼게리 슈퍼투스칸', ['wine.sassicaia'], 'category phrase', ['category-not-entity'], 'easy'],
  ['이탈리아 명품 레드', ['wine.sassicaia'], 'descriptive category', ['descriptive-category'], 'easy'],
  ['사시카이아 같은 와인', ['wine.sassicaia'], 'recommendation-like phrase', ['recommendation-like'], 'medium'],
  ['사씨카이아 비교', ['wine.sassicaia'], 'comparison query', ['comparison-like'], 'easy'],
  ['사씨카이아 스타일', ['wine.sassicaia'], 'style phrase', ['style-not-entity'], 'medium'],
  ['카베르네 수퍼투스칸', ['wine.sassicaia'], 'descriptive category', ['descriptive-category'], 'easy'],
] as const satisfies readonly NegativeExactLookupRow[];

function aliasesForEntityIds(entityIds: readonly string[]): readonly string[] {
  return [...new Set(entityIds.flatMap((entityId) => GUARDED_CANONICAL_ALIASES[entityId] ?? []))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s*');
}

function answerEntityPattern(values: readonly string[]): string {
  return `(${[...new Set(values)]
    .filter((value) => value.trim().length > 0)
    .map(escapeRegex)
    .join('|')})`;
}

function buildPositiveScenario(row: PositiveExactLookupRow, index: number): AgentBenchmarkScenario {
  const [query, expectedEntityId, canonicalKo, canonicalEn, phenomena, difficulty, mustNotReturnEntityIds] = row;
  const acceptedAliases = [query, ...aliasesForEntityIds([expectedEntityId])];
  return {
    id: LARGE_TRANSLITERATION_POSITIVE_SCENARIO_ID_BASE + index,
    tier: 'wine_name_lookup',
    query,
    description: `Large Korean transliteration exact lookup positive: ${canonicalEn} (${difficulty})`,
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: [answerEntityPattern([query, canonicalKo, canonicalEn, ...acceptedAliases])],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId,
        canonicalKo,
        canonicalEn,
        acceptedCanonicalAliases: acceptedAliases,
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        mustNotReturnEntityIds,
        mustNotReturnCanonicalAliases: aliasesForEntityIds(mustNotReturnEntityIds),
        phenomena,
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'contains_any', value: acceptedAliases },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        `Must treat "${query}" as an exact Korean transliteration lookup for ${canonicalEn}. `
        + `Accepted aliases include: ${[...new Set([query, canonicalKo, canonicalEn, ...acceptedAliases])].join(', ')}. `
        + 'Any accepted Korean or English alias spelling satisfies alias anchoring; do not require a different canonical Korean spelling literal when the answer uses the user spelling or the evidence canonical form. '
        + 'Noise suffixes such as vintage, country, region, type, and grape terms need not be repeated in the final answer once the base exact entity is confirmed. '
        + 'Alias, spacing, vintage, country, region, type, and grape noise may be normalized only when the exact entity remains unambiguous. '
        + 'If evidence confirms the exact entity, the answer should identify it directly. If live evidence cannot confirm the exact entity, the answer must abstain honestly instead of drifting to category or nearby-brand results.',
    },
  };
}

function buildNegativeScenario(row: NegativeExactLookupRow, index: number): AgentBenchmarkScenario {
  const [query, mustNotReturnEntityIds, reason, phenomena, difficulty] = row;
  return {
    id: LARGE_TRANSLITERATION_NEGATIVE_SCENARIO_ID_BASE + index,
    tier: 'wine_name_lookup',
    query,
    description: `Large Korean transliteration exact lookup hard negative: ${reason} (${difficulty})`,
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_return_guarded_entity',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnEntityIds,
        mustNotReturnCanonicalAliases: aliasesForEntityIds(mustNotReturnEntityIds),
        phenomena,
      },
      rubric:
        `Must not force "${query}" into an exact wine entity. Reason: ${reason}. `
        + 'Browsing or explaining ambiguity is acceptable only if the answer does not present a guarded wine as a confirmed exact match.',
    },
  };
}

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIOS: readonly AgentBenchmarkScenario[] =
  POSITIVE_ROWS.map(buildPositiveScenario);

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIOS: readonly AgentBenchmarkScenario[] =
  NEGATIVE_ROWS.map(buildNegativeScenario);

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  ...TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIOS,
  ...TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIOS,
];

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIO_IDS: ReadonlySet<number> = new Set(
  TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIOS.map((scenario) => scenario.id),
);

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIO_IDS: ReadonlySet<number> = new Set(
  TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIOS.map((scenario) => scenario.id),
);

export const TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIO_IDS: ReadonlySet<number> = new Set([
  ...TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIO_IDS,
  ...TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIO_IDS,
]);
