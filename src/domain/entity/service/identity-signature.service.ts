import type { EntityType } from '../model/entity-type.js';
import { computeIdentitySignature, type SignatureParams } from '../model/identity-signature.js';

/**
 * Result of a validated identity signature computation.
 * Contains either a successful signature or an error.
 */
export type SignatureResult =
  | { readonly ok: true; readonly signature: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validates that required fields are present for the given entity type,
 * then delegates to {@link computeIdentitySignature}.
 *
 * Also enforces the collapse-prevention rule: a wine signature must never
 * equal a vintage signature for the same underlying data.
 *
 * @param type - The entity type.
 * @param params - Signature parameters.
 * @returns A SignatureResult with either the computed signature or a validation error.
 */
export function computeValidatedSignature(
  type: EntityType,
  params: SignatureParams,
): SignatureResult {
  const missing = getMissingFields(type, params);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required fields for ${type} signature: ${missing.join(', ')}`,
    };
  }

  const signature = computeIdentitySignature(type, params);

  // Collapse prevention: if we are computing a wine signature and have enough
  // info to compute the corresponding vintage signature, verify they differ.
  if (type === 'wine' && params.vintageYear != null) {
    // We need a wineId to compute the vintage sig; use a placeholder based on
    // the wine's own signature to do the comparison.
    const vintageSig = computeIdentitySignature('vintage', {
      canonicalLabel: params.canonicalLabel,
      wineId: signature, // use wine sig as stand-in for wineId
      vintageYear: params.vintageYear,
    });
    if (signature === vintageSig) {
      return {
        ok: false,
        error: 'Wine and vintage signatures collide — this indicates a hashing defect',
      };
    }
  }

  return { ok: true, signature };
}

/**
 * Returns the list of missing required fields for a given entity type.
 */
function getMissingFields(type: EntityType, params: SignatureParams): string[] {
  const missing: string[] = [];

  switch (type) {
    case 'wine':
      if (!params.canonicalLabel) missing.push('canonicalLabel');
      if (!params.producerId) missing.push('producerId');
      if (!params.regionId) missing.push('regionId');
      break;
    case 'vintage':
      if (!params.wineId) missing.push('wineId');
      if (params.vintageYear == null) missing.push('vintageYear');
      break;
    case 'producer':
      if (!params.canonicalLabel) missing.push('canonicalLabel');
      break;
    case 'region':
      if (!params.canonicalLabel) missing.push('canonicalLabel');
      break;
    case 'grape':
      if (!params.canonicalLabel) missing.push('canonicalLabel');
      break;
  }

  return missing;
}
