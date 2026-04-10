/**
 * E2-T1: conformal-config SSoT module tests.
 */

import { describe, it, expect } from 'vitest';
import { CONFORMAL_ALPHA, CONFORMAL_COVERAGE_TARGET } from '../conformal-config.js';

describe('conformal-config SSoT (E2-T1)', () => {
  it('CONFORMAL_ALPHA is 0.3 (70% coverage target)', () => {
    expect(CONFORMAL_ALPHA).toBe(0.3);
  });

  it('CONFORMAL_COVERAGE_TARGET is 1 - CONFORMAL_ALPHA', () => {
    expect(CONFORMAL_COVERAGE_TARGET).toBeCloseTo(1 - CONFORMAL_ALPHA, 10);
  });

  it('CONFORMAL_COVERAGE_TARGET is 0.7', () => {
    expect(CONFORMAL_COVERAGE_TARGET).toBe(0.7);
  });
});
