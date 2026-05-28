import type { CommandResult } from '../context/command-result.js';

/**
 * Output formats the CLI renderer contract promises. `--json` is a stable
 * scripting contract from day one. `table`/`yaml`/`raw` are fleshed out by
 * the renderer adapters in T-CLI-04; the kernel only fixes the enum so the
 * global-args parser and command surface agree on the same set.
 */
export type OutputFormat = 'human' | 'json' | 'table' | 'yaml' | 'raw';

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  'human',
  'json',
  'table',
  'yaml',
  'raw',
];

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Renders a {@link CommandResult} to the chosen format. Implementations live
 * in the interface/infrastructure layers and own all stdout/stderr writes —
 * commands and facades never render.
 */
export interface OutputRenderer {
  render(result: CommandResult, format: OutputFormat): void;
}
