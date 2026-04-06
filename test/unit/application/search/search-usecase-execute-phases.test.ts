import { describe, it, expect, vi } from 'vitest';
import { formatConstraintConflictDescription } from '../../../../src/application/search/search-usecase-constraint-conflict.js';
import { mergeCachedSearchResponseMeta } from '../../../../src/application/search/search-usecase-cache-hit.js';
import { dispatchSearchRouteExecution } from '../../../../src/application/search/search-usecase-route-dispatch.js';
import type { EntityResolveResult } from '../../../../src/domain/resolver/model/resolve-result.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

describe('formatConstraintConflictDescription', () => {
  it('joins pairwise conflicts with semicolons', () => {
    const desc = formatConstraintConflictDescription([
      [
        { attribute: 'color', operator: 'eq', value: 'red' },
        { attribute: 'color', operator: 'eq', value: 'white' },
      ],
    ]);
    expect(desc).toContain('color');
    expect(desc).toContain('"red"');
    expect(desc).toContain('"white"');
  });
});

describe('mergeCachedSearchResponseMeta', () => {
  it('updates requestId and queryTimeMs', () => {
    const base = {
      queryType: 'search' as const,
      engineDecision: {} as import('../../../../src/domain/decision/model/decision-output.js').EngineDecisionOutput,
      results: [],
      meta: {
        requestId: 'old',
        queryTimeMs: 1,
      },
    };
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const merged = mergeCachedSearchResponseMeta(base, 'new-req', 9000);
    expect(merged.meta.requestId).toBe('new-req');
    expect(merged.meta.queryTimeMs).toBe(1000);
    vi.restoreAllMocks();
  });
});

describe('dispatchSearchRouteExecution', () => {
  const minimalResolve = (): EntityResolveResult => ({
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'unknown',
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 0,
  });

  it('entity route returns empty ranked results', async () => {
    const entity = vi.fn(async () => minimalResolve());
    const out = await dispatchSearchRouteExecution('entity', {
      executeEntity: entity,
      executeHybrid: async () => {
        throw new Error('no hybrid');
      },
      executeMixed: async () => {
        throw new Error('no mixed');
      },
    });
    expect(entity).toHaveBeenCalledOnce();
    expect(out.rankedResults).toEqual([]);
  });

  it('delegates hybrid and mixed', async () => {
    const eid = createEntityId();
    const hybridOut = {
      resolveResult: minimalResolve(),
      rankedResults: [{ entityId: eid } as import('../../../../src/domain/ranking/model/ranked-result.js').RankedResult],
    };
    const hybrid = vi.fn(async () => hybridOut);
    const mixed = vi.fn(async () => hybridOut);
    const ent = vi.fn(async () => minimalResolve());

    await expect(
      dispatchSearchRouteExecution('hybrid', {
        executeEntity: ent,
        executeHybrid: hybrid,
        executeMixed: mixed,
      }),
    ).resolves.toBe(hybridOut);
    expect(hybrid).toHaveBeenCalledOnce();

    await expect(
      dispatchSearchRouteExecution('mixed', {
        executeEntity: ent,
        executeHybrid: hybrid,
        executeMixed: mixed,
      }),
    ).resolves.toBe(hybridOut);
    expect(mixed).toHaveBeenCalledOnce();
  });
});
