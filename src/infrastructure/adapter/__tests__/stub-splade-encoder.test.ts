import { describe, it, expect } from 'vitest';
import { StubSpladeEncoder } from '../stub-splade-encoder.js';

describe('StubSpladeEncoder', () => {
  const encoder = new StubSpladeEncoder();

  it('returns an empty array for an empty query (no I/O)', async () => {
    expect(await encoder.encode('')).toEqual([]);
    expect(await encoder.encode('   ')).toEqual([]);
  });

  it('encodes a single token into one (token, weight=1) pair', async () => {
    const out = await encoder.encode('bordeaux');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ token: 'bordeaux', weight: 1 });
  });

  it('encodes multiple tokens into N weight entries', async () => {
    const out = await encoder.encode('full-bodied bordeaux red 2018');
    // "full", "bodied", "bordeaux", "red", "2018" — five tokens, non-alphanumeric split.
    expect(out).toHaveLength(5);
    const tokens = out.map((w) => w.token).sort();
    expect(tokens).toEqual(['2018', 'bodied', 'bordeaux', 'full', 'red']);
    for (const w of out) {
      expect(w.weight).toBe(1);
      expect(Number.isFinite(w.weight)).toBe(true);
    }
  });

  it('normalizes tokens to lowercase', async () => {
    const out = await encoder.encode('BORDEAUX Merlot');
    const tokens = out.map((w) => w.token).sort();
    expect(tokens).toEqual(['bordeaux', 'merlot']);
  });
});
