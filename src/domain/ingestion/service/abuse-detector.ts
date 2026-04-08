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

/** Default sustained rate limit (records per hour). Burst attacks that stay below the count limit are caught here. */
const DEFAULT_RATE_LIMIT_PER_HOUR = 1000;

/** Max entity names listed in SEO-spam reason string. */
const SEO_SPAM_REASON_ENTITY_PREVIEW_COUNT = 5;
/** Title length beyond which we flag likely SEO stuffing. */
const SEO_SPAM_TITLE_CHAR_THRESHOLD = 200;
/** Severity uses `high` when entity references exceed this count. */
const SEO_SPAM_HIGH_SEVERITY_MIN_ENTITIES = 3;
/** Minimum entity name length to consider for SEO spam matching. */
const SEO_SPAM_MIN_ENTITY_LENGTH = 3;
/** Truncate titles in anomaly reasons for logs/UI. */
const TITLE_ANOMALY_REASON_SNIPPET_CHARS = 80;
/** Multiplier vs default limits for mass-registration `high` severity. */
const MASS_REGISTRATION_SEVERITY_BURST_MULTIPLIER = 5;

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
      if (entity.length < SEO_SPAM_MIN_ENTITY_LENGTH) continue;

      const escaped = escapeRegExp(entity);
      const pattern = new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
        'u',
      );
      if (pattern.test(lowerTitle)) {
        matchedEntities.push(entity);
      }
    }

    if (matchedEntities.length > 1) {
      return {
        flagged: true,
        reason: `Title references ${String(matchedEntities.length)} known entities: ${matchedEntities.slice(0, SEO_SPAM_REASON_ENTITY_PREVIEW_COUNT).join(', ')}. Possible SEO keyword stuffing.`,
        severity: matchedEntities.length > SEO_SPAM_HIGH_SEVERITY_MIN_ENTITIES ? 'high' : 'medium',
      };
    }

    // Check for excessive length (SEO spam titles tend to be very long)
    if (record.rawTitle.length > SEO_SPAM_TITLE_CHAR_THRESHOLD) {
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
    const exceedsCount = recentCount > DEFAULT_MASS_REGISTRATION_LIMIT;
    const exceedsRate = ratePerHour > DEFAULT_RATE_LIMIT_PER_HOUR;

    if (exceedsCount || exceedsRate) {
      const severity: AbuseSeverity =
        recentCount > DEFAULT_MASS_REGISTRATION_LIMIT * MASS_REGISTRATION_SEVERITY_BURST_MULTIPLIER
        || ratePerHour > DEFAULT_RATE_LIMIT_PER_HOUR * MASS_REGISTRATION_SEVERITY_BURST_MULTIPLIER
          ? 'high'
          : 'medium';

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
        reason: `Title-to-canonical similarity is ${similarity.toFixed(2)}, below threshold ${String(threshold)}. Raw: "${truncate(rawTitle, TITLE_ANOMALY_REASON_SNIPPET_CHARS)}" vs Canonical: "${truncate(canonicalLabel, TITLE_ANOMALY_REASON_SNIPPET_CHARS)}"`,
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
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
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
 * Escapes special regex characters in a string for safe interpolation.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Truncates a string to a maximum length, appending "..." if truncated.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, Math.max(0, maxLength - 3)) + '...';
}
