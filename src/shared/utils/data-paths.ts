import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const HOME_DATA_DIR = resolve(homedir(), '.wine-search-engine', 'data');
const REPO_DATA_DIR = resolve(process.cwd(), 'data');

export function getWineDataDir(): string {
  const configured = process.env['WINE_DATA_DIR']?.trim();
  if (configured && configured.length > 0) {
    return resolve(configured);
  }

  if (existsSync(HOME_DATA_DIR)) {
    return HOME_DATA_DIR;
  }

  return REPO_DATA_DIR;
}

export function resolveDataPath(pathLike: string): string {
  if (isAbsolute(pathLike)) {
    return pathLike;
  }

  const dataDir = getWineDataDir();
  const normalized = pathLike.startsWith('data/') ? pathLike.slice('data/'.length) : pathLike;
  const resolved = resolve(dataDir, normalized);

  // Path containment check: prevent "../" traversal escaping the data directory
  if (!resolved.startsWith(dataDir + sep) && resolved !== dataDir) {
    throw new Error(
      `Path traversal blocked: "${pathLike}" resolves outside data directory "${dataDir}"`,
    );
  }

  return resolved;
}
