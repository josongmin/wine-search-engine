import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatLlmPort } from '../../../domain/ai/port/chat-llm.port.js';
import type { EmbeddingServicePort } from '../../../domain/retrieval/port/embedding-service.port.js';
import type { Doc2QueryInput } from '../../../domain/retrieval/port/doc2query-generator.port.js';
import { OpenAiDoc2QueryGenerator } from '../openai-doc2query-generator.js';
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';

// A query set rich enough to clear the downstream sanity gates:
//   - MIN_ACCEPTABLE_QUERIES (8)
//   - hasAnchor (contains the producer token "trapiche")
//   - MIN_KOREAN_RATIO (0.35 of finals contain Hangul)
const SAMPLE_QUERIES: readonly string[] = [
  '2020 Trapiche Gran Medalla Malbec',
  'trapiche malbec',
  'Argentina Mendoza Malbec',
  '아르헨티나 멘도사 말벡',
  '묵직한 과일향 말벡',
  '5만원대 아르헨티나 레드',
  '바베큐 스테이크와 어울리는 말벡',
  '홈술 캐주얼 저녁 레드',
  '아르헨티나 와인 추천해줘',
  '과일향 있는 말벡 와인',
];

function makeChatLlm(): ChatLlmPort {
  return {
    complete: vi.fn().mockResolvedValue({ text: JSON.stringify(SAMPLE_QUERIES) }),
  };
}

function makeInput(): Doc2QueryInput {
  return {
    canonicalLabel: '2020 Trapiche Gran Medalla Malbec',
    producer: 'Trapiche',
    region: 'Argentina / Mendoza',
    country: 'Argentina',
    grapePrimary: 'Malbec',
    grapes: ['Malbec'],
    body: 0.8,
    tannin: 0.6,
    priceUsd: 40,
    priceBand: 'mid',
    vintageYear: 2020,
    alcoholPct: 14,
    flavorProfiles: ['dark fruit', 'oak'],
    pairingTags: ['steak'],
    drinkingWindowStart: null,
    drinkingWindowEnd: null,
    isTopRated: false,
    koreanAliases: ['트라피체 그란 메달라 말벡'],
    numQueries: 12,
  };
}

describe('OpenAiDoc2QueryGenerator round-trip embedding failure', () => {
  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  it('degrades to un-filtered queries AND records observability when embedBatch throws', async () => {
    const embeddingService: EmbeddingServicePort = {
      embedBatch: vi.fn().mockRejectedValue(new Error('embedding provider 503')),
    };
    const gen = new OpenAiDoc2QueryGenerator({
      chatLlm: makeChatLlm(),
      embeddingService,
    });

    const out = await gen.generate(makeInput());

    // Behavior preserved: the pipeline still produces a usable query set
    // (the round-trip ranker is skipped, but downstream gates pass).
    expect(out.length).toBeGreaterThanOrEqual(8);
    expect(out).toContain('trapiche malbec');

    // Failure is now observable rather than silent.
    const snap = globalSilentSkipCounter.snapshot();
    expect(snap.doc2query_round_trip_embedding_failure).toBe(1);
  });

  it('does NOT record a skip when the embedding service succeeds (ranking applied)', async () => {
    // Return a usable embedding for every input row so the ranker keeps the
    // candidates rather than dropping them as below the similarity floor.
    const embeddingService: EmbeddingServicePort = {
      embedBatch: vi
        .fn()
        .mockImplementation((texts: readonly string[]) =>
          Promise.resolve(texts.map(() => [1, 0, 0])),
        ),
    };
    const gen = new OpenAiDoc2QueryGenerator({
      chatLlm: makeChatLlm(),
      embeddingService,
    });

    const out = await gen.generate(makeInput());

    expect(out.length).toBeGreaterThanOrEqual(8);
    const snap = globalSilentSkipCounter.snapshot();
    expect(snap.doc2query_round_trip_embedding_failure).toBe(0);
  });

  it('an empty/absent source embedding is the no-op early-return path, NOT an embedding failure', async () => {
    // When embedBatch resolves but yields no usable source embedding
    // (embeddings[0] === undefined), the ranker degrades to the original
    // queries via an early return that lives OUTSIDE the narrowed try. The
    // degradation counter (which tracks *thrown* embedding failures) must
    // stay at 0 — only a genuine embedBatch throw is the silent-skip event.
    const embeddingService: EmbeddingServicePort = {
      embedBatch: vi.fn().mockResolvedValue([]),
    };
    const gen = new OpenAiDoc2QueryGenerator({
      chatLlm: makeChatLlm(),
      embeddingService,
    });

    const out = await gen.generate(makeInput());
    expect(out.length).toBeGreaterThanOrEqual(8);
    const snap = globalSilentSkipCounter.snapshot();
    expect(snap.doc2query_round_trip_embedding_failure).toBe(0);
  });
});
