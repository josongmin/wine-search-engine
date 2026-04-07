import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

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

  const normalized = pathLike.startsWith('data/') ? pathLike.slice('data/'.length) : pathLike;
  return resolve(getWineDataDir(), normalized);
}

export function getDefaultWineDataDir(): string {
  return HOME_DATA_DIR;
}
