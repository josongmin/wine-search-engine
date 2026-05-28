import { describe, expect, it } from 'vitest';
import { LocalEntityFacade } from '../local-entity-facade.js';
import type { ResolveRequest } from '../../../../application/search/resolve-request.dto.js';

interface CapturedCall {
  request: ResolveRequest;
  options: { requestId: string; abortSignal?: AbortSignal | undefined };
}

function makeFacade(
  channels: {
    resolveResult?: unknown;
    autocompleteResult?: unknown;
  },
  resolveCalls: CapturedCall[],
  autocompleteCalls: CapturedCall[],
): LocalEntityFacade {
  return new LocalEntityFacade({
    withContainer: async (work) =>
      await work({
        resolveUseCase: {
          execute: async (request: ResolveRequest, options: { requestId: string; abortSignal?: AbortSignal | undefined }) => {
            resolveCalls.push({ request, options });
            return channels.resolveResult;
          },
        },
        autocompleteUseCase: {
          execute: async (request: ResolveRequest, options: { requestId: string; abortSignal?: AbortSignal | undefined }) => {
            autocompleteCalls.push({ request, options });
            return channels.autocompleteResult;
          },
        },
      } as never),
  });
}

describe('LocalEntityFacade', () => {
  it('passes query + requestId through resolveUseCase.execute and returns the result', async () => {
    const resolveCalls: CapturedCall[] = [];
    const autocompleteCalls: CapturedCall[] = [];
    const expected = { status: 'resolved', candidates: [] };
    const facade = makeFacade({ resolveResult: expected }, resolveCalls, autocompleteCalls);

    const result = await facade.resolve(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    expect(result).toBe(expected);
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.request).toEqual({ query: 'opus one 2018', requestId: 'req-1' });
    expect(resolveCalls[0]?.options.requestId).toBe('req-1');
  });

  it('threads optional context/sessionContext/queryBudget into the ResolveRequest when present', async () => {
    const resolveCalls: CapturedCall[] = [];
    const autocompleteCalls: CapturedCall[] = [];
    const facade = makeFacade({ resolveResult: {} }, resolveCalls, autocompleteCalls);

    const context = { locale: 'ko-KR' } as never;
    const sessionContext = { sessionId: 's1' } as never;
    const queryBudget = { maxTokens: 1000 } as never;

    await facade.resolve(
      {
        query: 'q',
        context,
        sessionContext,
        queryBudget,
      },
      { requestId: 'req-2' },
    );

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.request).toEqual({
      query: 'q',
      requestId: 'req-2',
      context,
      sessionContext,
      queryBudget,
    });
  });

  it('omits optional keys when callers do not supply them (exactOptionalPropertyTypes)', async () => {
    const resolveCalls: CapturedCall[] = [];
    const autocompleteCalls: CapturedCall[] = [];
    const facade = makeFacade({ resolveResult: {} }, resolveCalls, autocompleteCalls);

    await facade.resolve({ query: 'q' }, { requestId: 'req-3' });

    expect(resolveCalls).toHaveLength(1);
    const request = resolveCalls[0]?.request;
    expect(request).toBeDefined();
    expect(Object.keys(request as object).sort()).toEqual(['query', 'requestId']);
  });

  it('passes query + requestId through autocompleteUseCase.execute and returns the result', async () => {
    const resolveCalls: CapturedCall[] = [];
    const autocompleteCalls: CapturedCall[] = [];
    const expected = { suggestions: [{ label: 'opus one' }] };
    const facade = makeFacade(
      { autocompleteResult: expected },
      resolveCalls,
      autocompleteCalls,
    );

    const result = await facade.autocomplete(
      { query: 'op' },
      { requestId: 'req-4' },
    );

    expect(result).toBe(expected);
    expect(autocompleteCalls).toHaveLength(1);
    expect(autocompleteCalls[0]?.request).toEqual({ query: 'op', requestId: 'req-4' });
  });

  it('forwards the abortSignal into the use-case options', async () => {
    const resolveCalls: CapturedCall[] = [];
    const autocompleteCalls: CapturedCall[] = [];
    const facade = makeFacade({ resolveResult: {} }, resolveCalls, autocompleteCalls);
    const controller = new AbortController();

    await facade.resolve(
      { query: 'q' },
      { requestId: 'req-5', abortSignal: controller.signal },
    );

    expect(resolveCalls[0]?.options.abortSignal).toBe(controller.signal);
  });
});
