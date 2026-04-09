import { describe, it, expect } from 'vitest';
import { resolveIntentAuthority } from '../intent-authority.js';

describe('resolveIntentAuthority', () => {
  it('rule_only mode ignores learned', () => {
    const r = resolveIntentAuthority({
      mode: 'rule_only',
      rulePrior: { intent: 'facet_search', confidence: 0.7 },
      learnedPrediction: { intent: 'semantic_discovery', confidence: 0.95 },
    });
    expect(r.intent).toBe('facet_search');
    expect(r.source).toBe('rule');
    expect(r.confidence).toBe(0.7);
  });

  it('learned_only without learned input falls back to rule', () => {
    const r = resolveIntentAuthority({
      mode: 'learned_only',
      rulePrior: { intent: 'entity_exact', confidence: 0.6 },
    });
    expect(r.intent).toBe('entity_exact');
    expect(r.source).toBe('rule');
  });

  it('hybrid_agree when both agree', () => {
    const r = resolveIntentAuthority({
      mode: 'hybrid',
      rulePrior: { intent: 'pairing_search', confidence: 0.7 },
      learnedPrediction: { intent: 'pairing_search', confidence: 0.82 },
    });
    expect(r.source).toBe('hybrid_agree');
    expect(r.intent).toBe('pairing_search');
    expect(r.confidence).toBe(0.82);
    expect(r.hedge.hedge).toBe(false);
  });

  it('hybrid uses learned when learned wins by margin', () => {
    const r = resolveIntentAuthority({
      mode: 'hybrid',
      rulePrior: { intent: 'facet_search', confidence: 0.55 },
      learnedPrediction: { intent: 'semantic_discovery', confidence: 0.8 },
    });
    expect(r.source).toBe('learned');
    expect(r.intent).toBe('semantic_discovery');
  });

  it('hybrid uses rule when rule wins by margin', () => {
    const r = resolveIntentAuthority({
      mode: 'hybrid',
      rulePrior: { intent: 'entity_exact', confidence: 0.9 },
      learnedPrediction: { intent: 'entity_fuzzy', confidence: 0.5 },
    });
    expect(r.source).toBe('rule');
    expect(r.intent).toBe('entity_exact');
  });

  it('hybrid hedges when neither dominates', () => {
    const r = resolveIntentAuthority({
      mode: 'hybrid',
      rulePrior: { intent: 'facet_search', confidence: 0.6 },
      learnedPrediction: { intent: 'semantic_discovery', confidence: 0.65 },
    });
    expect(r.source).toBe('hybrid_disagree_hedge');
    expect(r.hedge.hedge).toBe(true);
    expect(r.hedge.intents).toContain('facet_search');
    expect(r.hedge.intents).toContain('semantic_discovery');
  });
});
