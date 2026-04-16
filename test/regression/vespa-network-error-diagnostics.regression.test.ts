import { afterEach, describe, expect, it, vi } from 'vitest';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';

describe('Vespa network error diagnostics regression (R-VESPA-NET-DETAIL-01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces nested transport cause fields in bulkFeed document failures', async () => {
    const socketCause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
      errno: 'ECONNRESET',
      syscall: 'read',
      address: '10.0.0.5',
      port: 443,
    });
    const fetchFailure = Object.assign(new TypeError('fetch failed'), {
      cause: socketCause,
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(fetchFailure);

    const client = new VespaClient('https://vespa.example.com', 'wine', 'wine_entity');

    const result = await client.bulkFeed([
      {
        id: 'wine-network-diagnostics-test',
        fields: { canonical_label: 'Network Diagnostics Test' },
      },
    ]);

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('doc[wine-network-diagnostics-test]:');
    expect(result.errors[0]).toContain('TypeError');
    expect(result.errors[0]).toContain('fetch failed');
    expect(result.errors[0]).toContain('code=ECONNRESET');
    expect(result.errors[0]).toContain('errno=ECONNRESET');
    expect(result.errors[0]).toContain('syscall=read');
    expect(result.errors[0]).toContain('address=10.0.0.5');
    expect(result.errors[0]).toContain('port=443');
  });
});
