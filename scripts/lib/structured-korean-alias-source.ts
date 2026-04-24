import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WINES } from '../seed-wines-real.js';

const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');
const SILVER_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'silver-phase2-test.ndjson');
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;

export type StructuredKoreanAliasSourceProvenance =
  | 'gold_catalog'
  | 'seed_catalog'
  | 'silver_catalog';

export interface StructuredKoreanAliasSourceRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly koreanAliases: readonly string[];
  readonly provenance: StructuredKoreanAliasSourceProvenance;
}

interface GoldCatalogRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly koreanAliases?: readonly string[] | undefined;
}

interface SilverCatalogRow {
  readonly sourceId: string;
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly aliases?: {
    readonly identitySafeProjection?: readonly string[] | undefined;
  } | undefined;
}

function filterHangulAliases(aliases: readonly string[]): readonly string[] {
  return aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && HANGUL_RE.test(alias));
}

export async function loadGoldStructuredKoreanAliasSourceRows():
Promise<readonly StructuredKoreanAliasSourceRow[]> {
  const raw = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldCatalogRow)
    .map((row) => ({
      entityId: row.entityId,
      canonicalLabel: row.canonicalLabel,
      producer: row.producer,
      koreanAliases: filterHangulAliases(row.koreanAliases ?? []),
      provenance: 'gold_catalog' as const,
    }))
    .filter((row) => row.koreanAliases.length > 0);
}

export function loadSeedStructuredKoreanAliasSourceRows():
readonly StructuredKoreanAliasSourceRow[] {
  return WINES
    .map((wine) => ({
      entityId: String(wine.entityId),
      canonicalLabel: wine.canonicalLabel,
      producer: wine.producer,
      koreanAliases: filterHangulAliases(wine.aliasesIdentitySafe ?? []),
      provenance: 'seed_catalog' as const,
    }))
    .filter((row) => row.koreanAliases.length > 0);
}

export async function loadSilverStructuredKoreanAliasSourceRows():
Promise<readonly StructuredKoreanAliasSourceRow[]> {
  const raw = await fs.readFile(SILVER_CATALOG_PATH, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SilverCatalogRow)
    .map((row) => ({
      entityId: row.sourceId,
      canonicalLabel: row.canonicalLabel,
      producer: row.producer,
      koreanAliases: filterHangulAliases(row.aliases?.identitySafeProjection ?? []),
      provenance: 'silver_catalog' as const,
    }))
    .filter((row) => row.koreanAliases.length > 0);
}
