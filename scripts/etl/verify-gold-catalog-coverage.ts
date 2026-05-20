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

  const missing: string[] = [];
  for (const [caseId, target] of Object.entries(mapParsed.map)) {
    if (target == null) {
      continue;
    }
    if (isSourceRecordStylePublicEntityId(target)) {
      throw new Error(`target-entity-map references forbidden source-style id for ${caseId}: ${target}`);
    }
    if (!allowedIds.has(target)) {
      missing.push(`${caseId} → ${target}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Gold catalog coverage failed: target entity ids missing from canonical-entities.json:\n${missing.join('\n')}`,
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
