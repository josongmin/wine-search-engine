import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type StretchStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

interface StretchRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: StretchStatus;
  readonly class: string;
}

function loadStretchCorpus(): StretchRow[] {
  const raw = readFileSync(join(process.cwd(), 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StretchRow);
}

describe('lookup-v2 Korean realworld stretch corpus stays wide and adversarial', () => {
  it('keeps enough row volume and status diversity to pressure realistic Korean search behavior', () => {
    const rows = loadStretchCorpus();
    const qids = new Set(rows.map((row) => row.qid));
    const classes = new Set(rows.map((row) => row.class));
    const statusCounts = rows.reduce<Record<StretchStatus, number>>(
      (acc, row) => {
        acc[row.expected_status] += 1;
        return acc;
      },
      { resolved: 0, ambiguous: 0, failed: 0, redirect_discovery: 0 },
    );

    expect(rows.length).toBeGreaterThanOrEqual(46);
    expect(qids.size).toBe(rows.length);
    expect(statusCounts.resolved).toBeGreaterThanOrEqual(25);
    expect(statusCounts.redirect_discovery).toBeGreaterThanOrEqual(10);
    expect(statusCounts.failed).toBeGreaterThanOrEqual(6);

    for (const requiredClass of [
      'realworld_exact_vintage',
      'realworld_korean_orthography',
      'realworld_collapsed_typo_gap',
      'realworld_brand_suffix',
      'realworld_gap_napa_icon',
      'realworld_concept_region_grape',
      'realworld_pairing_recommendation',
      'realworld_occasion_recommendation',
      'realworld_gift_recommendation',
      'realworld_style_recommendation',
      'realworld_near_miss_no_match',
      'realworld_adversarial_no_match',
    ]) {
      expect(classes.has(requiredClass)).toBe(true);
    }
  });

  it('keeps strong Hangul and sentence-level pressure instead of collapsing into clean canonical labels', () => {
    const rows = loadStretchCorpus();
    const hangulRows = rows.filter((row) => /[가-힣]/u.test(row.query));
    const spacedPhraseRows = rows.filter((row) => /\s/u.test(row.query));
    const recommendationRows = rows.filter((row) => row.class.includes('recommendation'));
    const gapRows = rows.filter((row) => row.class.includes('_gap'));

    expect(hangulRows.length).toBeGreaterThanOrEqual(42);
    expect(spacedPhraseRows.length).toBeGreaterThanOrEqual(20);
    expect(recommendationRows.length).toBeGreaterThanOrEqual(7);
    expect(gapRows.length).toBeGreaterThanOrEqual(10);
  });
});
