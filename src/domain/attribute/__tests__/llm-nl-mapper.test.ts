import { describe, it, expect } from 'vitest';
import { LlmNLMapper, CACHE_KEY_NAMESPACE } from '../service/llm-nl-mapper.js';
import type { PhraseCachePort } from '../port/phrase-cache.port.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../ai/port/chat-llm.port.js';
import type { LlmConstraintItem } from '../model/llm-constraint-schema.js';

// ── Helpers ──────────────────────────────────────────────────────────────

class NullMappingTable implements MappingTablePort {
  findMapping(_phrase: string): Promise<NLMapping | null> {
    return Promise.resolve(null);
  }
  findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return Promise.resolve([]);
  }
  getCurrentVersion(): Promise<string> {
    return Promise.resolve('v1.0');
  }
}

class StubChatLlm implements ChatLlmPort {
  public callCount = 0;
  public lastRequest: ChatCompletionRequest | undefined;

  constructor(private readonly response: LlmConstraintItem[]) {}

  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.callCount += 1;
    this.lastRequest = request;
    return Promise.resolve({
      text: JSON.stringify(this.response),
      model: 'stub',
      finishReason: 'stop',
    });
  }
}

class FailingChatLlm implements ChatLlmPort {
  public callCount = 0;
  complete(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.callCount += 1;
    return Promise.reject(new Error('llm down'));
  }
}

/** Never resolves; rejects when `abortSignal` aborts (mirrors real HTTP cancellation). */
class HangUntilAbortChatLlm implements ChatLlmPort {
  public callCount = 0;

  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.callCount += 1;
    return new Promise((_resolve, reject) => {
      const signal = request.abortSignal;
      if (signal === undefined) {
        reject(new Error('HangUntilAbortChatLlm: abortSignal required'));
        return;
      }
      if (signal.aborted) {
        reject(new Error('HangUntilAbortChatLlm: already aborted'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(new Error('HangUntilAbortChatLlm: aborted'));
        },
        { once: true },
      );
    });
  }
}

/** Resolves after a delay without honoring `abortSignal` (violates real HTTP behavior). */
class IgnoresAbortDelayedChatLlm implements ChatLlmPort {
  public callCount = 0;

  constructor(
    private readonly delayMs: number,
    private readonly response: LlmConstraintItem[],
  ) {}

  complete(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.callCount += 1;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          text: JSON.stringify(this.response),
          model: 'stub-bad',
          finishReason: 'stop',
        });
      }, this.delayMs);
    });
  }
}

class InMemoryPhraseCache implements PhraseCachePort {
  public store = new Map<string, LlmConstraintItem[]>();
  public getCalls: string[] = [];
  public setCalls: Array<{ key: string; items: LlmConstraintItem[]; ttl: number }> = [];

  get(phrase: string): Promise<LlmConstraintItem[] | null> {
    this.getCalls.push(phrase);
    const cached = this.store.get(phrase);
    return Promise.resolve(cached ?? null);
  }

  set(phrase: string, items: LlmConstraintItem[], ttlSeconds: number): Promise<void> {
    this.setCalls.push({ key: phrase, items, ttl: ttlSeconds });
    this.store.set(phrase, items);
    return Promise.resolve();
  }
}

class BrokenPhraseCache implements PhraseCachePort {
  get(_phrase: string): Promise<LlmConstraintItem[] | null> {
    return Promise.reject(new Error('redis exploded'));
  }
  set(_phrase: string, _items: LlmConstraintItem[], _ttl: number): Promise<void> {
    return Promise.reject(new Error('redis exploded'));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('LlmNLMapper phrase cache', () => {
  const fruityItem: LlmConstraintItem = {
    phrase: 'zzz_unknown_phrase',
    attribute: 'flavor_profile',
    operator: 'in',
    value: 'fruity',
    confidence: 0.9,
  };

  it('cache miss → calls LLM, then writes positive entry to cache', async () => {
    const llm = new StubChatLlm([fruityItem]);
    const cache = new InMemoryPhraseCache();
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);

    const { constraints: result, constraintExtraction: trace } = await mapper.mapConstraints([
      'zzz_unknown_phrase',
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.attribute).toBe('flavor_profile');
    expect(llm.lastRequest?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(llm.callCount).toBe(1);
    // version-namespaced key
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.key).toContain(CACHE_KEY_NAMESPACE);
    expect(cache.setCalls[0]?.key).toContain('zzz_unknown_phrase');
    expect(cache.setCalls[0]?.ttl).toBe(86_400);
    expect(trace?.phraseCacheHits).toBe(0);
    expect(trace?.phraseCacheMisses).toBe(1);
    expect(trace?.llmHitCount).toBe(1);
  });

  it('cache hit → skips LLM call, returns cached items', async () => {
    const llm = new StubChatLlm([]);
    const cache = new InMemoryPhraseCache();
    const cacheKey = `${CACHE_KEY_NAMESPACE}:zzz_unknown_phrase`;
    cache.store.set(cacheKey, [fruityItem]);

    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);
    const { constraints: result, constraintExtraction: trace } = await mapper.mapConstraints([
      'zzz_unknown_phrase',
    ]);

    expect(result).toHaveLength(1);
    expect(llm.callCount).toBe(0); // LLM was never called
    expect(trace?.phraseCacheHits).toBe(1);
  });

  it('negative cache: empty array hit means "LLM had nothing" — no LLM call, no result', async () => {
    const llm = new StubChatLlm([fruityItem]); // LLM would happily return something
    const cache = new InMemoryPhraseCache();
    cache.store.set(`${CACHE_KEY_NAMESPACE}:nonsense`, []); // negative entry

    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);
    const { constraints: result, constraintExtraction: trace } = await mapper.mapConstraints([
      'nonsense',
    ]);

    expect(result).toHaveLength(0);
    expect(llm.callCount).toBe(0); // critical: negative cache prevents LLM call
    // Negative skip is counted separately from hits — pure negative is not a useful hit.
    expect(trace?.phraseCacheHits).toBe(0);
    expect(trace?.phraseCacheNegativeSkipped).toBe(1);
  });

  it('LLM returning [] → writes negative entry with shorter TTL', async () => {
    const llm = new StubChatLlm([]); // LLM returns nothing
    const cache = new InMemoryPhraseCache();
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);

    await mapper.mapConstraints(['nomatch']);

    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.items).toEqual([]);
    expect(cache.setCalls[0]?.ttl).toBe(3_600); // negative TTL
  });

  it('phraseCacheHits only counts entries that survive filtering', async () => {
    const lowConfidenceItem: LlmConstraintItem = {
      ...fruityItem,
      confidence: 0.1, // below threshold
    };
    const llm = new StubChatLlm([]);
    const cache = new InMemoryPhraseCache();
    cache.store.set(`${CACHE_KEY_NAMESPACE}:zzz_unknown_phrase`, [lowConfidenceItem]);

    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);
    const { constraints: result, constraintExtraction: trace } = await mapper.mapConstraints([
      'zzz_unknown_phrase',
    ]);

    expect(result).toHaveLength(0);
    expect(llm.callCount).toBe(0);
    // Cached entry was found but filtered out — counts as a miss for trace
    // accounting purposes, NOT a hit (we paid the lookup, gained no constraints).
    expect(trace?.phraseCacheHits).toBe(0);
    expect(trace?.phraseCacheMisses).toBe(1);
  });

  it('cache get error → falls through to LLM and still returns results', async () => {
    const llm = new StubChatLlm([fruityItem]);
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, new BrokenPhraseCache());

    const { constraints: result } = await mapper.mapConstraints(['zzz_unknown_phrase']);

    expect(result).toHaveLength(1);
    expect(llm.callCount).toBe(1);
  });

  it('LLM failure → returns empty array (rule-only fallback) without throwing', async () => {
    const llm = new FailingChatLlm();
    const cache = new InMemoryPhraseCache();
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);

    const { constraints: result } = await mapper.mapConstraints(['zzz_unknown_phrase']);

    expect(result).toHaveLength(0);
    expect(llm.callCount).toBe(1);
    // No cache write on LLM failure
    expect(cache.setCalls).toHaveLength(0);
  });

  it('LLM timeout → aborts ChatLlmPort (abortSignal), rule-only fallback, no cache write', async () => {
    const llm = new HangUntilAbortChatLlm();
    const cache = new InMemoryPhraseCache();
    const mapperTimeoutMs = 100;
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, mapperTimeoutMs, cache);

    const { constraints: result, constraintExtraction: trace } = await mapper.mapConstraints([
      'zzz_unknown_phrase',
    ]);

    expect(result).toHaveLength(0);
    expect(llm.callCount).toBe(1);
    expect(cache.setCalls).toHaveLength(0);
    expect(trace?.llmLatencyMs).not.toBeNull();
    expect(trace?.llmLatencyMs ?? 0).toBeGreaterThanOrEqual(mapperTimeoutMs - 20);
  });

  it('LLM timeout → ignores late resolve if adapter ignores abortSignal (defensive)', async () => {
    const lateItem: LlmConstraintItem = { ...fruityItem, phrase: 'zzz_unknown_phrase' };
    const llm = new IgnoresAbortDelayedChatLlm(150, [lateItem]);
    const cache = new InMemoryPhraseCache();
    const mapperTimeoutMs = 50;
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, mapperTimeoutMs, cache);

    const { constraints: result } = await mapper.mapConstraints(['zzz_unknown_phrase']);

    expect(result).toHaveLength(0);
    expect(llm.callCount).toBe(1);
    expect(cache.setCalls).toHaveLength(0);
  });

  it('dedupes phrases at entry — duplicate input does not double-call rule table or LLM', async () => {
    const llm = new StubChatLlm([fruityItem]);
    const cache = new InMemoryPhraseCache();
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);

    const { constraints: result } = await mapper.mapConstraints([
      'zzz_unknown_phrase',
      'zzz_unknown_phrase',
      'zzz_unknown_phrase',
    ]);

    // Single result, single LLM call, single cache write — duplicates collapsed.
    expect(result).toHaveLength(1);
    expect(llm.callCount).toBe(1);
    expect(cache.setCalls).toHaveLength(1);
  });

  it('caps LLM batch at 20 phrases — extras are silently dropped', async () => {
    const llm = new StubChatLlm([]);
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000);

    // 25 unique phrases, none in rule table or DEFAULT_MAPPINGS
    const phrases = Array.from({ length: 25 }, (_, i) => `zzz_unknown_${i}`);
    await mapper.mapConstraints(phrases);

    // LLM should be called once with at most 20 phrases.
    expect(llm.callCount).toBe(1);
    const userMsg = llm.lastRequest?.messages.find((m) => m.role === 'user')?.content ?? '';
    const sentPhrases = JSON.parse(userMsg) as unknown as string[];
    expect(sentPhrases).toHaveLength(20);
    // Earlier phrases retained, later phrases dropped (slice semantics).
    expect(sentPhrases).toContain('zzz_unknown_0');
    expect(sentPhrases).toContain('zzz_unknown_19');
    expect(sentPhrases).not.toContain('zzz_unknown_20');
  });

  it('trace exposes phrase cache breakdown (hits/negativeSkipped/misses)', async () => {
    const apple: LlmConstraintItem = { ...fruityItem, phrase: 'apple' };
    const llm = new StubChatLlm([{ ...fruityItem, phrase: 'cherry' }]);
    const cache = new InMemoryPhraseCache();
    cache.store.set(`${CACHE_KEY_NAMESPACE}:apple`, [apple]); // hit
    cache.store.set(`${CACHE_KEY_NAMESPACE}:banana`, []); // negative skip
    // 'cherry' is not in cache → miss → LLM call

    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);
    const { constraintExtraction: trace } = await mapper.mapConstraints(['apple', 'banana', 'cherry']);

    expect(trace?.phraseCacheHits).toBe(1);
    expect(trace?.phraseCacheNegativeSkipped).toBe(1);
    expect(trace?.phraseCacheMisses).toBe(1);
    // Sum invariant: 1+1+1 = 3 phrases checked against the cache
    expect(
      (trace?.phraseCacheHits ?? 0)
      + (trace?.phraseCacheNegativeSkipped ?? 0)
      + (trace?.phraseCacheMisses ?? 0),
    ).toBe(3);
  });

  it('concurrent mapConstraints calls each get an isolated extraction trace', async () => {
    const llm = new StubChatLlm([]);
    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000);
    const [r1, r2] = await Promise.all([
      mapper.mapConstraints(['concurrent_a']),
      mapper.mapConstraints(['concurrent_b', 'concurrent_c']),
    ]);
    expect(r1.constraintExtraction?.candidatePhraseCount).toBe(1);
    expect(r2.constraintExtraction?.candidatePhraseCount).toBe(2);
  });

  it('CACHE_KEY_NAMESPACE includes both version and prompt fingerprint', () => {
    // Format: ${LLM_MAPPING_VERSION}:${8-char hex}
    expect(CACHE_KEY_NAMESPACE).toMatch(/^llm-v1\.0:[0-9a-f]{8}$/);
  });

  it('mixed batch: cached + uncached phrases call LLM only for uncached', async () => {
    const apple: LlmConstraintItem = { ...fruityItem, phrase: 'apple' };
    const banana: LlmConstraintItem = { ...fruityItem, phrase: 'banana' };

    const llm = new StubChatLlm([banana]);
    const cache = new InMemoryPhraseCache();
    cache.store.set(`${CACHE_KEY_NAMESPACE}:apple`, [apple]);

    const mapper = new LlmNLMapper(new NullMappingTable(), llm, 5_000, cache);
    const { constraints: result } = await mapper.mapConstraints(['apple', 'banana']);

    expect(result).toHaveLength(2);
    expect(llm.callCount).toBe(1);
    // LLM only saw uncached phrase
    const userMsg = llm.lastRequest?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('banana');
    expect(userMsg).not.toContain('apple');
  });
});
