import { describe, expect, it } from 'vitest';
import { assertLookupV2SemanticScopeTargetRegistryRowsValid } from '../../../scripts/eval/lookup-v2-semantic-scope-target-registry.js';

describe('assertLookupV2SemanticScopeTargetRegistryRowsValid', () => {
  it('allows reviewed-collision line-vintage authority rows to detach query vintage from the active flagship vintage', () => {
    expect(() => assertLookupV2SemanticScopeTargetRegistryRowsValid({
      rows: [
        {
          semanticScopeKey: 'line::palmer::::::::2020::qualified::ko',
          benchmarkGoldHint: 'palmer',
          normalizedBenchmarkGoldHint: 'palmer',
          scopeAxis: 'line',
          familyKey: 'palmer',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-palmer-grand-vin',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'iconic family-vintage query is anchored to the reviewed grand vin',
          evidenceClass: 'reviewed_collision_family_review',
        },
      ],
      runtimeDescriptorMap: new Map([
        ['wine-ce-palmer-grand-vin', { familyKey: 'palmer', vintage: 2009 }],
      ]),
    })).not.toThrow();
  });

  it('keeps manual-target rows fail-closed on vintage drift', () => {
    expect(() => assertLookupV2SemanticScopeTargetRegistryRowsValid({
      rows: [
        {
          semanticScopeKey: 'line::solaia::::::::2020::qualified::ko',
          benchmarkGoldHint: 'solaia',
          normalizedBenchmarkGoldHint: 'solaia',
          scopeAxis: 'line',
          familyKey: 'solaia',
          vintage: 2020,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-solaia-2018',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'should fail closed',
          evidenceClass: 'manual_target_family_review',
        },
      ],
      runtimeDescriptorMap: new Map([
        ['wine-ce-solaia-2018', { familyKey: 'solaia', vintage: 2018 }],
      ]),
    })).toThrow(/vintage mismatch/i);
  });
});
