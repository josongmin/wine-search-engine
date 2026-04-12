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
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

const DEFAULT_INPUT_PATH = resolve(process.cwd(), 'data/entity-ontology.json');
const DEFAULT_OUTPUT_PATH = resolveDataPath('data/nl-mappings.json');

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

interface Args {
  readonly inputPath: string;
  readonly outputPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  let inputPath = DEFAULT_INPUT_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      inputPath = argv[index + 1] ?? inputPath;
      index += 1;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = argv[index + 1] ?? outputPath;
      index += 1;
    }
  }

  return { inputPath, outputPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`Reading ontology from ${args.inputPath}\n`);

  let raw: string;
  try {
    raw = await readFile(args.inputPath, 'utf8');
  } catch {
    process.stderr.write(`Error: Could not read ${args.inputPath}. Run generate-entity-ontology.ts first.\n`);
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

  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${mappings.length} NL mappings to ${args.outputPath}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
