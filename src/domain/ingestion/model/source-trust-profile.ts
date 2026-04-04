/**
 * Trust calibration profile for a source system (RFC-002 §3.2).
 *
 * Each reliability score is a number in the range [0, 1] where 1 means
 * the field from this source is highly reliable and 0 means it should
 * be treated with extreme skepticism.
 */
export interface SourceTrustProfile {
  /** Machine-readable source system key. */
  readonly sourceSystem: string;
  /** Reliability of the title field. */
  readonly titleReliability: number;
  /** Reliability of the producer / winery field. */
  readonly producerReliability: number;
  /** Reliability of the region / appellation field. */
  readonly regionReliability: number;
  /** Reliability of the vintage field. */
  readonly vintageReliability: number;
  /** Reliability of generic attribute fields (grape, volume, etc.). */
  readonly attributeReliability: number;
  /** Risk that marketplace noise (SEO spam, promotional text) contaminates titles. */
  readonly marketplaceNoiseRisk: number;
}

/**
 * Validates that all reliability scores fall within [0, 1].
 *
 * @param profile - The trust profile to validate.
 * @returns `true` when all scores are in range.
 * @throws {RangeError} When any score is outside [0, 1].
 */
export function validateTrustProfile(profile: SourceTrustProfile): true {
  const fields: ReadonlyArray<keyof SourceTrustProfile> = [
    'titleReliability',
    'producerReliability',
    'regionReliability',
    'vintageReliability',
    'attributeReliability',
    'marketplaceNoiseRisk',
  ];

  for (const field of fields) {
    const value = profile[field];
    if (typeof value === 'number' && (value < 0 || value > 1)) {
      throw new RangeError(`${field} must be in [0, 1], got ${String(value)}`);
    }
  }

  return true;
}
