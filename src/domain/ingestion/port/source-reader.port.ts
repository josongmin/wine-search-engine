import type { RawSourceRecord } from '../model/raw-source-record.js';

/**
 * A paginated batch of raw source records.
 */
export interface SourceReaderBatch {
  /** The records in this batch. */
  readonly records: readonly RawSourceRecord[];
  /** Opaque cursor for fetching the next batch; absent when exhausted. */
  readonly nextCursor?: string | undefined;
}

/**
 * Port for reading raw records from an external source system.
 *
 * Implementations are infrastructure adapters (e.g. HTTP scrapers,
 * database readers, file importers).
 */
export interface SourceReader {
  /**
   * Reads a batch of raw records from the given source system.
   *
   * @param sourceSystem - The source system identifier to read from.
   * @param limit - Maximum number of records to return in this batch.
   * @param cursor - Opaque pagination cursor from a previous call.
   * @returns A batch of records and an optional cursor for the next page.
   */
  readBatch(
    sourceSystem: string,
    limit: number,
    cursor?: string,
  ): Promise<SourceReaderBatch>;
}
