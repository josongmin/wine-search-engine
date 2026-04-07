#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createTestServer, closeTestServer } from '../../test/e2e/helpers/test-server.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

interface Args {
  input?: string;
  allowFullDataset: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let input: string | undefined;
  let allowFullDataset = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      input = argv[index + 1];
      index += 1;
    } else if (arg === '--allow-full-dataset') {
      allowFullDataset = true;
    }
  }

  return { input, allowFullDataset };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const defaultInput = resolveDataPath('data/golden-queries-bronze.jsonl');
  const selectedInput = args.input ?? defaultInput;

  if (selectedInput === defaultInput && !args.allowFullDataset) {
    console.error(
      [
        'Refusing to run local full offline eval against the in-memory test server.',
        'The local harness only contains a tiny fixture corpus, so the 500-query bronze set produces misleading near-zero metrics.',
        'Use `npm run eval:offline:smoke:local` for fixture-compatible local verification,',
        'or rerun with `--allow-full-dataset` if you explicitly want mismatch diagnostics.',
      ].join(' '),
    );
    process.exitCode = 1;
    return;
  }

  const server = await createTestServer();
  const address = await server.app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const url = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
    const child = spawn(
      'npx',
      [
        'tsx',
        path.resolve(process.cwd(), 'scripts/eval/run-offline-eval.ts'),
        ...process.argv.slice(2),
      ],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          SEARCH_API_URL: url,
          EVAL_SKIP_EMBEDDING_VALIDATION: process.env['EVAL_SKIP_EMBEDDING_VALIDATION'] ?? 'true',
          EVAL_RUNTIME_TARGET: 'in_memory_test_server',
        },
      },
    );

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } finally {
    await closeTestServer(server);
  }
}

void run();
