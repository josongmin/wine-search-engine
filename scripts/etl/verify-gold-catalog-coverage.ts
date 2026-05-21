#!/usr/bin/env tsx
/**
 * ADR-007 gate: every non-null target in goldens/target-entity-map.json must
 * reference an entity_id present in goldens/canonical-entities.json.
 *
 * Optional: --entities-ndjson PATH — each JSON line must have entityId not
 * prefixed with `vivino-` (namespace seal for snapshot artifacts).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { z } from 'zod';

import { parseNdjson } from './ndjson.js';
import { loadGoldCanonicalLookup, resolveDefaultFixtureRepoRoot } from './snapshot-entity-identity.js';
import { isSourceRecordStylePublicEntityId } from '../../src/domain/shared/constants/public-entity-id-namespace.js';

const TargetMapSchema = z
  .object({
    map: z.record(z.string(), z.string().nullable()),
  })
  .passthrough();

interface CliArgs {
  readonly fixtureRepoRoot?: string | undefined;
  readonly entitiesNdjson?: string | undefined;
}

/**
 * Result of a set-theoretic catalog coverage check (golden ⊆ snapshot).
 */
export interface CatalogCoverage {
  /** Count of distinct golden ids present in the snapshot set. */
  readonly covered: number;
  /**
   * Distinct golden ids absent from the snapshot, in first-seen order of the
   * golden input (deterministic, dedup'd, verbatim — no normalization).
   */
  readonly missing: readonly string[];
  /**
   * covered / |distinct golden|, always in [0, 1]. Empty golden ⇒ 1.0
   * (vacuous full coverage).
   */
  readonly coverageRatio: number;
}

/**
 * Pure core of the ADR-007 gate: does every golden ground-truth entity_id
 * appear in the published snapshot set?
 *
 * Set-theoretic and deterministic — `golden`/`snapshot` are treated as sets
 * (duplicates collapse). `missing` is reported in first-seen golden order so
 * the result is byte-stable for identical inputs. Ids are compared and
 * surfaced verbatim (no NFC folding, no transliteration) so Korean and
 * accented canonical ids round-trip exactly.
 */
export function computeCatalogCoverage(
  goldenIds: readonly string[],
  snapshotIds: readonly string[],
): CatalogCoverage {
  const snapshotSet = new Set(snapshotIds);
  const seen = new Set<string>();
  const missing: string[] = [];
  let covered = 0;
  for (const id of goldenIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (snapshotSet.has(id)) {
      covered += 1;
    } else {
      missing.push(id);
    }
  }
  const distinctGolden = seen.size;
  // Empty golden ⇒ vacuous full coverage (nothing required, nothing missing).
  const coverageRatio = distinctGolden === 0 ? 1 : covered / distinctGolden;
  return { covered, missing, coverageRatio };
}

function parseArgs(argv: readonly string[]): CliArgs {
  let fixtureRepoRoot: string | undefined;
  let entitiesNdjson: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1];
      i += 1;
    } else if (arg === '--entities-ndjson') {
      entitiesNdjson = argv[i + 1];
      i += 1;
    }
  }
  return { fixtureRepoRoot, entitiesNdjson };
}

function resolveFixtureRoot(args: CliArgs): string {
  if (args.fixtureRepoRoot != null && args.fixtureRepoRoot.length > 0) {
    const root = normalize(
      isAbsolute(args.fixtureRepoRoot) ? args.fixtureRepoRoot : resolve(args.fixtureRepoRoot),
    );
    if (!existsSync(root)) {
      throw new Error(`--fixture-repo path does not exist: ${root}`);
    }
    return root;
  }
  const def = resolveDefaultFixtureRepoRoot();
  if (def == null) {
    throw new Error(
      'Fixture repo not found: set FIXTURE_REPO_PATH or --fixture-repo, or clone wine-engine-fixture as a sibling.',
    );
  }
  return def;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveFixtureRoot(args);
  const goldLookup = await loadGoldCanonicalLookup(root);
  const allowedIds = new Set(goldLookup.values());

  const mapPath = join(root, 'goldens', 'target-entity-map.json');
  const mapRaw = await readFile(mapPath, 'utf8');
  const mapParsed = TargetMapSchema.parse(JSON.parse(mapRaw) as unknown);

  const goldenTargets: string[] = [];
  const targetToCaseIds = new Map<string, string[]>();
  for (const [caseId, target] of Object.entries(mapParsed.map)) {
    if (target == null) {
      continue;
    }
    if (isSourceRecordStylePublicEntityId(target)) {
      throw new Error(`target-entity-map references forbidden source-style id for ${caseId}: ${target}`);
    }
    goldenTargets.push(target);
    const cases = targetToCaseIds.get(target);
    if (cases == null) {
      targetToCaseIds.set(target, [caseId]);
    } else {
      cases.push(caseId);
    }
  }

  const coverage = computeCatalogCoverage(goldenTargets, [...allowedIds]);

  if (coverage.missing.length > 0) {
    const detail = coverage.missing
      .flatMap((target) => (targetToCaseIds.get(target) ?? []).map((caseId) => `${caseId} → ${target}`))
      .join('\n');
    throw new Error(
      `Gold catalog coverage failed: target entity ids missing from canonical-entities.json:\n${detail}`,
    );
  }

  if (args.entitiesNdjson != null) {
    const raw = await readFile(args.entitiesNdjson, 'utf8');
    const { records } = parseNdjson<{ readonly entityId?: string }>(raw, args.entitiesNdjson);
    for (const row of records) {
      const id = row.entityId;
      if (id == null || id.length === 0) {
        throw new Error(`entities NDJSON row missing entityId in ${args.entitiesNdjson}`);
      }
      if (isSourceRecordStylePublicEntityId(id)) {
        throw new Error(`Namespace seal: entityId must not use vivino- prefix: ${id}`);
      }
    }
  }

  console.log(
    JSON.stringify({
      result: 'passed',
      fixture_root: root,
      target_non_null_count: Object.values(mapParsed.map).filter((v) => v != null).length,
      entities_ndjson_scanned: args.entitiesNdjson ?? null,
    }),
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
