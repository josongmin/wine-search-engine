import { describe, it, expect } from 'vitest';
import { pct, priceBand, ms, clamp } from '../format';

describe('pct', () => {
  it('converts 0-1 to percentage string', () => {
    expect(pct(0)).toBe('0%');
    expect(pct(0.5)).toBe('50%');
    expect(pct(1)).toBe('100%');
    expect(pct(0.923)).toBe('92%');
  });
});

describe('priceBand', () => {
  it('maps known bands to dollar signs', () => {
    expect(priceBand('budget')).toBe('$');
    expect(priceBand('value')).toBe('$$');
    expect(priceBand('mid')).toBe('$$$');
    expect(priceBand('premium')).toBe('$$$$');
    expect(priceBand('luxury')).toBe('$$$$$');
  });

  it('is case-insensitive', () => {
    expect(priceBand('PREMIUM')).toBe('$$$$');
  });

  it('returns dash for undefined', () => {
    expect(priceBand(undefined)).toBe('—');
  });

  it('returns raw value for unknown band', () => {
    expect(priceBand('ultra')).toBe('ultra');
  });
});

describe('ms', () => {
  it('formats sub-second as ms', () => {
    expect(ms(320)).toBe('320ms');
    expect(ms(0)).toBe('0ms');
  });

  it('formats seconds with decimals', () => {
    expect(ms(1500)).toBe('1.50s');
    expect(ms(2345)).toBe('2.35s');
  });
});

describe('clamp', () => {
  it('clamps within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
