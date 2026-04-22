import fs from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../domain/query/service/anchor-extractor.js';
import {
  buildAliasLookupPlan,
  isPhoneticAliasSurfaceCompatible,
} from '../../domain/query/service/alias-lookup-plan.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';
import { buildHangulJamoKey } from '../../domain/shared/utils/hangul.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../health/search-snapshot-readiness.js';
import {
  isActiveSnapshotSubstrateBootstrapAllowed,
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

interface SnapshotAliasRecord {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
}

interface PgAliasRecord {
  readonly alias_id: string;
  readonly entity_id: string;
  readonly surface_form: string;
  readonly normalized_value: string;
  readonly source_trust: number;
  readonly confidence: number;
}

type AliasStrategy =
  | 'exact'
  | 'lexical_exact'
  | 'compact_exact'
  | 'transliterated_exact'
  | 'phonetic_exact'
  | 'transliterated_fuzzy'
  | 'hangul_ime_completion';

const MIN_WHOLE_TOKEN_LOOKUP_LENGTH = 4;

const LATIN_VOWEL_RE = /[aeiouy]/g;
const SnapshotAliasRecordSchema = z.object({
  aliasId: z.string().min(1),
  entityId: z.string().min(1),
  value: z.string().min(1),
  normalizedValue: z.string().min(1),
  sourceTrust: z.number(),
  confidencePrior: z.number(),
}).passthrough();
const SnapshotManifestSchema = z.object({
  artifacts: z.object({
    aliasesNdjson: z.string().min(1),
  }).passthrough().optional(),
}).passthrough();
const PHONETIC_NORMALIZATION_RULES: readonly [RegExp, string][] = [
  [/sch/g, 'ch'],
  [/sh/g, 'ch'],
  [/ph/g, 'f'],
  [/eaux/g, 'o'],
  [/eau/g, 'o'],
  [/aux/g, 'o'],
] as const;

function compactForLookup(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/)
    .filter(Boolean);
}

function phoneticCompactForLookup(value: string): string {
  let normalized = compactForLookup(value).toLowerCase();
  for (const [pattern, replacement] of PHONETIC_NORMALIZATION_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(LATIN_VOWEL_RE, '');
}

function parseNdjson(raw: string, filePath: string): readonly SnapshotAliasRecord[] {
  const rows: SnapshotAliasRecord[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const parsedRecord = SnapshotAliasRecordSchema.parse(parsed);
      rows.push(parsedRecord);
    } catch (error) {
      throw new Error(
        `Failed to parse NDJSON row ${index + 1} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return rows;
}

function parseAliasesManifestPath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const aliasesNdjson = manifest.artifacts?.aliasesNdjson;
  if (typeof aliasesNdjson !== 'string' || aliasesNdjson.length === 0) {
    throw new Error(`Malformed search snapshot manifest at ${manifestPath}: artifacts.aliasesNdjson is required`);
  }
  return aliasesNdjson;
}

function trimDedupedQueries(queries: readonly string[]): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const trimmed = query.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

type IndexedAliasRecord = SnapshotAliasRecord;

interface HangulCompletionAliasRecord {
  readonly alias: IndexedAliasRecord;
  readonly jamoKey: string;
  readonly syllableBoundaryOffsets: ReadonlySet<number>;
}

interface GroupedAliasMatch {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly entityIds: Set<string>;
  matchConfidence: number;
  readonly strategies: Set<string>;
}

export class SearchSnapshotAliasMatcher implements AliasMatcher {
  static async loadFromPostgres(pool: Pool): Promise<SearchSnapshotAliasMatcher | undefined> {
    try {
      const { activeSnapshotId } = await resolveActiveSnapshot(pool);
      const { rows } = await pool.query<PgAliasRecord>(
        `SELECT alias_id, entity_id, surface_form, normalized_value, source_trust, confidence
         FROM aliases
         WHERE search_snapshot_id = $1 AND is_suppressed = FALSE
         ORDER BY confidence DESC`,
        [activeSnapshotId],
      );
      const aliases = rows
        .filter((row) => (
          typeof row.alias_id === 'string' &&
          row.alias_id.length > 0 &&
          typeof row.entity_id === 'string' &&
          row.entity_id.length > 0 &&
          typeof row.surface_form === 'string' &&
          row.surface_form.length > 0 &&
          typeof row.normalized_value === 'string' &&
          row.normalized_value.length > 0
        ))
        .map((row) => ({
          aliasId: row.alias_id,
          entityId: row.entity_id,
          value: row.surface_form,
          normalizedValue: row.normalized_value,
          sourceTrust: Number.isFinite(row.source_trust) ? row.source_trust : 0,
          confidencePrior: Number.isFinite(row.confidence) ? row.confidence : 0,
        }));

      if (aliases.length === 0) {
        bootstrapLogger.info(
          {
            activeSnapshotId,
          },
          '[Container] Search snapshot alias overlay loaded from PostgreSQL but empty; falling back to search-index',
        );
        return undefined;
      }

      bootstrapLogger.info(
        {
          activeSnapshotId,
          aliasCount: aliases.length,
        },
        '[Container] Search snapshot alias overlay loaded from PostgreSQL into memory',
      );
      return new SearchSnapshotAliasMatcher(aliases);
    } catch (error: unknown) {
      if (!isActiveSnapshotSubstrateBootstrapAllowed()) {
        throw error;
      }
      bootstrapLogger.warn(
        {
          err: error,
        },
        '[Container] PostgreSQL alias overlay unavailable; falling back to search-index runtime substrate',
      );
      return undefined;
    }
  }

  static async loadFromRuntimeState(
    runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
  ): Promise<SearchSnapshotAliasMatcher | undefined> {
    try {
      const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
      const manifestRaw = await fs.readFile(runtimeState.manifestPath, 'utf8');
      const aliasesPath = parseAliasesManifestPath(manifestRaw, runtimeState.manifestPath);
      const aliasesRaw = await fs.readFile(aliasesPath, 'utf8');
      const aliases = parseNdjson(aliasesRaw, aliasesPath);
      bootstrapLogger.info(
        {
          snapshotId: runtimeState.snapshotId,
          aliasCount: aliases.length,
          runtimeStatePath,
        },
        '[Container] Search snapshot alias substrate loaded into memory',
      );
      return new SearchSnapshotAliasMatcher(aliases);
    } catch (error) {
      bootstrapLogger.warn(
        {
          runtimeStatePath,
          err: error,
        },
        '[Container] Search snapshot alias substrate unavailable; continuing without in-memory alias preload',
      );
      return undefined;
    }
  }

  private readonly exactIndex = new Map<string, readonly IndexedAliasRecord[]>();
  private readonly wholeTokenIndex = new Map<string, readonly IndexedAliasRecord[]>();
  private readonly compactIndex = new Map<string, readonly IndexedAliasRecord[]>();
  private readonly phoneticIndex = new Map<string, readonly IndexedAliasRecord[]>();
  private readonly hangulCompletionPrefixIndex = new Map<string, readonly HangulCompletionAliasRecord[]>();

  constructor(
    aliases: readonly SnapshotAliasRecord[],
  ) {
    for (const alias of aliases) {
      this.addToIndex(this.exactIndex, alias.normalizedValue, alias);
      for (const token of tokenizeForLookup(alias.normalizedValue)) {
        this.addToIndex(this.wholeTokenIndex, token, alias);
      }

      const compactValue = compactForLookup(alias.normalizedValue);
      if (compactValue.length > 0) {
        this.addToIndex(this.compactIndex, compactValue, alias);
      }

      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      if (phoneticValue.length > 0) {
        this.addToIndex(this.phoneticIndex, phoneticValue, alias);
      }

      for (const surface of this.buildHangulCompletionSurfaces(alias)) {
        this.addHangulCompletionSurface(alias, surface);
      }
    }
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const trimmedQueries = trimDedupedQueries(normalizedQueries);
    const matches = new Map<string, readonly AliasMatchResult[]>();
    for (const query of trimmedQueries) {
      matches.set(query, this.findMatchesSync(query));
    }
    return Promise.resolve(matches);
  }

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve(this.findMatchesSync(normalizedQuery));
  }

  private findMatchesSync(normalizedQuery: string): readonly AliasMatchResult[] {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const lookupPlan = buildAliasLookupPlan(trimmed);
    const {
      tokenList: tokens,
      compactList: compactTokens,
      transliteratedList: transliteratedTokens,
      phoneticList: phoneticTokens,
    } = lookupPlan;
    const exactSet = new Set(tokens);
    const compactSet = new Set(compactTokens);
    const transliteratedSet = new Set(transliteratedTokens);
    const phoneticSet = new Set(phoneticTokens);
    const candidateAliases = new Map<string, IndexedAliasRecord>();
    const grouped = new Map<string, GroupedAliasMatch>();

    for (const token of tokens) {
      for (const alias of this.exactIndex.get(token) ?? []) {
        candidateAliases.set(alias.aliasId, alias);
      }
      if (token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH && !token.includes(' ')) {
        for (const alias of this.wholeTokenIndex.get(token) ?? []) {
          candidateAliases.set(alias.aliasId, alias);
        }
      }
    }

    for (const token of compactTokens) {
      for (const alias of this.compactIndex.get(token) ?? []) {
        candidateAliases.set(alias.aliasId, alias);
      }
    }

    for (const token of phoneticTokens) {
      for (const alias of this.phoneticIndex.get(token) ?? []) {
        candidateAliases.set(alias.aliasId, alias);
      }
    }

    const hangulCompletionMatches = this.findHangulCompletionAliases(tokens);

    for (const alias of candidateAliases.values()) {
      const compactValue = compactForLookup(alias.normalizedValue);
      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      const hasWholeTokenMatch =
        tokens.some((token) => (
          token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH
          && !token.includes(' ')
          && tokenizeForLookup(alias.normalizedValue).includes(token)
        ));
      const strategy: AliasStrategy | null =
        transliteratedSet.has(alias.normalizedValue) || transliteratedSet.has(compactValue)
          ? 'transliterated_exact'
          : compactSet.has(compactValue)
            ? 'compact_exact'
            : hasWholeTokenMatch
              ? 'lexical_exact'
              : exactSet.has(alias.normalizedValue)
                ? 'exact'
                : phoneticSet.has(phoneticValue)
                  ? isPhoneticAliasSurfaceCompatible(trimmed, alias.value)
                    ? 'phonetic_exact'
                    : null
                  : null;
      if (strategy !== null) {
        this.upsertGrouped(grouped, alias, strategy);
      }
    }

    for (const match of hangulCompletionMatches) {
      this.upsertGrouped(grouped, match.alias, 'transliterated_fuzzy');
      this.upsertGrouped(grouped, match.alias, 'hangul_ime_completion');
    }

    return [...grouped.values()]
      .sort((left, right) => right.matchConfidence - left.matchConfidence)
      .map((match) => ({
        surfaceForm: match.surfaceForm,
        normalizedForm: match.normalizedForm,
        entityIds: [...match.entityIds].map((entityId) => createCanonicalEntityId(entityId)),
        matchConfidence: match.matchConfidence,
        lookupStrategy: [...match.strategies].sort().join('+'),
      }));
  }

  private addToIndex(
    index: Map<string, readonly IndexedAliasRecord[]>,
    key: string,
    alias: IndexedAliasRecord,
  ): void {
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, [alias]);
      return;
    }
    index.set(key, [...existing, alias]);
  }

  private addUniqueHangulCompletionPrefix(
    prefix: string,
    record: HangulCompletionAliasRecord,
  ): void {
    const existing = this.hangulCompletionPrefixIndex.get(prefix);
    if (existing === undefined) {
      this.hangulCompletionPrefixIndex.set(prefix, [record]);
      return;
    }
    if (existing.some((item) => item.alias.aliasId === record.alias.aliasId && item.jamoKey === record.jamoKey)) {
      return;
    }
    this.hangulCompletionPrefixIndex.set(prefix, [...existing, record]);
  }

  private buildHangulCompletionSurfaces(alias: IndexedAliasRecord): readonly string[] {
    const surfaces = new Set<string>();
    for (const value of [alias.value, alias.normalizedValue]) {
      const key = buildHangulJamoKey(value);
      if (key.containsHangul && key.key.length > 0) {
        surfaces.add(value);
      }

      const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(value);
      if (exceptionSurface !== undefined) {
        surfaces.add(exceptionSurface);
      }
    }
    return [...surfaces];
  }

  private addHangulCompletionSurface(
    alias: IndexedAliasRecord,
    surface: string,
  ): void {
    const key = buildHangulJamoKey(surface);
    if (!key.containsHangul || key.key.length === 0) {
      return;
    }

    const record: HangulCompletionAliasRecord = {
      alias,
      jamoKey: key.key,
      syllableBoundaryOffsets: key.syllableBoundaryOffsets,
    };

    for (let prefixLength = 1; prefixLength < key.key.length; prefixLength += 1) {
      if (key.syllableBoundaryOffsets.has(prefixLength)) {
        continue;
      }
      this.addUniqueHangulCompletionPrefix(key.key.slice(0, prefixLength), record);
    }
  }

  private findHangulCompletionAliases(
    tokens: readonly string[],
  ): readonly HangulCompletionAliasRecord[] {
    const matches = new Map<string, HangulCompletionAliasRecord>();
    for (const token of tokens) {
      const key = buildHangulJamoKey(token);
      if (
        !key.containsHangul ||
        key.key.length === 0 ||
        key.syllableCount < 2
      ) {
        continue;
      }

      for (const record of this.hangulCompletionPrefixIndex.get(key.key) ?? []) {
        if (!record.jamoKey.startsWith(key.key)) {
          continue;
        }
        if (record.syllableBoundaryOffsets.has(key.key.length) && !key.containsStandaloneJamo) {
          continue;
        }
        matches.set(`${record.alias.aliasId}\u0000${record.jamoKey}`, record);
      }
    }
    return [...matches.values()];
  }

  private upsertGrouped(
    grouped: Map<string, GroupedAliasMatch>,
    alias: IndexedAliasRecord,
    strategy: AliasStrategy,
  ): void {
    const key = `${alias.normalizedValue}\u0000${alias.value}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        surfaceForm: alias.value,
        normalizedForm: alias.normalizedValue,
        entityIds: new Set([alias.entityId]),
        matchConfidence: alias.confidencePrior,
        strategies: new Set([strategy]),
      });
      return;
    }

    existing.entityIds.add(alias.entityId);
    existing.strategies.add(strategy);
    if (alias.confidencePrior > existing.matchConfidence) {
      existing.matchConfidence = alias.confidencePrior;
    }
  }
}
