import { describe, expect, it } from 'vitest';
import {
  buildCurationTasks,
  suggestAliasTypeForHole,
  type CoverageHoleInput,
} from '../../../src/domain/alias/curation/coverage-curation-task.js';

describe('suggestAliasTypeForHole (T-ELV2-03 curation)', () => {
  it.each([
    ['transliteration', 'translation'],
    ['hot_entity_coverage_korean', 'translation'],
    ['noisy_typo', 'misspelling'],
    ['phonetic_drift', 'misspelling'],
    ['abbreviation_gap', 'abbreviation'],
    ['hot_entity_coverage', 'canonical'],
  ] as const)('maps hole class %s → %s', (holeClass, expected) => {
    expect(suggestAliasTypeForHole(holeClass)).toBe(expected);
  });
});

describe('buildCurationTasks', () => {
  const holes: CoverageHoleInput[] = [
    { surfaceForm: 'Dom Perignon', holeClass: 'hot_entity_coverage', observedStatus: 'failed' },
    { surfaceForm: '돔페리뇽', holeClass: 'transliteration', observedStatus: 'failed' },
  ];

  it('creates one needs_target task per hole with a suggested alias type', () => {
    const tasks = buildCurationTasks(holes);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ surfaceForm: 'Dom Perignon', status: 'needs_target', suggestedAliasType: 'canonical' });
    expect(tasks[1]).toMatchObject({ surfaceForm: '돔페리뇽', suggestedAliasType: 'translation' });
    expect(tasks[0]?.reason).toContain('coverage hole');
  });

  it('de-duplicates by normalized surface form', () => {
    const tasks = buildCurationTasks([
      { surfaceForm: 'Dom Perignon', holeClass: 'a', observedStatus: 'failed' },
      { surfaceForm: 'dom perignon', holeClass: 'b', observedStatus: 'ambiguous' },
    ]);
    expect(tasks).toHaveLength(1);
  });

  it('skips empty surfaces', () => {
    expect(buildCurationTasks([{ surfaceForm: '   ', holeClass: 'x', observedStatus: 'failed' }])).toHaveLength(0);
  });
});
