import { describe, it, expect, vi } from 'vitest';
import { processTurn, type AgentRunner } from '../repl-loop.js';
import { ReplSession } from '../session.js';
import type { AgentResult } from '../../../domain/agent/model/agent-result.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ResultItem } from '../../../domain/response/model/result-item.js';
import type { ConversationContext } from '../../../domain/agent/model/conversation-context.js';

function item(id: string, label: string): ResultItem {
  return {
    entity: { entityId: id, canonicalLabel: label, type: 'wine', wineType: 'red' },
    relevanceScore: 0.9,
    match: { matchType: 'semantic', score: 0.9 },
    constraints: { satisfied: [], violated: [], unknown: [] },
    uncertainty: { confidence: 0.9, band: 'high' },
    evidenceItems: [],
  } as unknown as ResultItem;
}

function fakeResult(answer: string, items: ResultItem[] = []): AgentResult {
  const searchResults = { results: items } as unknown as SearchResponseV1;
  return {
    answer,
    steps: [],
    totalDurationMs: 12,
    totalTokens: { input: 10, output: 5 },
    toolCallCount: items.length > 0 ? 1 : 0,
    fallbackApplied: false,
    terminationReason: 'answer',
    ...(items.length > 0 ? { searchResults } : {}),
  };
}

describe('processTurn', () => {
  it('sends the raw input as the query and NO context on the first turn', async () => {
    const execute = vi.fn(async () => fakeResult('키안티를 추천합니다.', [item('w1', 'Chianti')]));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    const { output } = await processTurn(runner, session, '피자 와인 추천');

    const [query, requestId, , , conversationContext] = execute.mock.calls[0] ?? [];
    expect(query).toBe('피자 와인 추천');
    expect(typeof requestId).toBe('string');
    expect(conversationContext).toBeUndefined(); // no prior turns
    expect(output).toContain('키안티를 추천합니다.');
    expect(session.turnCount).toBe(1);
  });

  it('passes STRUCTURED prior-turn context (with entities) on the second turn', async () => {
    const execute = vi.fn(async () => fakeResult('5만원 이하는 발폴리첼라.'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();
    // Simulate a completed first turn that surfaced entities.
    session.record('피자 와인 추천', fakeResult('키안티/발폴리첼라', [
      item('w1', 'Chianti Classico'),
      item('w2', 'Valpolicella'),
    ]));

    await processTurn(runner, session, '그중에 5만원 이하는?');

    const [query, , , , conversationContext] = execute.mock.calls[0] ?? [];
    expect(query).toBe('그중에 5만원 이하는?'); // query stays the bare follow-up
    const ctx = conversationContext as ConversationContext;
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0]?.userQuery).toBe('피자 와인 추천');
    expect(ctx.turns[0]?.entities.map((e) => e.label)).toEqual([
      'Chianti Classico',
      'Valpolicella',
    ]);
  });

  it('context reflects only EARLIER turns (captured before recording this one)', async () => {
    const execute = vi.fn(async () => fakeResult('답'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    // First turn: context must be undefined at call time even though we record after.
    await processTurn(runner, session, '첫 질문');
    expect(execute.mock.calls[0]?.[4]).toBeUndefined();

    // Second turn: context has exactly the first turn.
    await processTurn(runner, session, '둘째 질문');
    const ctx2 = execute.mock.calls[1]?.[4] as ConversationContext;
    expect(ctx2.turns).toHaveLength(1);
    expect(ctx2.turns[0]?.userQuery).toBe('첫 질문');
  });

  it('forwards a maxSteps override', async () => {
    const execute = vi.fn(async () => fakeResult('ok'));
    const runner: AgentRunner = { execute };
    const session = new ReplSession();

    await processTurn(runner, session, 'q', { maxSteps: 7 });

    expect(execute.mock.calls[0]?.[2]).toEqual({ maxSteps: 7 });
  });

  it('appends a trace block when trace=true', async () => {
    const execute = vi.fn(
      async () =>
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
