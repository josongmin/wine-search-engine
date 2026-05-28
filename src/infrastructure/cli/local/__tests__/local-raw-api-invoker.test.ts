import { describe, expect, it } from 'vitest';
import { LocalRawApiInvoker } from '../local-raw-api-invoker.js';
import { CliError } from '../../../../application/cli/command/cli-error.js';

describe('LocalRawApiInvoker', () => {
  it('rejects call() with CliError(usage) — local target cannot perform raw HTTP', async () => {
    const invoker = new LocalRawApiInvoker();

    await expect(
      invoker.call({ method: 'GET', path: '/health' }, { requestId: 'req-1' }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      invoker.call({ method: 'GET', path: '/health' }, { requestId: 'req-1' }),
    ).rejects.toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('Local api call is unsupported') as unknown as string,
    });
  });

  it('openApi() resolves with /openapi.json and a non-null document', async () => {
    const invoker = new LocalRawApiInvoker();

    const result = await invoker.openApi({ requestId: 'req-2' });

    expect(result.path).toBe('/openapi.json');
    expect(result.document).not.toBeNull();
    expect(typeof result.document).toBe('object');
  });
});
