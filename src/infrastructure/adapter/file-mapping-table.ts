import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MappingTablePort } from '../../domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../domain/attribute/model/nl-mapping.js';
import { resolveDataPath } from '../../domain/shared/utils/data-paths.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

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
}).strict(); // Rule 10: external file data — reject unknown keys to surface schema drift early.

/** Max mappings to accept from a single file (domain bound: ~500 entities × 3 aliases). */
const MAX_MAPPINGS_FROM_FILE = 2000;

const NLMappingFileSchema = z.object({
  version: z.string(),
  generatedAt: z.string().optional(),
  mappingCount: z.number().int().nonnegative().optional(),
  mappings: z.array(NLMappingSchema).max(MAX_MAPPINGS_FROM_FILE),
}).strict();

interface LoadedMappingState {
  readonly mappings: readonly NLMapping[];
  readonly version: string;
}

async function loadMappingStateFromFile(path: string): Promise<LoadedMappingState> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const result = NLMappingFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    bootstrapLogger.error(
      { path, detail },
      'NL mapping file schema mismatch; refusing to boot with drifted runtime artifact',
    );
    throw new Error(`Invalid NL mapping file at ${path}: ${detail}`);
  }
  const mappingCount = result.data.mappingCount ?? result.data.mappings.length;
  if (mappingCount !== result.data.mappings.length) {
    throw new Error(
      `Invalid NL mapping file at ${path}: mappingCount=${mappingCount} but parsed=${result.data.mappings.length}`,
    );
  }
  return {
    mappings: result.data.mappings as readonly NLMapping[],
    version: result.data.version,
  };
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
