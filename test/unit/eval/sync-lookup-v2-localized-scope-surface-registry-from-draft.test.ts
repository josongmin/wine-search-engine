import { describe, expect, it } from 'vitest';
import { syncLookupV2LocalizedScopeSurfaceRegistryFromDraft } from '../../../scripts/eval/sync-lookup-v2-localized-scope-surface-registry-from-draft.js';

describe('syncLookupV2LocalizedScopeSurfaceRegistryFromDraft', () => {
  it('publishes localized component surfaces for approved family scopes already owned by semantic scope authority', () => {
    const result = syncLookupV2LocalizedScopeSurfaceRegistryFromDraft({
      draftRows: [
        {
          surface: '샤또 몬텔레나',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'montelena',
          semanticScopeKey: 'family::montelena::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'montelena',
          surfaceFormKind: 'bare',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'evidence',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          benchmarkGoldEntityId: 'wine-ce-montelena-1987',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
        },
      ],
      existingRows: [],
      approvedScopeMap: new Map([
        ['family::montelena::::::::::bare::ko', {
          semanticScopeKey: 'family::montelena::::::::::bare::ko',
          benchmarkGoldHint: 'montelena',
          normalizedBenchmarkGoldHint: 'montelena',
          scopeAxis: 'family',
          familyKey: 'montelena',
          surfaceFormKind: 'bare',
          locale: 'ko',
          entityId: 'wine-ce-montelena-1987',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T20:30:00.000Z',
          decisionReason: 'approved family target',
          evidenceClass: 'manual_target_family_review',
        }],
      ]),
    });

    expect(result.insertedRows).toBe(1);
    expect(result.skippedExistingRows).toBe(0);
    expect(result.mergedRows).toEqual([
      {
        componentKind: 'family',
        componentKey: 'montelena',
        localSurface: '샤또 몬텔레나',
        normalizedLocalSurface: '샤또 몬텔레나',
        locale: 'ko',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T20:30:00.000Z',
        decisionReason:
          'auto-synced localized component surface from approved semantic scope target semanticScopeKey=family::montelena::::::::::bare::ko',
        evidenceClass: 'localized_scope_surface_review',
      },
    ]);
  });

  it('skips rows whose semantic scope key is not approved', () => {
    const result = syncLookupV2LocalizedScopeSurfaceRegistryFromDraft({
      draftRows: [
        {
          surface: '폴 로저 18',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_vintage_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'pol roger',
          semanticScopeKey: 'line::pol roger::::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'pol roger',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'evidence',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      existingRows: [],
      approvedScopeMap: new Map(),
    });

    expect(result.insertedRows).toBe(0);
    expect(result.approvedScopeRows).toBe(0);
    expect(result.mergedRows).toEqual([]);
  });

  it('deduplicates already-published component surfaces', () => {
    const existingRow = {
      componentKind: 'family' as const,
      componentKey: 'montelena',
      localSurface: '샤또 몬텔레나',
      normalizedLocalSurface: '샤또 몬텔레나',
      locale: 'ko' as const,
      decisionStatus: 'approved' as const,
      reviewedBy: 'codex',
      reviewedAt: '2026-06-06T20:30:00.000Z',
      decisionReason: 'existing',
      evidenceClass: 'localized_scope_surface_review' as const,
    };
    const result = syncLookupV2LocalizedScopeSurfaceRegistryFromDraft({
      draftRows: [
        {
          surface: '샤또 몬텔레나',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'montelena',
          semanticScopeKey: 'family::montelena::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'montelena',
          surfaceFormKind: 'bare',
          triageBucket: 'auto_targetable',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'evidence',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          benchmarkGoldEntityId: 'wine-ce-montelena-1987',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
        },
      ],
      existingRows: [existingRow],
      approvedScopeMap: new Map([
        ['family::montelena::::::::::bare::ko', {
          semanticScopeKey: 'family::montelena::::::::::bare::ko',
          benchmarkGoldHint: 'montelena',
          normalizedBenchmarkGoldHint: 'montelena',
          scopeAxis: 'family',
          familyKey: 'montelena',
          surfaceFormKind: 'bare',
          locale: 'ko',
          entityId: 'wine-ce-montelena-1987',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T20:30:00.000Z',
          decisionReason: 'approved family target',
          evidenceClass: 'manual_target_family_review',
        }],
      ]),
    });

    expect(result.insertedRows).toBe(0);
    expect(result.skippedExistingRows).toBe(1);
    expect(result.mergedRows).toEqual([existingRow]);
  });

  it('does not project qualified query text into component surface rows', () => {
    const result = syncLookupV2LocalizedScopeSurfaceRegistryFromDraft({
      draftRows: [
        {
          surface: '실버 오크 알렉산더 밸리 2018',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'silver oak',
          semanticScopeKey: 'line::silver oak::alexander valley::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'silver oak',
          lineKey: 'alexander valley',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'evidence',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      existingRows: [],
      approvedScopeMap: new Map([
        ['line::silver oak::alexander valley::::::2018::qualified::ko', {
          semanticScopeKey: 'line::silver oak::alexander valley::::::2018::qualified::ko',
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          scopeAxis: 'line',
          familyKey: 'silver oak',
          lineKey: 'alexander valley',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-silver-oak-av',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'approved scope target',
          evidenceClass: 'manual_target_family_review',
        }],
      ]),
    });

    expect(result.candidateDraftRows).toBe(0);
    expect(result.approvedScopeRows).toBe(0);
    expect(result.insertedRows).toBe(0);
    expect(result.mergedRows).toEqual([]);
  });
});
