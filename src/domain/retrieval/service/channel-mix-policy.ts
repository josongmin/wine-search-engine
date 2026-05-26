import type { RetrievalChannel } from '../model/retrieval-channel.js';
import type { QueryFamilyLabel } from '../../query/model/query-observability-vocab.js';
import {
  getLiveRetrievalProfileDefinition,
  resolveLiveQueryFamilyPolicy,
} from './live-retrieval-policy-registry.js';

export type QueryFamily = QueryFamilyLabel;

interface ChannelMixDecision {
  readonly profileName: string;
  readonly channelMix: readonly RetrievalChannel[];
  readonly reason: string;
}

export function resolveChannelMix(
  queryFamily: QueryFamily,
): ChannelMixDecision {
  const policy = resolveLiveQueryFamilyPolicy(queryFamily);
  const profile = getLiveRetrievalProfileDefinition(policy.profileName);
  return {
    profileName: policy.profileName,
    channelMix: profile.channelMix,
    reason: policy.reason,
  };
}
