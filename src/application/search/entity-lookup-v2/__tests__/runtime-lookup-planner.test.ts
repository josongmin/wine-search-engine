import { describe, expect, it } from 'vitest';
import type { AliasMatchResult, AliasMatcher } from '../../../../domain/query/service/anchor-extractor.js';
import { RuntimeLookupPlanner } from '../runtime-lookup-planner.js';
import { createEntityId } from '../../../../domain/shared/types/index.js';

class ExactAliasMatcher implements AliasMatcher {
  constructor(private readonly responses: Map<string, readonly AliasMatchResult[]>) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return this.responses.get(normalizedQuery) ?? [];
  }
}

function makeMatch(
  surfaceForm: string,
  entityIds: readonly string[],
  lookupStrategy: string,
  confidence: number = 1,
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: entityIds.map((id) => createEntityId(id)),
    matchConfidence: confidence,
    lookupStrategy,
  };
}

describe('RuntimeLookupPlanner', () => {
  it('drops atomic fragment anchors for multi-token lookup no-match surfaces', async () => {
    const planner = new RuntimeLookupPlanner({
      aliasMatcher: new ExactAliasMatcher(new Map([
        ['chateau', [makeMatch('Chateau Margaux', ['wine-chateau-margaux'], 'lexical_exact')]],
        ['fantaisie', [makeMatch('Fantaisie', ['wine-fantaisie'], 'lexical_exact')]],
      ])),
    });

    const plan = await planner.plan('Chateau Fantaisie 2025');

    expect(plan.anchors).toHaveLength(0);
    expect(plan.queryClass).toBe('unknown');
  });

  it('keeps whole-surface anchors and prunes fragment-only collisions when both are present', async () => {
    const planner = new RuntimeLookupPlanner({
      aliasMatcher: new ExactAliasMatcher(new Map([
        ['오푸스투', [makeMatch('Opus One 2018', ['opus-one-2018'], 'phonetic_exact', 0.88)]],
        ['opus', [makeMatch('1987 Opus One Opus One', ['wine-opus-one'], 'lexical_exact')]],
      ])),
    });

    const plan = await planner.plan('오푸스투');

    expect(plan.queryClass).toBe('short_entity');
    expect(plan.anchors).toHaveLength(1);
    expect(plan.anchors[0]?.surfaceForm).toBe('Opus One 2018');
    expect(plan.anchors[0]?.lookupVariants).toEqual(
      expect.arrayContaining(['오푸스투']),
    );
  });

  it('drops multi-token subspan anchors without a whole-surface witness', async () => {
    const planner = new RuntimeLookupPlanner({
      aliasMatcher: new ExactAliasMatcher(new Map([
        ['라 투르', [
          makeMatch(
            '1996 Château Latour Grand Vin Pauillac (Premier Grand Cru Classé)',
            ['wine-chateau-latour'],
            'lexical_exact',
          ),
        ]],
      ])),
    });

    const plan = await planner.plan('샤또 라 투르 도르 2019');

    expect(plan.anchors).toHaveLength(0);
    expect(plan.queryClass).toBe('unknown');
  });
});
