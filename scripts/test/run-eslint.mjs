#!/usr/bin/env node

import { spawn } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);

const child = spawn(
  process.execPath,
  [
    './node_modules/eslint/bin/eslint.js',
    '--cache',
    '--cache-location',
    '.cache/eslint/changed',
    '--no-warn-ignored',
    ...forwardedArgs,
  ],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
