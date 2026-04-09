import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { MappingTablePort } from '../../domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../domain/attribute/model/nl-mapping.js';
import { resolveDataPath } from '../../shared/utils/data-paths.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

/**
 * Zod schema for validating individual NL mapping entries read from JSON.
 * Ensures external data matches the NLMapping interface at runtime (Rule 12).
 */
const NLMappingSchema = z.object({
  phrase: z.string(),
  mappedAttribute: z.string(),
  operator: z.string(),
  value: z.union([z.number(), z.string(), z.tuple([z.number(), z.number()])]),
  mappingConfidence: z.number().finite(),
  mappingVersion: z.string(),
  source: z.string(),
});

/** Max mappings to accept from a single file (domain bound: ~500 entities × 3 aliases). */
const MAX_MAPPINGS_FROM_FILE = 2000;

/**
 * File-backed implementation of {@link MappingTablePort}.
 *
 * Loads NL-to-attribute mappings from a JSON file at construction time.
 * If the file is absent or malformed the adapter falls back to an empty
 * mapping set so the application can still start without the data file.
 *
 * Expected JSON shape:
 * ```json
 * { "version": "v1.0", "mappings": [ <NLMapping>, ... ] }
 * ```
 *
 * Default path: `<cwd>/data/nl-mappings.json`
 */
export class FileMappingTableAdapter implements MappingTablePort {
  private readonly mappings: readonly NLMapping[];
  private readonly version: string;

  constructor(filePath?: string) {
    const path = filePath ?? resolveDataPath('data/nl-mappings.json');
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // Runtime shape check (Rule 12: never JSON.parse as T directly)
      const obj = typeof parsed === 'object' && parsed !== null
        ? parsed as Record<string, unknown>
        : undefined;
      this.version = typeof obj?.['version'] === 'string' ? obj['version'] : 'v1.0';
      const rawMappings = Array.isArray(obj?.['mappings']) ? obj['mappings'] as unknown[] : [];
      const validated: NLMapping[] = [];
      for (const item of rawMappings.slice(0, MAX_MAPPINGS_FROM_FILE)) {
        const result = NLMappingSchema.safeParse(item);
        if (result.success) {
          validated.push(result.data as NLMapping);
        }
      }
      this.mappings = validated;
    } catch (err) {
      // File missing or unreadable — start with empty mapping set.
      // Log at warn level so operators can detect corrupted/missing data files.
      bootstrapLogger.warn(
        { path, message: err instanceof Error ? err.message : 'unknown' },
        'NL mapping file unavailable; starting with empty mapping set',
      );
      this.version = 'v1.0';
      this.mappings = [];
    }
  }

  findMapping(phrase: string, version?: string): Promise<NLMapping | null> {
    const lower = phrase.toLowerCase();
    return Promise.resolve(
      this.mappings.find(
        (m) =>
          m.phrase.toLowerCase() === lower &&
          (version == null || m.mappingVersion === version),
      ) ?? null,
    );
  }

  findMappingsByAttribute(attribute: string): Promise<readonly NLMapping[]> {
    return Promise.resolve(this.mappings.filter((m) => m.mappedAttribute === attribute));
  }

  getCurrentVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }
}
