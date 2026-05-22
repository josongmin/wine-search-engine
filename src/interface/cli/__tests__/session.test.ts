import { describe, it, expect } from 'vitest';
import { ReplSession } from '../session.js';
import type { AgentResult } from '../../../domain/agent/model/agent-result.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { ResultItem } from '../../../domain/response/model/result-item.js';

function resultItem(id: string, label: string, score: number): ResultItem {
  return {
    entity: {
      entityId: id,
      canonicalLabel: label,
      type: 'wine',
      region: 'Toscana',
      wineType: 'red',
      vintage: 2019,
      priceRange: '$20-$30',
    },
    relevanceScore: score,
    match: { matchType: 'semantic', score },
    constraints: { satisfied: [], violated: [], unknown: [] },
    uncertainty: { confidence: score, band: 'high' },
    evidenceItems: [],
  } as unknown as ResultItem;
}

function agentResult(answer: string, items: ResultItem[]): AgentResult {
  const searchResults = { results: items } as unknown as SearchResponseV1;
  return {
    answer,
    steps: [],
    totalDurationMs: 10,
    totalTokens: { input: 5, output: 5 },
    toolCallCount: 1,
    fallbackApplied: false,
    terminationReason: 'answer',
    ...(items.length > 0 ? { searchResults } : {}),
  };
}

describe('ReplSession', () => {
  it('returns undefined context with no prior turns', () => {
    const s = new ReplSession();
    expect(s.toConversationContext()).toBeUndefined();
    expect(s.turnCount).toBe(0);
  });

  it('captures answer + structured entities from the AgentResult', () => {
    const s = new ReplSession();
    s.record('피자 와인 추천', agentResult('키안티 추천', [
      resultItem('w1', 'Chianti Classico', 0.91),
      resultItem('w2', 'Valpolicella', 0.84),
    ]));

    const ctx = s.toConversationContext();
    expect(ctx).toBeDefined();
    const t0 = ctx?.turns[0];
    expect(t0?.userQuery).toBe('피자 와인 추천');
    expect(t0?.answerSummary).toBe('키안티 추천');
    expect(t0?.entities).toHaveLength(2);
    expect(t0?.entities[0]).toMatchObject({
      entityId: 'w1',
      label: 'Chianti Classico',
      wineType: 'red',
      priceRange: '$20-$30',
      relevanceScore: 0.91,
    });
  });

  it('handles a turn with no search results (empty entities)', () => {
    const s = new ReplSession();
    s.record('안녕', agentResult('안녕하세요!', []));
    const ctx = s.toConversationContext();
    expect(ctx?.turns[0]?.entities).toEqual([]);
  });

  it('accumulates turns chronologically', () => {
    const s = new ReplSession();
    s.record('첫', agentResult('a1', []));
    s.record('둘', agentResult('a2', []));
    const ctx = s.toConversationContext();
    expect(ctx?.turns.map((t) => t.userQuery)).toEqual(['첫', '둘']);
    expect(s.turnCount).toBe(2);
  });

  it('reset() clears history', () => {
    const s = new ReplSession();
    s.record('q', agentResult('a', []));
    s.reset();
    expect(s.turnCount).toBe(0);
    expect(s.toConversationContext()).toBeUndefined();
  });
});
