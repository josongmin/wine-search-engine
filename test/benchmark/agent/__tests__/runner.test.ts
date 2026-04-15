import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../runner.js';

describe('withRetry', () => {
  it('executes once when maxRetries is zero', async () => {
    const fn = vi.fn(async () => 'ok');

    const result = await withRetry(fn, 0, () => true);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after the initial attempt up to maxRetries', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(
      fn,
      1,
      (err) => err instanceof Error && err.message === 'timeout',
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('normalizes undefined rejections into actionable errors', async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(undefined);

    await expect(withRetry(fn, 0, () => false)).rejects.toThrow(
      'undefined rejection',
    );
  });
});
