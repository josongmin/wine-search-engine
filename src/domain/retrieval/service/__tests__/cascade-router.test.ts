import { describe, it, expect } from 'vitest';
import { CascadeRouter } from '../cascade-router.js';

describe('CascadeRouter', () => {
  const router = new CascadeRouter();

  describe('estimateDifficulty', () => {
    it('short_entity with strong alias match → easy', () => {
      expect(router.estimateDifficulty('short_entity', 0.5, 0.95, 0)).toBe('easy');
    });

    it('anchored_similarity high confidence, few constraints → medium', () => {
      expect(router.estimateDifficulty('anchored_similarity', 0.9, 0.5, 1)).toBe('medium');
    });

    it('ambiguous_short_form → hard', () => {
      expect(router.estimateDifficulty('ambiguous_short_form', 0.5, 0.5, 0)).toBe('hard');
    });

    it('many constraints → hard', () => {
      expect(router.estimateDifficulty('pure_constraint', 0.5, 0.5, 5)).toBe('hard');
    });
  });

  describe('getPhases', () => {
    it('easy → sparse only', () => {
      expect(router.getPhases('easy')).toEqual(['sparse']);
    });

    it('medium → sparse + dense', () => {
      expect(router.getPhases('medium')).toEqual(['sparse', 'dense']);
    });

    it('hard → full pipeline', () => {
      expect(router.getPhases('hard')).toEqual(['sparse', 'dense', 'anchor_neighborhood']);
    });
  });

  describe('getDispatchDecision (T4.1)', () => {
    it('easy query → channels: [sparse_bm25]', () => {
      const decision = router.getDispatchDecision('short_entity', 0.5, 0.95, 0);
      expect(decision.difficulty).toBe('easy');
      expect(decision.channelsToActivate).toEqual(['sparse_bm25']);
      expect(decision.skippedPhases).toContain('dense');
      expect(decision.skippedPhases).toContain('anchor_neighborhood');
    });

    it('medium query → channels: [sparse_bm25, dense_semantic]', () => {
      const decision = router.getDispatchDecision('anchored_similarity', 0.9, 0.5, 1);
      expect(decision.channelsToActivate).toEqual(['sparse_bm25', 'dense_semantic']);
    });

    it('hard query → channels: [sparse_bm25, dense_semantic, anchor_similarity]', () => {
      const decision = router.getDispatchDecision('ambiguous_short_form', 0, 0, 0);
      expect(decision.channelsToActivate).toContain('sparse_bm25');
      expect(decision.channelsToActivate).toContain('dense_semantic');
      expect(decision.channelsToActivate).toContain('anchor_similarity');
      expect(decision.channelsToActivate).not.toContain(null);
    });

    it('skippedPhases does not include executed phases', () => {
      const decision = router.getDispatchDecision('short_entity', 0.5, 0.95, 0);
      expect(decision.skippedPhases).not.toContain('sparse');
    });
  });
});
