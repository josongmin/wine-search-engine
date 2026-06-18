/**
 * Regression: noisy Korean exact entity recovery.
 *
 * Append-only — do NOT delete entries.
 * Guards the contract that noisy Korean variants for Château Margaux still
 * resolve to the canonical entity on the V2 lookup authority (via the resolve
 * delegate), instead of stopping at an ambiguous-but-top-1-correct state.
 */

import { describe, expect, it } from 'vitest';
import { executeResolveViaEntityLookupV2 } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2-resolve-mapping.js';
import { createTestContainer } from '../integration/helpers/test-container.js';

const CHATEAU_MARGAUX_ID = 'chateau-margaux-2015';
const OPUS_ONE_ID = 'opus-one-2018';

const NOISY_KOREAN_QUERIES = [
  '마고 샤또',
  '샤또 마고',
  '샤또마고1996',
] as const;

const NOISY_KOREAN_OPUS_QUERIES = [
  '오푸스원',
  '오퍼스 원',
  '오푸스ㅇ',
  '오퍼스ㅇ',
] as const;

describe('Noisy Korean exact entity recovery', () => {
  const parts = createTestContainer();

  it.each(NOISY_KOREAN_QUERIES)('resolves %s to chateau-margaux-2015', async (query) => {
    const result = await executeResolveViaEntityLookupV2(
      parts.container.entityLookupV2UseCase,
      { query },
    );

    expect(result.status).toBe('resolved');
    expect(result.topEntity?.entityId).toBe(CHATEAU_MARGAUX_ID);
    expect(result.candidates.map((candidate) => String(candidate.entityId))).toContain(
      CHATEAU_MARGAUX_ID,
    );
  });

  it.each(NOISY_KOREAN_OPUS_QUERIES)('resolves %s to opus-one-2018', async (query) => {
    const result = await executeResolveViaEntityLookupV2(
      parts.container.entityLookupV2UseCase,
      { query },
    );

    expect(result.status).toBe('resolved');
    expect(result.topEntity?.entityId).toBe(OPUS_ONE_ID);
    expect(result.candidates.map((candidate) => String(candidate.entityId))).toContain(
      OPUS_ONE_ID,
    );
  });
});
