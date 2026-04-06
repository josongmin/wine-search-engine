import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildHttpRouteContractOpenApiBridge } from '../src/interface/http/routes/http-route-contract-openapi.js';

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  const document = buildHttpRouteContractOpenApiBridge();
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  if (outputPath === undefined) {
    process.stdout.write(serialized);
    return;
  }

  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, serialized, 'utf8');
  process.stdout.write(`${resolved}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
