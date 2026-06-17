/**
 * Entity Lookup V2 — recall substrate capability contract (SSoT).
 *
 * Documents which recall substrates are wired in the lookup lane vs reserved
 * for search/hybrid or future work. Prevents silent drift where ops assumes
 * PgAliasMatcher trigram or lookup LTR is active when it is not.
 */

import { LOOKUP_RETRIEVAL_CHANNELS } from './lookup-v2-types.js';

/** Channels the multi-channel engine can emit when substrates are wired. */
export const LOOKUP_V2_WIRED_RECALL_CHANNELS = LOOKUP_RETRIEVAL_CHANNELS;

/** Recall substrates intentionally NOT wired into lookup-v2 today. */
export const LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES = [
  {
    id: 'pg_alias_matcher_trigram',
    reason: 'PgAliasMatcher edit-distance/trigram lives in search/hybrid anchor extraction only',
  },
  {
    id: 'lookup_ltr_rerank',
    reason: 'lookup_domain_model_absent — no lookup-domain LTR model is published',
  },
] as const;

/** Channels declared in the contract but emitted only by explicit reuse paths. */
export const LOOKUP_V2_RESERVED_RECALL_CHANNELS = ['dense'] as const;

/** Ops coverage-health response bound for unwired substrate ids (catalog cubic slack). */
export const LOOKUP_V2_OPS_UNWIRED_SUBSTRATE_IDS_MAX =
  LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES.length
  * LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES.length
  * LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES.length;

export type LookupV2UnwiredRecallSubstrateId =
  (typeof LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES)[number]['id'];

export interface LookupV2SubstrateCapabilitySnapshot {
  readonly wiredChannels: readonly (typeof LOOKUP_V2_WIRED_RECALL_CHANNELS)[number][];
  readonly unwiredSubstrates: readonly (typeof LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES)[number][];
  readonly reservedChannels: readonly (typeof LOOKUP_V2_RESERVED_RECALL_CHANNELS)[number][];
  readonly ltrSupportStatus: 'unsupported';
  readonly ltrSupportReason: 'lookup_domain_model_absent';
}

export function buildLookupV2SubstrateCapabilitySnapshot(
  ltrSupport: Pick<LookupV2SubstrateCapabilitySnapshot, 'ltrSupportStatus' | 'ltrSupportReason'>,
): LookupV2SubstrateCapabilitySnapshot {
  return {
    wiredChannels: LOOKUP_V2_WIRED_RECALL_CHANNELS,
    unwiredSubstrates: LOOKUP_V2_UNWIRED_RECALL_SUBSTRATES,
    reservedChannels: LOOKUP_V2_RESERVED_RECALL_CHANNELS,
    ltrSupportStatus: ltrSupport.ltrSupportStatus,
    ltrSupportReason: ltrSupport.ltrSupportReason,
  };
}
