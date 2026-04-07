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

  it('throws on bad shape with structural diagnostic only', () => {
    const sensitivePayload = { error: 'invalid_api_key', secret: 'sk-abc123' };
    expect(() => embeddingsFromOpenAiResponse(sensitivePayload)).toThrow(/Embedding API/i);
    try {
      embeddingsFromOpenAiResponse(sensitivePayload);
    } catch (e) {
      const msg = (e as Error).message;
      // Must NOT leak actual field values
      expect(msg).not.toContain('sk-abc123');
      expect(msg).not.toContain('invalid_api_key');
      // Must contain structural info for debugging
      expect(msg).toContain('data=');
    }
  });

  it('describes null/undefined/primitive shapes without crash', () => {
    expect(() => embeddingsFromOpenAiResponse(null)).toThrow(/null/);
    expect(() => embeddingsFromOpenAiResponse(undefined)).toThrow(/undefined/);
    expect(() => embeddingsFromOpenAiResponse('string')).toThrow(/type=string/);
  });
});
