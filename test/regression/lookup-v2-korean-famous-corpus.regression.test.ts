import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CorpusStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

interface CorpusRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: CorpusStatus;
  readonly class: string;
}

function loadCorpus(): CorpusRow[] {
  const raw = readFileSync(join(process.cwd(), 'test/fixtures/lookup-v2-korean-famous-expanded.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

describe('lookup-v2 Korean-famous expanded corpus stays large and diverse', () => {
  it('keeps a large Korean iconic coverage set instead of collapsing to a tiny sample', () => {
    const rows = loadCorpus();
    const qids = new Set(rows.map((row) => row.qid));
    const classes = new Set(rows.map((row) => row.class));
    const statusCounts = rows.reduce<Record<CorpusStatus, number>>(
      (acc, row) => {
        acc[row.expected_status] += 1;
        return acc;
      },
      { resolved: 0, ambiguous: 0, failed: 0, redirect_discovery: 0 },
    );

    expect(rows.length).toBeGreaterThanOrEqual(75);
    expect(qids.size).toBe(rows.length);

    expect(statusCounts.resolved).toBeGreaterThanOrEqual(48);
    expect(statusCounts.ambiguous).toBeGreaterThanOrEqual(10);
    expect(statusCounts.redirect_discovery).toBeGreaterThanOrEqual(6);
    expect(statusCounts.failed).toBeGreaterThanOrEqual(4);

    for (const requiredClass of [
      'korean_icon_bordeaux',
      'korean_icon_burgundy',
      'korean_icon_champagne',
      'korean_icon_super_tuscan',
      'korean_icon_iberia_latam',
      'korean_icon_napa_cult',
      'korean_icon_australia',
      'korean_icon_germany_sauternes',
      'ambiguity_broad_icon',
      'ambiguity_appellation_collision',
      'ambiguity_common_noun_collision',
      'ambiguity_short_form',
      'ambiguity_near_miss',
      'concept_grape',
      'concept_region',
      'concept_style_korean',
      'concept_recommendation',
      'concept_recommendation_korean',
      'concept_pairing_korean',
      'adversarial_no_match',
    ]) {
      expect(classes.has(requiredClass)).toBe(true);
    }
  });

  it('retains strong Korean-local pressure instead of drifting back to Latin-only labels', () => {
    const rows = loadCorpus();
    const hangulRows = rows.filter((row) => /[가-힣]/u.test(row.query));
    const iconicResolved = rows.filter((row) => row.expected_status === 'resolved' && row.class.startsWith('korean_icon_'));
    const ambiguityRows = rows.filter((row) => row.class.startsWith('ambiguity_'));
    const conceptRows = rows.filter((row) => row.class.startsWith('concept_'));

    expect(hangulRows.length).toBeGreaterThanOrEqual(58);
    expect(iconicResolved.length).toBeGreaterThanOrEqual(48);
    expect(ambiguityRows.length).toBeGreaterThanOrEqual(10);
    expect(conceptRows.length).toBeGreaterThanOrEqual(8);
  });
});
