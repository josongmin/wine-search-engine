/**
 * Regression tests for the agent system prompt contract.
 *
 * This keeps the mixed-color food-pairing rule pinned in the stable regression
 * lane so `get_food_pairings` does not drift back toward `color: both`.
 */

import { describe, expect, it } from 'vitest';
import { buildSystemMessage } from '../../src/application/agent/agent-prompt.js';

describe('agent system prompt contract', () => {
  it('routes mixed red+white requests away from get_food_pairings', () => {
    const prompt = buildSystemMessage().content;

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

  it('forbids synthesizing an answer from invalid tool observations', () => {
    const prompt = buildSystemMessage().content;

    expect(prompt).toContain('If a tool result says "Invalid input for …"');
    expect(prompt).toContain('Do NOT answer from that failed observation');
    expect(prompt).toContain('Immediately issue a corrected tool call or switch to a different valid tool');
  });
});
