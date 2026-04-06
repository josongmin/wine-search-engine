import path from 'node:path';
import { access } from 'node:fs/promises';

async function main(): Promise<void> {
  const modelDir = process.argv[2];
  if (modelDir === undefined || modelDir.trim().length === 0) {
    throw new Error('Usage: tsx scripts/verify-drinking-window-model.ts <model-dir>');
  }

  const resolved = path.resolve(modelDir);
  const startPath = path.join(resolved, 'window_start.onnx');
  const endPath = path.join(resolved, 'window_end.onnx');

  await access(startPath);
  await access(endPath);

  process.stdout.write(`${resolved}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
