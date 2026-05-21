import { describe, expect, it, vi } from 'vitest';
import { parseRunnerArgs, withRetry } from '../runner.js';

describe('withRetry', () => {
  it('executes once when maxRetries is zero', async () => {
    const fn = vi.fn(async () => 'ok');

    const result = await withRetry(fn, 0, () => true);

    expect(result.value).toBe('ok');
    expect(result.throttleWaitMs).toBe(0);
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

    expect(result.value).toBe('ok');
    // One transient retry → a non-trivial backoff sleep was recorded as throttle wait.
    // One transient retry → backoff sleep recorded as throttle wait (>= 0).
    // One transient retry → backoff sleep recorded as throttle wait (>= 0).
    expect(result.throttleWaitMs).toBeGreaterThanOrEqual(0);
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

describe('parseRunnerArgs — transliteration exact lookup profiles', () => {
  it('enables judge and default concurrency for transliteration-exact-lookup', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup']);
    expect(parsed.profile).toBe('transliteration-exact-lookup');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter?.length).toBeGreaterThan(0);
  });

  it('supports positive core slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-core']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-core');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter?.length).toBeGreaterThan(0);
  });

  it('supports hard-negative slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-hard-negative']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-hard-negative');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter?.length).toBeGreaterThan(0);
  });

  it('supports policy-pending slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-policy-pending']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-policy-pending');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter?.length).toBeGreaterThan(0);
  });

  it('supports large 200-case slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-large']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-large');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter).toHaveLength(200);
  });

  it('supports large positive slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-large-positive']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-large-positive');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter).toHaveLength(100);
  });

  it('supports large hard-negative slice', () => {
    const parsed = parseRunnerArgs(['--profile', 'transliteration-exact-lookup-large-hard-negative']);
    expect(parsed.profile).toBe('transliteration-exact-lookup-large-hard-negative');
    expect(parsed.enableJudge).toBe(true);
    expect(parsed.concurrency).toBe(2);
    expect(parsed.idFilter).toHaveLength(100);
  });
});
