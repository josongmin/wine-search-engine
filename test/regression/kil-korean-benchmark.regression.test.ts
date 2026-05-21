/**
 * Regression: Korean-pattern KIL benchmark against the in-memory pipeline.
 *
 * Companion to `kil-noisy-benchmark.regression.test.ts` (which is en-heavy).
 * This suite exercises the `/v1/search/lookup` pipeline against
 * `data/noisy-entity-benchmark-ko.jsonl` — ~370 cases over a Korea-market
 * catalog (best-sellers like 1865 / 몬테스 알파 / 카시예로 델 디아블로 plus
 * famous premium: 5대 샤토, 슈퍼투스칸, 돔페리뇽/뵈브클리코, 케이머스 …).
 * The catalog is injected via `fixtureDocuments` / `fixtureAliases`
 * (`korean-wine-fixtures.ts`) so it never perturbs the shared default corpus.
 *
 * Categories (grounded in real Korean wine-search behaviour):
 *   ko_spacing          띄어쓰기/음절 과분할      (붙여쓰기, "오 푸 스 원")
 *   ko_shorthand        줄임말/부분명            ("오푸스", "디아블로", "1865")
 *   ko_particle         조사·존칭·의도어 부착     ("오푸스원이요", "…추천해줘")
 *   ko_codeswitch       한영 병기·혼용           ("오퍼스 one", "caymus 케이머스")
 *   ko_ime_jamo         IME 종성/모음 잔류        ("오푸스ㅇ", "디아블로ㅗ")
 *   ko_loanword_variant 외래어 표기 변형          ("샤또"/"샤토", "까베르네")
 *   ko_vintage          빈티지 한글 결합          ("오푸스원 18", "라피트 2016")
 *   ko_phonetic_var     된소리/거센소리 발음 변형  ("마꼬", "라뚜르", "꽁띠")
 *   ko_region_producer  지역/카테고리 + label     ("나파 케이머스", "칠레 몬테스")
 *   ko_typo             명백한 한글 자모 오타      ("몬데스", "케이무스", "클라우드")
 *   ko_ambiguous        의도적 모호/abstain        ("샤토", "카베르네", "샴페인 추천")
 *
 * Metric note: `ko_ambiguous` cases are *designed to abstain* — the correct
 * behaviour is NOT to confidently surface one entity, so recall@K is the
 * wrong lens and that category is intentionally NOT recall-gated below. Every
 * other category is a genuine recall target.
 *
 * Append-only: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { createTestContainer } from '../integration/helpers/test-container.js';
import {
  evaluateNoisyEntityBenchmarkWithSearchExecutor,
} from '../../scripts/eval/run-noisy-entity-eval.ts';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  KOREAN_WINE_ALIASES,
  KOREAN_WINE_DOCUMENTS,
} from '../integration/helpers/korean-wine-fixtures.js';

/**
 * Overall recall floor. Measured recall@3 ≈ 0.97 on the post-dedup +
 * harder-typo suite (~370 cases). The headline includes the designed-abstain
 * `ko_ambiguous` slice (~0.48 by design), which structurally caps the
 * overall; floor at 0.92 sits ~5% below measured — tighter than the
 * earlier 0.88 audit-flagged cushion that let the fuzzy gain unwind.
 */
const KO_RECALL_AT_3_FLOOR = 0.92;
const KO_RECALL_AT_1_FLOOR = 0.92;

/**
 * Per-category recall@3 floors. `ko_ambiguous` is intentionally absent
 * (gated by KO_FALSE_EXACT_CEILING / KO_RESOLUTION_MATCH_FLOOR below).
 * Floors sit ~3-7% below measured (was ~8-12%, audit flagged as no-op).
 */
const KO_PER_CATEGORY_RECALL_AT_3_FLOORS: Readonly<Record<string, number>> = {
  ko_spacing: 0.95, // measured 1.0
  ko_shorthand: 0.95, // measured 1.0
  ko_particle: 0.95, // measured 1.0
  ko_codeswitch: 0.93, // measured 1.0
  ko_ime_jamo: 0.93, // measured 1.0
  ko_loanword_variant: 0.95, // measured 1.0
  ko_vintage: 0.93, // measured 1.0
  ko_region_producer: 0.93, // measured 1.0
  ko_typo: 0.85, // measured 1.0 on single-jamo slips, harder 2-edit additions may dip
  ko_phonetic_var: 0.80, // measured ~0.92 — 된소리 변형
};

/**
 * Abstention gates — Epic 17.3 hallucination guard.
 *
 * `ko_ambiguous` rows carry `expected_resolution: 'ambiguous'` +
 * `confident_wrong_top1_forbidden: true`. Without these floors the recall
 * gate above is structurally incomplete: a system that *confidently resolved*
 * every designed-abstain query to a wrong wine would still pass the recall
 * floors. The eval harness already computes the metrics
 * (`resolution_checked_count`, `resolution_match_rate`, `false_exact_rate`);
 * these constants make the regression read them.
 *
 *  - `KO_MIN_RESOLUTION_CHECKED` — sanity floor; if the corpus loses its
 *    `expected_resolution` tags the test must red rather than silently skip.
 *  - `KO_FALSE_EXACT_CEILING` — fraction of `expected_resolution='ambiguous'`
 *    rows the system was permitted to confidently resolve. Strict ceiling.
 *  - `KO_RESOLUTION_MATCH_FLOOR` — fraction of `expected_resolution`-tagged
 *    rows whose decisionStatus matched the expectation.
 */
const KO_MIN_RESOLUTION_CHECKED = 15;
const KO_FALSE_EXACT_CEILING = 0.25;
const KO_RESOLUTION_MATCH_FLOOR = 0.55;

describe('KIL Korean-pattern benchmark — in-process pipeline', () => {
  it('clears recall floors on the Korean noisy entity suite', async () => {
    const parts = createTestContainer({
      fixtureDocuments: KOREAN_WINE_DOCUMENTS,
      fixtureAliases: KOREAN_WINE_ALIASES,
    });
    const report = await evaluateNoisyEntityBenchmarkWithSearchExecutor(
      parts.container.searchUseCase,
      {
        input: resolveDataPath('data/noisy-entity-benchmark-ko.jsonl'),
        mode: 'entity',
        concurrency: 4,
      },
    );

    const summary = {
      query_count: report.query_count,
      recall_at_1: report.recall_at_1,
      recall_at_3: report.recall_at_3,
      mrr: report.mrr,
      resolution_checked_count: report.resolution_checked_count,
      resolution_match_rate: report.resolution_match_rate,
      false_exact_rate: report.false_exact_rate,
      by_category: Object.fromEntries(
        Object.entries(report.by_category).map(([cat, stats]) => [
          cat,
          { recall_at_3: stats.recall_at_3, count: stats.query_count },
        ]),
      ),
    };
    console.log('[KIL Korean benchmark]', JSON.stringify(summary, null, 2));

    expect(report.query_count).toBeGreaterThanOrEqual(120);
    expect(
      report.recall_at_1,
      `KO recall@1=${String(report.recall_at_1)} below floor ${String(KO_RECALL_AT_1_FLOOR)}; ` +
        `summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KO_RECALL_AT_1_FLOOR);
    expect(
      report.recall_at_3,
      `KO recall@3=${String(report.recall_at_3)} below floor ${String(KO_RECALL_AT_3_FLOOR)}; ` +
        `summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KO_RECALL_AT_3_FLOOR);

    for (const [category, floor] of Object.entries(KO_PER_CATEGORY_RECALL_AT_3_FLOORS)) {
      const stats = report.by_category[category];
      if (stats === undefined) {
        continue;
      }
      expect(
        stats.recall_at_3,
        `Category "${category}" recall@3=${String(stats.recall_at_3)} below floor ${String(floor)}; ` +
          `n=${String(stats.query_count)}; summary: ${JSON.stringify(summary)}`,
      ).toBeGreaterThanOrEqual(floor);
    }

    // Abstention gates — pin the `ko_ambiguous` category whose recall is
    // intentionally low-by-design. Without these the entire category goes
    // silently unenforced (audit-3 #2: eval reports the metrics, regression
    // never read them; a system that confidently mis-resolved every ambiguous
    // query would still pass the recall floors above).
    expect(
      report.resolution_checked_count,
      `resolution_checked_count=${String(report.resolution_checked_count)} below floor ${String(KO_MIN_RESOLUTION_CHECKED)} — abstention is unmeasured; ` +
        `summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KO_MIN_RESOLUTION_CHECKED);
    expect(
      report.false_exact_rate ?? 0,
      `false_exact_rate=${String(report.false_exact_rate)} above ceiling ${String(KO_FALSE_EXACT_CEILING)} — designed-abstain rows were confidently resolved (Epic 17.3 violation); ` +
        `summary: ${JSON.stringify(summary)}`,
    ).toBeLessThanOrEqual(KO_FALSE_EXACT_CEILING);
    expect(
      report.resolution_match_rate ?? 0,
      `resolution_match_rate=${String(report.resolution_match_rate)} below floor ${String(KO_RESOLUTION_MATCH_FLOOR)}; ` +
        `summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KO_RESOLUTION_MATCH_FLOOR);
  }, 180_000);
});
