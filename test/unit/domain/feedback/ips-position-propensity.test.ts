/**
 * E5-T13: W6-P1-4 — IPS propensity constant extraction
 * Test first (TDD).
 */
import { describe, it, expect } from 'vitest';
import {
  IPS_POSITION_PROPENSITY,
  PositionBasedExaminationModel,
} from '../../../../src/domain/feedback/service/position-debias.js';

describe('E5-T13: IPS_POSITION_PROPENSITY constant', () => {
  it('has exactly 5 entries', () => {
    expect(IPS_POSITION_PROPENSITY).toHaveLength(5);
  });

  it('position 0 = 1.0 (full examination)', () => {
    expect(IPS_POSITION_PROPENSITY[0]).toBe(1.0);
  });

  it('position 1 = 0.6', () => {
    expect(IPS_POSITION_PROPENSITY[1]).toBe(0.6);
  });

  it('position 2 = 0.4', () => {
    expect(IPS_POSITION_PROPENSITY[2]).toBe(0.4);
  });

  it('position 3 = 0.3', () => {
    expect(IPS_POSITION_PROPENSITY[3]).toBe(0.3);
  });

  it('position 4 = 0.2 (decay to lowest explicit entry)', () => {
    expect(IPS_POSITION_PROPENSITY[4]).toBe(0.2);
  });

  it('propensities are strictly decreasing (position bias decay)', () => {
    for (let i = 1; i < IPS_POSITION_PROPENSITY.length; i++) {
      expect(IPS_POSITION_PROPENSITY[i]).toBeLessThan(IPS_POSITION_PROPENSITY[i - 1]!);
    }
  });

  it('PositionBasedExaminationModel uses IPS_POSITION_PROPENSITY values', () => {
    const model = new PositionBasedExaminationModel();
    for (let i = 0; i < IPS_POSITION_PROPENSITY.length; i++) {
      expect(model.examineProbability(i)).toBe(IPS_POSITION_PROPENSITY[i]);
    }
  });
});
