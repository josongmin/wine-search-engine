import { describe, expect, it } from 'vitest';
import {
  buildCoverageReport,
  formatCoverageReport,
  type CoverageInputRow,
} from '../../../src/domain/resolver/v2/coverage-report.js';

const rows: CoverageInputRow[] = [
  { qid: '1', query: 'Opus One 2018', expectedStatus: 'resolved', class: 'exact_entity', observedStatus: 'resolved' },
  // Dom Perignon coverage hole — gold says resolve, engine failed → curation candidate (DoD #2)
  { qid: '2', query: 'Dom Perignon', expectedStatus: 'resolved', class: 'hot_entity_coverage', observedStatus: 'failed' },
  { qid: '3', query: '돔페리뇽', expectedStatus: 'resolved', class: 'hot_entity_coverage', observedStatus: 'failed' },
  // concept handled correctly
  { qid: '4', query: '까쇼', expectedStatus: 'redirect_discovery', class: 'concept_grape', observedStatus: 'redirect_discovery' },
  // noisy typo correctly closed
  { qid: '5', query: 'opu one', expectedStatus: 'failed', class: 'noisy_typo', observedStatus: 'failed' },
];

describe('buildCoverageReport (T-ELV2-03 hot-entity coverage)', () => {
  it('surfaces hot-entity coverage holes for the curation flow', () => {
    const report = buildCoverageReport(rows);
    expect(report.hotEntityCount).toBe(3);
    expect(report.coveredCount).toBe(1);
    expect(report.holes).toHaveLength(2);
    expect(report.holes.map((h) => h.query)).toEqual(['Dom Perignon', '돔페리뇽']);
    expect(report.coverageRate).toBeCloseTo(1 / 3);
    expect(report.holesByClass.hot_entity_coverage).toBe(2);
  });

  it('counts non-entity (concept / typo) handling separately from coverage', () => {
    const report = buildCoverageReport(rows);
    expect(report.nonEntityTotal).toBe(2);
    expect(report.nonEntityCorrect).toBe(2);
  });

  it('reports zero holes when every hot entity resolves', () => {
    const report = buildCoverageReport([
      { qid: 'a', query: 'X', expectedStatus: 'resolved', class: 'e', observedStatus: 'resolved' },
    ]);
    expect(report.holes).toHaveLength(0);
    expect(report.coverageRate).toBe(1);
  });

  it('renders an operator summary listing the holes', () => {
    const text = formatCoverageReport(buildCoverageReport(rows));
    expect(text).toMatch(/Dom Perignon/);
    expect(text).toMatch(/need curation/);
  });
});
