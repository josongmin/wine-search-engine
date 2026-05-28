#!/usr/bin/env node
import { runCli } from './run-cli.js';

/**
 * Thin CLI entrypoint. The shell owns the process exit; everything else lives
 * in `runCli`. We set `process.exitCode` (rather than calling `process.exit`)
 * so buffered stdout/stderr flushes before the process ends.
 */
void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
