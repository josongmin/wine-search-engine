import { createReadStream } from 'node:fs';
import * as readline from 'node:readline/promises';

/**
 * Streams up to `limit` parsed NDJSON records from a file.
 *
 * This is intentionally bounded so diagnostic tests can avoid loading large
 * fixture files into memory when they only need the first few records.
 */
export async function loadNdjsonRecords<T>(
  filePath: string,
  limit: number,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const records: T[] = [];

  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      records.push(JSON.parse(trimmed) as T);
      if (records.length >= limit) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return records;
}
