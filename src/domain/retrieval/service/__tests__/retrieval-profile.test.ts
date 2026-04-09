import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetrievalProfileService } from '../retrieval-profile.js';
import { resolveChannelMix } from '../channel-mix-policy.js';
import { QUERY_FAMILY_LABELS } from '../../../query/model/query-observability-vocab.js';
import { bootstrapLogger } from '../../../../config/bootstrap-logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RetrievalProfileService (T4.1)', () => {
  const service = new RetrievalProfileService();

  it('hybrid_default profile has sparse_bm25 + dense_semantic channels', () => {
    const profile = service.getProfile('pure_constraint', 'hybrid');
    expect(profile.name).toBe('hybrid_default');
    expect(profile.channelMix).toContain('sparse_bm25');
    expect(profile.channelMix).toContain('dense_semantic');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });

  it('mixed route → mixed_anchor profile with anchor_similarity channel', () => {
    const profile = service.getProfile('anchored_similarity', 'mixed');
    expect(profile.name).toBe('mixed_anchor');
    expect(profile.channelMix).toContain('anchor_similarity');
  });

  it('short_entity → exact_safe_fallback profile', () => {
    const profile = service.getProfile('short_entity', 'hybrid');
    expect(profile.name).toBe('exact_safe_fallback');
    expect(profile.sparseWeight).toBeGreaterThan(profile.denseWeight);
  });

  it('producer_browse mode → browse_default profile', () => {
    const profile = service.getProfile('pure_constraint', 'hybrid', 'producer_browse');
    expect(profile.name).toBe('browse_default');
    expect(profile.channelMix).toContain('browse_producer');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });

  it('region_browse mode → region_browse profile', () => {
    const profile = service.getProfile('pure_constraint', 'hybrid', 'region_browse');
    expect(profile.name).toBe('region_browse');
    expect(profile.channelMix).toContain('browse_region');
    expect(profile.channelMix).not.toContain('anchor_similarity');
  });

  it('compare_candidates mode → compare_default profile with compare_anchor channel', () => {
    const profile = service.getProfile('comparison_query', 'hybrid', 'compare_candidates');
    expect(profile.name).toBe('compare_default');
    expect(profile.channelMix).toContain('compare_anchor');
  });

  it('getChannelMix returns correct channels for profile', () => {
    const channels = service.getChannelMix('anchored_similarity', 'mixed');
    expect(channels).toContain('anchor_similarity');
    expect(channels).toContain('dense_semantic');
  });

  it('relative mode → relative_filter profile with sparse_bm25 channel', () => {
    const profile = service.getProfile('pure_constraint', 'hybrid', 'relative');
    expect(profile.name).toBe('relative_filter');
    expect(profile.channelMix).toContain('sparse_bm25');
    expect(profile.channelMix).toContain('relative_filter');
    expect(profile.channelMix).not.toContain('dense_semantic');
    expect(profile.denseWeight).toBe(0);
    expect(profile.sparseWeight).toBe(1.0);
  });

  it.each([
    ['entity_lookup', 'exact_safe_fallback'],
    ['entity_resolution', 'exact_safe_fallback'],
    ['attribute_search', 'hybrid_default'],
    ['constraint_filter', 'hybrid_default'],
    ['similar_items', 'mixed_anchor'],
    ['no_match_detection', 'hybrid_default'],
    ['semantic_hybrid', 'hybrid_default'],
    ['hybrid_search', 'hybrid_default'],
  ] as const)('does not warn for canonical retrieval mode %s', (mode, expectedProfile) => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => bootstrapLogger);

    const profile = service.getProfile('pure_constraint', 'hybrid', mode);

    expect(profile.name).toBe(expectedProfile);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns for truly unknown retrieval modes only', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => bootstrapLogger);

    const profile = service.getProfile('pure_constraint', 'hybrid', 'totally_unknown_mode');

    expect(profile.name).toBe('hybrid_default');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('resolveChannelMix (T4.6)', () => {
  it('covers every QUERY_FAMILY_LABELS entry without throwing', () => {
    for (const family of QUERY_FAMILY_LABELS) {
      const decision = resolveChannelMix(family);
      expect(decision.profileName).toBeTruthy();
      expect(decision.channelMix.length).toBeGreaterThan(0);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it('comparison family → compare_default profile with compare_anchor channel', () => {
    const decision = resolveChannelMix('comparison');
    expect(decision.profileName).toBe('compare_default');
    expect(decision.channelMix).toContain('compare_anchor');
  });

  it('recommendation family → mixed_anchor profile', () => {
    const decision = resolveChannelMix('recommendation');
    expect(decision.profileName).toBe('mixed_anchor');
    expect(decision.channelMix).toContain('anchor_similarity');
  });

  it('entity_exact family → exact_safe_fallback profile', () => {
    const decision = resolveChannelMix('entity_exact');
    expect(decision.profileName).toBe('exact_safe_fallback');
  });

  it('producer_browse family → browse_default profile', () => {
    const decision = resolveChannelMix('producer_browse');
    expect(decision.profileName).toBe('browse_default');
  });

  it('no_match, ambiguous, unknown families → hybrid_default profile', () => {
    for (const family of ['no_match', 'ambiguous', 'unknown'] as const) {
      const decision = resolveChannelMix(family);
      expect(decision.profileName).toBe('hybrid_default');
    }
  });

  it('T4.6 getProfile with queryFamily falls through to hybrid_default for unknown', () => {
    const service = new RetrievalProfileService();
    const profile = service.getProfile('pure_constraint', 'hybrid', undefined, 'unknown');
    expect(profile.name).toBe('hybrid_default');
  });

  it('T4.6 getProfile with queryFamily uses family policy over route heuristics', () => {
    const service = new RetrievalProfileService();
    const profile = service.getProfile('anchored_similarity', 'mixed', undefined, 'entity_exact');
    expect(profile.name).toBe('exact_safe_fallback');
  });
});
