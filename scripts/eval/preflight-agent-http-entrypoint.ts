#!/usr/bin/env tsx

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();

import { assertAgentHttpEntrypointReady } from './agent-fixture-runner-common.js';

interface CliArgs {
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://127.0.0.1:3000';
  let timeoutMs = 10_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--timeout-ms') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 1000) timeoutMs = parsed;
    }
  }

  return { apiUrl, timeoutMs };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await assertAgentHttpEntrypointReady(args.apiUrl, args.timeoutMs);
  console.log(`Agent HTTP entrypoint preflight passed: ${args.apiUrl.replace(/\/+$/u, '')}/v1/agent`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
