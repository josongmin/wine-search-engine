import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

const DATA_PATH_PREFIX_PATTERN = /^data(?:[\\/]|$)/u;

/**
 * CLI args may still pass repo-relative `data/...` paths.
 * Route those through the shared data dir so eval artifacts stay outside the repo
 * when `~/.wine-search-engine/data` is active.
 */
export function resolveCliDataPathArg(pathLike: string): string {
  if (DATA_PATH_PREFIX_PATTERN.test(pathLike)) {
    return resolveDataPath(pathLike);
  }

  return pathLike;
}
