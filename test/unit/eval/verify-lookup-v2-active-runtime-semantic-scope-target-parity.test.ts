import { describe, expect, it } from 'vitest';
import { LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION } from '../../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';
import {
  buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary,
} from '../../../scripts/eval/verify-lookup-v2-active-runtime-semantic-scope-target-parity.js';

describe('verifyLookupV2ActiveRuntimeSemanticScopeTargetParity', () => {
  it('fails when approved semantic scope target rows are missing from the active runtime artifact', () => {
    const summary = buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary({
      runtimeStatePath: '/tmp/runtime-search-snapshot.json',
      runtimeSnapshotId: 'search-snapshot:v1:test',
      runtimeSemanticScopeArtifactPath: '/tmp/lookup-semantic-scope-runtime.json',
      registryPath: '/tmp/lookup-semantic-scope-target-registry.jsonl',
      registryRows: [
        {
          semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
          benchmarkGoldHint: 'solaia',
          normalizedBenchmarkGoldHint: 'solaia',
          scopeAxis: 'line',
          familyKey: 'solaia',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-solaia-2018',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'approved line vintage target',
          evidenceClass: 'manual_target_family_review',
        },
      ],
      runtimeArtifact: {
        schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-08T00:00:00.000Z',
        entries: {},
      },
    });

    expect(summary.parity).toBe(false);
    expect(summary.missingApprovedScopeKeys).toEqual([
      'line::solaia::::::::2018::qualified::ko',
    ]);
    expect(summary.mismatchedRows).toEqual([]);
  });

  it('fails when the active runtime entry drifts from the approved registry row', () => {
    const summary = buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary({
      runtimeStatePath: '/tmp/runtime-search-snapshot.json',
      runtimeSnapshotId: 'search-snapshot:v1:test',
      runtimeSemanticScopeArtifactPath: '/tmp/lookup-semantic-scope-runtime.json',
      registryPath: '/tmp/lookup-semantic-scope-target-registry.jsonl',
      registryRows: [
        {
          semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
          benchmarkGoldHint: 'solaia',
          normalizedBenchmarkGoldHint: 'solaia',
          scopeAxis: 'line',
          familyKey: 'solaia',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-solaia-2018',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'approved line vintage target',
          evidenceClass: 'manual_target_family_review',
        },
      ],
      runtimeArtifact: {
        schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-08T00:00:00.000Z',
        entries: {
          'line::solaia::::::::2018::qualified::ko': {
            semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
            scopeAxis: 'line',
            familyKey: 'solaia',
            vintage: 2019,
            surfaceFormKind: 'qualified',
            locale: 'ko',
            entityId: 'wine-ce-solaia-2019',
          },
        },
      },
    });

    expect(summary.parity).toBe(false);
    expect(summary.missingApprovedScopeKeys).toEqual([]);
    expect(summary.mismatchedRows).toEqual([
      {
        semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
        field: 'entityId',
        registryValue: 'wine-ce-solaia-2018',
        runtimeValue: 'wine-ce-solaia-2019',
      },
      {
        semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
        field: 'vintage',
        registryValue: 2018,
        runtimeValue: 2019,
      },
    ]);
  });

  it('passes when every approved semantic scope target row is present in the active runtime artifact', () => {
    const summary = buildLookupV2ActiveRuntimeSemanticScopeTargetParitySummary({
      runtimeStatePath: '/tmp/runtime-search-snapshot.json',
      runtimeSnapshotId: 'search-snapshot:v1:test',
      runtimeSemanticScopeArtifactPath: '/tmp/lookup-semantic-scope-runtime.json',
      registryPath: '/tmp/lookup-semantic-scope-target-registry.jsonl',
      registryRows: [
        {
          semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
          benchmarkGoldHint: 'solaia',
          normalizedBenchmarkGoldHint: 'solaia',
          scopeAxis: 'line',
          familyKey: 'solaia',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-solaia-2018',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'approved line vintage target',
          evidenceClass: 'manual_target_family_review',
        },
      ],
      runtimeArtifact: {
        schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-08T00:00:00.000Z',
        entries: {
          'line::solaia::::::::2018::qualified::ko': {
            semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
            scopeAxis: 'line',
            familyKey: 'solaia',
            vintage: 2018,
            surfaceFormKind: 'qualified',
            locale: 'ko',
            entityId: 'wine-ce-solaia-2018',
          },
        },
      },
    });

    expect(summary.parity).toBe(true);
    expect(summary.missingApprovedScopeKeys).toEqual([]);
    expect(summary.mismatchedRows).toEqual([]);
    expect(summary.approvedRegistryRows).toBe(1);
    expect(summary.runtimeEntries).toBe(1);
  });
});
