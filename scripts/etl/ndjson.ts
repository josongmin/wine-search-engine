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
 * @returns Parsed records and count of skipped lines.
 */
export function parseNdjson<T>(
  content: string,
  label = 'ndjson',
): { records: T[]; skipped: number } {
  const lines = content.trim().split('\n').filter((line) => line.length > 0);
  const records: T[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T);
    } catch {
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Warning: malformed JSON at ${label}:${i + 1}, skipping`);
      }
    }
  }

  if (skipped > 5) {
    console.warn(`  Warning: ${skipped} total malformed lines in ${label}`);
  }

  return { records, skipped };
}
