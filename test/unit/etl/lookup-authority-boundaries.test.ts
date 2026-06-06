import { describe, expect, it } from 'vitest';
import { assertLookupAuthorityBoundaryConsistency } from '../../../scripts/etl/lookup-authority-boundaries.js';

describe('lookup authority boundaries', () => {
  it('fails closed when keep-policy-conflict surface still exists in exact-safe registry', () => {
    expect(() => assertLookupAuthorityBoundaryConsistency({
      exactSafeRows: [
        {
          surface: '라뚜르',
          entityId: 'wine-ce-latour',
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      ambiguityRows: [
        {
          surface: '라뚜르',
          locale: 'ko',
          ambiguityTypes: ['short_form', 'entity'],
          severity: 'high',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      policyConflictRows: [
        {
          surface: '라뚜르',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-latour',
          conflictType: 'short_form_collision',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      policyFamilyDecisionRows: [
        {
          policyConflictSurface: '라뚜르',
          entityId: 'wine-ce-latour',
          decision: 'keep_policy_conflict',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'test',
        },
      ],
    })).toThrow(/keep_policy_conflict|missing/);
  });

  it('fails closed when keep-policy-conflict surface is missing from ambiguity registry', () => {
    expect(() => assertLookupAuthorityBoundaryConsistency({
      exactSafeRows: [],
      ambiguityRows: [],
      policyConflictRows: [
        {
          surface: '그랜지',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-grange',
          conflictType: 'short_form_collision',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      policyFamilyDecisionRows: [
        {
          policyConflictSurface: '그랜지',
          entityId: 'wine-ce-grange',
          decision: 'keep_policy_conflict',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'test',
        },
      ],
    })).toThrow(/requires ambiguity registry owner/);
  });

  it('accepts a promoted surface only when exact-safe exists and ambiguity does not', () => {
    expect(() => assertLookupAuthorityBoundaryConsistency({
      exactSafeRows: [
        {
          surface: '우니꼬',
          entityId: 'wine-ce-unico',
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      ambiguityRows: [],
      policyConflictRows: [
        {
          surface: '우니꼬',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-unico',
          conflictType: 'broad_icon_collision',
          sourceEvidence: 'test',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      policyFamilyDecisionRows: [
        {
          policyConflictSurface: '우니꼬',
          entityId: 'wine-ce-unico',
          decision: 'promote_exact_safe',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'test',
        },
      ],
    })).not.toThrow();
  });
});
