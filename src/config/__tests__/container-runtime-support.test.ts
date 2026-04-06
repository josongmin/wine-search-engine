import { describe, expect, it } from 'vitest';
import { buildRuntimeSupportServices } from '../container-runtime-support.js';
import { parseEnv } from '../env.js';

describe('buildRuntimeSupportServices', () => {
  it('propagates the configured judge failure mode and observer', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      INJECTION_JUDGE_FAIL_OPEN: 'true',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.judgeFailureMode).toBe('fail_open');
    expect(services.queryEntrySecurityObserver).toBeDefined();
  });

  it('defaults to fail_closed mode when unset', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.judgeFailureMode).toBe('fail_closed');
    expect(services.queryEntrySecurityObserver).toBeDefined();
  });
});
