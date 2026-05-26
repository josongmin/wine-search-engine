import { describe, expect, it } from 'vitest';
import { hashStableJson } from '../../src/domain/shared/utils/stable-json.js';
import {
  LIVE_FUSION_CONFIGS,
  LIVE_QUERY_FAMILY_POLICY,
  LIVE_RETRIEVAL_POLICY_CONFIG_HASH,
  LIVE_RETRIEVAL_POLICY_VERSION,
  LIVE_RETRIEVAL_PROFILE_DEFINITIONS,
} from '../../src/domain/retrieval/service/live-retrieval-policy-registry.js';
import { QUERY_FAMILY_LABELS } from '../../src/domain/query/model/query-observability-vocab.js';

describe('live retrieval policy version lock', () => {
  it('requires a config-hash update when live policy tables change', () => {
    expect(hashStableJson({
      LIVE_FUSION_CONFIGS,
      LIVE_RETRIEVAL_PROFILE_DEFINITIONS,
      LIVE_QUERY_FAMILY_POLICY,
    })).toBe(LIVE_RETRIEVAL_POLICY_CONFIG_HASH);
  });

  it('embeds the current config hash prefix in the version string', () => {
    expect(LIVE_RETRIEVAL_POLICY_VERSION).toContain(LIVE_RETRIEVAL_POLICY_CONFIG_HASH.slice(0, 8));
  });

  it('covers every declared query family with a live retrieval policy entry', () => {
    for (const family of QUERY_FAMILY_LABELS) {
      expect(LIVE_QUERY_FAMILY_POLICY[family], family).toBeDefined();
      const profileName = LIVE_QUERY_FAMILY_POLICY[family].profileName;
      expect(LIVE_RETRIEVAL_PROFILE_DEFINITIONS[profileName], `${family}:${profileName}`).toBeDefined();
    }
  });
});
