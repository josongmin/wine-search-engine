/**
 * SearchUseCaseAdapter — port-to-use-case structural translation tests.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  SearchExecutionOptions,
  SearchExecutorResult,
} from '../../../search/port/search-executor.port.js';
import type { SearchRequest } from '../../../search/search-request.dto.js';
import type { SearchResponseV1 } from '../../../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../../domain/response/model/comparison-response.js';
import type { SearchUseCase } from '../../../search/search.usecase.js';
import {
  SearchUseCaseAdapter,
  UnexpectedSearchAdapterResponseError,
  mapSearchUseCaseInputToSearchRequest,
} from '../search-use-case-adapter.js';
import type { SearchUseCaseInput } from '../../execution-plan-schemas.js';

const REQUEST_ID = 'req-search-adapter-01';

function makeSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: [],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    meta: {} as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse;
}

interface StubSearchUseCase {
  readonly execute: (
    req: SearchRequest,
    requestId: string,
    opts?: SearchExecutionOptions,
  ) => Promise<SearchExecutorResult>;
}

function makeUseCase(
  impl?: (
    req: SearchRequest,
    requestId: string,
    opts?: SearchExecutionOptions,
  ) => Promise<SearchExecutorResult>,
): StubSearchUseCase & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeSearchResponse())));
  return { execute: executeMock, executeMock };
}

function asUseCase(stub: StubSearchUseCase): SearchUseCase {
  return stub as unknown as SearchUseCase;
}

describe('mapSearchUseCaseInputToSearchRequest', () => {
  it('maps minimal input (query only)', () => {
    const input: SearchUseCaseInput = { query: '와인' };
    expect(mapSearchUseCaseInputToSearchRequest(input)).toEqual({
      query: '와인',
      callerInterpretation: {
        authority: 'caller',
        intent: 'semantic_discovery',
        queryClass: 'semantic_preference',
      },
    });
  });

  it('forwards filters / preferences when non-empty', () => {
    const constraint = {
      attribute: 'country',
      operator: '=' as const,
      value: 'France',
      source_phrase: 'France',
      confidence: 1.0,
      mapping_version: 'test',
    };
    const input: SearchUseCaseInput = {
      query: 'Bordeaux',
      filters: [constraint],
      preferences: [constraint],
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.filters).toEqual([constraint]);
    expect(req.preferences).toEqual([constraint]);
  });

  it('does NOT emit empty filter / preference arrays', () => {
    const input: SearchUseCaseInput = {
      query: 'q',
      filters: [],
      preferences: [],
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.filters).toBeUndefined();
    expect(req.preferences).toBeUndefined();
  });

  it('threads mode into both options and retrieval_mode', () => {
    const input: SearchUseCaseInput = { query: 'q', mode: 'hybrid' };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.options).toEqual({ mode: 'hybrid', explain: false, clarification: false });
    expect(req.retrieval_mode).toBe('hybrid');
  });

  it('omits options when mode is absent', () => {
    const input: SearchUseCaseInput = { query: 'q' };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.options).toBeUndefined();
    expect(req.retrieval_mode).toBeUndefined();
    expect(req.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'semantic_discovery',
      queryClass: 'semantic_preference',
    });
  });

  it('maps anchorEntityId to a path-authoritative similar_to_entity request (RFC-021 T-PSA-02)', () => {
    const input: SearchUseCaseInput = {
      query: 'opus-one-2018',
      anchorEntityId: 'opus-one-2018',
      limit: 12,
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.primitiveRoute).toBe('similar_to_entity');
    expect(req.anchorEntityId).toBe('opus-one-2018');
    expect(req.limit).toBe(12);
    // Reference similarity is path-authoritative — NOT a callerInterpretation
    // and NOT a lane mode.
    expect(req.callerInterpretation).toBeUndefined();
    expect(req.options).toBeUndefined();
    expect(req.retrieval_mode).toBeUndefined();
  });

  it('threads structured residual filters/preferences through the similar_to_entity mapping', () => {
    const pref = {
      attribute: 'price_usd',
      operator: '<=' as const,
      value: 40,
      source_phrase: '50000원 이하',
      confidence: 1.0,
      mapping_version: 'reference_similarity_tool_v1',
    };
    const input: SearchUseCaseInput = {
      query: 'opus-one-2018',
      anchorEntityId: 'opus-one-2018',
      preferences: [pref],
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.primitiveRoute).toBe('similar_to_entity');
    expect(req.preferences).toEqual([pref]);
  });

  it('forwards limit and representativeConcept', () => {
    const input: SearchUseCaseInput = {
      query: 'q',
      limit: 10,
      representativeConcept: { field: 'country', value: 'France' },
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.limit).toBe(10);
    expect(req.representativeConcept).toEqual({ field: 'country', value: 'France' });
  });

  it('preserves explicit callerInterpretation instead of flattening to generic search intent', () => {
    const input: SearchUseCaseInput = {
      query: '스테이크에 어울리는 와인',
      callerInterpretation: {
        authority: 'caller',
        intent: 'pairing_search',
        queryClass: 'semantic_preference',
      },
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'pairing_search',
      queryClass: 'semantic_preference',
    });
  });

  it('forwards explicit callerInterpretation even on entity-mode requests', () => {
    const input: SearchUseCaseInput = {
      query: 'Opus One 2018',
      mode: 'entity',
      callerInterpretation: {
        authority: 'caller',
        intent: 'entity_exact',
        queryClass: 'exact_entity',
      },
    };
    const req = mapSearchUseCaseInputToSearchRequest(input);
    expect(req.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'entity_exact',
      queryClass: 'exact_entity',
    });
  });
});

describe('SearchUseCaseAdapter', () => {
  it('threads requestId and abortSignal into the use case', async () => {
    const stub = makeUseCase();
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    const ctrl = new AbortController();
    await adapter.execute({ query: '와인' }, REQUEST_ID, { abortSignal: ctrl.signal });

    expect(stub.executeMock).toHaveBeenCalledTimes(1);
    const call = stub.executeMock.mock.calls[0] ?? [];
    expect(call[0]).toEqual({
      query: '와인',
      callerInterpretation: {
        authority: 'caller',
        intent: 'semantic_discovery',
        queryClass: 'semantic_preference',
      },
    });
    expect(call[1]).toBe(REQUEST_ID);
    const opts = call[2] as SearchExecutionOptions | undefined;
    expect(opts?.requestId).toBe(REQUEST_ID);
    expect(opts?.abortSignal).toBe(ctrl.signal);
  });

  it('preserves non-generic callerInterpretation through execute()', async () => {
    const stub = makeUseCase();
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    await adapter.execute({
      query: '스테이크에 어울리는 와인',
      callerInterpretation: {
        authority: 'caller',
        intent: 'pairing_search',
        queryClass: 'semantic_preference',
      },
    }, REQUEST_ID);
    expect(stub.executeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      callerInterpretation: {
        authority: 'caller',
        intent: 'pairing_search',
        queryClass: 'semantic_preference',
      },
    }));
  });

  it('does not pass abortSignal when caller omits it', async () => {
    const stub = makeUseCase();
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    await adapter.execute({ query: 'q' }, REQUEST_ID);
    const opts = stub.executeMock.mock.calls[0]?.[2] as SearchExecutionOptions | undefined;
    expect(opts?.abortSignal).toBeUndefined();
    expect(opts?.requestId).toBe(REQUEST_ID);
  });

  it('returns the SearchResponseV1 unchanged', async () => {
    const response = makeSearchResponse();
    const stub = makeUseCase(() => Promise.resolve(response));
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    const out = await adapter.execute({ query: 'q' }, REQUEST_ID);
    expect(out).toBe(response);
  });

  it('throws UnexpectedSearchAdapterResponseError when use case returns a comparison response', async () => {
    const stub = makeUseCase(() => Promise.resolve(makeComparisonResponse()));
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    await expect(adapter.execute({ query: 'q' }, REQUEST_ID))
      .rejects.toBeInstanceOf(UnexpectedSearchAdapterResponseError);
  });

  it('propagates errors from the underlying use case', async () => {
    const boom = new Error('pipeline blew up');
    const stub = makeUseCase(() => Promise.reject(boom));
    const adapter = new SearchUseCaseAdapter(asUseCase(stub));
    await expect(adapter.execute({ query: 'q' }, REQUEST_ID)).rejects.toBe(boom);
  });
});
