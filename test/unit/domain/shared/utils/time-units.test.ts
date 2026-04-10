/**
 * E5-T4: BUG-DS05 — SECONDS_PER_MINUTE duplication SSoT
 * Verifies time unit constants are correct.
 */
import { describe, it, expect } from 'vitest';
import {
  SECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
  HOURS_PER_DAY,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
} from '../../../../../src/domain/shared/utils/time-units.js';

describe('time-units SSoT', () => {
  it('SECONDS_PER_MINUTE = 60', () => {
    expect(SECONDS_PER_MINUTE).toBe(60);
  });

  it('MINUTES_PER_HOUR = 60', () => {
    expect(MINUTES_PER_HOUR).toBe(60);
  });

  it('HOURS_PER_DAY = 24', () => {
    expect(HOURS_PER_DAY).toBe(24);
  });

  it('MS_PER_SECOND = 1000', () => {
    expect(MS_PER_SECOND).toBe(1_000);
  });

  it('MS_PER_MINUTE = 60_000', () => {
    expect(MS_PER_MINUTE).toBe(60_000);
  });

  it('MS_PER_HOUR = 3_600_000', () => {
    expect(MS_PER_HOUR).toBe(3_600_000);
  });

  it('MS_PER_DAY = 86_400_000', () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
