#!/usr/bin/env node

import { spawn } from 'node:child_process';

const rawArgs = process.argv.slice(2);
let emptyExitCode = null;
const forwardedCliArgs = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--empty-exit-code') {
    emptyExitCode = Number(rawArgs[i + 1] ?? '');
    i += 1;
    continue;
  }
  forwardedCliArgs.push(arg);
}

const [mode, config, ...forwardedArgs] = forwardedCliArgs;

if (!mode || !config) {
  console.error('Usage: node scripts/test/run-vitest-lane.mjs [--empty-exit-code N] <run|related> <config> [vitest args...]');
  process.exit(1);
}

let sawNoTestsMessage = false;
const child = spawn(
  process.execPath,
  [
    './node_modules/vitest/vitest.mjs',
    mode,
    '--configLoader',
    'runner',
    '--config',
    config,
    ...forwardedArgs,
  ],
  {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: process.env,
  },
);

for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream?.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('No test files found')) {
      sawNoTestsMessage = true;
    }
    target.write(chunk);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if ((code ?? 0) === 0 && sawNoTestsMessage && emptyExitCode !== null && Number.isInteger(emptyExitCode)) {
    process.exit(emptyExitCode);
  }
  process.exit(code ?? 1);
});
