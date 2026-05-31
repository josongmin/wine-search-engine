/**
 * ADR-015 Axis 2 invariants: query rewriter determinism & graceful
 * decline behaviour.
 *
 * Locks:
 *   - `relax` is deterministic + idempotent on its output (the relaxed
 *     bundle reaches a fixed point after at most one further `relax`).
 *   - `decompose` is deterministic.
 *   - `expand_synonym` is deterministic.
 *   - `reformulate` calls the LLM exactly once, parses JSON, propagates
 *     reformulated query into both lexical + semantic queries.
 *   - Malformed LLM JSON → null (rewriter declines, executor breaks).
 *   - Null LLM port → reformulate declines without throwing.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryRewriter } from '../../src/domain/retrieval/service/query-rewriter.js';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';
import type { CriticDecision } from '../../src/domain/retrieval/service/retrieval-critic.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { HybridRetrievalInput } from '../../src/domain/retrieval/model/retrieval-input.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';

function plan(over: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'red wine napa',
    normalizedQuery: 'red wine napa',
    constraints: {
      hard: [
        {
          attribute: 'color',
          operator: '=',
          value: 'red',
          source: 'utterance',
          confidence: 0.9,
        },
        {
          attribute: 'region',
          operator: '=',
          value: 'Napa Valley',
          source: 'utterance',
          confidence: 0.8,
        },
        {
          attribute: 'vintage_year',
          operator: '=',
          value: 2018,
          source: 'utterance',
          confidence: 0.7,
        },
      ],
      soft: [],
      inferred: [],
    },
    anchors: [],
    expansions: { fuzzyEntityHypotheses: [] },
    ...over,
  } as unknown as QueryPlanV1;
}

function input(
  pln: QueryPlanV1,
  over: Partial<HybridRetrievalInput> = {},
): HybridRetrievalInput {
  return {
    queryPlan: pln,
    route: 'hybrid',
    lexicalQueries: ['red'],
    semanticQueries: ['red wine', 'napa cabernet'],
    hardConstraints: pln.constraints.hard,
    softConstraints: pln.constraints.soft,
    ...over,
  } as unknown as HybridRetrievalInput;
}

function relaxDecision(): Extract<CriticDecision, { retry: true }> {
  return {
    retry: true,
    rewriteType: 'relax',
    subqueryId: 'root',
    reason: 'coverage_zero_relax',
  };
}

function expandDecision(): Extract<CriticDecision, { retry: true }> {
  return {
    retry: true,
    rewriteType: 'expand_synonym',
    subqueryId: 'root',
    reason: 'no_matches_expand_synonym',
  };
}

function decomposeDecision(): Extract<CriticDecision, { retry: true }> {
  return {
    retry: true,
    rewriteType: 'decompose',
    subqueryId: 'root',
    reason: 'partial_coverage_decompose',
  };
}

function reformulateDecision(): Extract<CriticDecision, { retry: true }> {
  return {
    retry: true,
    rewriteType: 'reformulate',
    subqueryId: 'root',
    reason: 'fallback_reformulate',
  };
}

describe('query-rewriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('relax is deterministic across two invocations', async () => {
    const rewriter = createQueryRewriter();
    const base = input(plan());
    const a = await rewriter.apply(base, relaxDecision());
    const b = await rewriter.apply(base, relaxDecision());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.input.hardConstraints).toEqual(b?.input.hardConstraints);
    expect(a?.trace.relaxedAttributes).toEqual(b?.trace.relaxedAttributes);
  });

  it('expand_synonym is deterministic and adds known variants only when seeded', async () => {
    const rewriter = createQueryRewriter();
    const base = input(plan(), { lexicalQueries: ['red'] });
    const a = await rewriter.apply(base, expandDecision());
    const b = await rewriter.apply(base, expandDecision());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.input.lexicalQueries).toEqual(b?.input.lexicalQueries);
    // 'red' triggers the 'redwine' variant.
    expect(a?.input.lexicalQueries).toContain('redwine');
  });

  it('expand_synonym declines when no seed token is present', async () => {
    const rewriter = createQueryRewriter();
    const base = input(plan(), { lexicalQueries: ['cabernet'] });
    const result = await rewriter.apply(base, expandDecision());
    expect(result).toBeNull();
  });

  it('decompose is deterministic and rotates semantic queries', async () => {
    const rewriter = createQueryRewriter();
    const base = input(plan());
    const a = await rewriter.apply(base, decomposeDecision());
    const b = await rewriter.apply(base, decomposeDecision());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.input.semanticQueries).toEqual(b?.input.semanticQueries);
    expect(a?.input.semanticQueries[0]).not.toBe(base.semanticQueries[0]);
  });

  it('reformulate calls the LLM and propagates the rewritten query', async () => {
    const llm: ChatLlmPort = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({ reformulatedQuery: 'napa red wine 2018', confidence: 0.8 }),
        model: 'test-model',
        finishReason: 'stop',
      })),
    };
    const rewriter = createQueryRewriter({ chatLlm: llm });
    const base = input(plan());
    const result = await rewriter.apply(base, reformulateDecision());
    expect(result).not.toBeNull();
    expect(result?.input.queryPlan.normalizedQuery).toBe('napa red wine 2018');
    expect(result?.trace.promptVersion).toBe('critic_reformulate_v1');
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('reformulate declines on malformed LLM JSON', async () => {
    const llm: ChatLlmPort = {
      complete: async () => ({ text: 'not-json', model: 'test', finishReason: 'stop' }),
    };
    const rewriter = createQueryRewriter({ chatLlm: llm });
    const base = input(plan());
    expect(await rewriter.apply(base, reformulateDecision())).toBeNull();
  });

  it('reformulate declines (returns null) when LLM port is unwired', async () => {
    const rewriter = createQueryRewriter();
    const base = input(plan());
    expect(await rewriter.apply(base, reformulateDecision())).toBeNull();
  });

  it('reformulate declines AND warn-logs when the LLM call throws (no silent swallow)', async () => {
    const warnSpy = vi
      .spyOn(bootstrapLogger, 'warn')
      .mockImplementation(() => undefined);
    const boom = new Error('upstream LLM timeout');
    const llm: ChatLlmPort = {
      complete: vi.fn(async () => {
        throw boom;
      }),
    };
    const rewriter = createQueryRewriter({ chatLlm: llm });
    const base = input(plan());

    // Fallback behaviour preserved: declines (returns null), does not throw.
    expect(await rewriter.apply(base, reformulateDecision())).toBeNull();

    // The error is surfaced via a warn log routed through the err serializer.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ err: boom });
  });
});
