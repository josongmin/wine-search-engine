import { describe, expect, it, vi } from 'vitest';
import { LocalLookupFacade } from '../local-lookup-facade.js';

describe('LocalLookupFacade (V2-only lookup authority)', () => {
  it('calls EntityLookupV2UseCase directly and snake-cases the V2-native result', async () => {
    const seen: unknown[] = [];
    const execute = vi.fn(async (cmd: unknown) => {
      seen.push(cmd);
      return {
        status: 'resolved',
        topCandidate: { entityId: 'opus-one-2018', canonicalLabel: 'Opus One 2018', calibratedScore: 0.97 },
        candidates: [],
        clarificationOptions: [],
      };
    });
    const facade = new LocalLookupFacade({
      withContainer: async (work) => await work({ entityLookupV2UseCase: { execute } } as never),
    });

    const result = await facade.lookupWine(
      { query: 'opus one 2018', limit: 3, context: { locale: 'ko', currency: 'KRW' } },
      { requestId: 'req-1' },
    );

    // command shape: V2-native (maxCandidates + mode), NOT a SearchRequest.
    expect(seen[0]).toEqual({
      query: 'opus one 2018',
      maxCandidates: 3,
      mode: 'default',
      requestId: 'req-1',
      locale: 'ko',
    });
    // result is snake_case wire shape.
    expect(result['status']).toBe('resolved');
    expect((result['top_candidate'] as Record<string, unknown>)['entity_id']).toBe('opus-one-2018');
  });

  it('defaults maxCandidates when no limit is supplied', async () => {
    const execute = vi.fn(async () => ({ status: 'failed', topCandidate: null, candidates: [], clarificationOptions: [] }));
    const facade = new LocalLookupFacade({
      withContainer: async (work) => await work({ entityLookupV2UseCase: { execute } } as never),
    });

    await facade.lookupWine({ query: 'unknown wine' }, { requestId: 'req-2' });

    const cmd = execute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof cmd['maxCandidates']).toBe('number');
    expect(cmd['mode']).toBe('default');
  });
});
