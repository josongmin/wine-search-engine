/**
 * Regression: HyDE (Hypothetical Document Embeddings) generator invariants.
 *
 * Locks:
 *  - Returns `null` for `entity_lookup` and `comparative` intents (skip).
 *  - Returns a non-empty doc string for `food_pairing`, `exploratory`,
 *    and `attribute_search` when the LLM responds successfully.
 *  - LLM failure → returns `null` (no throw).
 *  - Length cap: docs longer than the schema bound are rejected by the
 *    port's Zod validation (raises StructuredLlmValidationError); the
 *    generator catches and returns `null`.
 *  - Docs shorter than the min length are rejected as null (low signal).
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  createHydeGenerator,
  __resetHydeFailureLogForTests,
  type HydeGenerator,
} from '../../src/domain/retrieval/service/hyde-generator.js';
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
      throw new Error('execute() should not be called by HydeGenerator');
    },
    synthesize: <TSchema extends Parameters<StructuredLlmPort['synthesize']>[0]['schema']>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<unknown>> => {
      throw new Error('synthesize() should not be called by HydeGenerator');
    },
  };
}

const TEST_MODEL = 'gpt-5-mini';

const SAMPLE_HYDE_DOC =
  'A full-bodied Cabernet Sauvignon from a warm-climate vineyard, ' +
  'displaying ripe blackcurrant, cedar, and tobacco notes layered ' +
  'over firm tannins and balanced acidity. Aged 18 months in French ' +
  'oak; pairs naturally with grilled red meats and aged hard cheeses.';

beforeEach(() => {
  __resetHydeFailureLogForTests();
});

function buildSuccessfulHydePort(): StructuredLlmPort {
  return makeStubPort(async () => ({
    data: { document: SAMPLE_HYDE_DOC },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    durationMs: 0,
  }));
}

describe('hyde-generator', () => {
  it('returns null for entity_lookup intent (skip)', async () => {
    const analyze = vi.fn();
    const gen: HydeGenerator = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('Opus One 2018', 'entity_lookup');
    expect(out).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('returns null for comparative intent (skip)', async () => {
    const analyze = vi.fn();
    const gen: HydeGenerator = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('Sassicaia vs Tignanello', 'comparative');
    expect(out).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('returns a non-empty doc for food_pairing intent', async () => {
    const port = buildSuccessfulHydePort();
    const gen = createHydeGenerator({ structuredLlm: port, model: TEST_MODEL });
    const out = await gen.generate('스테이크에 어울리는 와인', 'food_pairing');
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
    expect(out).toBe(SAMPLE_HYDE_DOC);
  });

  it('returns a non-empty doc for exploratory / attribute searches', async () => {
    const port = buildSuccessfulHydePort();
    const gen = createHydeGenerator({ structuredLlm: port, model: TEST_MODEL });
    const exploratory = await gen.generate(
      '바디감 좋은 가성비 레드',
      'exploratory',
    );
    expect(exploratory).not.toBeNull();
    const attribute = await gen.generate(
      'Napa Cabernet under $50',
      'attribute_search',
    );
    expect(attribute).not.toBeNull();
  });

  it('LLM failure → null (no throw)', async () => {
    const analyze = vi.fn(async () => {
      throw new Error('upstream timeout');
    });
    const gen = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('스테이크에 어울리는 와인', 'food_pairing');
    expect(out).toBeNull();
  });

  it('empty query returns null without LLM call', async () => {
    const analyze = vi.fn();
    const gen = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    expect(await gen.generate('', 'food_pairing')).toBeNull();
    expect(await gen.generate('   ', 'food_pairing')).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('respects the length cap: very long docs trigger schema validation → returns null', async () => {
    // The Zod schema validates inside the port and would throw
    // StructuredLlmValidationError. We simulate that by throwing from
    // analyze() — the generator must swallow and return null.
    const analyze = vi.fn(async () => {
      const e = new Error('schema validation: document too long');
      e.name = 'StructuredLlmValidationError';
      throw e;
    });
    const gen = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('exploratory query', 'exploratory');
    expect(out).toBeNull();
  });

  it('too-short doc is treated as low-signal and returns null', async () => {
    // Simulates an adapter that emits a 20-char doc despite the schema's
    // min-length floor (e.g. a flaky LLM emitting just a phrase).
    const analyze = vi.fn(async () => ({
      data: { document: 'too short' },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      durationMs: 0,
    }));
    const gen = createHydeGenerator({
      structuredLlm: makeStubPort(analyze),
      model: TEST_MODEL,
    });
    const out = await gen.generate('exploratory query', 'exploratory');
    // In the real flow Zod's .min would reject this BEFORE reaching the
    // generator's runtime check — but defense in depth: the runtime
    // check also rejects, so this test guards both layers.
    expect(out).toBeNull();
  });
});
