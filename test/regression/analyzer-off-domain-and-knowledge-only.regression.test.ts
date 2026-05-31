/**
 * Regression: PtE query-analyzer honors the adaptive-budget classifier's
 * `off_domain` AND `knowledge_only` outcomes (F-CritA cluster).
 *
 * Pre-fix the analyzer only branched on `adversarial` and silently fell
 * through to the deterministic pipeline for `off_domain`/`knowledge_only`,
 * which then misclassified as `intent=search` → router emitted a
 * single-search plan → search_hybrid was called → `mustNotCallTools`
 * violation on bench #20 / #103 / #104 / #109.
 *
 * Patches pinned here:
 *  1. Off-domain regex tolerates Korean particles (조사) after the subject
 *     so "소주가" / "맥주는" / "위스키도" etc. all match.
 *  2. Off-domain branch added to query-analyzer → returns
 *     `{ kind: 'rejected', reason: 'off_domain' }`.
 *  3. Knowledge-only pattern added — WH-cue + explanation-action covers
 *     "왜 ... 설명해봐" / "explain how ..." style queries.
 *
 * Note: the `terminationReason='answer'` split for non-security rejects
 * (F-CritB) lives in the orchestrator; that contract is exercised via the
 * bench harness end-to-end (not unit-testable cheaply here without wiring
 * the full orchestrator).
 */

import { describe, it, expect } from 'vitest';
import { classifyQueryBudget } from '../../src/domain/agent/service/adaptive-budget.js';

describe('off-domain classification with Korean particles (bench #20/#104/#109)', () => {
  const offDomainCases = [
    { query: '와인 말고 맥주 추천', label: '#20 beer' },
    { query: '소주가 와인보다 낫지 않냐', label: '#104 soju + particle 가' },
    { query: '보르도 오늘 날씨 어때?', label: '#109 weather' },
    { query: '맥주는 어떤 게 좋아', label: 'beer + 는 particle' },
    { query: '위스키도 추천해줘', label: 'whisky + 도 particle' },
    { query: '주식 추천', label: 'stock' },
    { query: '오늘 야구 경기', label: 'baseball' },
    { query: 'bitcoin 가격', label: 'crypto (bitcoin)' },
  ];

  for (const { query, label } of offDomainCases) {
    it(`classifies "${label}" as off_domain`, () => {
      const c = classifyQueryBudget(query);
      expect(c?.classification).toBe('off_domain');
    });
  }
});

describe('knowledge-only classification (bench #103)', () => {
  const knowledgeCases = [
    { query: '와인 가격이 왜 이렇게 비싸? 설명해봐', label: '#103 why + explain' },
    { query: '왜 와인이 빨갛지 알려줘', label: 'why + tell' },
    { query: '어떻게 와인을 만들어요 설명해주세요', label: 'how + explain' },
    { query: 'explain why wine is expensive', label: 'English why + explain' },
  ];

  for (const { query, label } of knowledgeCases) {
    it(`classifies "${label}" as knowledge_only`, () => {
      const c = classifyQueryBudget(query);
      expect(c?.classification).toBe('knowledge_only');
    });
  }

  it('does NOT misclassify a WH-only query without explanation-action as knowledge_only', () => {
    // Plain "왜 이 와인이 좋아?" has a WH-cue but no explanation-action
    // verb → must NOT trigger knowledge_only (the agent should still try
    // to call search/recommendation tools).
    const c = classifyQueryBudget('왜 이 와인이 좋아?');
    expect(c?.classification).not.toBe('knowledge_only');
  });
});

describe('false-positive guards for off_domain (must NOT trigger on wine queries)', () => {
  const wineCases = [
    '보르도 레드 와인 추천',
    '오푸스원 가격',
    '카베르네 소비뇽 추천',
    'Cabernet from Napa',
  ];
  for (const query of wineCases) {
    it(`does NOT classify "${query}" as off_domain`, () => {
      const c = classifyQueryBudget(query);
      expect(c?.classification).not.toBe('off_domain');
    });
  }
});
