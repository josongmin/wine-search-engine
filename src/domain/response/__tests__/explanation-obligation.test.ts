import { describe, expect, it } from 'vitest';
import { getExplanationObligation } from '../service/explanation-obligation.js';

describe('getExplanationObligation', () => {
  it('falls back to the unknown obligation for out-of-vocabulary families', () => {
    expect(getExplanationObligation('totally_unknown_family')).toEqual(
      getExplanationObligation('unknown'),
    );
  });

  it('marks comparison as evidence-first without mandatory counterfactuals', () => {
    expect(getExplanationObligation('comparison')).toMatchObject({
      requiresEvidenceItems: true,
      requiresCounterfactual: false,
      requiresClarification: false,
    });
  });
});
