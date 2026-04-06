/**
 * Structured extraction service (RFC-002 §6).
 *
 * Transforms a {@link RawSourceRecord} into a {@link CanonicalizationCandidate}
 * by extracting structured fields, stripping noise, and computing a raw
 * parsing confidence score.
 */

import { nanoid } from 'nanoid';

import type { CanonicalizationCandidate, ExtractedFields } from '../model/canonicalization-candidate.js';
import type { RawSourceRecord } from '../model/raw-source-record.js';
import { detectContamination } from './contamination-detector.js';
import { normalizeField, normalizeKoreanText, normalizeVolume, normalizeYear } from './field-normalizer.js';
import { stripNoiseTokens } from './noise-stripper.js';

/** Number of extractable fields used for confidence calculation. */
const TOTAL_EXTRACTABLE_FIELDS = 6; // producer, wineLabel, vintage, region, grape, volumeMl

/**
 * Extracts structured fields from a raw source record and produces a
 * canonicalization candidate.
 *
 * The extraction pipeline:
 * 1. Normalize raw title (whitespace, NFC, Korean if applicable)
 * 2. Strip noise tokens
 * 3. Extract structured fields from raw text + dedicated fields
 * 4. Generate alias candidates from title fragments
 * 5. Compute raw parsing confidence based on extraction coverage
 *
 * @param record - The raw source record to extract from.
 * @returns A canonicalization candidate with extracted fields.
 */
export function extract(record: RawSourceRecord): CanonicalizationCandidate {
  const locale = record.locale;

  // Step 1: Normalize the title
  const normalizedRawTitle = normalizeField(record.rawTitle, locale);

  // Step 2: Strip noise tokens
  const { cleaned: normalizedTitle, noiseFlags } = stripNoiseTokens(normalizedRawTitle);

  // Step 3: Extract structured fields
  const producer = extractProducer(record, locale);
  const wineLabel = extractWineLabel(normalizedTitle, producer);
  const vintage = extractVintage(record);
  const region = extractRegion(record, locale);
  const grape = extractGrape(record, locale);
  const volumeMl = extractVolume(record);

  const extracted: ExtractedFields = {
    ...(producer !== undefined ? { producer } : {}),
    ...(wineLabel !== undefined ? { wineLabel } : {}),
    ...(vintage !== undefined ? { vintage } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(grape !== undefined && grape.length > 0 ? { grape } : {}),
    ...(volumeMl !== undefined ? { volumeMl } : {}),
  };

  // Step 4: Generate alias candidates
  const aliasCandidates = generateAliasCandidates(normalizedTitle, extracted);

  // Step 5: Compute raw parsing confidence
  const parsingConfidence = computeParsingConfidence(extracted);

  // Step 6: Marketplace title contamination vs structured label (RFC-002 §5.4)
  const canonicalForContamination = buildCanonicalLabelForContamination(
    extracted,
    normalizedTitle,
  );
  const contamination = detectContamination(record.rawTitle, canonicalForContamination);
  const mergedNoiseFlags = contamination.flagged
    ? [...noiseFlags, 'marketplace_contamination_suspected']
    : [...noiseFlags];

  return {
    candidateId: nanoid(),
    sourceRecordId: record.sourceRecordId,
    normalizedTitle,
    extracted,
    noiseFlags: mergedNoiseFlags,
    aliasCandidates,
    parsingConfidence,
  };
}

function buildCanonicalLabelForContamination(
  extracted: ExtractedFields,
  fallbackTitle: string,
): string {
  const parts = [extracted.producer, extracted.wineLabel].filter(
    (p): p is string => p !== undefined && p.trim().length > 0,
  );
  if (parts.length > 0) {
    return parts.join(' ').trim();
  }
  return fallbackTitle;
}

/**
 * Extracts the producer name from the record.
 * Prefers the dedicated producerText field; falls back to title heuristics.
 */
function extractProducer(record: RawSourceRecord, locale?: string): string | undefined {
  if (record.producerText !== undefined && record.producerText.trim().length > 0) {
    return normalizeField(record.producerText, locale);
  }

  // Heuristic: if the title contains a known delimiter pattern like " - ", take the first part
  const title = normalizeField(record.rawTitle, locale);
  const dashSplit = title.split(/\s+-\s+/);
  if (dashSplit.length >= 2 && dashSplit[0]!.length > 0) {
    return dashSplit[0]!.trim();
  }

  return undefined;
}

/**
 * Extracts the wine label from the normalized title.
 * Attempts to remove the producer prefix if known.
 */
function extractWineLabel(normalizedTitle: string, producer?: string): string | undefined {
  if (normalizedTitle.length === 0) return undefined;

  let label = normalizedTitle;

  // Remove producer prefix if present
  if (producer !== undefined) {
    const lowerTitle = label.toLowerCase();
    const lowerProducer = producer.toLowerCase();
    if (lowerTitle.startsWith(lowerProducer)) {
      label = label.slice(producer.length).trim();
      // Remove leading separators
      label = label.replace(/^[-–—:,]\s*/, '');
    }
  }

  // Remove vintage year from label
  label = label.replace(/\b(1[89]\d{2}|20[0-9]{2})\b/, '').trim();

  // Collapse whitespace
  label = label.replace(/\s+/g, ' ').trim();

  return label.length > 0 ? label : undefined;
}

/**
 * Extracts vintage year from the record.
 * Prefers dedicated vintageText; falls back to title extraction.
 */
function extractVintage(record: RawSourceRecord): number | undefined {
  if (record.vintageText !== undefined && record.vintageText.trim().length > 0) {
    const year = normalizeYear(record.vintageText);
    if (year !== null) return year;
  }

  // Fallback: extract from title
  const year = normalizeYear(record.rawTitle);
  return year !== null ? year : undefined;
}

/**
 * Extracts region from the record.
 */
function extractRegion(record: RawSourceRecord, locale?: string): string | undefined {
  if (record.regionText !== undefined && record.regionText.trim().length > 0) {
    return normalizeField(record.regionText, locale);
  }
  return undefined;
}

/**
 * Extracts grape varieties from the record.
 */
function extractGrape(record: RawSourceRecord, locale?: string): readonly string[] | undefined {
  if (record.grapeText === undefined || record.grapeText.trim().length === 0) {
    return undefined;
  }

  const grapes = record.grapeText
    .split(/[,;/]/)
    .map((g) => normalizeField(g.trim(), locale))
    .filter((g) => g.length > 0);

  return grapes.length > 0 ? grapes : undefined;
}

/**
 * Extracts volume from the record.
 */
function extractVolume(record: RawSourceRecord): number | undefined {
  if (record.volumeText !== undefined && record.volumeText.trim().length > 0) {
    const vol = normalizeVolume(record.volumeText);
    if (vol !== null) return vol;
  }

  // Fallback: try to find volume in title
  const titleMatch = record.rawTitle.match(/(\d+(?:\.\d+)?)\s*(ml|cl|l)\b/i);
  if (titleMatch !== null) {
    const vol = normalizeVolume(`${titleMatch[1]}${titleMatch[2]}`);
    if (vol !== null) return vol;
  }

  return undefined;
}

/**
 * Generates alias candidates from the normalized title and extracted fields.
 * These are alternative name forms that could match existing entities.
 */
function generateAliasCandidates(
  normalizedTitle: string,
  extracted: ExtractedFields,
): readonly string[] {
  const aliases: string[] = [];

  // The full normalized title is itself an alias candidate
  if (normalizedTitle.length > 0) {
    aliases.push(normalizedTitle);
  }

  // Producer + Label combination
  if (extracted.producer !== undefined && extracted.wineLabel !== undefined) {
    aliases.push(`${extracted.producer} ${extracted.wineLabel}`);
  }

  // Producer + Label + Vintage combination
  if (
    extracted.producer !== undefined &&
    extracted.wineLabel !== undefined &&
    extracted.vintage !== undefined
  ) {
    aliases.push(`${extracted.producer} ${extracted.wineLabel} ${String(extracted.vintage)}`);
  }

  // Label alone (if different from title)
  if (extracted.wineLabel !== undefined && extracted.wineLabel !== normalizedTitle) {
    aliases.push(extracted.wineLabel);
  }

  // Korean-normalized variant if title contains Korean characters
  if (/[\uAC00-\uD7AF]/.test(normalizedTitle)) {
    const koreanNormalized = normalizeKoreanText(normalizedTitle);
    if (koreanNormalized !== normalizedTitle) {
      aliases.push(koreanNormalized);
    }
  }

  // Deduplicate
  return [...new Set(aliases)];
}

/**
 * Computes a raw parsing confidence in [0, 1] based on how many
 * structured fields were successfully extracted.
 */
function computeParsingConfidence(extracted: ExtractedFields): number {
  let extractedCount = 0;

  if (extracted.producer !== undefined) extractedCount++;
  if (extracted.wineLabel !== undefined) extractedCount++;
  if (extracted.vintage !== undefined) extractedCount++;
  if (extracted.region !== undefined) extractedCount++;
  if (extracted.grape !== undefined && extracted.grape.length > 0) extractedCount++;
  if (extracted.volumeMl !== undefined) extractedCount++;

  return extractedCount / TOTAL_EXTRACTABLE_FIELDS;
}
