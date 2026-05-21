import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function main(): Promise<number> {
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
  return 0;
}

const isCliEntrypoint =
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isCliEntrypoint) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message
        = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
