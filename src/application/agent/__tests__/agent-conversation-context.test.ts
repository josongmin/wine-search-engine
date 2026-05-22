import { describe, it, expect } from 'vitest';
import {
  buildConversationContextBlock,
  CONVERSATION_CONTEXT_MAX_CHARS,
  CONVERSATION_MAX_ENTITIES_RECENT,
  CONVERSATION_MAX_ENTITIES_OLDER,
} from '../agent-prompt.js';
import type {
  ConversationContext,
  ConversationTurnContext,
  PriorEntityRef,
} from '../../../domain/agent/model/conversation-context.js';

function entity(n: number): PriorEntityRef {
  return {
    entityId: `wine-${n}`,
    label: `Wine ${n}`,
    vintage: 2018,
    region: 'Napa',
    wineType: 'red',
    priceRange: '$20-$30',
    relevanceScore: 0.9,
  };
}

function turn(user: string, answer: string, entityCount: number): ConversationTurnContext {
  return {
    userQuery: user,
    answerSummary: answer,
    entities: Array.from({ length: entityCount }, (_, i) => entity(i + 1)),
  };
}

describe('buildConversationContextBlock', () => {
  it('returns empty string for empty context', () => {
    const ctx: ConversationContext = { turns: [] };
    expect(buildConversationContextBlock(ctx)).toBe('');
  });

  it('renders header/footer, user query, answer summary, and entity rows', () => {
    const ctx: ConversationContext = { turns: [turn('피자 와인 추천', '키안티 추천', 2)] };
    const block = buildConversationContextBlock(ctx);
    expect(block).toContain('이전 대화 맥락');
    expect(block).toContain('이전 대화 맥락 끝');
    expect(block).toContain('피자 와인 추천');
    expect(block).toContain('답변요약: 키안티 추천');
    expect(block).toContain('Wine 1');
    expect(block).toContain('rel 0.90');
    expect(block).toContain('$20-$30');
  });

  it('labels the newest turn [T-1] and orders turns chronologically', () => {
    const ctx: ConversationContext = {
      turns: [turn('첫', 'a1', 0), turn('둘', 'a2', 0), turn('셋', 'a3', 0)],
    };
    const block = buildConversationContextBlock(ctx);
    // Newest ('셋') is the most recent → [T-1]; rendered last (chronological).
    expect(block).toContain('[T-1] 사용자: 셋');
    expect(block).toContain('[T-3] 사용자: 첫');
    expect(block.indexOf('첫')).toBeLessThan(block.indexOf('셋'));
  });

  it('caps entity rows: recent turn keeps more than older turns', () => {
    const ctx: ConversationContext = {
      turns: [turn('older', 'a', 20), turn('recent', 'a', 20)],
    };
    const block = buildConversationContextBlock(ctx);
    // The recent turn shows up to RECENT cap; an older turn up to OLDER cap.
    const recentRows = (block.match(/^\s+\d+\. Wine /gm) ?? []).length;
    expect(recentRows).toBeLessThanOrEqual(
      CONVERSATION_MAX_ENTITIES_RECENT + CONVERSATION_MAX_ENTITIES_OLDER,
    );
    // The recent turn must show its higher cap.
    expect(block).toContain(`${CONVERSATION_MAX_ENTITIES_RECENT}. Wine ${CONVERSATION_MAX_ENTITIES_RECENT}`);
  });

  it('never exceeds the char budget and keeps the NEWEST turn (eviction)', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(`질문${i}`, 'x'.repeat(400), 10));
    const block = buildConversationContextBlock({ turns });
    expect(block.length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_CHARS);
    expect(block).toContain('질문9'); // newest survives
    expect(block).not.toContain('질문0'); // oldest evicted
  });
});
