import fs from 'node:fs/promises';
import { z } from 'zod';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../domain/query/service/anchor-extractor.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../health/search-snapshot-readiness.js';

interface SnapshotAliasRecord {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
}

type AliasStrategy =
  | 'exact'
  | 'compact_exact'
  | 'transliterated_exact'
  | 'phonetic_exact';

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

function buildLookupTokens(query: string): {
  readonly tokens: readonly string[];
  readonly compactTokens: readonly string[];
  readonly transliteratedTokens: readonly string[];
  readonly phoneticTokens: readonly string[];
} {
  const views = buildNormalizedQueryViews(query);
  const words = views.punctuationStripped.split(/\s+/).filter(Boolean);
  const tokens = new Set<string>();
  const compactTokens = new Set<string>();
  const transliteratedTokens = new Set<string>();
  const phoneticTokens = new Set<string>();

  for (const value of views.lookupVariants) {
    if (value.length > 0) {
      tokens.add(value);
      if (value !== views.compact) {
        compactTokens.add(compactForLookup(value));
      }
    }
  }
  if (views.compact.length > 0) {
    compactTokens.add(views.compact);
  }
  if (views.transliterated !== undefined && views.transliterated.length > 0) {
    transliteratedTokens.add(views.transliterated);
    transliteratedTokens.add(compactForLookup(views.transliterated));
  }
  if (views.phoneticCompact !== undefined && views.phoneticCompact.length > 0) {
    phoneticTokens.add(views.phoneticCompact);
  }
  for (const word of words) {
    if (word.length >= 2) {
      tokens.add(word);
      compactTokens.add(word.replace(/\s+/g, ''));
    }
  }
  for (let i = 0; i < words.length - 1; i += 1) {
    const left = words[i];
    const right = words[i + 1];
    if (left !== undefined && right !== undefined) {
      const bigram = `${left} ${right}`;
      tokens.add(bigram);
      compactTokens.add(bigram.replace(/\s+/g, ''));
    }
  }

  return {
    tokens: [...tokens],
    compactTokens: [...compactTokens].filter((token) => token.length > 0),
    transliteratedTokens: [...transliteratedTokens].filter((token) => token.length > 0),
    phoneticTokens: [...phoneticTokens].filter((token) => token.length > 0),
  };
}

type IndexedAliasRecord = SnapshotAliasRecord;

interface GroupedAliasMatch {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly entityIds: Set<string>;
  matchConfidence: number;
  readonly strategies: Set<string>;
}

export class SearchSnapshotAliasMatcher implements AliasMatcher {
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
  private readonly compactIndex = new Map<string, readonly IndexedAliasRecord[]>();
  private readonly phoneticIndex = new Map<string, readonly IndexedAliasRecord[]>();

  constructor(
    aliases: readonly SnapshotAliasRecord[],
  ) {
    for (const alias of aliases) {
      this.addToIndex(this.exactIndex, alias.normalizedValue, alias);

      const compactValue = compactForLookup(alias.normalizedValue);
      if (compactValue.length > 0) {
        this.addToIndex(this.compactIndex, compactValue, alias);
      }

      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      if (phoneticValue.length > 0) {
        this.addToIndex(this.phoneticIndex, phoneticValue, alias);
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

    const {
      tokens,
      compactTokens,
      transliteratedTokens,
      phoneticTokens,
    } = buildLookupTokens(trimmed);
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

    for (const alias of candidateAliases.values()) {
      const compactValue = compactForLookup(alias.normalizedValue);
      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      const strategy: AliasStrategy | null =
        transliteratedSet.has(alias.normalizedValue) || transliteratedSet.has(compactValue)
          ? 'transliterated_exact'
          : compactSet.has(compactValue)
            ? 'compact_exact'
            : exactSet.has(alias.normalizedValue)
              ? 'exact'
              : phoneticSet.has(phoneticValue)
                ? 'phonetic_exact'
                : null;
      if (strategy !== null) {
        this.upsertGrouped(grouped, alias, strategy);
      }
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
