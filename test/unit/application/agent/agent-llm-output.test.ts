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
      plannerRepair: expect.objectContaining({
        code: 'partial_actions_batch',
        recoveredFrom: 'actions',
        droppedCandidates: [
          expect.objectContaining({
            location: 'actions',
            index: 2,
            reason: 'missing_tool_name',
          }),
        ],
      }),
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
      plannerRepair: expect.objectContaining({
        code: 'embedded_tool_recovery',
        recoveredFrom: 'bare_tool',
      }),
    });
  });

  it('recovers a bare tool JSON object embedded inside malformed thought output', () => {
    const parsed = parseLlmOutput(
      '\n{"thought":"{"tool":"compare_wines","input":{"query_a":"바롤로","query_b":"브루넬로","wine_type":"red"}}"}',
    );

    expect(parsed).toEqual({
      thought: 'recovered embedded tool call',
      action: {
        tool: 'compare_wines',
        input: {
          query_a: '바롤로',
          query_b: '브루넬로',
          wine_type: 'red',
        },
      },
      plannerRepair: expect.objectContaining({
        code: 'embedded_tool_recovery',
        recoveredFrom: 'embedded_json',
      }),
    });
  });

  it('recovers a stringified bare tool object carried only in thought', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: JSON.stringify({
        tool: 'compare_wines',
        input: { query_a: 'Barolo', query_b: 'Brunello' },
      }),
    }));

    expect(parsed).toEqual({
      thought: 'recovered embedded tool call',
      action: {
        tool: 'compare_wines',
        input: { query_a: 'Barolo', query_b: 'Brunello' },
      },
      plannerRepair: expect.objectContaining({
        code: 'embedded_tool_recovery',
        recoveredFrom: 'thought_string',
      }),
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
      candidateIssues: [
        expect.objectContaining({
          location: 'action',
          tool: 'get_food_pairings',
          reason: 'invalid_tool_input',
        }),
      ],
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

  it('routes JSON-like but unparseable output to planner defect recovery', () => {
    const parsed = parseLlmOutput('{"thought":"search","action":');

    expect(parsed).toEqual({
      thought: 'malformed planner output',
      plannerDefect: expect.objectContaining({
        code: 'malformed_json_output',
      }),
    });
  });

  it('recovers final answers when JSON strings contain raw newlines', () => {
    const parsed = parseLlmOutput(`{"thought":"검색 결과를 종합한다","answer":"추천 1: Moët & Chandon Brut Impérial NV
- 가격: 약 74,250원
- 프랑스 샹파뉴"}`);

    expect(parsed).toEqual({
      thought: '검색 결과를 종합한다',
      answer: '추천 1: Moët & Chandon Brut Impérial NV\n- 가격: 약 74,250원\n- 프랑스 샹파뉴',
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
      recoveredAnswer: '오퍼스 원입니다.',
      recoveredAction: {
        tool: 'search_wines',
        input: { query: 'opus one' },
      },
    }));
  });

  it('fails closed on mixed answer payloads even when action is malformed', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'bad mixed primitive action',
      answer: '그 와인입니다.',
      action: 'search_wines',
    }));

    expect(parsed.thought).toBe('bad mixed primitive action');
    expect(parsed.plannerDefect).toEqual(expect.objectContaining({
      code: 'mixed_answer_and_tool',
      recoveredAnswer: '그 와인입니다.',
      candidateIssues: [
        expect.objectContaining({
          location: 'action',
          reason: 'non_object_action',
        }),
      ],
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
    expect(parsed.plannerRepair).toEqual(expect.objectContaining({
      code: 'partial_actions_batch',
      droppedCandidates: [
        expect.objectContaining({
          location: 'actions',
          index: 1,
          tool: 'get_food_pairings',
          reason: 'invalid_tool_input',
        }),
      ],
    }));
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
      candidateIssues: [
        expect.objectContaining({
          location: 'bare_tool',
          tool: 'compare_wines',
          reason: 'invalid_tool_input',
        }),
      ],
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
      plannerRepair: expect.objectContaining({
        code: 'tool_input_repaired',
        recoveredFrom: 'action',
        repairedCandidates: [
          expect.objectContaining({
            location: 'action',
            tool: 'compare_wines',
            removedUnknownKeys: ['food'],
          }),
        ],
      }),
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
    expect(parsed.plannerRepair).toEqual(expect.objectContaining({
      code: 'partial_actions_batch',
      droppedCandidates: [
        expect.objectContaining({
          tool: 'get_food_pairings',
          reason: 'invalid_tool_input',
        }),
      ],
    }));
  });

  it('preserves recovered valid actions inside mixed answer+batch defect', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'mixed parallel payload',
      answer: '먼저 검색해 보겠습니다.',
      actions: [
        { tool: 'search_wines', input: { query: 'Barolo' } },
        { tool: 'get_food_pairings', input: { food: 42 } },
        'bad-entry',
      ],
    }));

    expect(parsed.plannerDefect).toEqual(expect.objectContaining({
      code: 'mixed_answer_and_tool',
      recoveredAnswer: '먼저 검색해 보겠습니다.',
      recoveredActions: [
        { tool: 'search_wines', input: { query: 'Barolo' } },
      ],
      candidateIssues: [
        expect.objectContaining({
          location: 'actions',
          index: 1,
          tool: 'get_food_pairings',
          reason: 'invalid_tool_input',
        }),
        expect.objectContaining({
          location: 'actions',
          index: 2,
          reason: 'non_object_action',
        }),
      ],
    }));
  });

  it('reports repaired and dropped candidates separately for partially valid batches', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'repairable batch',
      actions: [
        {
          tool: 'compare_wines',
          input: { query_a: 'Barolo', query_b: 'Brunello', food: 'steak' },
        },
        {
          tool: 'get_food_pairings',
          input: { food: 42 },
        },
      ],
    }));

    expect(parsed.actions).toEqual([
      { tool: 'compare_wines', input: { query_a: 'Barolo', query_b: 'Brunello' } },
    ]);
    expect(parsed.plannerRepair).toEqual(expect.objectContaining({
      code: 'partial_actions_batch',
      repairedCandidates: [
        expect.objectContaining({
          location: 'actions',
          index: 0,
          tool: 'compare_wines',
          removedUnknownKeys: ['food'],
        }),
      ],
      droppedCandidates: [
        expect.objectContaining({
          location: 'actions',
          index: 1,
          tool: 'get_food_pairings',
          reason: 'invalid_tool_input',
        }),
      ],
    }));
  });

  it('keeps scanning embedded JSON candidates after an invalid tool payload', () => {
    const parsed = parseLlmOutput(JSON.stringify({
      thought: 'prefix {"tool":"get_food_pairings","input":{"food":42}} middle {"tool":"search_wines","input":{"query":"barolo"}} suffix',
    }));

    expect(parsed).toEqual({
      thought: 'recovered embedded tool call',
      action: {
        tool: 'search_wines',
        input: { query: 'barolo' },
      },
      plannerRepair: expect.objectContaining({
        code: 'embedded_tool_recovery',
        recoveredFrom: 'thought_string',
      }),
    });
  });
});
