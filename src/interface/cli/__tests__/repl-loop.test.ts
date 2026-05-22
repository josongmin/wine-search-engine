import { describe, it, expect, vi } from 'vitest';
import { processTurn, type AgentRunner } from '../repl-loop.js';
import { ReplSession } from '../session.js';
import type { AgentResult } from '../../../domain/agent/model/agent-result.js';

function fakeResult(answer: string): AgentResult {
  return {
    answer,
    steps: [],
    totalDurationMs: 12,
    totalTokens: { input: 10, output: 5 },
    toolCallCount: 0,
    fallbackApplied: false,
    terminationReason: 'answer',
  };
}

describe('processTurn', () => {
  it('passes the raw input to the runner on the first turn and records the answer', async () => {
    const execute = vi.fn(async () => fakeResult('키안티를 추천합니다.'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    const { output } = await processTurn(runner, session, '피자 와인 추천');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe('피자 와인 추천'); // query
    expect(output).toContain('키안티를 추천합니다.');
    expect(session.turnCount).toBe(1);
  });

  it('folds prior context into the query on the second turn', async () => {
    const execute = vi.fn(async () => fakeResult('5만원 이하는 발폴리첼라.'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();
    session.record('피자 와인 추천', '키안티, 발폴리첼라를 추천합니다.');

    await processTurn(runner, session, '그중에 5만원 이하는?');

    const sentQuery = execute.mock.calls[0]?.[0] as string;
    expect(sentQuery).toContain('이전 대화:');
    expect(sentQuery).toContain('키안티');
    expect(sentQuery).toContain('현재 질문: 그중에 5만원 이하는?');
  });

  it('forwards a maxSteps override and a fresh requestId', async () => {
    const execute = vi.fn(async () => fakeResult('ok'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    await processTurn(runner, session, 'q', { maxSteps: 7 });

    const [, requestId, overrides] = execute.mock.calls[0] ?? [];
    expect(typeof requestId).toBe('string');
    expect((requestId as string).length).toBeGreaterThan(0);
    expect(overrides).toEqual({ maxSteps: 7 });
  });

  it('records the ORIGINAL input (not the context-stuffed query) to avoid recursive nesting', async () => {
    const execute = vi.fn(async () => fakeResult('답변2'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();
    session.record('첫 질문', '첫 답변');

    await processTurn(runner, session, '둘째 질문');

    // The recorded user turn must be the bare input, so a third turn does not
    // re-embed the "이전 대화:" block recursively.
    const second = session.turns[1];
    expect(second?.user).toBe('둘째 질문');
    expect(second?.user).not.toContain('이전 대화:');
  });

  it('appends a trace block when trace=true', async () => {
    const execute = vi.fn(async () =>
      ({
        ...fakeResult('답'),
        steps: [
          {
            index: 1,
            thought: '검색이 필요',
            action: { tool: 'search_wines', input: { query: '피자' } },
            observation: '3건 발견',
            durationMs: 5,
            tokenCount: { input: 4, output: 2 },
          },
        ],
        toolCallCount: 1,
      }) satisfies AgentResult,
    );
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    const { output } = await processTurn(runner, session, 'q', { trace: true });
    expect(output).toContain('trace');
    expect(output).toContain('search_wines');
    expect(output).toContain('step 1');
  });
});
