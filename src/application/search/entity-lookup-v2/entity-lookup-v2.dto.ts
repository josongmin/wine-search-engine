/**
 * Entity Lookup V2 — application-level command + result DTOs.
 *
 * Dedicated to the `/v2/entity-lookup` surface (T-ELV2-01). These are camelCase
 * domain-facing shapes; the HTTP layer snake-cases them on the way out and
 * validates against `EntityLookupV2ResponseSchema`.
 */

import type { LookupRetrievalChannel, LookupV2Status } from '../../../domain/resolver/v2/lookup-v2-types.js';

/** Dedicated entry command for the V2 lookup use case. */
export interface EntityLookupV2Command {
  readonly query: string;
  readonly locale?: string | undefined;
  readonly maxCandidates: number;
  readonly mode: 'default' | 'diagnostic';
  readonly requestId?: string | undefined;
}

export interface NormalizedQueryViewsView {
  readonly raw: string;
  readonly strict: string;
  readonly accentless: string;
  readonly compact: string;
  readonly vintageCanonicalized: string;
  readonly vintageStripped: string;
  readonly transliterated?: string | undefined;
  readonly phoneticCompact?: string | undefined;
  readonly lookupVariants: readonly string[];
}

export interface LookupV2ChannelHitView {
  readonly channel: LookupRetrievalChannel;
  readonly matchedView: string;
  readonly matchedAlias?: string | undefined;
  readonly channelScore: number;
  readonly channelRank: number;
}

export interface LookupV2CandidateView {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly entityType?: string | undefined;
  readonly calibratedScore: number;
  readonly rank: number;
  readonly channelAgreement: number;
  readonly channelHits: readonly LookupV2ChannelHitView[];
}

export interface LookupV2ClarificationOptionView {
  readonly entityId: string;
  readonly label: string;
  readonly distinguishingFeature?: string | undefined;
}

export interface LookupV2ChannelCoverageView {
  readonly channel: LookupRetrievalChannel;
  readonly firing: boolean;
  readonly hitCount: number;
  readonly latencyMs: number;
}

export interface LookupV2EvidenceSummaryView {
  readonly admissionReasonCode: string;
  readonly decisionReasonCode: string;
  readonly topConfidence?: number | undefined;
  readonly top1Top2Margin?: number | undefined;
  readonly calibrationTrusted: boolean;
  readonly queryClass: string;
  readonly candidatePoolSize: number;
  readonly channelCoverage: readonly LookupV2ChannelCoverageView[];
}

export interface EntityLookupV2Result {
  readonly status: LookupV2Status;
  readonly decisionReason: string;
  readonly normalizedQueryViews: NormalizedQueryViewsView;
  readonly candidates: readonly LookupV2CandidateView[];
  readonly topCandidate: LookupV2CandidateView | null;
  readonly clarificationOptions: readonly LookupV2ClarificationOptionView[];
  readonly evidenceSummary: LookupV2EvidenceSummaryView;
  readonly meta: {
    readonly requestId?: string | undefined;
    readonly queryTimeMs: number;
    readonly version: string;
    readonly engineSchemaVersion: 'entity_lookup_v2';
  };
}
