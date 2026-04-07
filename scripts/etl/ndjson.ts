/**
 * Safe NDJSON loader with per-line error handling.
 *
 * A single malformed line should NOT crash the entire pipeline.
 * Instead, it logs a warning and skips that line.
 */

/**
 * Parse NDJSON content into typed records, skipping malformed lines.
 *
 * @param content - Raw NDJSON string (newline-delimited JSON).
 * @param label - Label for error messages (e.g. file path).
 * @param validator - Optional per-record validator. Returns true if the record
 *                    conforms to expected shape. Failing records are counted as
 *                    skipped and logged.
 * @returns Parsed records and count of skipped lines.
 */
export function parseNdjson<T>(
  content: string,
  label = 'ndjson',
  validator?: (record: unknown) => record is T,
): { records: T[]; skipped: number } {
  const records: T[] = [];
  let skipped = 0;
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { records, skipped };
  }

  const lines = trimmed.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!.replace(/\r$/, '').trim();

    // Skip empty lines — increment line number but don't count as malformed
    if (rawLine.length === 0) continue;

    try {
      const parsed: unknown = JSON.parse(rawLine);

      // If a validator is provided, check the parsed record's shape
      if (validator) {
        if (!validator(parsed)) {
          skipped++;
          if (skipped <= 5) {
            console.warn(`  Warning: schema mismatch at ${label}:${i + 1}, skipping`);
          }
          continue;
        }
        records.push(parsed);
      } else {
        records.push(parsed as T);
      }
    } catch {
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Warning: malformed JSON at ${label}:${i + 1}, skipping`);
      }
    }
  }

  if (skipped > 5) {
    console.warn(`  Warning: ${skipped} total malformed/invalid lines in ${label}`);
  }

  return { records, skipped };
}
