/**
 * NDJSON loader with explicit fail-closed default semantics.
 *
 * Default mode is strict: a malformed line or schema mismatch aborts the
 * caller immediately. Tolerant skipping is available only via opt-in.
 */

/**
 * Parse NDJSON content into typed records.
 *
 * @param content - Raw NDJSON string (newline-delimited JSON).
 * @param label - Label for error messages (e.g. file path).
 * @param validator - Optional per-record validator. Returns true if the record
 *                    conforms to expected shape.
 * @param options - Parsing mode. Strict by default; tolerant mode skips invalid
 *                  lines with warnings.
 * @returns Parsed records and count of skipped lines in tolerant mode.
 */
export interface ParseNdjsonOptions {
  readonly mode?: 'strict' | 'tolerant';
}

export function parseNdjson<T>(
  content: string,
  label = 'ndjson',
  validator?: (record: unknown) => record is T,
  options?: ParseNdjsonOptions,
): { records: T[]; skipped: number } {
  const records: T[] = [];
  let skipped = 0;
  const mode = options?.mode ?? 'strict';
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { records, skipped };
  }

  const lines = trimmed.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!.replace(/\r$/, '').trim();

    // Skip empty lines — increment line number but don't count as malformed.
    if (rawLine.length === 0) continue;

    try {
      const parsed: unknown = JSON.parse(rawLine);

      // If a validator is provided, check the parsed record's shape
      if (validator) {
        if (!validator(parsed)) {
          if (mode === 'strict') {
            throw new Error(`schema mismatch at ${label}:${i + 1}`);
          }
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
    } catch (error) {
      if (mode === 'strict') {
        const reason =
          error instanceof Error && error.message.includes('schema mismatch')
            ? error.message
            : `malformed JSON at ${label}:${i + 1}`;
        throw new Error(`parseNdjson: ${reason}`);
      }
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Warning: malformed JSON at ${label}:${i + 1}, skipping`);
      }
    }
  }

  if (mode === 'tolerant' && skipped > 5) {
    console.warn(`  Warning: ${skipped} total malformed/invalid lines in ${label}`);
  }

  return { records, skipped };
}
