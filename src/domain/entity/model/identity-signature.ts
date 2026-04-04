import { identityHash } from '../../shared/utils/hash.js';
import type { EntityType } from './entity-type.js';

/**
 * Parameters required to compute an identity signature.
 * Which fields are used depends on the entity type.
 */
export interface SignatureParams {
  /** Canonical label of the entity (normalized). */
  readonly canonicalLabel: string;
  /** Producer entity id — required for wine. */
  readonly producerId?: string;
  /** Region entity id — required for wine; optional for producer/region. */
  readonly regionId?: string;
  /** Parent wine entity id — required for vintage. */
  readonly wineId?: string;
  /** Vintage year — required for vintage. */
  readonly vintageYear?: number;
  /** Parent region entity id — used for producer and region. */
  readonly parentRegionId?: string;
}

/**
 * Normalizes a label for deterministic hashing:
 * trims, lowercases, and collapses whitespace.
 */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Computes a deterministic identity signature for an entity
 * based on its type and disambiguating parameters (RFC-001 §2.4).
 *
 * Signature rules:
 * - **wine**: hash(canonicalLabel + producerId + regionId) — vintage excluded
 * - **vintage**: hash(wineId + vintageYear) — distinct from wine hash
 * - **producer** / **region**: hash(normalizedLabel + parentRegionId)
 * - **grape**: hash(normalizedLabel)
 *
 * @param type - The entity type.
 * @param params - The disambiguating parameters.
 * @returns A hex-encoded SHA-256 identity signature.
 * @throws If required parameters for the given type are missing.
 */
export function computeIdentitySignature(type: EntityType, params: SignatureParams): string {
  switch (type) {
    case 'wine': {
      if (!params.canonicalLabel) {
        throw new Error('wine signature requires canonicalLabel');
      }
      if (!params.producerId) {
        throw new Error('wine signature requires producerId');
      }
      if (!params.regionId) {
        throw new Error('wine signature requires regionId');
      }
      return identityHash(
        'wine',
        normalizeLabel(params.canonicalLabel),
        params.producerId,
        params.regionId,
      );
    }
    case 'vintage': {
      if (!params.wineId) {
        throw new Error('vintage signature requires wineId');
      }
      if (params.vintageYear == null) {
        throw new Error('vintage signature requires vintageYear');
      }
      return identityHash(
        'vintage',
        params.wineId,
        String(params.vintageYear),
      );
    }
    case 'producer': {
      if (!params.canonicalLabel) {
        throw new Error('producer signature requires canonicalLabel');
      }
      return identityHash(
        'producer',
        normalizeLabel(params.canonicalLabel),
        params.parentRegionId ?? '',
      );
    }
    case 'region': {
      if (!params.canonicalLabel) {
        throw new Error('region signature requires canonicalLabel');
      }
      return identityHash(
        'region',
        normalizeLabel(params.canonicalLabel),
        params.parentRegionId ?? '',
      );
    }
    case 'grape': {
      if (!params.canonicalLabel) {
        throw new Error('grape signature requires canonicalLabel');
      }
      return identityHash(
        'grape',
        normalizeLabel(params.canonicalLabel),
      );
    }
  }
}
