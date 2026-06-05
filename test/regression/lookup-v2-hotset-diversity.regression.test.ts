import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type HotsetStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

interface HotsetRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: HotsetStatus;
  readonly class: string;
}

function loadHotset(): HotsetRow[] {
  const raw = readFileSync(join(process.cwd(), 'test/fixtures/lookup-v2-hotset.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HotsetRow);
}

describe('lookup-v2 hotset fixture stays diverse enough to catch real regressions', () => {
  it('keeps the expanded scenario mix instead of collapsing back to a tiny smoke set', () => {
    const rows = loadHotset();
    const classes = new Set(rows.map((row) => row.class));
    const qids = new Set(rows.map((row) => row.qid));
    const statusCounts = rows.reduce<Record<HotsetStatus, number>>(
      (acc, row) => {
        acc[row.expected_status] += 1;
        return acc;
      },
      { resolved: 0, ambiguous: 0, failed: 0, redirect_discovery: 0 },
    );

    expect(rows.length).toBeGreaterThanOrEqual(45);
    expect(qids.size).toBe(rows.length);

    expect(statusCounts.resolved).toBeGreaterThanOrEqual(20);
    expect(statusCounts.redirect_discovery).toBeGreaterThanOrEqual(7);
    expect(statusCounts.ambiguous).toBeGreaterThanOrEqual(9);
    expect(statusCounts.failed).toBeGreaterThanOrEqual(5);

    for (const requiredClass of [
      'exact_entity',
      'transliteration',
      'transliteration_hard',
      'transliteration_spacing',
      'concept_grape',
      'concept_grape_korean',
      'concept_style',
      'concept_region',
      'generic',
      'generic_korean',
      'producer_grape',
      'producer_wine',
      'multi_vintage_noisy',
      'appellation_entity_collision',
      'producer_entity_collision',
      'common_noun_entity_collision',
      'ambiguity_korean_typo',
      'concept_grape_recommendation',
      'safe_abstain_recommendation_phrase',
      'adversarial_no_match',
      'vintage_conflict_impossible',
      'hot_entity_coverage',
      'generic_korean_failed',
    ]) {
      expect(classes.has(requiredClass)).toBe(true);
    }
  });

  it('retains Korean and mixed-script pressure instead of drifting to Latin-only cases', () => {
    const rows = loadHotset();
    const hangulRows = rows.filter((row) => /[가-힣]/u.test(row.query));
    const koreanRedirects = hangulRows.filter((row) => row.expected_status === 'redirect_discovery');
    const koreanResolved = hangulRows.filter((row) => row.expected_status === 'resolved');
    const ambiguousCollisionRows = rows.filter((row) => row.expected_status === 'ambiguous' && /collision|vintage/u.test(row.class));

    expect(hangulRows.length).toBeGreaterThanOrEqual(25);
    expect(koreanRedirects.length).toBeGreaterThanOrEqual(3);
    expect(koreanResolved.length).toBeGreaterThanOrEqual(14);
    expect(ambiguousCollisionRows.length).toBeGreaterThanOrEqual(7);
  });

  it('keeps hotset class labels wired into the live shadow scorer for per-class gating', () => {
    const runner = readFileSync(join(process.cwd(), 'scripts/eval/run-lookup-v2-shadow-compare.ts'), 'utf8');

    expect(runner).toContain('queryClass: row.class');
    expect(runner).toContain('await pool.end();');
  });
});
