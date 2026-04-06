/**
 * Lists TypeScript files under `src/domain/` that appear unreferenced from elsewhere in `src/`.
 *
 * - Fast path: substring match for `domain/.../file.js` or `.../file.js` (no domain prefix).
 * - Precise path: resolve relative `from './...'` / `from '../...'` imports (TS uses `.js` specifiers).
 *
 * Barrel-only exports (`index.ts`) can still be "orphans" if nothing imports that barrel path;
 * dynamic imports and string-built paths are not followed.
 *
 * Usage: `npx tsx scripts/find-domain-orphans.ts`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const SRC_ROOT = join(import.meta.dirname, '../src');

function walkTsFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function isExcludedDomainFile(relFromSrc: string): boolean {
  return (
    relFromSrc.includes('/__tests__/') ||
    relFromSrc.endsWith('.test.ts') ||
    relFromSrc === 'domain/shared/types/index.ts'
  );
}

function resolveImportToSource(spec: string, importerAbs: string): string | null {
  if (!spec.startsWith('.')) return null;
  const resolved = resolve(dirname(importerAbs), spec);
  const asTs = resolved.replace(/\.js$/, '.ts');
  if (existsSync(asTs) && statSync(asTs).isFile()) {
    return normalize(asTs);
  }
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    return normalize(resolved);
  }
  return null;
}

const FROM_IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

function collectResolvedImports(importerAbs: string, content: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(FROM_IMPORT_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    const target = resolveImportToSource(spec, importerAbs);
    if (target !== null) {
      out.add(target);
    }
  }
  return out;
}

function main(): void {
  const allFiles: string[] = [];
  walkTsFiles(SRC_ROOT, allFiles);

  const domainFiles = allFiles
    .map((abs) => relative(SRC_ROOT, abs).replaceAll('\\', '/'))
    .filter((rel) => rel.startsWith('domain/') && rel.endsWith('.ts'))
    .filter((rel) => !isExcludedDomainFile(rel));

  /** importerAbs -> absolute paths of resolved relative imports */
  const importGraph = new Map<string, Set<string>>();
  for (const abs of allFiles) {
    const rel = relative(SRC_ROOT, abs).replaceAll('\\', '/');
    if (rel.includes('/__tests__/') || rel.endsWith('.test.ts')) continue;
    const content = readFileSync(abs, 'utf8');
    importGraph.set(abs, collectResolvedImports(abs, content));
  }

  const orphans: string[] = [];

  for (const rel of domainFiles) {
    const candidateAbs = normalize(join(SRC_ROOT, rel));
    const withoutDomainPrefix = rel.replace(/^domain\//, '');
    const needles = [
      `${withoutDomainPrefix.replace(/\.ts$/, '')}.js`,
      `domain/${withoutDomainPrefix.replace(/\.ts$/, '')}.js`,
    ];
    const others = allFiles.filter((abs) => relative(SRC_ROOT, abs).replaceAll('\\', '/') !== rel);
    const otherCorpus = others
      .map((abs) => readFileSync(abs, 'utf8'))
      .join('\n');
    const referencedByString = needles.some((n) => otherCorpus.includes(n));
    if (referencedByString) {
      continue;
    }
    let referencedByResolve = false;
    for (const [, targets] of importGraph) {
      if (targets.has(candidateAbs)) {
        referencedByResolve = true;
        break;
      }
    }
    if (!referencedByResolve) {
      orphans.push(rel);
    }
  }

  orphans.sort();
  const barrelIndexes = orphans.filter((o) => o.endsWith('/index.ts'));
  const nonBarrel = orphans.filter((o) => !o.endsWith('/index.ts'));

  if (nonBarrel.length === 0 && barrelIndexes.length === 0) {
    console.log('No orphan domain modules detected (heuristic).');
    return;
  }

  if (nonBarrel.length > 0) {
    console.log(
      `Likely unreferenced domain modules (${nonBarrel.length}) — verify before deleting:\n`,
    );
    for (const o of nonBarrel) {
      console.log(`  ${o}`);
    }
    process.exitCode = 1;
  }

  if (barrelIndexes.length > 0) {
    console.log(
      `\nBarrel index files with no direct path imports (${barrelIndexes.length}) — often OK if callers use deep paths:\n`,
    );
    for (const o of barrelIndexes) {
      console.log(`  ${o}`);
    }
  }
}

main();
