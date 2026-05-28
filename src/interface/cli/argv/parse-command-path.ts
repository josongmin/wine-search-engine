export interface CommandPath {
  readonly group: string;
  readonly name: string;
  /** Tokens after `<group> <name>` — handed to the leaf command's own parser. */
  readonly leafArgs: readonly string[];
}

/**
 * Resolves the `<group> <name>` command path from the leftover tokens. Returns
 * `null` when a full path is not present (no tokens, or group without a leaf
 * name), so the shell can fall back to help or a usage error.
 */
export function parseCommandPath(rest: readonly string[]): CommandPath | null {
  const group = rest[0];
  const name = rest[1];
  if (group === undefined || name === undefined) {
    return null;
  }
  return { group, name, leafArgs: rest.slice(2) };
}
