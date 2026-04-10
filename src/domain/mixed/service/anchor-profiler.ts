import type { EntityId } from '../../shared/types/index.js';
import type { AnchorProfile } from '../model/anchor-profile.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/** Optional slots counted toward profile completeness (grapes, body, sweetness, style). */
const ANCHOR_PROFILE_OPTIONAL_ATTRIBUTE_SLOTS = 4;

/**
 * Raw entity data used to build an anchor profile.
 *
 * This interface represents the minimal data contract that must be
 * provided to the profiler. In practice, entity data would come from
 * the Entity domain or an enrichment adapter.
 */
export interface AnchorEntityData {
  /** Entity identifier. */
  readonly entityId: EntityId;

  /** Canonical display label for the entity. */
  readonly canonicalLabel: string;

  /** Wine region. */
  readonly region: string;

  /** Grape varieties. */
  readonly grapes: readonly string[];

  /** Body level [0, 1] normalised (Vespa float). Defaults to 0.5 (midpoint) if missing. */
  readonly body?: number | undefined;

  /** Sweetness level [0, 1] normalised (Vespa float). Defaults to 0.1 (dry baseline) if missing. */
  readonly sweetness?: number | undefined;

  /** Style descriptor (e.g. "bold red"). Defaults to "unknown" if missing. */
  readonly style?: string | undefined;

  /** Pre-computed embedding vector. */
  readonly embedding?: readonly number[] | undefined;
}

/**
 * Default body when entity data does not specify body.
 * 0.5 = midpoint of [0, 1] normalised scale — neutral assumption when absent.
 */
const DEFAULT_BODY = 0.5;

/**
 * Default sweetness when entity data does not specify sweetness.
 * 0.1 = near-dry baseline; most red wines are low-sweetness, so this is a
 * conservative prior that avoids over-penalising dry-wine queries.
 */
const DEFAULT_SWEETNESS = 0.1;

/**
 * Default style when entity data does not specify style.
 */
const DEFAULT_STYLE = 'unknown';

/**
 * Builds an {@link AnchorProfile} from resolved entity data.
 *
 * The profiler extracts wine attributes (region, grapes, body, sweetness,
 * style) and computes an anchor confidence derived from the resolution
 * pipeline's confidence score.
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class AnchorProfiler {
  /**
   * Builds an anchor profile from raw entity data and resolution confidence.
   *
   * @param entityData - The resolved entity's attribute data.
   * @param resolutionConfidence - Confidence from the resolution pipeline, in [0, 1].
   * @returns A fully-formed anchor profile.
   */
  buildProfile(
    entityData: AnchorEntityData,
    resolutionConfidence: number,
  ): AnchorProfile {
    const body = entityData.body ?? DEFAULT_BODY;
    const sweetness = entityData.sweetness ?? DEFAULT_SWEETNESS;
    const style = entityData.style ?? DEFAULT_STYLE;

    // Anchor confidence is derived from resolution confidence with
    // a penalty for missing attributes that reduce profile quality
    const completeness = this.computeCompleteness(entityData);
    const anchorConfidence = clamp01(resolutionConfidence * completeness);

    return {
      entityId: entityData.entityId,
      canonicalLabel: entityData.canonicalLabel,
      region: entityData.region,
      grapes: [...entityData.grapes],
      body,
      sweetness,
      style,
      embedding: entityData.embedding,
      anchorConfidence,
    };
  }

  /**
   * Computes a completeness score for the entity data.
   *
   * Measures what fraction of important attributes are present.
   * Used to discount anchor confidence when the entity profile is sparse.
   */
  private computeCompleteness(entityData: AnchorEntityData): number {
    let present = 0;
    let total = 0;

    // Required fields (always present by type contract)
    total += 3; // region, canonicalLabel, entityId
    present += 3;

    // Optional but important fields
    total += ANCHOR_PROFILE_OPTIONAL_ATTRIBUTE_SLOTS;
    if (entityData.grapes.length > 0) present++;
    if (entityData.body !== undefined) present++;
    if (entityData.sweetness !== undefined) present++;
    if (entityData.style !== undefined) present++;

    // Embedding is very valuable for similarity
    total += 1;
    if (entityData.embedding !== undefined && entityData.embedding.length > 0) {
      present++;
    }

    return present / total;
  }
}

// clamp01: imported from @shared/utils/clamp (SSoT).
