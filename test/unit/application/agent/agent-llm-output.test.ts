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

  it('recovers the first valid JSON object when a later concatenated object is truncated', () => {
    const parsed = parseLlmOutput(
      '{"thought":"search","action":{"tool":"search_wines","input":{"query":"anniversary dinner"}}}\n{"thought":"partial"',
    );

    expect(parsed).toEqual({
      thought: 'search',
      action: {
        tool: 'search_wines',
        input: { query: 'anniversary dinner' },
      },
    });
  });

  it('fails closed when a known tool carries invalid typed input', () => {
    const raw = JSON.stringify({
      thought: 'bad typed input',
      action: { tool: 'get_food_pairings', input: { food: 123 } },
    });
    const parsed = parseLlmOutput(raw);

    expect(parsed.thought).toBe('bad typed input');
    expect(parsed.plannerDefect).toEqual(expect.objectContaining({
      code: 'invalid_tool_input',
    }));
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

  it('normalizes single occasion tags to an array on known tool attempts', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'date recommendation',
      action: {
        tool: 'search_wines',
        input: {
          query: '분위기 좋은 와인',
          occasion: 'date_night',
        },
      },
    }));

    expect(parsed).toEqual({
      thought: 'date recommendation',
      action: {
        tool: 'search_wines',
        input: {
          query: '분위기 좋은 와인',
          occasion: ['date_night'],
        },
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

    expect(parsed.thought).toBe('bad mix');
    expect(parsed.plannerDefect).toEqual(expect.objectContaining({
      code: 'mixed_answer_and_tool',
    }));
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

    expect(parsed.thought).toBe('bare invalid');
    expect(parsed.plannerDefect).toEqual(expect.objectContaining({
      code: 'invalid_tool_input',
    }));
  });

  it('repairs compare_wines inputs by dropping unknown schema fields', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'compare concept wines',
      action: {
        tool: 'compare_wines',
        input: {
          query_a: 'Barolo',
          query_b: 'Brunello',
          food: 'steak',
        },
      },
    }));

    expect(parsed).toEqual({
      thought: 'compare concept wines',
      action: {
        tool: 'compare_wines',
        input: {
          query_a: 'Barolo',
          query_b: 'Brunello',
        },
      },
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

  it('coexists: unknown tool recovery + known tool validation feedback in same batch', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'mixed errors',
      actions: [
        { tool: 'search_wines', input: {} },
        { tool: 'nonexistent_tool', input: { x: 1 } },
        { tool: 'get_food_pairings', input: { food: 42 } },
      ],
    }));

    // search_wines with empty input → passes (all fields optional in attempt schema)
    // nonexistent_tool → preserved for unknown tool recovery feedback
    // get_food_pairings with food:42 → filtered out (wrong type, fail-closed)
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions![0]).toEqual({ tool: 'search_wines', input: {} });
    expect(parsed.actions![1]).toEqual({ tool: 'nonexistent_tool', input: { x: 1 } });
  });
});
