import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env.js';

describe('query entry security config', () => {
  it('defaults the Layer 2 judge timeout to the provider transport timeout budget', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    expect(config.queryEntrySecurity.judgeTimeoutMs).toBe(config.openai.injectionHttpTimeoutMs);
  });

  it('allows an explicit Layer 2 judge timeout override', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      INJECTION_JUDGE_TIMEOUT_MS: '12000',
    });

    expect(config.queryEntrySecurity.judgeTimeoutMs).toBe(12_000);
  });

  it('defaults injection judge failures to fail_closed', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    expect(config.queryEntrySecurity.judgeFailureMode).toBe('fail_closed');
  });

  it('allows injection judge failures to be configured as fail_open', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      INJECTION_JUDGE_FAIL_OPEN: 'true',
    });

    expect(config.queryEntrySecurity.judgeFailureMode).toBe('fail_open');
  });

  it('keeps fail_closed as runtime default when flag is omitted', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      OPENAI_API_KEY: 'sk-test',
    });

    expect(config.queryEntrySecurity.judgeFailureMode).toBe('fail_closed');
  });

  it('selects OpenAI injection provider by default', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    expect(config.queryEntrySecurity.injectionProvider).toBe('openai');
  });

  it('allows Anthropic injection provider to be selected explicitly for legacy deployments', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LLM_INJECTION_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    expect(config.queryEntrySecurity.injectionProvider).toBe('anthropic');
  });
});
