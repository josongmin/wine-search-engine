import { describe, expect, it } from 'vitest';
import {
  assertLookupV2FamilyCollisionRegistryRowsValid,
  buildLookupV2FamilyCollisionRegistryMap,
} from '../../../scripts/eval/lookup-v2-family-collision-registry.js';

describe('lookup-v2-family-collision-registry', () => {
  it('accepts reviewed active-entity-collision rows with deterministic normalized hints', () => {
    const rows = [{
      benchmarkGoldHint: 'Silver Oak',
      normalizedBenchmarkGoldHint: 'silver oak',
      collisionStatus: 'active_entity_collision',
      reviewedBy: 'codex',
      reviewedAt: '2026-06-07T01:20:00.000Z',
      decisionReason: 'generic family intent collides across Napa and Alexander Valley owners',
      evidenceClass: 'collision_support_review',
    }] as const;

    expect(() => assertLookupV2FamilyCollisionRegistryRowsValid({ rows })).not.toThrow();
    expect(buildLookupV2FamilyCollisionRegistryMap(rows).get('silver oak')).toEqual(rows[0]);
  });

  it('fails closed on duplicate normalized hints', () => {
    expect(() =>
      assertLookupV2FamilyCollisionRegistryRowsValid({
        rows: [
          {
            benchmarkGoldHint: 'Rayas',
            normalizedBenchmarkGoldHint: 'rayas',
            collisionStatus: 'active_entity_collision',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T01:20:00.000Z',
            decisionReason: 'first row',
            evidenceClass: 'collision_support_review',
          },
          {
            benchmarkGoldHint: 'rayas',
            normalizedBenchmarkGoldHint: 'rayas',
            collisionStatus: 'active_entity_collision',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T01:20:00.000Z',
            decisionReason: 'duplicate row',
            evidenceClass: 'collision_support_review',
          },
        ],
      }),
    ).toThrow(/duplicate normalizedBenchmarkGoldHint/i);
  });
});
