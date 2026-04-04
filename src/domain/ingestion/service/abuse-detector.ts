/**
 * Abuse detection service (RFC-002 §10.1).
 *
 * Detects SEO spam, mass registration attacks, and title anomalies
 * in ingested records before they enter the entity catalog.
 */

import type { RawSourceRecord } from '../model/raw-source-record.js';

/** Severity level for an abuse detection flag. */
export type AbuseSeverity = 'low' | 'medium' | 'high';

/** Result of an individual abuse check. */
export interface AbuseCheckResult {
  /** Whether the check flagged the input as abusive. */
  readonly flagged: boolean;
  /** Human-readable explanation when flagged. */
  readonly reason?: string | undefined;
  /** Severity of the detected abuse. */
  readonly severity: AbuseSeverity;
}

/** Default threshold for title anomaly detection (Jaccard distance). */
const DEFAULT_ANOMALY_THRESHOLD = 0.3;

/** Default mass registration threshold (records per window). */
const DEFAULT_MASS_REGISTRATION_LIMIT = 1000;

/**
 * Detects various forms of abuse in ingested wine catalog data.
 */
export class AbuseDetector {
  /**
   * Detects SEO spam by checking whether the raw title stuffs known
   * entity names that are unrelated to the actual product.
   *
   * A title is flagged when it mentions more than one known entity name,
   * which is a strong signal of keyword stuffing.
   *
   * @param record - The raw source record to check.
   * @param knownEntities - Set of known canonical entity names (lowercased).
   * @returns The abuse check result.
   */
  detectSeoSpam(record: RawSourceRecord, knownEntities: Set<string>): AbuseCheckResult {
    if (knownEntities.size === 0) {
      return { flagged: false, severity: 'low' };
    }

    const lowerTitle = record.rawTitle.toLowerCase();
    const matchedEntities: string[] = [];

    for (const entity of knownEntities) {
      if (entity.length > 0 && lowerTitle.includes(entity)) {
        matchedEntities.push(entity);
      }
    }

    if (matchedEntities.length > 1) {
      return {
        flagged: true,
        reason: `Title references ${String(matchedEntities.length)} known entities: ${matchedEntities.slice(0, 5).join(', ')}. Possible SEO keyword stuffing.`,
        severity: matchedEntities.length > 3 ? 'high' : 'medium',
      };
    }

    // Check for excessive length (SEO spam titles tend to be very long)
    if (record.rawTitle.length > 200) {
      return {
        flagged: true,
        reason: `Title is unusually long (${String(record.rawTitle.length)} chars). Possible SEO spam.`,
        severity: 'low',
      };
    }

    return { flagged: false, severity: 'low' };
  }

  /**
   * Detects mass registration attacks by checking whether a source system
   * has submitted an unusual volume of records in a given time window.
   *
   * @param sourceSystem - The source system identifier.
   * @param recentCount - Number of records submitted in the window.
   * @param windowHours - Duration of the monitoring window in hours.
   * @returns The abuse check result.
   */
  detectMassRegistration(
    sourceSystem: string,
    recentCount: number,
    windowHours: number,
  ): AbuseCheckResult {
    if (windowHours <= 0) {
      return { flagged: false, severity: 'low' };
    }

    const ratePerHour = recentCount / windowHours;

    if (recentCount > DEFAULT_MASS_REGISTRATION_LIMIT) {
      const severity: AbuseSeverity =
        recentCount > DEFAULT_MASS_REGISTRATION_LIMIT * 5 ? 'high' : 'medium';

      return {
        flagged: true,
        reason: `Source "${sourceSystem}" submitted ${String(recentCount)} records in ${String(windowHours)}h (${ratePerHour.toFixed(1)}/h). Exceeds limit of ${String(DEFAULT_MASS_REGISTRATION_LIMIT)}.`,
        severity,
      };
    }

    return { flagged: false, severity: 'low' };
  }

  /**
   * Detects title anomalies by comparing the raw title against the
   * canonical label using Jaccard similarity on token sets.
   *
   * A large divergence between the raw title and the canonical label
   * suggests the title has been manipulated or is not a genuine product listing.
   *
   * @param rawTitle - The original raw title from the source.
   * @param canonicalLabel - The canonical wine label after extraction.
   * @param threshold - Minimum Jaccard similarity required (default 0.3).
   * @returns The abuse check result.
   */
  detectTitleAnomaly(
    rawTitle: string,
    canonicalLabel: string,
    threshold: number = DEFAULT_ANOMALY_THRESHOLD,
  ): AbuseCheckResult {
    if (rawTitle.trim().length === 0 || canonicalLabel.trim().length === 0) {
      return { flagged: false, severity: 'low' };
    }

    const rawTokens = tokenize(rawTitle);
    const canonicalTokens = tokenize(canonicalLabel);

    if (rawTokens.size === 0 || canonicalTokens.size === 0) {
      return { flagged: false, severity: 'low' };
    }

    const similarity = jaccardSimilarity(rawTokens, canonicalTokens);

    if (similarity < threshold) {
      return {
        flagged: true,
        reason: `Title-to-canonical similarity is ${similarity.toFixed(2)}, below threshold ${String(threshold)}. Raw: "${truncate(rawTitle, 80)}" vs Canonical: "${truncate(canonicalLabel, 80)}"`,
        severity: similarity < threshold / 2 ? 'high' : 'medium',
      };
    }

    return { flagged: false, severity: 'low' };
  }
}

/**
 * Tokenizes a string into a set of lowercased words.
 */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_,;:.()\u005b\u005d{}'"!?/]+/)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Computes the Jaccard similarity coefficient between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 1;

  return intersectionSize / unionSize;
}

/**
 * Truncates a string to a maximum length, appending "..." if truncated.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
