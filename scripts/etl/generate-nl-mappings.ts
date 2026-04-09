/**
 * RFC-019 Phase 3: Generate NL mappings from the versioned entity ontology.
 *
 * Reads data/entity-ontology.json and produces data/nl-mappings.json,
 * which maps natural-language surface forms (including Korean) to
 * canonical entity identifiers.
 *
 * Usage: npx tsx scripts/etl/generate-nl-mappings.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const INPUT_PATH = resolve(process.cwd(), 'data/entity-ontology.json');
const OUTPUT_PATH = resolve(process.cwd(), 'data/nl-mappings.json');

interface NLMapping {
  readonly surface: string;
  readonly entityId: string;
  readonly canonical: string;
  readonly entityType: string;
}

interface OntologyEntity {
  readonly id: string;
  readonly type: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
}

interface OntologyFile {
  readonly version: string;
  readonly entities: Readonly<Record<string, OntologyEntity>>;
}

async function main(): Promise<void> {
  process.stdout.write(`Reading ontology from ${INPUT_PATH}\n`);

  let raw: string;
  try {
    raw = await readFile(INPUT_PATH, 'utf8');
  } catch {
    process.stderr.write(`Error: Could not read ${INPUT_PATH}. Run generate-entity-ontology.ts first.\n`);
    process.exitCode = 1;
    return;
  }

  const ontology: unknown = JSON.parse(raw);
  if (
    typeof ontology !== 'object' ||
    ontology === null ||
    !('entities' in ontology) ||
    !('version' in ontology)
  ) {
    process.stderr.write('Error: Invalid ontology file structure.\n');
    process.exitCode = 1;
    return;
  }

  const typed = ontology as OntologyFile;
  const mappings: NLMapping[] = [];

  for (const entity of Object.values(typed.entities)) {
    if (entity === undefined) continue;

    for (const alias of entity.aliases) {
      mappings.push({
        surface: alias.toLowerCase().normalize('NFKC'),
        entityId: entity.id,
        canonical: entity.canonical,
        entityType: entity.type,
      });
    }
  }

  // Sort for deterministic output
  mappings.sort((left, right) =>
    left.surface.localeCompare(right.surface) || left.entityId.localeCompare(right.entityId),
  );

  const output = {
    version: typed.version,
    generatedAt: new Date().toISOString(),
    mappingCount: mappings.length,
    mappings,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${mappings.length} NL mappings to ${OUTPUT_PATH}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
