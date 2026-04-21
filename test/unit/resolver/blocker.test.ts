import { beforeEach, describe, expect, it } from 'vitest';
import { Blocker } from '../../../src/domain/resolver/service/blocker.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import { globalSilentSkipCounter } from '../../../src/observability/silent-skip-counters.js';

describe('Blocker observability', () => {
  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  it('increments the zero-candidate counter when blocking returns no candidates', async () => {
    const blocker = new Blocker({
      block: async () => [],
    } satisfies BlockingPort);

    await blocker.block('unknown wine', 'unknown wine');

    expect(globalSilentSkipCounter.snapshot().blocker_zero_candidates).toBe(1);
  });
});
