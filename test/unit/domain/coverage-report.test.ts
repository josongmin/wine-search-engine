import { describe, expect, it } from 'vitest';
import { buildCoverageReport } from '../../../src/domain/resolver/v2/coverage-report.js';

describe('coverage-report strict operator buckets', () => {
  it('splits unresolved hot rows by strict collision, family/qualified surface gaps, scope support, and scope target gap', () => {
    const report = buildCoverageReport([
      {
        qid: 'q1',
        query: '실버오크',
        expectedStatus: 'resolved',
        expectedEntityHint: 'silver oak',
        class: 'realworld_spaced_alias',
        observedStatus: 'ambiguous',
        observedReasonCode: 'reviewed_family_collision_requires_clarification',
      },
      {
        qid: 'q2',
        query: '뵈브 끌리꼬',
        expectedStatus: 'resolved',
        expectedEntityHint: 'veuve clicquot',
        class: 'realworld_korean_orthography',
        observedStatus: 'failed',
        supportStatus: 'active_entity_absent',
      },
      {
        qid: 'q3',
        query: '마세토',
        expectedStatus: 'resolved',
        expectedEntityHint: 'masseto',
        class: 'realworld_korean_orthography',
        observedStatus: 'failed',
        surfaceGapBucket: 'family_surface_gap',
      },
      {
        qid: 'q4',
        query: '솔라이아 2019',
        expectedStatus: 'resolved',
        expectedEntityHint: 'solaia',
        class: 'realworld_vintage_suffix',
        observedStatus: 'failed',
        surfaceGapBucket: 'qualified_scope_surface_gap',
      },
      {
        qid: 'q5',
        query: '오푸스 원 2019',
        expectedStatus: 'resolved',
        expectedEntityHint: 'opus one',
        class: 'realworld_vintage_suffix',
        observedStatus: 'failed',
      },
    ]);

    expect(report.holesByOperatorBucket).toEqual({
      strict_collision_ambiguous: 1,
      family_surface_gap: 1,
      qualified_scope_surface_gap: 1,
      scope_target_missing: 1,
      scope_support_needed: 1,
    });
    expect(report.holes.map((hole) => [hole.qid, hole.operatorBucket])).toEqual([
      ['q1', 'strict_collision_ambiguous'],
      ['q2', 'scope_support_needed'],
      ['q3', 'family_surface_gap'],
      ['q4', 'qualified_scope_surface_gap'],
      ['q5', 'scope_target_missing'],
    ]);
  });
});
