import fs from 'node:fs/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  AliasMatchResult,
  AliasMatcher,
  AliasLookupOptions,
} from '../../domain/query/service/anchor-extractor.js';
import {
  buildAliasSurfaceLookupPlan,
  isPhoneticAliasSurfaceCompatible,
} from '../../domain/query/service/alias-lookup-plan.js';
import {
  buildAliasPrefixTerms,
  isEligiblePrefixQuery,
  isDisallowedWholeLeadingTokenExpansion,
  matchesAliasPrefixTerm,
} from '../../domain/query/service/alias-prefix-terms.js';
import {
  resolveAliasMatchConfidence,
  type AliasMatchConfidenceStrategy,
} from '../../domain/query/service/alias-match-confidence.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import {
  compactForLookup,
  phoneticCompactForLookup,
} from '../../domain/query/service/phonetic-skeleton.js';
import { Transliterator } from '../../domain/alias/service/transliterator.js';
import { doubleMetaphoneKeys } from '../../domain/alias/service/double-metaphone.js';
import { buildHangulJamoKey } from '../../domain/shared/utils/hangul.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { AliasType } from '../../domain/alias/model/alias.js';
import { parseAliasType, ALIAS_TYPES } from '../../domain/alias/model/alias.js';
import { pickHigherTrustAliasType } from '../../domain/alias/service/conflict-resolver.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';
import {
  DEFAULT_RUNTIME_STATE_PATH,
  loadSearchSnapshotRuntimeState,
} from '../health/search-snapshot-readiness.js';
import {
  resolveActiveSnapshot,
} from '../db/active-snapshot-resolver.js';

interface SnapshotAliasRecord {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceTrust: number;
  readonly confidencePrior: number;
  /**
   * RFC-003 §4 alias type. Optional during incremental ingest migration;
   * older snapshot artifacts may omit it, in which case the matcher emits
   * no `aliasType` and the resolver scorer falls back to strategy-based
   * inference (`inferAliasType` in search-usecase-resolver-candidates.ts).
   *
   * The explicit `| undefined` is required for zod's `.optional()` parse
   * shape under `exactOptionalPropertyTypes`.
   */
  readonly aliasType?: AliasType | undefined;
  /**
   * Legacy snapshot artifacts stored the RFC-003 discriminator on `type`
   * instead of `aliasType`. Runtime loaders normalize it at read time so
   * old artifacts remain identity-safe.
   */
  readonly type?: string | undefined;
}

interface PgAliasRecord {
  readonly alias_id: string;
  readonly entity_id: string;
  readonly surface_form: string;
  readonly normalized_value: string;
  readonly source_trust: number;
  readonly confidence: number;
  readonly alias_type?: string;
}

type AliasStrategy = AliasMatchConfidenceStrategy;

const MIN_WHOLE_TOKEN_LOOKUP_LENGTH = 4;

/**
 * Reused empty Double Metaphone keyset for aliases that don't produce
 * Latin-script phonetic codes (Hangul-only aliases, etc.). Module-scope
 * to avoid per-iteration allocation during the strategy decision loop.
 */
const EMPTY_DM_KEYSET: ReadonlySet<string> = new Set<string>();

type ConnectablePool = Pool & {
  connect: Pool['connect'];
};

function hasConnect(pool: Pool): pool is ConnectablePool {
  return typeof pool.connect === 'function';
}

const SnapshotAliasRecordSchema = z.object({
  aliasId: z.string().min(1),
  entityId: z.string().min(1),
  value: z.string().min(1),
  normalizedValue: z.string().min(1),
  sourceTrust: z.number(),
  confidencePrior: z.number(),
  aliasType: z.enum(ALIAS_TYPES).optional(),
  type: z.string().min(1).optional(),
}).passthrough();
const SnapshotManifestSchema = z.object({
  artifacts: z.object({
    aliasesNdjson: z.string().min(1),
  }).passthrough().optional(),
}).passthrough();

// Phonetic skeleton (compactForLookup / phoneticCompactForLookup /
// PHONETIC_NORMALIZATION_RULES / LATIN_VOWEL_RE) is the SSoT in
// `@domain/query/service/phonetic-skeleton`.

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeStoredAliasValue(value: string): string {
  return buildNormalizedQueryViews(value).strict;
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort('PostgreSQL alias overlay load timeout');
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
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
      const aliasType = parseAliasType(parsedRecord.aliasType ?? parsedRecord.type);
      rows.push({
        aliasId: parsedRecord.aliasId,
        entityId: parsedRecord.entityId,
        value: parsedRecord.value,
        normalizedValue: parsedRecord.normalizedValue,
        sourceTrust: parsedRecord.sourceTrust,
        confidencePrior: parsedRecord.confidencePrior,
        ...(aliasType !== undefined ? { aliasType } : {}),
      });
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

interface PrefixLookupRecord {
  readonly alias: IndexedAliasRecord;
  readonly prefixTerms: readonly string[];
}

interface GroupedAliasMatch {
  readonly surfaceForm: string;
  readonly normalizedForm: string;
  readonly entityIds: Set<string>;
  matchConfidence: number;
  readonly strategies: Set<string>;
  aliasType: AliasType | undefined;
}

export class SearchSnapshotAliasMatcher implements AliasMatcher {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotAliasMatcher | undefined> {
    try {
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const aliasesPath = parseAliasesManifestPath(manifestRaw, manifestPath);
      const aliasesRaw = await fs.readFile(aliasesPath, 'utf8');
      const aliases = parseNdjson(aliasesRaw, aliasesPath);
      const buildStartedAt = Date.now();
      const matcher = new SearchSnapshotAliasMatcher(aliases);
      matcher.warmBroadRecallIndexes();
      bootstrapLogger.info(
        {
          manifestPath,
          aliasCount: aliases.length,
          buildMs: Date.now() - buildStartedAt,
        },
        '[Container] Search snapshot alias substrate loaded from manifest into memory',
      );
      return matcher;
    } catch (error) {
      bootstrapLogger.warn(
        {
          manifestPath,
          err: error,
        },
        '[Container] Search snapshot alias manifest unavailable; continuing without in-memory alias preload',
      );
      return undefined;
    }
  }

  static async loadFromPostgres(
    pool: Pool,
    snapshotIdOverride?: string,
    options?: { readonly queryTimeoutMs?: number },
  ): Promise<SearchSnapshotAliasMatcher | undefined> {
    const queryTimeoutMs = options?.queryTimeoutMs;
    const resolveActiveSnapshotOptions = queryTimeoutMs === undefined
      ? undefined
      : { queryTimeoutMs };
    const timed = queryTimeoutMs === undefined ? undefined : createTimeoutSignal(queryTimeoutMs);
    try {
      const activeSnapshotId = snapshotIdOverride
        ?? (await resolveActiveSnapshot(pool, {
          ...resolveActiveSnapshotOptions,
        })).activeSnapshotId;
      let rowsResult: { rows: ReadonlyArray<PgAliasRecord> };
      if (timed === undefined || !hasConnect(pool)) {
        rowsResult = await pool.query<PgAliasRecord>(
          `SELECT alias_id, entity_id, surface_form, normalized_value, source_trust, confidence, alias_type
           FROM aliases
           WHERE search_snapshot_id = $1 AND is_suppressed = FALSE
           ORDER BY confidence DESC`,
          [activeSnapshotId],
        );
      } else {
        rowsResult = await runAbortablePgQuery<PgAliasRecord>(
          pool,
          timed.signal,
          `SELECT alias_id, entity_id, surface_form, normalized_value, source_trust, confidence, alias_type
           FROM aliases
           WHERE search_snapshot_id = $1 AND is_suppressed = FALSE
           ORDER BY confidence DESC`,
          [activeSnapshotId],
        );
      }
      const rows = rowsResult.rows;
      const aliases: SnapshotAliasRecord[] = rows
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
        .map((row) => {
          const aliasType = parseAliasType(row.alias_type);
          return {
            aliasId: row.alias_id,
            entityId: row.entity_id,
            value: row.surface_form,
            normalizedValue: row.normalized_value,
            sourceTrust: Number.isFinite(row.source_trust) ? row.source_trust : 0,
            confidencePrior: Number.isFinite(row.confidence) ? row.confidence : 0,
            ...(aliasType !== undefined ? { aliasType } : {}),
          };
        });

      if (aliases.length === 0) {
        bootstrapLogger.info(
          {
            activeSnapshotId,
          },
          '[Container] Search snapshot alias overlay loaded from PostgreSQL but empty; falling back to search-index',
        );
        return undefined;
      }

      const buildStartedAt = Date.now();
      const matcher = new SearchSnapshotAliasMatcher(aliases);
      matcher.warmBroadRecallIndexes();
      bootstrapLogger.info(
        {
          activeSnapshotId,
          aliasCount: aliases.length,
          buildMs: Date.now() - buildStartedAt,
        },
        '[Container] Search snapshot alias overlay loaded from PostgreSQL into memory',
      );
      return matcher;
    } catch (error: unknown) {
      bootstrapLogger.warn(
        {
          err: error,
        },
        '[Container] PostgreSQL alias overlay unavailable; falling back to search-index runtime substrate',
      );
      return undefined;
    } finally {
      timed?.clear();
    }
  }

  static async loadFromRuntimeState(
    runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
  ): Promise<SearchSnapshotAliasMatcher | undefined> {
    try {
      const runtimeState = await loadSearchSnapshotRuntimeState(runtimeStatePath);
      return await SearchSnapshotAliasMatcher.loadFromManifest(runtimeState.manifestPath);
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

  private readonly exactIndex = new Map<string, IndexedAliasRecord[]>();
  private readonly wholeTokenIndex = new Map<string, IndexedAliasRecord[]>();
  private readonly compactIndex = new Map<string, IndexedAliasRecord[]>();
  private readonly phoneticIndex = new Map<string, IndexedAliasRecord[]>();
  /**
   * Double Metaphone code → aliases. Each alias contributes its
   * primary key and (if distinct) its alternate key. The matcher uses
   * the union of query DM keys to retrieve candidates from this index.
   */
  private readonly doubleMetaphoneIndex = new Map<string, IndexedAliasRecord[]>();
  /**
   * Cached DM keyset per alias to avoid re-encoding during the strategy
   * decision loop. Empty set for non-Latin aliases.
   */
  private readonly doubleMetaphoneKeysByAliasId = new Map<string, ReadonlySet<string>>();
  private readonly prefixLookupRecords: PrefixLookupRecord[] = [];
  private readonly prefixTermsByAliasId = new Map<string, readonly string[]>();
  private readonly hangulCompletionRecords: HangulCompletionAliasRecord[] = [];
  private readonly aliases: readonly IndexedAliasRecord[];
  private readonly surfaceForms: readonly string[];
  private compactIndexBuilt = false;
  private broadRecallIndexesBuilt = false;

  constructor(
    aliases: readonly SnapshotAliasRecord[],
  ) {
    const normalizedAliases: IndexedAliasRecord[] = [];
    const surfaceForms: string[] = [];
    const seenSurfaceForms = new Set<string>();
    for (const rawAlias of aliases) {
      const alias: IndexedAliasRecord = {
        ...rawAlias,
        normalizedValue: normalizeStoredAliasValue(rawAlias.normalizedValue),
      };
      normalizedAliases.push(alias);
      this.addToIndex(this.exactIndex, alias.normalizedValue, alias);
      const compactValue = compactForLookup(alias.normalizedValue);
      if (compactValue.length > 0) {
        this.addToIndex(this.compactIndex, compactValue, alias);
      }
      if (!seenSurfaceForms.has(alias.value)) {
        seenSurfaceForms.add(alias.value);
        surfaceForms.push(alias.value);
      }
    }
    this.aliases = normalizedAliases;
    this.surfaceForms = surfaceForms;
    this.compactIndexBuilt = true;
  }

  getSurfaceForms(): readonly string[] {
    return this.surfaceForms;
  }

  warmBroadRecallIndexes(): void {
    this.ensureBroadRecallIndexes();
  }

  findMatchesBatch(
    normalizedQueries: readonly string[],
    options?: AliasLookupOptions,
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    const trimmedQueries = trimDedupedQueries(normalizedQueries);
    const matches = new Map<string, readonly AliasMatchResult[]>();
    for (const query of trimmedQueries) {
      matches.set(query, this.findMatchesSync(query, options));
    }
    return Promise.resolve(matches);
  }

  findMatches(
    normalizedQuery: string,
    options?: AliasLookupOptions,
  ): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve(this.findMatchesSync(normalizedQuery, options));
  }

  private findMatchesSync(
    normalizedQuery: string,
    options?: AliasLookupOptions,
  ): readonly AliasMatchResult[] {
    const trimmed = normalizedQuery.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const lookupPlan = buildAliasSurfaceLookupPlan(trimmed);
    const {
      tokenList: tokens,
      compactList: compactTokens,
      transliteratedList: transliteratedTokens,
      phoneticList: phoneticTokens,
      views,
    } = lookupPlan;
    const queryTokens: readonly string[] = tokenizeForLookup(views.vintageStripped);
    const isAtomicAliasQuery =
      queryTokens.length === 1
      && queryTokens[0] !== undefined
      && !queryTokens[0].includes(' ');
    const shouldUsePhoneticBroadRecall =
      queryTokens.length > 0
      && queryTokens.length <= 3;
    const exactSet = new Set(tokens);
    const compactSet = new Set(compactTokens);
    const transliteratedSet = new Set(transliteratedTokens);
    const phoneticSet = new Set(phoneticTokens);
    let queryDmKeys: ReadonlySet<string> = EMPTY_DM_KEYSET;
    let prefixTokens: readonly string[] = [];
    let transliteratedPrefixTokens: readonly string[] = [];
    const lookupScope = options?.scope ?? 'span';
    const recallMode = options?.recallMode;
    const allowBroadRecall = lookupScope === 'span' && recallMode !== 'surface_only';
    const candidateAliases = new Map<string, IndexedAliasRecord>();
    const grouped = new Map<string, GroupedAliasMatch>();

    for (const token of tokens) {
      for (const alias of this.exactIndex.get(token) ?? []) {
        candidateAliases.set(alias.aliasId, alias);
      }
    }

    let hangulCompletionMatches: readonly HangulCompletionAliasRecord[] = [];
    if (candidateAliases.size === 0) {
      this.ensureCompactIndex();
      for (const token of compactTokens) {
        for (const alias of this.compactIndex.get(token) ?? []) {
          candidateAliases.set(alias.aliasId, alias);
        }
      }
      if (allowBroadRecall) {
        if (isAtomicAliasQuery || shouldUsePhoneticBroadRecall) {
          this.ensureBroadRecallIndexes();
        }

        for (const token of tokens) {
          if (
            isAtomicAliasQuery &&
            token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH &&
            !token.includes(' ')
          ) {
            for (const alias of this.wholeTokenIndex.get(token) ?? []) {
              candidateAliases.set(alias.aliasId, alias);
            }
          }
        }

        if (shouldUsePhoneticBroadRecall) {
          const nextDmKeys = new Set<string>();
          for (const variant of views.lookupVariants) {
            for (const dmKey of doubleMetaphoneKeys(variant)) {
              nextDmKeys.add(dmKey);
            }
          }
          queryDmKeys = nextDmKeys;

          for (const token of phoneticTokens) {
            for (const alias of this.phoneticIndex.get(token) ?? []) {
              candidateAliases.set(alias.aliasId, alias);
            }
          }

          for (const dmKey of queryDmKeys) {
            for (const alias of this.doubleMetaphoneIndex.get(dmKey) ?? []) {
              candidateAliases.set(alias.aliasId, alias);
            }
          }
        }

        if (isAtomicAliasQuery) {
          prefixTokens = buildAliasPrefixTerms([views.strict])
            .filter((token) => isEligiblePrefixQuery(token));
          transliteratedPrefixTokens = views.transliterated !== undefined
            ? buildAliasPrefixTerms([views.transliterated]).filter((token) => isEligiblePrefixQuery(token))
            : [];

          for (const token of [...prefixTokens, ...transliteratedPrefixTokens]) {
            for (const record of this.prefixLookupRecords) {
              if (!record.prefixTerms.some((term) => matchesAliasPrefixTerm(token, term))) {
                continue;
              }
              candidateAliases.set(record.alias.aliasId, record.alias);
            }
          }

          hangulCompletionMatches = this.findHangulCompletionAliases(tokens);
        }
      }
    }

    for (const alias of candidateAliases.values()) {
      const compactValue = compactForLookup(alias.normalizedValue);
      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      const aliasDmKeys: ReadonlySet<string> =
        this.doubleMetaphoneKeysByAliasId.get(alias.aliasId) ?? EMPTY_DM_KEYSET;
      const prefixTerms: readonly string[] = this.prefixTermsByAliasId.get(alias.aliasId) ?? [];
      const hasWholeTokenMatch =
        queryTokens.some((token) => (
          token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH
          && !token.includes(' ')
          && tokenizeForLookup(alias.normalizedValue).includes(token)
          && !isDisallowedWholeLeadingTokenExpansion(token, alias.normalizedValue)
        ));
      const hasTransliteratedPrefixMatch = transliteratedPrefixTokens.some((token) =>
        prefixTerms.some((term) => matchesAliasPrefixTerm(token, term))
      );
      const hasPrefixMatch = prefixTokens.some((token) =>
        prefixTerms.some((term) => matchesAliasPrefixTerm(token, term))
      );
      // Phonetic *promotion* accepts EITHER the legacy compact-vowel
      // skeleton OR a Double Metaphone keyset overlap. Decoupling
      // recall (broad) from promotion (precise) lets us tighten
      // precision via DM without dropping the legacy recall path.
      const hasPhoneticSkeletonMatch = phoneticSet.has(phoneticValue);
      const hasPhoneticDoubleMetaphoneMatch =
        queryDmKeys.size > 0
        && aliasDmKeys.size > 0
        && (() => {
          for (const k of queryDmKeys) {
            if (aliasDmKeys.has(k)) return true;
          }
          return false;
        })();
      const strategy: AliasStrategy | null =
        transliteratedSet.has(alias.normalizedValue) || transliteratedSet.has(compactValue)
          ? 'transliterated_exact'
        : exactSet.has(alias.normalizedValue)
          ? 'exact'
        : compactSet.has(compactValue)
          ? 'compact_exact'
        : hasWholeTokenMatch
          ? 'lexical_exact'
        : hasTransliteratedPrefixMatch
          ? 'transliterated_prefix'
        : hasPrefixMatch
          ? 'prefix_exact'
        : (hasPhoneticSkeletonMatch || hasPhoneticDoubleMetaphoneMatch)
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
        ...(match.aliasType !== undefined ? { aliasType: match.aliasType } : {}),
      }));
  }

  private addToIndex(
    index: Map<string, IndexedAliasRecord[]>,
    key: string,
    alias: IndexedAliasRecord,
  ): void {
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, [alias]);
      return;
    }
    existing.push(alias);
  }

  private buildHangulCompletionRecords(alias: IndexedAliasRecord): readonly HangulCompletionAliasRecord[] {
    const records: HangulCompletionAliasRecord[] = [];
    const seenJamoKeys = new Set<string>();
    for (const value of [alias.value, alias.normalizedValue]) {
      const key = buildHangulJamoKey(value);
      if (key.containsHangul && key.key.length > 0 && !seenJamoKeys.has(key.key)) {
        seenJamoKeys.add(key.key);
        records.push({
          alias,
          jamoKey: key.key,
          syllableBoundaryOffsets: key.syllableBoundaryOffsets,
        });
      }

      const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(value);
      if (exceptionSurface !== undefined) {
        const exceptionKey = buildHangulJamoKey(exceptionSurface);
        if (
          exceptionKey.containsHangul
          && exceptionKey.key.length > 0
          && !seenJamoKeys.has(exceptionKey.key)
        ) {
          seenJamoKeys.add(exceptionKey.key);
          records.push({
            alias,
            jamoKey: exceptionKey.key,
            syllableBoundaryOffsets: exceptionKey.syllableBoundaryOffsets,
          });
        }
      }
    }
    return records;
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

      for (const record of this.hangulCompletionRecords) {
        if (
          key.key.length >= record.jamoKey.length ||
          !record.jamoKey.startsWith(key.key)
        ) {
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
    const matchConfidence = resolveAliasMatchConfidence(alias.confidencePrior, strategy);
    if (existing === undefined) {
      grouped.set(key, {
        surfaceForm: alias.value,
        normalizedForm: alias.normalizedValue,
        entityIds: new Set([alias.entityId]),
        matchConfidence,
        strategies: new Set([strategy]),
        aliasType: alias.aliasType,
      });
      return;
    }

    existing.entityIds.add(alias.entityId);
    existing.strategies.add(strategy);
    if (matchConfidence > existing.matchConfidence) {
      existing.matchConfidence = matchConfidence;
    }
    // Higher-trust alias_type wins so a curated sibling lifts a derived
    // sibling's tag on the same (surfaceForm, normalizedForm) key.
    existing.aliasType = pickHigherTrustAliasType(existing.aliasType, alias.aliasType);
  }

  private ensureCompactIndex(): void {
    if (this.compactIndexBuilt) {
      return;
    }
    this.compactIndexBuilt = true;
  }

  private ensureBroadRecallIndexes(): void {
    if (this.broadRecallIndexesBuilt) {
      return;
    }

    this.ensureCompactIndex();

    for (const alias of this.aliases) {
      for (const token of tokenizeForLookup(alias.normalizedValue)) {
        this.addToIndex(this.wholeTokenIndex, token, alias);
      }

      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      if (phoneticValue.length > 0) {
        this.addToIndex(this.phoneticIndex, phoneticValue, alias);
      }

      const dmKeys = doubleMetaphoneKeys(alias.normalizedValue);
      this.doubleMetaphoneKeysByAliasId.set(alias.aliasId, dmKeys);
      for (const dmKey of dmKeys) {
        this.addToIndex(this.doubleMetaphoneIndex, dmKey, alias);
      }

      const prefixTerms = buildAliasPrefixTerms([alias.value, alias.normalizedValue]);
      if (prefixTerms.length > 0) {
        this.prefixTermsByAliasId.set(alias.aliasId, prefixTerms);
        this.prefixLookupRecords.push({
          alias,
          prefixTerms,
        });
      }

      for (const record of this.buildHangulCompletionRecords(alias)) {
        this.hangulCompletionRecords.push(record);
      }
    }

    this.broadRecallIndexesBuilt = true;
  }
}
