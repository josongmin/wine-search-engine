/**
 * stdout/stderr seam for the CLI shell. All output flows through here so the
 * renderer never touches `console.*` (banned in src/) and tests can capture
 * output without monkey-patching `process`.
 */
export interface CliIo {
  write(chunk: string): void;
  writeError(chunk: string): void;
}

export const realCliIo: CliIo = {
  write(chunk: string): void {
    process.stdout.write(chunk);
  },
  writeError(chunk: string): void {
    process.stderr.write(chunk);
  },
};
