#!/usr/bin/env node
import { runCli } from './run-cli.js';

function normalizeCliArgs(argv: readonly string[]): readonly string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

/**
 * Thin CLI entrypoint. The shell owns the process exit; everything else lives
 * in `runCli`. We set `process.exitCode` (rather than calling `process.exit`)
 * so buffered stdout/stderr flushes before the process ends.
 */
void runCli(normalizeCliArgs(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
