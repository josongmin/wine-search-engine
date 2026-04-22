/**
 * Regression tests for the agent system prompt contract.
 *
 * This keeps the mixed-color food-pairing rule pinned in the stable regression
 * lane so `get_food_pairings` does not drift back toward `color: both`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPlannerContinuationSystemMessage,
  buildSystemMessage,
  buildSynthesisSystemMessage,
} from '../../src/application/agent/agent-prompt.js';

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

  it('keeps generic mood wording out of the drinkability contract and routes gift intent through learned facets', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('ONLY treat these as drinkability checks when the query targets a specific wine or an explicit comparison pair');
    expect(prompt).toContain('Generic recommendation wording such as "우울할 때 마시기 좋은 와인", "힐링되는 와인", "선물하기 좋은 와인" is NOT a drinkability query');
    expect(prompt).toContain('Gift/non-expert/safe recommendation intent should preserve the original lexical anchor');
    expect(prompt).toContain('use structured occasion / gift_suitability_min / beginner_suitability_min fields');
    expect(prompt).toContain('Do NOT invent label aesthetics, packaging, or luxury prestige proxies');
    expect(prompt).not.toContain('"presentation_forward"');
  });

  it('documents the full typed tool surface for retrieval mode, orange wine, and legacy USD food budgets', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('search_wines(query, limit?, retrieval_mode?');
    expect(prompt).toContain('min_price_krw?');
    expect(prompt).toContain('max_alcohol_pct?');
    expect(prompt).toContain('occasion?');
    expect(prompt).toContain('gift_suitability_min?');
    expect(prompt).toContain('beginner_suitability_min?');
    expect(prompt).toContain('retrieval_mode: "auto" | "entity" | "hybrid" | "mixed"');
    expect(prompt).toContain('"fortified" | "dessert" | "orange" | "natural"');
    expect(prompt).toContain('get_food_pairings(food, max_price?, max_price_krw?, color?, sweetness_target?, acidity_min?, tannin_max?, styles?, pairing_tags?)');
    expect(prompt).toContain('max_price is legacy USD input; prefer max_price_krw for new calls');
  });

  it('documents structured occasion and learned suitability fields for gift/non-expert intent', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('occasion: OPTIONAL canonical situation tags');
    expect(prompt).toContain('gift_suitability_min: OPTIONAL [0,1] learned suitability floor');
    expect(prompt).toContain('beginner_suitability_min: OPTIONAL [0,1] learned suitability floor');
  });

  it('maps explicit sweetness and low-alcohol wording to structured search fields', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('If the user explicitly states sweetness, off-dry, or low-alcohol preferences');
    expect(prompt).toContain('map them to structured search fields (style:"sweet"/"off_dry", max_alcohol_pct)');
    expect(prompt).toContain('"도수 낮은" → 12');
  });

  it('documents structured price ranges and exact mixed-slot parallel search', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('"1-2만원 사이"→min_price_krw=10000 + max_price_krw=20000');
    expect(prompt).toContain('If those slots imply different wine types or colors');
    expect(prompt).toContain('emit PARALLEL search_wines actions — one typed call per slot');
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

  it('makes exact lookup negative observations override recommendation synthesis', () => {
    const synthesisPrompt = buildSynthesisSystemMessage().content;
    const continuationPrompt = buildPlannerContinuationSystemMessage().content;

    for (const prompt of [synthesisPrompt, continuationPrompt]) {
      expect(prompt).toContain('EXACT_LOOKUP_NEGATIVE');
      expect(prompt).toContain('do NOT present any');
      expect(prompt).toContain('never use the reference wine itself as the answer');
    }
  });

  it('keeps continuation answers on the same drinkability and pairing quality contract', () => {
    const prompt = buildPlannerContinuationSystemMessage().content;

    expect(prompt).toContain('For drinking-window answers: first answer yes/no');
    expect(prompt).toContain('cite the drinking-window years');
    expect(prompt).toContain('repeat BOTH the generic wine name and the resolved vintage');
    expect(prompt).toContain('For food-pairing answers');
    expect(prompt).toContain('only recommend wines with explicit pairing evidence');
    expect(prompt).toContain('If the latest observation is insufficient for an explicit pairing or drinkability answer');
  });
});
