import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MappingTablePort } from '../../domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../domain/attribute/model/nl-mapping.js';

interface MappingTableFile {
  readonly version: string;
  readonly mappings: readonly NLMapping[];
}

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
    const path = filePath ?? resolve(process.cwd(), 'data/nl-mappings.json');
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MappingTableFile>;
      this.version = parsed.version ?? 'v1.0';
      this.mappings = parsed.mappings ?? [];
    } catch {
      // File missing or unreadable — start with empty mapping set.
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
