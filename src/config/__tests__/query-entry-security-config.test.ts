import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env.js';

describe('query entry security config', () => {
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
    });

    expect(config.queryEntrySecurity.judgeFailureMode).toBe('fail_closed');
  });
});
