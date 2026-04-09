import { readFile } from 'node:fs/promises';
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
  value: z.union([z.number().finite(), z.string(), z.tuple([z.number().finite(), z.number().finite()])]),
  mappingConfidence: z.number().finite(),
  mappingVersion: z.string(),
  source: z.string(),
});

/** Max mappings to accept from a single file (domain bound: ~500 entities × 3 aliases). */
const MAX_MAPPINGS_FROM_FILE = 2000;

interface LoadedMappingState {
  readonly mappings: readonly NLMapping[];
  readonly version: string;
}

const EMPTY_STATE: LoadedMappingState = { mappings: [], version: 'v1.0' };

async function loadMappingStateFromFile(path: string): Promise<LoadedMappingState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Runtime shape check (Rule 12: never JSON.parse as T directly)
    const obj = typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
    const version = typeof obj?.['version'] === 'string' ? obj['version'] : 'v1.0';
    const rawMappings = Array.isArray(obj?.['mappings']) ? obj['mappings'] as unknown[] : [];
    const validated: NLMapping[] = [];
    for (const item of rawMappings.slice(0, MAX_MAPPINGS_FROM_FILE)) {
      const result = NLMappingSchema.safeParse(item);
      if (result.success) {
        validated.push(result.data as NLMapping);
      }
    }
    return { mappings: validated, version };
  } catch (err) {
    // File missing or unreadable — start with empty mapping set.
    // Log at warn level so operators can detect corrupted/missing data files.
    bootstrapLogger.warn(
      { err, path },
      'NL mapping file unavailable; starting with empty mapping set',
    );
    return EMPTY_STATE;
  }
}

/**
 * File-backed implementation of {@link MappingTablePort}.
 *
 * Loads NL-to-attribute mappings from a JSON file asynchronously. Callers have
 * two options:
 *
 *  1. **Preferred — async factory**: `await FileMappingTableAdapter.create(path)`
 *     loads the file at startup and returns a ready-to-use adapter with the
 *     mapping set cached in memory. Use this from async wiring paths.
 *
 *  2. **Legacy — sync constructor**: `new FileMappingTableAdapter(path)` kicks
 *     off the async load in the background. Every port method awaits the
 *     in-flight load promise before answering. No event-loop blocking I/O; the
 *     first call pays the load latency once and subsequent calls hit the
 *     cached state.
 *
 * Expected JSON shape:
 * ```json
 * { "version": "v1.0", "mappings": [ <NLMapping>, ... ] }
 * ```
 *
 * Default path: `<cwd>/data/nl-mappings.json`
 */
export class FileMappingTableAdapter implements MappingTablePort {
  private readonly statePromise: Promise<LoadedMappingState>;

  constructor(filePath?: string) {
    const path = filePath ?? resolveDataPath('data/nl-mappings.json');
    // Fire-and-cache: load asynchronously in the background. Port methods
    // await this promise, so there is no event-loop blocking I/O and callers
    // still see consistent results once the file has been parsed.
    this.statePromise = loadMappingStateFromFile(path);
  }

  /**
   * Async factory that preloads the mapping file before returning the adapter.
   *
   * Prefer this over `new FileMappingTableAdapter(path)` from async wiring
   * paths so the first request does not pay the load latency.
   */
  static async create(filePath?: string): Promise<FileMappingTableAdapter> {
    const adapter = new FileMappingTableAdapter(filePath);
    // Ensure the cache is warm before the adapter is handed out.
    await adapter.statePromise;
    return adapter;
  }

  async findMapping(phrase: string, version?: string): Promise<NLMapping | null> {
    const { mappings } = await this.statePromise;
    const lower = phrase.toLowerCase();
    return (
      mappings.find(
        (m) =>
          m.phrase.toLowerCase() === lower &&
          (version == null || m.mappingVersion === version),
      ) ?? null
    );
  }

  async findMappingsByAttribute(attribute: string): Promise<readonly NLMapping[]> {
    const { mappings } = await this.statePromise;
    return mappings.filter((m) => m.mappedAttribute === attribute);
  }

  async getCurrentVersion(): Promise<string> {
    const { version } = await this.statePromise;
    return version;
  }
}
