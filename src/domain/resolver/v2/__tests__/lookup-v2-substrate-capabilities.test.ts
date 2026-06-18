import { describe, expect, it } from 'vitest';
import {
  buildLookupV2SubstrateCapabilitySnapshot,
  LOOKUP_V2_RESERVED_RECALL_CHANNELS,
  LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES,
  LOOKUP_V2_WIRED_RECALL_CHANNELS,
} from '../lookup-v2-substrate-capabilities.js';
import { LOOKUP_RETRIEVAL_CHANNELS } from '../lookup-v2-types.js';

describe('lookup-v2-substrate-capabilities (SSoT)', () => {
  it('mirrors declared retrieval channels and marks lookup LTR as unwired', () => {
    expect(LOOKUP_V2_WIRED_RECALL_CHANNELS).toEqual(LOOKUP_RETRIEVAL_CHANNELS);
    expect(LOOKUP_V2_RESERVED_RECALL_CHANNELS).toEqual(['dense']);
    expect(LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES.map((row) => row.id)).toEqual([
      'pg_alias_matcher_trigram',
      'lookup_ltr_rerank',
    ]);

    const snapshot = buildLookupV2SubstrateCapabilitySnapshot({
      ltrSupportStatus: 'unsupported',
      ltrSupportReason: 'lookup_domain_model_absent',
    });
    expect(snapshot.ltrSupportStatus).toBe('unsupported');
    expect(snapshot.wiredChannels).toContain('family_graph');
    expect(snapshot.wiredChannels).toContain('line_graph');
    expect(snapshot.wiredChannels).toContain('vintage_graph');
  });
});
