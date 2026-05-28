import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  assertEmbeddingIsolatedPorts,
  buildEmbeddingIsolatedRuntimeSpecs,
  buildIsolatedEmbeddingRunnerArgs,
  resolveIsolatedRuntimePorts,
} from '../../../scripts/eval/run-offline-eval-embedding-sensitive-isolated.js';

describe('embedding-sensitive isolated runner', () => {
  it('fails closed when dense-on and dense-off share the same port', () => {
    expect(() =>
      assertEmbeddingIsolatedPorts({
        denseOnPort: 3006,
        denseOffPort: 3006,
      }),
    ).toThrow(/distinct ports/);
  });

  it('builds isolated runtime specs that disable injection judge noise and multi-query fanout', () => {
    const [denseOn, denseOff] = buildEmbeddingIsolatedRuntimeSpecs({
      denseOnPort: 3006,
      denseOffPort: 3007,
    });

    expect(denseOn?.name).toBe('dense_on');
    expect(denseOn?.apiUrl).toBe('http://127.0.0.1:3006');
    expect(denseOn?.env).toMatchObject({
      PORT: '3006',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
      WINE_SEARCH_MULTI_QUERY_ENABLED: 'false',
    });
    expect(denseOn?.env['KILL_SWITCH_DENSE_RETRIEVAL']).toBeUndefined();

    expect(denseOff?.name).toBe('dense_off');
    expect(denseOff?.apiUrl).toBe('http://127.0.0.1:3007');
    expect(denseOff?.env).toMatchObject({
      PORT: '3007',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
      WINE_SEARCH_MULTI_QUERY_ENABLED: 'false',
      KILL_SWITCH_DENSE_RETRIEVAL: 'true',
    });
  });

  it('builds downstream runner args with distinct dense-on and dense-off urls', () => {
    const args = buildIsolatedEmbeddingRunnerArgs({
      forwardedRunnerArgs: ['--fixture-corpus', 'gate', '--output', '/tmp/out.json'],
      denseOnApiUrl: 'http://127.0.0.1:3006',
      denseOffApiUrl: 'http://127.0.0.1:3007',
    });

    expect(args).toContain('--compare-dense-off');
    expect(args).toContain('--api-url');
    expect(args).toContain('http://127.0.0.1:3006');
    expect(args).toContain('--dense-off-api-url');
    expect(args).toContain('http://127.0.0.1:3007');
    expect(args.slice(-4)).toEqual(['--fixture-corpus', 'gate', '--output', '/tmp/out.json']);
  });

  it('fails closed when an explicit isolated runtime port is already occupied', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to allocate occupied test port');
    }

    try {
      await expect(
        resolveIsolatedRuntimePorts({
          denseOnPort: address.port,
          denseOffPort: address.port + 1,
          startupTimeoutMs: 1_000,
          pollIntervalMs: 100,
          forwardedRunnerArgs: [],
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
