#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { parseNdjson } from './ndjson.js';

const DEFAULT_INPUT = resolveDataPath('data/silver-docquery.ndjson');
const DEFAULT_OUTPUT = resolve(process.cwd(), 'src/domain/evaluation/service/region-parents.generated.ts');

interface Args {
  readonly input: string;
  readonly output: string;
}

interface RegionSnapshotRecord {
  readonly region?: string;
  readonly country?: string;
  readonly appellation?: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--input' || arg === '-i') && argv[i + 1] !== undefined) {
      input = argv[++i]!;
      continue;
    }
    if ((arg === '--output' || arg === '-o') && argv[i + 1] !== undefined) {
      output = argv[++i]!;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: tsx scripts/etl/generate-region-parents.ts [--input PATH] [--output PATH]',
          `  --input  default: ${DEFAULT_INPUT}`,
          `  --output default: ${DEFAULT_OUTPUT}`,
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
  }

  return { input, output };
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/œ/gu, 'oe')
    .replace(/æ/gu, 'ae')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueOrdered(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function splitRegionHierarchy(region: string): readonly string[] {
  return uniqueOrdered(
    region
      .split(' / ')
      .map((part) => normalizeKey(part))
      .filter((part) => part.length > 0),
  );
}

function updateCandidate(
  candidates: Map<string, Map<string, number>>,
  child: string,
  parents: readonly string[],
): void {
  if (child.length === 0 || parents.length === 0) return;
  const safeParents = uniqueOrdered(parents);
  if (safeParents.length === 0) return;
  const key = JSON.stringify(safeParents);
  const perChild = candidates.get(child) ?? new Map<string, number>();
  perChild.set(key, (perChild.get(key) ?? 0) + 1);
  candidates.set(child, perChild);
}

function deriveRegionParents(records: readonly RegionSnapshotRecord[]): Map<string, readonly string[]> {
  const candidates = new Map<string, Map<string, number>>();

  for (const record of records) {
    const country = typeof record.country === 'string' ? normalizeKey(record.country) : '';
    const regionChain =
      typeof record.region === 'string'
        ? splitRegionHierarchy(record.region)
        : [];
    const appellation =
      typeof record.appellation === 'string'
        ? normalizeKey(record.appellation)
        : '';

    if (country.length === 0 || regionChain.length === 0) continue;

    // Region paths in Silver snapshots are ordered broad -> narrow.
    // Convert to nearest-parent-first chains for ontology:
    //   "California / Sonoma County / Alexander Valley"
    //    -> alexander valley: [sonoma county, california, united states]
    for (let i = regionChain.length - 1; i >= 0; i--) {
      const child = regionChain[i]!;
      const parents = uniqueOrdered([...regionChain.slice(0, i).reverse(), country]);
      updateCandidate(candidates, child, parents);
    }

    if (appellation.length > 0) {
      const mostSpecificRegion = regionChain[regionChain.length - 1]!;
      const broaderRegions = regionChain.slice(0, -1).reverse();
      updateCandidate(candidates, appellation, uniqueOrdered([mostSpecificRegion, ...broaderRegions, country]));
    }
  }

  const selected = new Map<string, readonly string[]>();
  for (const [child, chains] of candidates) {
    let bestParents: readonly string[] | undefined;
    let bestVotes = -1;
    for (const [chainKey, votes] of chains) {
      const parsed = JSON.parse(chainKey) as string[];
      if (
        votes > bestVotes ||
        (votes === bestVotes && (bestParents === undefined || parsed.length > bestParents.length)) ||
        (votes === bestVotes &&
          bestParents !== undefined &&
          parsed.length === bestParents.length &&
          chainKey < JSON.stringify(bestParents))
      ) {
        bestVotes = votes;
        bestParents = parsed;
      }
    }
    if (bestParents !== undefined && bestParents.length > 0) {
      selected.set(child, bestParents);
    }
  }

  return new Map(
    [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderGeneratedModule(entries: readonly [string, readonly string[]][]): string {
  const rows = entries.map(([child, parents]) => {
    const parentList = parents.map((parent) => `'${parent.replace(/'/g, "\\'")}'`).join(', ');
    return `  ['${child.replace(/'/g, "\\'")}', [${parentList}]],`;
  });

  return [
    '/**',
    ' * Auto-generated region hierarchy extensions.',
    ' *',
    ' * Source of truth:',
    ' * - Generated from ETL snapshots via `scripts/etl/generate-region-parents.ts`.',
    ' *',
    ' * Generation rule:',
    ' * - This map MUST contain only deterministic child->ancestor chains derived',
    ' *   from explicit structured fields (`region`, `country`, `appellation`) in',
    ' *   snapshot data. No heuristic inference is allowed.',
    ' */',
    'export const GENERATED_REGION_PARENTS: ReadonlyMap<string, readonly string[]> = new Map([',
    ...rows,
    ']);',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.input, 'utf8');
  const { records } = parseNdjson<RegionSnapshotRecord>(raw, args.input);
  const generated = deriveRegionParents(records);
  const lines = [...generated.entries()];
  const content = renderGeneratedModule(lines);

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, content, 'utf8');

  process.stdout.write(
    `Generated ${lines.length} region parent entries from ${records.length} records -> ${args.output}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
