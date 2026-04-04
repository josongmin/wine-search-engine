/**
 * The type of source system that produced a catalog record.
 * Used to determine parsing heuristics and trust calibration.
 */
export type SourceType = 'catalog' | 'marketplace' | 'retailer' | 'manual' | 'editorial';

/**
 * A single raw record ingested from an external source system (RFC-002 §3.1).
 *
 * All `*Text` fields are raw, un-normalized strings exactly as they appeared
 * in the source. Normalization happens downstream in the canonicalization
 * pipeline.
 */
export interface RawSourceRecord {
  /** Unique identifier within the source system. */
  readonly sourceRecordId: string;
  /** Machine-readable source system key (e.g. "vivino", "wine-searcher"). */
  readonly sourceSystem: string;
  /** Classification of the source system. */
  readonly sourceType: SourceType;
  /** Raw product title as scraped / received. */
  readonly rawTitle: string;
  /** Optional subtitle or secondary title line. */
  readonly rawSubtitle?: string | undefined;
  /** Free-text product description. */
  readonly rawDescription?: string | undefined;
  /** Raw producer / winery text. */
  readonly producerText?: string | undefined;
  /** Raw region / appellation text. */
  readonly regionText?: string | undefined;
  /** Raw grape variety text (may be comma-separated). */
  readonly grapeText?: string | undefined;
  /** Raw vintage text (may include non-numeric characters). */
  readonly vintageText?: string | undefined;
  /** Raw price text including currency symbols. */
  readonly priceText?: string | undefined;
  /** Raw volume text (e.g. "750ml", "750 ML"). */
  readonly volumeText?: string | undefined;
  /** Canonical URL of the source listing. */
  readonly sourceUrl?: string | undefined;
  /** BCP-47 locale of the source listing. */
  readonly locale?: string | undefined;
  /** ISO 4217 currency code when known. */
  readonly currency?: string | undefined;
  /** Timestamp when this record was ingested into our system. */
  readonly ingestionTimestamp: Date;
}
