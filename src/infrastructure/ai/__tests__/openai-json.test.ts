import { describe, expect, it } from 'vitest';
import { embeddingsFromOpenAiResponse } from '../openai-json.js';

describe('embeddingsFromOpenAiResponse', () => {
  it('orders by index', () => {
    const out = embeddingsFromOpenAiResponse({
      object: 'list',
      model: 'x',
      data: [
        { object: 'embedding', index: 1, embedding: [0, 1] },
        { object: 'embedding', index: 0, embedding: [2, 3] },
      ],
    });
    expect(out).toEqual([
      [2, 3],
      [0, 1],
    ]);
  });

  it('throws on bad shape', () => {
    expect(() => embeddingsFromOpenAiResponse({ foo: 1 })).toThrow(/Embedding API/i);
  });
});
