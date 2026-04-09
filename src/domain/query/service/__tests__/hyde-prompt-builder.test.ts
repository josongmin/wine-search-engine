import { describe, it, expect } from 'vitest';
import { buildHyDEPrompt } from '../hyde-prompt-builder.js';
import { QUERY_INTENTS } from '../../model/query-intent.js';

describe('buildHyDEPrompt', () => {
  it('entity_exact returns wikipedia-style prompt', () => {
    const p = buildHyDEPrompt({ query: 'Sassicaia 2015', intent: 'entity_exact' });
    expect(p.skip).toBe(false);
    expect(p.user).toMatch(/Wikipedia-style/);
    expect(p.user).toContain('Sassicaia 2015');
    expect(p.system).toMatch(/sommelier/);
  });

  it('pairing_search prompt mentions "pairs"', () => {
    const p = buildHyDEPrompt({ query: 'grilled lamb', intent: 'pairing_search' });
    expect(p.skip).toBe(false);
    expect(p.user.toLowerCase()).toContain('pair');
    expect(p.user).toContain('grilled lamb');
  });

  it('all non-skip intents return non-empty user prompt', () => {
    for (const intent of QUERY_INTENTS) {
      const p = buildHyDEPrompt({ query: 'test query', intent });
      if (p.skip) continue;
      expect(p.user.length).toBeGreaterThan(0);
      expect(p.user).toContain('test query');
    }
  });

  it('skip=false for facet_search', () => {
    const p = buildHyDEPrompt({ query: 'Tuscan reds under 50', intent: 'facet_search' });
    expect(p.skip).toBe(false);
    expect(p.user).toContain('Tuscan reds under 50');
  });

  it('same query yields stable prompt', () => {
    const a = buildHyDEPrompt({ query: 'Barolo 2016', intent: 'entity_fuzzy' });
    const b = buildHyDEPrompt({ query: 'Barolo 2016', intent: 'entity_fuzzy' });
    expect(a).toEqual(b);
  });
});
