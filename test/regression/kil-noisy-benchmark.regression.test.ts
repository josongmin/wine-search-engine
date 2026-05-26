/**
 * Regression: noisy KIL benchmark wired against the in-memory test container.
 *
 * Exercises `/v1/search/lookup`'s underlying pipeline (SearchUseCase with
 * `mode: entity`) against the curated 104-case `data/noisy-entity-benchmark.jsonl`
 * suite. The benchmark covers 11 noise categories — typo, accent_stripped,
 * whitespace_collapse_split, abbreviation, transliteration, phonetic,
 * producer_label_partial, vintage_partial, mixed_language, noisy_short_form,
 * adversarial_near_miss — across en/ko/zh.
 *
 * Why a regression test instead of just the CLI: the CLI hits a live HTTP
 * endpoint (`SEARCH_API_URL`), which requires Vespa + Postgres + the dev
 * service running. The in-memory container exposes the exact same
 * `SearchUseCase` (which implements `SearchExecutorPort`) so the eval can
 * run end-to-end without the infrastructure dependencies and still produce
 * the same `recall@K` / `MRR` numbers the CLI would emit.
 *
 * Coverage gate: the in-memory fixtures carry 8 of the 9 expected entities
 * (`romanee-conti-2015` is absent; the fixtures ship `romanee-conti-2019`),
 * so the achievable upper bound on recall is roughly the in-fixture share.
 * The gate enforces a conservative floor that catches a real recall
 * regression without breaking on the 2019-vintage drift.
 */
import { describe, expect, it } from 'vitest';
import { createTestContainer } from '../integration/helpers/test-container.js';
import {
  evaluateNoisyEntityBenchmarkWithSearchExecutor,
} from '../../scripts/eval/run-noisy-entity-eval.ts';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { TEST_ALIASES } from '../integration/helpers/test-fixtures.js';

/**
 * Recall@3 floor.
 *
 * Floor history:
 *  - 0.50: pre-P1.4 baseline (covered ~0.74 measured).
 *  - 0.64: post-P1.4 (abbreviation ETL lifted overall to ~0.80 measured).
 *  - 0.73: post-Latin-fuzzy (in-memory matcher gained Damerau-OSA on Latin,
 *    en bench lifted to ~0.81 measured; floor tightened ~10% below to catch
 *    a real backslide. Previously the 0.64 floor allowed the Latin-fuzzy
 *    gain to fully unwind without reding the test — see audit findings).
 */
const KIL_RECALL_AT_3_FLOOR = 0.73;

/** Conservative recall@1 floor — same ~10% margin below measured. */
const KIL_RECALL_AT_1_FLOOR = 0.73;

/**
 * Per-category recall@3 floors. Tightened to ~10% below measured (audit
 * found the previous ~25% cushion let multiple categories regress
 * silently). Categories not listed are small (n < 5) or too volatile.
 */
const PER_CATEGORY_RECALL_AT_3_FLOORS: Readonly<Record<string, number>> = {
  abbreviation: 0.60, // measured ~0.67–0.78 (depends on fixture)
  accent_stripped: 0.83, // measured 1.0
  whitespace_collapse_split: 0.90, // measured 1.0
  producer_label_partial: 0.80, // measured ~0.92
  // In-memory source truth currently caps this slice at 7/9:
  // - `neb-076` targets `romanee-conti-2015`, but the fixture corpus ships only 2019
  // - `neb-100` is a bare generic `barolo` query with `expected_resolution:"ambiguous"`
  //   and now fail-closes under the stricter exactness contract
  noisy_short_form: 7 / 9,
  transliteration: 0.80, // measured ~0.9
};

describe('KIL noisy benchmark — in-process pipeline against curated fixture corpus', () => {
  it('clears the recall floor on the 104-case noisy entity suite', async () => {
    const parts = createTestContainer();
    const report = await evaluateNoisyEntityBenchmarkWithSearchExecutor(
      parts.container.searchUseCase,
      {
        input: resolveDataPath('data/noisy-entity-benchmark.jsonl'),
        mode: 'entity',
        concurrency: 4,
      },
    );

    // Surface the full numbers in the failure message so triage doesn't
    // need to re-run the eval to learn which category fell over.
    const summary = {
      query_count: report.query_count,
      recall_at_1: report.recall_at_1,
      recall_at_3: report.recall_at_3,
      mrr: report.mrr,
      by_category: Object.fromEntries(
        Object.entries(report.by_category).map(([cat, stats]) => [
          cat,
          { recall_at_3: stats.recall_at_3, count: stats.count },
        ]),
      ),
    };
    console.log('[KIL noisy benchmark]', JSON.stringify(summary, null, 2));

    // The full benchmark is 104 cases; some loader paths filter to a default
    // suite (≈100). Accept any reasonable lower bound — the recall floors are
    // the real gate.
    expect(report.query_count).toBeGreaterThanOrEqual(90);
    expect(
      report.recall_at_1,
      `recall@1=${String(report.recall_at_1)} below floor ${String(KIL_RECALL_AT_1_FLOOR)}; ` +
        `full summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KIL_RECALL_AT_1_FLOOR);
    expect(
      report.recall_at_3,
      `recall@3=${String(report.recall_at_3)} below floor ${String(KIL_RECALL_AT_3_FLOOR)}; ` +
        `full summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(KIL_RECALL_AT_3_FLOOR);

    // Per-category gates — surface category-level regressions that the
    // overall metric would smooth over.
    for (const [category, floor] of Object.entries(PER_CATEGORY_RECALL_AT_3_FLOORS)) {
      const stats = report.by_category[category];
      if (stats === undefined) {
        continue; // category absent from this run — fixture filter applied.
      }
      expect(
        stats.recall_at_3,
        `Category "${category}" recall@3=${String(stats.recall_at_3)} below floor ${String(floor)}; ` +
          `n=${String(stats.count)}; full summary: ${JSON.stringify(summary)}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  }, 120_000);

  /**
   * Curated-only baseline protection. The default container alias set is
   * `TEST_ALIASES_WITH_DERIVED` (curated ∪ derived initialisms); this case
   * pins down the curated-only path so a regression in the curated alias
   * pipeline can never hide behind a derived-initialism abbreviation lift.
   *
   * Floor is intentionally set tight (≥ 0.70 recall@3) — when ETL adds new
   * derived aliases on top, abbreviation/initialism categories WILL lift,
   * but the curated baseline must not regress underneath them.
   */
  it('curated-only path holds its baseline recall (no silent regression behind derivations)', async () => {
    const parts = createTestContainer({ fixtureAliases: TEST_ALIASES });
    const report = await evaluateNoisyEntityBenchmarkWithSearchExecutor(
      parts.container.searchUseCase,
      {
        input: resolveDataPath('data/noisy-entity-benchmark.jsonl'),
        mode: 'entity',
        concurrency: 4,
      },
    );

    const summary = {
      query_count: report.query_count,
      recall_at_1: report.recall_at_1,
      recall_at_3: report.recall_at_3,
      mrr: report.mrr,
    };
    console.log('[KIL curated-only baseline]', JSON.stringify(summary, null, 2));

    expect(report.query_count).toBeGreaterThanOrEqual(90);
    expect(
      report.recall_at_3,
      `Curated-only recall@3=${String(report.recall_at_3)} below baseline floor 0.70; ` +
        `full summary: ${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(0.70);
  }, 120_000);
});
