import type { EntityId } from '../../shared/types/index.js';
import type { Alias, AliasType } from '../model/alias.js';

/**
 * Result of an adversarial check.
 */
export interface AdversarialCheckResult {
  /** Whether the check passed (alias is allowed). */
  readonly passed: boolean;
  /** Human-readable reason for rejection, if `passed` is false. */
  readonly reason?: string;
}

/**
 * Maximum number of aliases a single source may register for one entity
 * within a short time window before velocity limiting kicks in.
 */
const VELOCITY_THRESHOLD = 50;

/**
 * Source noise-risk thresholds by alias type.
 * If a source's noise risk exceeds the threshold for the proposed type,
 * the alias is rejected.
 */
const SOURCE_TRUST_GATES: Readonly<Record<AliasType, number>> = {
  canonical: 0.9,
  translation: 0.7,
  phonetic: 0.6,
  misspelling: 0.5,
  observed_query_alias: 0.4,
  catalog_noise_alias: 0.3,
};

/**
 * Set of Unicode confusable character pairs (homoglyphs).
 * Maps each confusable codepoint to its ASCII equivalent.
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  ['\u0410', 'A'], // Cyrillic А → Latin A
  ['\u0412', 'B'], // Cyrillic В → Latin B
  ['\u0421', 'C'], // Cyrillic С → Latin C
  ['\u0415', 'E'], // Cyrillic Е → Latin E
  ['\u041D', 'H'], // Cyrillic Н → Latin H
  ['\u041A', 'K'], // Cyrillic К → Latin K
  ['\u041C', 'M'], // Cyrillic М → Latin M
  ['\u041E', 'O'], // Cyrillic О → Latin O
  ['\u0420', 'P'], // Cyrillic Р → Latin P
  ['\u0422', 'T'], // Cyrillic Т → Latin T
  ['\u0425', 'X'], // Cyrillic Х → Latin X
  ['\u0430', 'a'], // Cyrillic а → Latin a
  ['\u0435', 'e'], // Cyrillic е → Latin e
  ['\u043E', 'o'], // Cyrillic о → Latin o
  ['\u0440', 'p'], // Cyrillic р → Latin p
  ['\u0441', 'c'], // Cyrillic с → Latin c
  ['\u0443', 'y'], // Cyrillic у → Latin y
  ['\u0445', 'x'], // Cyrillic х → Latin x
  ['\u0455', 's'], // Cyrillic ѕ → Latin s
  ['\u0456', 'i'], // Cyrillic і → Latin i
  ['\u0458', 'j'], // Cyrillic ј → Latin j
  ['\u0501', 'd'], // Cyrillic ԁ → Latin d
  ['\u051B', 'q'], // Cyrillic ԛ → Latin q
  ['\u051D', 'w'], // Cyrillic ԝ → Latin w
  ['\uFF21', 'A'], // Fullwidth Ａ → Latin A
  ['\uFF22', 'B'], // Fullwidth Ｂ → Latin B
  ['\uFF23', 'C'], // Fullwidth Ｃ → Latin C
  ['\u2010', '-'], // Hyphen → ASCII hyphen
  ['\u2011', '-'], // Non-breaking hyphen
  ['\u2012', '-'], // Figure dash
  ['\u2013', '-'], // En dash
  ['\u2014', '-'], // Em dash
]);

/**
 * Normalizes a string by replacing known homoglyphs with their ASCII equivalents.
 */
function deconfuse(value: string): string {
  let result = '';
  for (const char of value) {
    const replacement = HOMOGLYPH_MAP.get(char);
    result += replacement !== undefined ? replacement : char;
  }
  return result;
}

/**
 * Detects whether a string contains any Unicode homoglyph characters.
 */
function containsHomoglyphs(value: string): boolean {
  for (const char of value) {
    if (HOMOGLYPH_MAP.has(char)) {
      return true;
    }
  }
  return false;
}

/**
 * Adversarial guard implementing RFC-003 §8.2.2.
 *
 * Protects against:
 * - **Homoglyph attacks**: Unicode look-alikes that impersonate existing aliases.
 * - **Velocity abuse**: Flooding the alias space from a single source.
 * - **Low-trust source injection**: Untrusted sources creating high-authority aliases.
 */
export class AdversarialGuard {
  /**
   * Checks whether a proposed alias value contains Unicode homoglyphs that
   * collide with existing aliases after deconfusion.
   *
   * @param value - The proposed alias value.
   * @param existingAliases - Current aliases to check against.
   * @returns Check result; fails if homoglyph collision detected.
   */
  checkHomoglyph(
    value: string,
    existingAliases: readonly Alias[],
  ): AdversarialCheckResult {
    if (!containsHomoglyphs(value)) {
      return { passed: true };
    }

    const deconfused = deconfuse(value).toLowerCase();

    for (const existing of existingAliases) {
      const existingDeconfused = deconfuse(existing.value).toLowerCase();
      if (
        deconfused === existingDeconfused &&
        value !== existing.value
      ) {
        return {
          passed: false,
          reason:
            `Homoglyph attack detected: "${value}" visually impersonates ` +
            `existing alias "${existing.value}" (entity ${existing.entityId})`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Checks whether a source is creating aliases at a suspicious rate.
   *
   * @param entityId - The entity receiving the alias.
   * @param source - The provenance identifier.
   * @param recentAliasCount - Number of aliases this source created for this
   *        entity in the recent time window.
   * @returns Check result; fails if velocity threshold exceeded.
   */
  checkVelocity(
    entityId: EntityId,
    source: string,
    recentAliasCount: number,
  ): AdversarialCheckResult {
    if (recentAliasCount > VELOCITY_THRESHOLD) {
      return {
        passed: false,
        reason:
          `Velocity limit exceeded: source "${source}" has created ` +
          `${String(recentAliasCount)} aliases for entity ${entityId} ` +
          `(threshold: ${String(VELOCITY_THRESHOLD)})`,
      };
    }

    return { passed: true };
  }

  /**
   * Checks whether a source with a given noise risk is allowed to create
   * an alias of the proposed type.
   *
   * Higher-authority alias types (canonical, translation) require lower
   * noise risk from the source. Noisy sources are only permitted to create
   * lower-authority alias types.
   *
   * @param sourceNoiseRisk - The source's estimated noise risk in [0, 1].
   *        Higher means noisier / less trustworthy.
   * @param proposedType - The alias type being created.
   * @returns Check result; fails if source is too noisy for the proposed type.
   */
  checkSourceTrustGate(
    sourceNoiseRisk: number,
    proposedType: AliasType,
  ): AdversarialCheckResult {
    const maxAllowedNoise = SOURCE_TRUST_GATES[proposedType];

    if (sourceNoiseRisk > maxAllowedNoise) {
      return {
        passed: false,
        reason:
          `Source noise risk ${String(sourceNoiseRisk)} exceeds maximum ` +
          `${String(maxAllowedNoise)} for alias type "${proposedType}"`,
      };
    }

    return { passed: true };
  }
}
