import { describe, expect, it } from 'vitest';
import { buildBundleFromAtoms } from '../constraint-reasoner.js';
import type { ConstraintAtom } from '../../../shared/types/constraint-atom.js';

describe('buildBundleFromAtoms', () => {
  it('preserves soft_promotion_authority when rebuilding a bundle from atoms', () => {
    const atoms: readonly ConstraintAtom[] = [{
      attribute: 'acidity',
      operator: '>=',
      value: 0.6,
      source_phrase: '상큼/산미',
      confidence: 0.8,
      soft_promotion_authority: 'allow',
      mapping_version: 'rule-based-v1.0',
      source_tier: 'soft',
      source_kind: 'explicit_utterance',
      authority_level: 100,
      semantic_scope: 'intrinsic',
      conflict_policy: 'prefer',
      constraint_role: 'prefer',
    }];

    const bundle = buildBundleFromAtoms(atoms);

    expect(bundle.soft).toHaveLength(1);
    expect(bundle.soft[0]?.soft_promotion_authority).toBe('allow');
  });
});
