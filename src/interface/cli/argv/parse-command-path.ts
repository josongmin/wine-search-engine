export interface CommandPath {
  readonly path: readonly string[];
  /** Tokens after the resolved command path — handed to the leaf parser. */
  readonly leafArgs: readonly string[];
}

export function parseCommandPath(
  rest: readonly string[],
  registeredPaths: readonly (readonly string[])[],
): CommandPath | null {
  const maxPrefixLength = Math.min(
    rest.length,
    registeredPaths.reduce((max, path) => Math.max(max, path.length), 0),
  );
  for (let prefixLength = maxPrefixLength; prefixLength >= 1; prefixLength -= 1) {
    const prefix = rest.slice(0, prefixLength);
    const matched = registeredPaths.find(
      (path) => path.length === prefixLength && path.every((token, index) => token === prefix[index]),
    );
    if (matched !== undefined) {
      return {
        path: [...matched],
        leafArgs: rest.slice(prefixLength),
      };
    }
  }
  return null;
}

export function hasCommandPathPrefix(
  rest: readonly string[],
  registeredPaths: readonly (readonly string[])[],
): boolean {
  return registeredPaths.some(
    (path) => rest.length < path.length && rest.every((token, index) => token === path[index]),
  );
}
