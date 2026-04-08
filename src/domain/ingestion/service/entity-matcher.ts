/**
 * Entity matching service (RFC-002 §7).
 *
 * Matches a {@link CanonicalizationCandidate} against existing canonical
 * entities using a strict rule-based cascade. Embedding-only merge is
 * explicitly FORBIDDEN per §7.0.
 *
 * Matching order:
 * 1. Exact identity hints (external refs)
 * 2. Producer + Label + Vintage
 * 3. Producer + Label
 * 4. Label + Region
 * 5. Unresolved → new_entity_candidate
 */

import type { EntityId } from '../../shared/types/index.js';
import type { CanonicalizationCandidate } from '../model/canonicalization-candidate.js';
import type { EntityMatchResult } from '../model/entity-match-result.js';
import type { SourceTrustProfile } from '../model/source-trust-profile.js';

/** Blend weight for base resolver confidence in trust-adjusted score. */
const TRUST_BLEND_BASE_WEIGHT = 0.7;
/** Blend weight for averaged source-trust fields. */
const TRUST_BLEND_TRUST_WEIGHT = 0.3;

/**
 * Minimal read-only view of an entity used for matching.
 * This avoids a hard dependency on the entity domain's full model.
 */
export interface MatchableEntity {
  readonly entityId: EntityId;
  readonly canonicalName: string;
  readonly producer?: string | undefined;
  readonly label?: string | undefined;
  readonly vintage?: number | undefined;
  readonly region?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly externalRefs?: ReadonlyMap<string, string> | undefined;
}

/**
 * Repository port for entity lookups required by the matcher.
 */
export interface EntityRepository {
  /** Find entities by external reference (e.g. LWIN). */
  findByExternalRef(type: string, value: string): Promise<readonly MatchableEntity[]>;
  /** Find entities by producer and label (case-insensitive). */
  findByProducerAndLabel(producer: string, label: string): Promise<readonly MatchableEntity[]>;
  /** Find entities by label and region (case-insensitive). */
  findByLabelAndRegion(label: string, region: string): Promise<readonly MatchableEntity[]>;
  /** Find entities whose aliases include the given text (case-insensitive). */
  findByAlias(alias: string): Promise<readonly MatchableEntity[]>;
}

/** Confidence thresholds for match decisions. */
const EXACT_REF_CONFIDENCE = 0.95;
const PRODUCER_LABEL_VINTAGE_CONFIDENCE = 0.90;
const PRODUCER_LABEL_CONFIDENCE = 0.75;
const LABEL_REGION_CONFIDENCE = 0.60;
const AMBIGUITY_THRESHOLD = 0.50;

/**
 * Matches canonicalization candidates against existing entities.
 *
 * Embedding-only merge is FORBIDDEN (RFC-002 §7.0). All matches require
 * at least one structural signal (producer, label, vintage, region, or
 * external reference).
 */
export class EntityMatcher {
  constructor(private readonly entityRepo: EntityRepository) {}

  /**
   * Attempts to match a candidate against existing entities.
   *
   * @param candidate - The canonicalization candidate to match.
   * @param trustProfile - Trust calibration for the source system.
   * @returns The match result with status, matched IDs, confidence, and reasons.
   */
  async match(
    candidate: CanonicalizationCandidate,
    trustProfile: SourceTrustProfile,
  ): Promise<EntityMatchResult> {
    // Step 1: Exact identity hints via external references
    if (candidate.externalRefs !== undefined && candidate.externalRefs.length > 0) {
      const refResult = await this.matchByExternalRefs(candidate);
      if (refResult !== null) return refResult;
    }

    const { extracted } = candidate;

    // Step 2: Producer + Label + Vintage
    if (
      extracted.producer !== undefined &&
      extracted.wineLabel !== undefined &&
      extracted.vintage !== undefined
    ) {
      const result = await this.matchByProducerLabelVintage(
        extracted.producer,
        extracted.wineLabel,
        extracted.vintage,
        trustProfile,
      );
      if (result !== null) return result;
    }

    // Step 3: Producer + Label (without vintage)
    if (extracted.producer !== undefined && extracted.wineLabel !== undefined) {
      const result = await this.matchByProducerLabel(
        extracted.producer,
        extracted.wineLabel,
        trustProfile,
      );
      if (result !== null) return result;
    }

    // Step 4: Label + Region
    if (extracted.wineLabel !== undefined && extracted.region !== undefined) {
      const result = await this.matchByLabelRegion(
        extracted.wineLabel,
        extracted.region,
        trustProfile,
      );
      if (result !== null) return result;
    }

    // Step 5: Unresolved — candidate for new entity
    return {
      status: 'new_entity_candidate',
      confidence: candidate.parsingConfidence,
      reasons: ['No matching entity found via structural signals'],
    };
  }

  /**
   * Attempts exact match via external references (e.g. LWIN).
   */
  private async matchByExternalRefs(
    candidate: CanonicalizationCandidate,
  ): Promise<EntityMatchResult | null> {
    if (candidate.externalRefs === undefined) return null;

    for (const ref of candidate.externalRefs) {
      const entities = await this.entityRepo.findByExternalRef(ref.type, ref.value);
      if (entities.length === 1) {
        return {
          status: 'matched',
          matchedEntityIds: [entities[0]!.entityId],
          confidence: EXACT_REF_CONFIDENCE,
          reasons: [`Exact match on external ref ${ref.type}=${ref.value}`],
        };
      }
      if (entities.length > 1) {
        return {
          status: 'ambiguous',
          matchedEntityIds: entities.map((e) => e.entityId),
          confidence: AMBIGUITY_THRESHOLD,
          reasons: [
            `Multiple entities share external ref ${ref.type}=${ref.value} (${String(entities.length)} found)`,
          ],
        };
      }
    }

    return null;
  }

  /**
   * Matches by producer + label + vintage.
   */
  private async matchByProducerLabelVintage(
    producer: string,
    label: string,
    vintage: number,
    trustProfile: SourceTrustProfile,
  ): Promise<EntityMatchResult | null> {
    const entities = await this.entityRepo.findByProducerAndLabel(producer, label);
    const vintageMatches = entities.filter((e) => e.vintage === vintage);

    if (vintageMatches.length === 1) {
      const confidence = this.applyTrustModifier(
        PRODUCER_LABEL_VINTAGE_CONFIDENCE,
        trustProfile,
        ['producerReliability', 'vintageReliability'],
      );
      return {
        status: 'matched',
        matchedEntityIds: [vintageMatches[0]!.entityId],
        confidence,
        reasons: [`Matched on producer + label + vintage (${String(vintage)})`],
      };
    }

    if (vintageMatches.length > 1) {
      return {
        status: 'ambiguous',
        matchedEntityIds: vintageMatches.map((e) => e.entityId),
        confidence: AMBIGUITY_THRESHOLD,
        reasons: [
          `Ambiguous: ${String(vintageMatches.length)} entities match producer + label + vintage`,
        ],
      };
    }

    return null;
  }

  /**
   * Matches by producer + label (any vintage).
   */
  private async matchByProducerLabel(
    producer: string,
    label: string,
    trustProfile: SourceTrustProfile,
  ): Promise<EntityMatchResult | null> {
    const entities = await this.entityRepo.findByProducerAndLabel(producer, label);

    if (entities.length === 1) {
      const confidence = this.applyTrustModifier(
        PRODUCER_LABEL_CONFIDENCE,
        trustProfile,
        ['producerReliability'],
      );
      return {
        status: 'matched',
        matchedEntityIds: [entities[0]!.entityId],
        confidence,
        reasons: ['Matched on producer + label'],
      };
    }

    if (entities.length > 1) {
      return {
        status: 'ambiguous',
        matchedEntityIds: entities.map((e) => e.entityId),
        confidence: AMBIGUITY_THRESHOLD,
        reasons: [
          `Ambiguous: ${String(entities.length)} entities match producer + label (different vintages)`,
        ],
      };
    }

    return null;
  }

  /**
   * Matches by label + region.
   */
  private async matchByLabelRegion(
    label: string,
    region: string,
    trustProfile: SourceTrustProfile,
  ): Promise<EntityMatchResult | null> {
    const entities = await this.entityRepo.findByLabelAndRegion(label, region);

    if (entities.length === 1) {
      const confidence = this.applyTrustModifier(
        LABEL_REGION_CONFIDENCE,
        trustProfile,
        ['regionReliability'],
      );
      return {
        status: 'matched',
        matchedEntityIds: [entities[0]!.entityId],
        confidence,
        reasons: [`Matched on label + region (${region})`],
      };
    }

    if (entities.length > 1) {
      return {
        status: 'ambiguous',
        matchedEntityIds: entities.map((e) => e.entityId),
        confidence: AMBIGUITY_THRESHOLD,
        reasons: [
          `Ambiguous: ${String(entities.length)} entities match label + region`,
        ],
      };
    }

    return null;
  }

  /**
   * Modifies base confidence by averaging with the relevant trust scores.
   * Lower trust scores reduce the final confidence.
   */
  private applyTrustModifier(
    baseConfidence: number,
    trustProfile: SourceTrustProfile,
    relevantFields: ReadonlyArray<keyof SourceTrustProfile>,
  ): number {
    if (relevantFields.length === 0) return baseConfidence;

    let trustSum = 0;
    let count = 0;
    for (const field of relevantFields) {
      const value = trustProfile[field];
      if (typeof value === 'number') {
        trustSum += value;
        count++;
      }
    }

    if (count === 0) return baseConfidence;

    const avgTrust = trustSum / count;
    // Weighted blend: 70% base confidence, 30% trust modifier
    return baseConfidence * TRUST_BLEND_BASE_WEIGHT + avgTrust * TRUST_BLEND_TRUST_WEIGHT;
  }
}
