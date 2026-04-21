/**
 * Regression: noisy Korean exact entity recovery.
 *
 * Append-only — do NOT delete entries.
 * Guards the contract that noisy Korean variants for Château Margaux still
 * resolve to the canonical entity on the exact-recovery path, instead of
 * stopping at an ambiguous-but-top-1-correct state.
 */

import { describe, expect, it } from 'vitest';
import { createTestContainer } from '../integration/helpers/test-container.js';

const CHATEAU_MARGAUX_ID = 'chateau-margaux-2015';

const NOISY_KOREAN_QUERIES = [
  '마고 샤또',
  '샤또 마고',
  '샤또마고1996',
] as const;

describe('Noisy Korean exact entity recovery', () => {
  const parts = createTestContainer();

  it.each(NOISY_KOREAN_QUERIES)('resolves %s to chateau-margaux-2015', async (query) => {
    const result = await parts.container.resolveUseCase.execute({ query });

    expect(result.status).toBe('resolved');
    expect(result.topEntity?.entityId).toBe(CHATEAU_MARGAUX_ID);
    expect(result.candidates.map((candidate) => String(candidate.entityId))).toContain(
      CHATEAU_MARGAUX_ID,
    );
  });
});
