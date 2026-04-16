/**
 * Regression tests for the agent system prompt contract.
 *
 * This keeps the mixed-color food-pairing rule pinned in the stable regression
 * lane so `get_food_pairings` does not drift back toward `color: both`.
 */

import { describe, expect, it } from 'vitest';
import { buildSystemMessage, buildSynthesisSystemMessage } from '../../src/application/agent/agent-prompt.js';

describe('agent system prompt contract', () => {
  it('routes mixed red+white requests away from get_food_pairings', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('You are Cuvee StepPlanner');
    expect(prompt).toContain('Mixed-type requests (red+white, "both colors") are NOT food pairing inputs');
    expect(prompt).toContain('Never use both, mixed, any, or a multi-color shorthand');
    expect(prompt).toContain('Use search_wines with want_diversity=true or parallel search_wines calls instead');
  });

  it('forces bare-entity search queries for exact wine metadata questions', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('For exact wine info questions (price, drinkability, release/availability)');
    expect(prompt).toContain('search_wines.query must be ONLY the wine/entity name');
    expect(prompt).toContain('Never append helper words like "price", "drinkability", "가격 확인", or "출시 여부"');
  });

  it('keeps generic mood wording out of the drinkability contract and preserves semantic style hints', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('ONLY treat these as drinkability checks when the query targets a specific wine or an explicit comparison pair');
    expect(prompt).toContain('Generic recommendation wording such as "우울할 때 마시기 좋은 와인", "힐링되는 와인", "선물하기 좋은 와인" is NOT a drinkability query');
    expect(prompt).toContain('"chillable", "screw_cap", "approachable", "crowd_pleasing"');
  });

  it('documents the full typed tool surface for retrieval mode, orange wine, and legacy USD food budgets', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('search_wines(query, limit?, retrieval_mode?');
    expect(prompt).toContain('retrieval_mode: "auto" | "entity" | "hybrid" | "mixed"');
    expect(prompt).toContain('"fortified" | "dessert" | "orange" | "natural"');
    expect(prompt).toContain('get_food_pairings(food, max_price?, max_price_krw?, color?)');
    expect(prompt).toContain('max_price is legacy USD input; prefer max_price_krw for new calls');
  });

  it('preserves Korean search query anchors instead of translating them into English paraphrases', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('query must preserve the user\'s original language and lexical anchor');
    expect(prompt).toContain('If the user asked in Korean, keep search_wines.query in Korean');
    expect(prompt).toContain('Do NOT rewrite "와인 잘 모르는 사람한테 선물할 거" into English paraphrases');
  });

  it('forbids synthesizing an answer from invalid tool observations', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('If a tool result says "Invalid input for …"');
    expect(prompt).toContain('Do NOT answer from that failed observation');
    expect(prompt).toContain('Immediately issue a corrected tool call or switch to a different valid tool');
  });

  it('keeps the synthesis prompt tool-free and observation-only', () => {
    const prompt = buildSynthesisSystemMessage().content;

    expect(prompt).toContain('You are Cuvee StepSynthesis');
    expect(prompt).toContain('Do NOT call tools');
    expect(prompt).toContain('Do NOT output "action" or "actions"');
    expect(prompt).toContain('Do NOT decide new tool work; that belongs to the planner phase');
  });
});
