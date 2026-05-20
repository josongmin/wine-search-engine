#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createTestServer, closeTestServer } from '../../test/e2e/helpers/test-server.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

interface Args {
  input: string;
  output: string;
  tier: 'bronze' | 'silver' | 'gate';
  baselineReport?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    input: resolveDataPath('data/eval-smoke-queries.jsonl'),
    output: resolveDataPath('data/eval-results-smoke.json'),
    tier: 'bronze',
    baselineReport: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      out.input = resolveCliDataPathArg(argv[++index] ?? out.input);
    } else if (arg === '--output' || arg === '-o') {
      out.output = resolveCliDataPathArg(argv[++index] ?? out.output);
    } else if (arg === '--tier') {
      const tier = argv[++index];
      if (tier === 'bronze' || tier === 'silver' || tier === 'gate') {
        out.tier = tier;
      }
    } else if (arg === '--baseline-report') {
      const baselineReport = argv[++index];
      out.baselineReport = baselineReport === undefined
        ? undefined
        : resolveCliDataPathArg(baselineReport);
    }
  }

  return out;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await createTestServer();
  const address = await server.app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const url = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
    const child = spawn(
      'npx',
      [
        'tsx',
        path.resolve(process.cwd(), 'scripts/eval/run-offline-eval.ts'),
        '--input',
        args.input,
        '--output',
        args.output,
        '--tier',
        args.tier,
        ...(args.baselineReport !== undefined
          ? ['--baseline-report', args.baselineReport]
          : []),
      ],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          SEARCH_API_URL: url,
          EVAL_SEARCH_CONCURRENCY: '1',
          EVAL_SEARCH_TIMEOUT_MS: '5000',
          EVAL_SKIP_EMBEDDING_VALIDATION: 'true',
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
