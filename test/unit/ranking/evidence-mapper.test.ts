import { describe, it, expect } from 'vitest';
import { EvidenceMapper } from '../../../src/domain/ranking/service/evidence-mapper.js';
import type { ComponentScores } from '../../../src/domain/ranking/model/ranked-result.js';

const mapper = new EvidenceMapper();

function makeScores(overrides?: Partial<ComponentScores>): ComponentScores {
  return {
    entityIntegrity: 0,
    semantic: 0,
    hardConstraintPass: true,
    softConstraint: 0,
    attributeAlignment: 0,
    preferenceAlignment: 0,
    popularity: 0,
    availability: 0,
    uncertaintyPenalty: 0,
    ...overrides,
  };
}

describe('EvidenceMapper', () => {
  describe('non-zero component → EvidenceItem created', () => {
    it('non-zero entityIntegrity creates an evidence item', () => {
      const scores = makeScores({ entityIntegrity: 0.8 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item).toBeDefined();
    });

    it('non-zero semantic score creates semantic_relevance evidence item', () => {
      const scores = makeScores({ semantic: 0.6, entityIntegrity: 0.5 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'semantic_relevance');
      expect(item).toBeDefined();
    });
  });

  describe('zero component → no EvidenceItem (except hard_constraint_pass)', () => {
    it('zero entityIntegrity → no entity_integrity evidence item', () => {
      const scores = makeScores({ entityIntegrity: 0 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item).toBeUndefined();
    });

    it('zero popularity → no popularity evidence item', () => {
      const scores = makeScores({ popularity: 0, entityIntegrity: 0.5 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'popularity');
      expect(item).toBeUndefined();
    });

    it('hard_constraint_pass is always included regardless of value', () => {
      const scoresPass = makeScores({ hardConstraintPass: true });
      const scoresFail = makeScores({ hardConstraintPass: false });

      const passItems = mapper.mapToEvidence(scoresPass);
      const failItems = mapper.mapToEvidence(scoresFail);

      expect(passItems.find((i) => i.type === 'hard_constraint_pass')).toBeDefined();
      expect(failItems.find((i) => i.type === 'hard_constraint_pass')).toBeDefined();
    });
  });

  describe('contribution string format', () => {
    it('positive contribution formatted as "+0.42"', () => {
      const scores = makeScores({ entityIntegrity: 0.42 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item!.contribution).toBe('+0.42');
    });

    it('negative contribution formatted as "-0.10" for uncertainty penalty', () => {
      const scores = makeScores({ entityIntegrity: 0.5, uncertaintyPenalty: 0.10 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'uncertainty_penalty');
      expect(item).toBeDefined();
      expect(item!.contribution).toBe('-0.10');
    });

    it('contribution is formatted to 2 decimal places', () => {
      const scores = makeScores({ entityIntegrity: 0.123456789 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item!.contribution).toBe('+0.12'); // rounded to 2dp via toFixed(2)
    });

    it('contribution string contains sign (+/-)', () => {
      const scores = makeScores({ semantic: 0.5, entityIntegrity: 0.5 });
      const items = mapper.mapToEvidence(scores);
      for (const item of items) {
        if (item.contribution !== '+pass' && item.contribution !== '-fail') {
          expect(item.contribution).toMatch(/^[+-]/);
        }
      }
    });
  });

  describe('strength classification', () => {
    it('contribution >= 0.3 → strength = high', () => {
      const scores = makeScores({ entityIntegrity: 0.5 }); // abs = 0.5 >= 0.3
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item!.strength).toBe('high');
    });

    it('contribution 0.1-0.3 → strength = medium', () => {
      const scores = makeScores({ entityIntegrity: 0.2 }); // abs = 0.2, 0.1 <= 0.2 < 0.3
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item!.strength).toBe('medium');
    });

    it('contribution < 0.1 → strength = low', () => {
      const scores = makeScores({ entityIntegrity: 0.05 }); // abs = 0.05 < 0.1
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'entity_integrity');
      expect(item!.strength).toBe('low');
    });

    it('uncertainty penalty also classified by strength', () => {
      const scores = makeScores({ entityIntegrity: 0.5, uncertaintyPenalty: 0.5 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'uncertainty_penalty');
      expect(item!.strength).toBe('high');
    });
  });

  describe('provenance text', () => {
    it('provenance text does not contain exact "%" symbol', () => {
      const scores = makeScores({
        entityIntegrity: 0.5,
        semantic: 0.3,
        softConstraint: 0.2,
        attributeAlignment: 0.4,
        popularity: 0.1,
        availability: 0.2,
      });
      const items = mapper.mapToEvidence(scores);
      for (const item of items) {
        expect(item.provenance).not.toContain('%');
      }
    });
  });

  describe('uncertainty penalty inclusion', () => {
    it('uncertaintyPenalty=0 → no uncertainty_penalty evidence item', () => {
      const scores = makeScores({ entityIntegrity: 0.5, uncertaintyPenalty: 0 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'uncertainty_penalty');
      expect(item).toBeUndefined();
    });

    it('uncertaintyPenalty > 0 → uncertainty_penalty evidence item included', () => {
      const scores = makeScores({ entityIntegrity: 0.5, uncertaintyPenalty: 0.2 });
      const items = mapper.mapToEvidence(scores);
      const item = items.find((i) => i.type === 'uncertainty_penalty');
      expect(item).toBeDefined();
    });
  });
});
