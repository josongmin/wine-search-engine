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
  const records: T[] = [];
  let skipped = 0;
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { records, skipped };
  }

  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart <= trimmed.length) {
    let lineEnd = trimmed.indexOf('\n', lineStart);
    if (lineEnd === -1) {
      lineEnd = trimmed.length;
    }

    const rawLine = trimmed.slice(lineStart, lineEnd);
    try {
      if (rawLine.length > 0) {
        records.push(JSON.parse(rawLine.replace(/\r$/, '')) as T);
      }
    } catch {
      skipped++;
      if (skipped <= 5) {
        console.warn(`  Warning: malformed JSON at ${label}:${lineNumber}, skipping`);
      }
    }

    if (rawLine.length > 0) {
      lineNumber += 1;
    }
    if (lineEnd === trimmed.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  if (skipped > 5) {
    console.warn(`  Warning: ${skipped} total malformed lines in ${label}`);
  }

  return { records, skipped };
}
