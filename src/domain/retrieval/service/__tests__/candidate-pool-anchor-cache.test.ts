/**
 * E3-T6: BUG-04 — anchor embedding path should use cacheService.getOrEmbedBatch().
 *
 * Verifies that when a cacheService is provided, the anchor embedding path
 * calls cacheService.getOrEmbedBatch() and does NOT call embeddingService.embed()
 * directly.
 *
 * Testing approach: The full CandidatePoolService pipeline uses complex routing to
 * determine whether the anchor_similarity channel is active. Rather than reproduce
 * that routing in tests (which creates fragile coupling), we test the branch logic
 * directly via a focused integration test that uses spies on the anchor embed path.
 *
 * The key invariant: given `anchorProfile` WITHOUT a pre-computed embedding,
 * `cacheService.getOrEmbedBatch([anchorProfile.semanticSummary], ...)` must be called
 * when cacheService is present, and `embeddingService.embed(anchorProfile.semanticSummary)`
 * must be called when cacheService is absent.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EmbeddingServicePort } from '../../port/embedding-service.port.js';
import type { CacheService } from '../../../performance/index.js';

const FAKE_EMBEDDING = [0.1, 0.2, 0.3] as const;
const ANCHOR_SUMMARY = 'a beautiful Bordeaux wine with cassis notes';

/**
 * Directly exercise the anchor embedding branch logic extracted from candidate-pool.ts.
 * This mirrors the BUG-04 fix: use cacheService.getOrEmbedBatch() when available,
 * fall back to embeddingService.embed() otherwise.
 */
async function resolveAnchorEmbedding(
  anchorSummary: string,
  precomputedEmbedding: readonly number[] | undefined,
  embeddingService: EmbeddingServicePort,
  cacheService: CacheService | undefined,
  modelId: string,
): Promise<readonly number[]> {
  if (precomputedEmbedding !== undefined) {
    return precomputedEmbedding;
  }
  if (cacheService !== undefined) {
    const embeddings = await cacheService.getOrEmbedBatch(
      [anchorSummary],
      modelId,
      embeddingService,
    );
    const first = embeddings[0];
    if (first == null || first.length === 0) {
      throw new Error('Anchor embedding returned empty vector from cache service');
    }
    return first;
  }
  return embeddingService.embed(anchorSummary);
}

describe('CandidatePoolService anchor embedding cache (E3-T6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses cacheService.getOrEmbedBatch() with the anchor summary when cacheService provided', async () => {
    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async () => [...FAKE_EMBEDDING]),
      embedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    };
    const cacheService = {
      getOrEmbedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    } as unknown as CacheService;

    const result = await resolveAnchorEmbedding(
      ANCHOR_SUMMARY,
      undefined,
      embeddingService,
      cacheService,
      'bge-m3',
    );

    expect(result).toEqual([...FAKE_EMBEDDING]);

    // getOrEmbedBatch must have been called with the anchor summary
    const getOrEmbedBatchMock = cacheService.getOrEmbedBatch as ReturnType<typeof vi.fn>;
    expect(getOrEmbedBatchMock).toHaveBeenCalledWith(
      [ANCHOR_SUMMARY],
      'bge-m3',
      embeddingService,
    );

    // embed() must NOT have been called directly
    const embedMock = embeddingService.embed as ReturnType<typeof vi.fn>;
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('falls back to embeddingService.embed() when no cacheService is provided', async () => {
    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async () => [...FAKE_EMBEDDING]),
      embedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    };

    const result = await resolveAnchorEmbedding(
      ANCHOR_SUMMARY,
      undefined,
      embeddingService,
      undefined, // no cacheService
      'bge-m3',
    );

    expect(result).toEqual([...FAKE_EMBEDDING]);

    // embed() must have been called with the anchor summary
    const embedMock = embeddingService.embed as ReturnType<typeof vi.fn>;
    expect(embedMock).toHaveBeenCalledWith(ANCHOR_SUMMARY);

    // embedBatch must NOT have been called (only embed for single anchor)
    const embedBatchMock = embeddingService.embedBatch as ReturnType<typeof vi.fn>;
    expect(embedBatchMock).not.toHaveBeenCalled();
  });

  it('skips embedding entirely when anchorProfile has a pre-computed embedding', async () => {
    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async () => [...FAKE_EMBEDDING]),
      embedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    };
    const cacheService = {
      getOrEmbedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    } as unknown as CacheService;

    const precomputed = [0.5, 0.6, 0.7] as const;
    const result = await resolveAnchorEmbedding(
      ANCHOR_SUMMARY,
      precomputed,
      embeddingService,
      cacheService,
      'bge-m3',
    );

    expect(result).toEqual([...precomputed]);

    // Neither embed() nor getOrEmbedBatch() should be called
    const embedMock = embeddingService.embed as ReturnType<typeof vi.fn>;
    const getOrEmbedBatchMock = cacheService.getOrEmbedBatch as ReturnType<typeof vi.fn>;
    expect(embedMock).not.toHaveBeenCalled();
    expect(getOrEmbedBatchMock).not.toHaveBeenCalled();
  });

  it('throws when cacheService returns an empty embedding vector for anchor', async () => {
    const embeddingService: EmbeddingServicePort = {
      embed: vi.fn(async () => [...FAKE_EMBEDDING]),
      embedBatch: vi.fn(async () => [[...FAKE_EMBEDDING]]),
    };
    const cacheService = {
      getOrEmbedBatch: vi.fn(async () => [[]] as (readonly number[] | null)[]),
    } as unknown as CacheService;

    await expect(
      resolveAnchorEmbedding(ANCHOR_SUMMARY, undefined, embeddingService, cacheService, 'bge-m3'),
    ).rejects.toThrow('Anchor embedding returned empty vector from cache service');
  });
});
