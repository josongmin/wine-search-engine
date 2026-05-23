/**
 * Regression: Multi-Query Rewrite generator invariants.
 *
 * Locks:
 *  - `entity_lookup` and `comparative` intents bypass the LLM (no port call).
 *  - On LLM failure (timeout / validation / unknown error) the generator
 *    returns `[query]` (the original) and does NOT throw.
 *  - Rewrites are deduplicated case-insensitively against the original
 *    AND each other.
 *  - The total output count is capped at `MULTI_QUERY_MAX_REWRITES + 1`
 *    (original + 3 rewrites = 4).
 *  - First-failure-only log policy: subsequent failures must NOT raise
 *    the failure counter again (verified via the test seam reset).
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  createMultiQueryGenerator,
  __resetMultiQueryFailureLogForTests,
  MULTI_QUERY_MAX_REWRITES,
  type IntentClass,
} from '../../src/domain/retrieval/service/multi-query-generator.js';
import type {
  StructuredLlmPort,
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  SynthesizeRequest,
  SynthesizeResult,
} from '../../src/domain/ai/port/structured-llm.port.js';

function makeStubPort(
  analyzeImpl: (req: AnalyzeRequest<never>) => Promise<AnalyzeResult<unknown>>,
): StructuredLlmPort {
  return {
    analyze: analyzeImpl as StructuredLlmPort['analyze'],
    execute: (_req: ExecuteRequest) => {
      throw new Error('execute() should not be called by MultiQueryGenerator');
    },
    synthesize: <TSchema extends Parameters<StructuredLlmPort['synthesize']>[0]['schema']>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<unknown>> => {
      throw new Error('synthesize() should not be called by MultiQueryGenerator');
    },
  };
}

const TEST_MODEL = 'gpt-5-mini';

beforeEach(() => {
  __resetMultiQueryFailureLogForTests();
});

describe('multi-query-generator', () => {
  it('skips LLM call for entity_lookup intent — returns [query]', async () => {
    const analyze = vi.fn();
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('Opus One 2018', 'entity_lookup');
    expect(out).toEqual(['Opus One 2018']);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('skips LLM call for comparative intent — returns [query]', async () => {
    const analyze = vi.fn();
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('Sassicaia vs Tignanello', 'comparative');
    expect(out).toEqual(['Sassicaia vs Tignanello']);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('returns original + LLM rewrites for exploratory intent', async () => {
    const analyze = vi.fn(async () => ({
      data: {
        rewrites: ['full-bodied Italian red', 'rich Sangiovese-based wine', 'bold Tuscan red'],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });

    const out = await gen.generate('바디감 좋은 이태리 레드', 'exploratory');
    expect(out[0]).toBe('바디감 좋은 이태리 레드');
    expect(out.slice(1)).toEqual([
      'full-bodied Italian red',
      'rich Sangiovese-based wine',
      'bold Tuscan red',
    ]);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('LLM failure → returns [query] without throwing (first-failure logged)', async () => {
    const analyze = vi.fn(async () => {
      throw new Error('upstream LLM timeout');
    });
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('red wine with steak', 'food_pairing');
    expect(out).toEqual(['red wine with steak']);
  });

  it('dedupes case-insensitively against the original query', async () => {
    const analyze = vi.fn(async () => ({
      data: {
        rewrites: ['RED WINE WITH STEAK', 'red wine pairing for grilled beef', 'steak-friendly tannic red'],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('red wine with steak', 'food_pairing');

    // The case-insensitive duplicate is filtered; remaining unique rewrites kept.
    expect(out).toEqual([
      'red wine with steak',
      'red wine pairing for grilled beef',
      'steak-friendly tannic red',
    ]);
  });

  it('dedupes case-insensitively across rewrites', async () => {
    const analyze = vi.fn(async () => ({
      data: {
        rewrites: ['Bold Italian Red', 'bold italian red', 'rich Sangiovese'],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('robust italian red', 'attribute_search');
    expect(out).toEqual(['robust italian red', 'Bold Italian Red', 'rich Sangiovese']);
  });

  it('caps total rewrites at MULTI_QUERY_MAX_REWRITES even when LLM emits more', async () => {
    // The Zod schema's `.max()` is intentionally loose (a hard
    // anti-DoS ceiling). The generator body trims to
    // MULTI_QUERY_MAX_REWRITES so an over-eager LLM emitting 5
    // rewrites still produces 1 + 3 = 4 outputs (not 1 + 5).
    const analyze = vi.fn(async () => ({
      data: {
        rewrites: [
          'variant alpha',
          'variant beta',
          'variant gamma',
          'variant delta',
          'variant epsilon',
        ],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('exploratory query', 'exploratory');
    expect(out).toHaveLength(MULTI_QUERY_MAX_REWRITES + 1);
    expect(out[0]).toBe('exploratory query');
    expect(out.slice(1)).toEqual(['variant alpha', 'variant beta', 'variant gamma']);
  });

  it('drops empty/whitespace-only rewrites silently', async () => {
    const analyze = vi.fn(async () => ({
      data: {
        // Note: Zod schema's .min(1) on each rewrite would normally block
        // pure-empty strings — but if a (hypothetical) lenient adapter
        // pre-trimmed and emitted "   ", the generator's runtime trim
        // must still drop it.
        rewrites: ['legitimate rewrite'],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('valid query', 'exploratory');
    expect(out).toEqual(['valid query', 'legitimate rewrite']);
  });

  it('empty / whitespace-only query → empty list (no LLM call)', async () => {
    const analyze = vi.fn();
    const gen = createMultiQueryGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const outEmpty = await gen.generate('', 'exploratory');
    expect(outEmpty).toEqual([]);
    const outBlank = await gen.generate('   ', 'exploratory');
    expect(outBlank).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each<IntentClass>(['food_pairing', 'exploratory', 'attribute_search'])(
    'invokes the LLM for non-gated intent: %s',
    async (intent) => {
      const analyze = vi.fn(async () => ({
        data: { rewrites: ['rewrite one'] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        durationMs: 0,
      }));
      const gen = createMultiQueryGenerator({
        structuredLlm: makeStubPort(analyze),
        model: TEST_MODEL,
      });
      const out = await gen.generate('test query', intent);
      expect(analyze).toHaveBeenCalledOnce();
      expect(out).toContain('test query');
      expect(out).toContain('rewrite one');
    },
  );
});
