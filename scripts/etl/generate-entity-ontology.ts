import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildOntologySnapshot } from '../../src/domain/attribute/service/ontology-snapshot.js';

const OUTPUT_PATH = resolve(process.cwd(), 'data/entity-ontology.json');

async function main(): Promise<void> {
  const snapshot = buildOntologySnapshot();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ontology snapshot to ${OUTPUT_PATH}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
