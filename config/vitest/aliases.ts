import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (`config/vitest` → `../..`). */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function vitestResolveAliases(): Record<string, string> {
  return {
    '@shared': path.join(repoRoot, 'src/domain/shared'),
    '@domain': path.join(repoRoot, 'src/domain'),
    '@app': path.join(repoRoot, 'src/application'),
    '@infra': path.join(repoRoot, 'src/infrastructure'),
    '@interface': path.join(repoRoot, 'src/interface'),
    '@config': path.join(repoRoot, 'src/config'),
  };
}
