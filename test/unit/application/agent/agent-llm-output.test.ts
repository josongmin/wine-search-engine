import { describe, expect, it } from 'vitest';
import {
  isValidLlmResult,
  parseLlmOutput,
} from '../../../../src/application/agent/agent-llm-output.js';

describe('agent-llm-output', () => {
  it('parses fenced final-answer JSON', () => {
    const parsed = parseLlmOutput('```json\n{"thought":"done","answer":"오퍼스 원을 추천합니다."}\n```');

    expect(parsed).toEqual({
      thought: 'done',
      answer: '오퍼스 원을 추천합니다.',
    });
  });

  it('parses parallel actions and normalizes string input to query objects', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'run both',
      actions: [
        { tool: 'search_wines', input: 'opus one' },
        { tool: 'get_food_pairings', input: { food: 'steak' } },
        { tool: 123, input: { bad: true } },
      ],
    }));

    expect(parsed).toEqual({
      thought: 'run both',
      actions: [
        { tool: 'search_wines', input: { query: 'opus one' } },
        { tool: 'get_food_pairings', input: { food: 'steak' } },
      ],
    });
  });

  it('recovers bare tool calls and ignores trailing concatenated JSON', () => {
    const parsed = parseLlmOutput(
      '{"thought":"search","tool":"search_wines","input":"barolo"}{"thought":"ignored","answer":"x"}',
    );

    expect(parsed).toEqual({
      thought: 'search',
      action: {
        tool: 'search_wines',
        input: { query: 'barolo' },
      },
    });
  });

  it('falls back to raw answer text for non-JSON output', () => {
    const parsed = parseLlmOutput('not-json at all');

    expect(parsed).toEqual({
      thought: '[unparseable LLM output]',
      answer: 'not-json at all',
    });
  });

  it('fails closed on mixed answer+action JSON objects', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'bad mix',
      answer: '오퍼스 원입니다.',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
    }));

    expect(parsed).toEqual({
      thought: '[invalid mixed LLM output]',
      answer: JSON.stringify({
        thought: 'bad mix',
        answer: '오퍼스 원입니다.',
        action: { tool: 'search_wines', input: { query: 'opus one' } },
      }),
    });
  });

  it('validates structured llm result envelopes', () => {
    expect(isValidLlmResult({ text: '{}', model: 'gpt-test', finishReason: 'stop' })).toBe(true);
    expect(isValidLlmResult({ text: '{}', finishReason: 'stop' })).toBe(false);
    expect(isValidLlmResult(undefined)).toBe(false);
  });
});
