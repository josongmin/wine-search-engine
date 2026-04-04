/**
 * A reference to an external system (e.g. LWIN, Wine-Searcher ID).
 */
export interface ExternalRef {
  /** Reference type identifier (e.g. "lwin", "wine-searcher"). */
  readonly type: string;
  /** The external identifier value. */
  readonly value: string;
}

/**
 * Fields extracted from a raw source record during structured extraction.
 */
export interface ExtractedFields {
  /** Normalized producer / winery name. */
  readonly producer?: string | undefined;
  /** Normalized wine label (name without producer, vintage, etc.). */
  readonly wineLabel?: string | undefined;
  /** Four-digit vintage year. */
  readonly vintage?: number | undefined;
  /** Normalized region or appellation. */
  readonly region?: string | undefined;
  /** Grape varieties found in the record. */
  readonly grape?: readonly string[] | undefined;
  /** Volume in millilitres. */
  readonly volumeMl?: number | undefined;
}

/**
 * A canonicalization candidate produced by the structured extractor (RFC-002 §6.2).
 *
 * This is an intermediate representation between a raw source record and a
 * matched (or new) canonical entity.  The `parsingConfidence` is a raw
 * extraction score, NOT the calibrated confidence C from §8.
 */
export interface CanonicalizationCandidate {
  /** Unique identifier for this candidate. */
  readonly candidateId: string;
  /** The source record this candidate was derived from. */
  readonly sourceRecordId: string;
  /** Title after noise stripping and normalization. */
  readonly normalizedTitle: string;
  /** Structured fields extracted from the raw record. */
  readonly extracted: ExtractedFields;
  /** Noise tokens that were stripped from the title. */
  readonly noiseFlags: readonly string[];
  /** Alternative name forms derived from title fragments. */
  readonly aliasCandidates: readonly string[];
  /**
   * Raw parsing confidence in [0, 1].
   * This is NOT the calibrated confidence C from RFC-002 §8.
   */
  readonly parsingConfidence: number;
  /** Optional external reference identifiers. */
  readonly externalRefs?: readonly ExternalRef[] | undefined;
}
