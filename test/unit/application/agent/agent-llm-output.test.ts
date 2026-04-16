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

  it('fails closed when a known tool carries invalid typed input', () => {
    const raw = JSON.stringify({
      thought: 'bad typed input',
      action: { tool: 'get_food_pairings', input: { food: 123 } },
    });
    const parsed = parseLlmOutput(raw);

    expect(parsed).toEqual({
      thought: '[unparseable LLM structure]',
      answer: raw,
    });
  });

  it('preserves unknown tools with object input for recovery feedback', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'try fake tool',
      action: { tool: 'fake_tool', input: { x: 1 } },
    }));

    expect(parsed).toEqual({
      thought: 'try fake tool',
      action: {
        tool: 'fake_tool',
        input: { x: 1 },
      },
    });
  });

  it('keeps known tools with missing optional attempt fields so execution can return validation feedback', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'search without query',
      action: { tool: 'search_wines', input: {} },
    }));

    expect(parsed).toEqual({
      thought: 'search without query',
      action: {
        tool: 'search_wines',
        input: {},
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

  it('filters out known tools with wrong-type input from parallel batch', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'parallel run',
      actions: [
        { tool: 'search_wines', input: { query: 'barolo' } },
        { tool: 'get_food_pairings', input: { food: 123 } },
        { tool: 'check_drinking_window', input: { entity_id: 'wine-1' } },
      ],
    }));

    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions![0]).toEqual({ tool: 'search_wines', input: { query: 'barolo' } });
    expect(parsed.actions![1]).toEqual({ tool: 'check_drinking_window', input: { entity_id: 'wine-1' } });
  });

  it('fails closed on bare tool call with invalid known-tool typed input', () => {
    const raw = JSON.stringify({
      thought: 'bare invalid',
      tool: 'compare_wines',
      input: { query_a: 123, query_b: 456 },
    });
    const parsed = parseLlmOutput(raw);

    expect(parsed).toEqual({
      thought: '[unparseable LLM structure]',
      answer: raw,
    });
  });

  it('preserves unknown tool in parallel batch alongside valid known tools', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'mix known+unknown',
      actions: [
        { tool: 'search_wines', input: { query: 'brunello' } },
        { tool: 'fake_lookup', input: { id: 'abc' } },
      ],
    }));

    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions![0]).toEqual({ tool: 'search_wines', input: { query: 'brunello' } });
    expect(parsed.actions![1]).toEqual({ tool: 'fake_lookup', input: { id: 'abc' } });
  });
});
