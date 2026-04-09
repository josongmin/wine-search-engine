/**
 * Field normalization utilities for the ingestion pipeline (RFC-002 §5).
 *
 * All functions are pure and side-effect free.
 */

import { normalizeUnicode } from '@domain/shared/utils/unicode-normalize.js';

/** Smallest plausible bare-number bottle volume (ml) for heuristic parse. */
const BARE_VOLUME_ASSUME_ML_MIN = 50;
/** Largest plausible bare-number bottle volume (ml) before rejecting. */
const BARE_VOLUME_ASSUME_ML_MAX = 5000;

/** Absolute upper bound for unit-bearing volumes (ml). Nebuchadnezzar = 15L; 30L gives margin. */
const MAX_VOLUME_ML = 30_000;

/** Latest plausible vintage year: current year + 1 (en primeur releases). */
const MAX_PLAUSIBLE_VINTAGE_YEAR = new Date().getFullYear() + 1;

/**
 * Normalizes a free-text field by trimming, collapsing whitespace,
 * applying Unicode NFC normalization, and optionally stripping accents.
 *
 * @param raw - The raw field value.
 * @param locale - Optional BCP-47 locale hint (used for locale-specific handling).
 * @returns The normalized string.
 */
export function normalizeField(raw: string, locale?: string): string {
  if (raw.length === 0) return '';

  // Shared SSOT: NFC normalization + homoglyph replacement + trim + whitespace collapse
  let result = normalizeUnicode(raw);

  // Korean locale: apply Korean-specific normalization
  if (locale !== undefined && isKoreanLocale(locale)) {
    result = normalizeKoreanText(result);
  }

  return result;
}

/**
 * Normalizes a raw volume string into millilitres.
 *
 * Handles common patterns like "750ML", "750ml", "750 ml", "1.5L", "1.5 L",
 * "75cl", "75 cl".
 *
 * @param raw - The raw volume text.
 * @returns Volume in millilitres, or `null` if the string cannot be parsed.
 */
export function normalizeVolume(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  // Match number (optionally with decimal) followed by optional space and unit
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ml|l|cl|litre|liter|litres|liters)$/);
  if (match === null) {
    // Try bare number — assume ml if it looks like a standard bottle size
    const bareNumber = trimmed.match(/^(\d+)$/);
    if (bareNumber !== null) {
      const value = Number(bareNumber[1]);
      // Common ml sizes: 187, 375, 500, 750, 1000, 1500
      if (value >= BARE_VOLUME_ASSUME_ML_MIN && value <= BARE_VOLUME_ASSUME_ML_MAX) {
        return value;
      }
    }
    return null;
  }

  const numericValue = parseFloat(match[1]!);
  // Guard: "750e308ml" → parseFloat → Infinity; must reject non-finite values
  // to prevent Infinity propagating through ingestion pipeline.
  if (!Number.isFinite(numericValue)) return null;
  const unit = match[2]!;

  let ml: number;
  switch (unit) {
    case 'ml':
      ml = numericValue;
      break;
    case 'cl':
      ml = numericValue * 10;
      break;
    case 'l':
    case 'litre':
    case 'liter':
    case 'litres':
    case 'liters':
      ml = numericValue * 1000;
      break;
    default:
      return null;
  }
  return ml > 0 && ml <= MAX_VOLUME_ML ? ml : null;
}

/**
 * Extracts a four-digit vintage year from a raw vintage string.
 *
 * Handles formats like "2018", "2018년", "Vintage 2018", "v.2018".
 *
 * @param raw - The raw vintage text.
 * @returns A four-digit year, or `null` if no valid year is found.
 */
export function normalizeYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Extract first four-digit sequence that looks like a plausible wine vintage
  const match = trimmed.match(/(?<![\p{L}\p{N}])(1[89]\d{2}|20[0-9]{2})(?![\p{L}\p{N}])/u);
  if (match === null) {
    // Try without word boundary for cases like "2018년"
    const looseMatch = trimmed.match(/(1[89]\d{2}|20[0-9]{2})/);
    if (looseMatch === null) return null;
    const looseYear = parseInt(looseMatch[1]!, 10);
    return looseYear > MAX_PLAUSIBLE_VINTAGE_YEAR ? null : looseYear;
  }

  const year = parseInt(match[1]!, 10);
  return year > MAX_PLAUSIBLE_VINTAGE_YEAR ? null : year;
}

/**
 * Applies Korean-specific text normalization (RFC-002 §5).
 *
 * - Normalizes Korean whitespace (full-width spaces to ASCII space)
 * - Removes zero-width characters
 * - Normalizes Korean parentheses (full-width to ASCII)
 * - Collapses whitespace
 *
 * @param raw - The raw Korean text.
 * @returns Normalized Korean text.
 */
export function normalizeKoreanText(raw: string): string {
  let result = raw;

  // Replace full-width spaces (U+3000) with ASCII space
  result = result.replace(/\u3000/g, ' ');

  // Remove zero-width characters (ZWSP, ZWNJ, ZWJ, soft hyphen)
  result = result.replace(/\u200B/g, '');
  result = result.replace(/\u200C/g, '');
  result = result.replace(/\u200D/g, '');
  result = result.replace(/\u00AD/g, '');

  // Replace full-width parentheses with ASCII equivalents
  result = result.replace(/\uFF08/g, '(');
  result = result.replace(/\uFF09/g, ')');

  // Replace full-width comma with ASCII
  result = result.replace(/\uFF0C/g, ',');

  // Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Checks if a locale string indicates Korean.
 */
function isKoreanLocale(locale: string): boolean {
  const lower = locale.toLowerCase();
  return lower === 'ko' || lower.startsWith('ko-') || lower.startsWith('ko_');
}
