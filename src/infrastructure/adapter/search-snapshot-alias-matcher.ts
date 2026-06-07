import fs from 'node:fs/promises';
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
import {
  buildAliasRegistryVersion,
  type AliasRegistryVersion,
} from '../../domain/alias/model/alias-registry-version.js';
import { pickHigherTrustAliasType } from '../../domain/alias/service/conflict-resolver.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import type { StageTimer } from '../../domain/shared/stage-timer.js';
import {
  type LookupAliasBroadRecallRuntimeArtifact,
  parseTrustedLookupAliasBroadRecallRuntimeArtifact,
  parseTrustedLookupAliasRuntimeArtifact,
  parseTrustedLookupAliasRuntimeCoreArtifact,
  type LookupAliasRuntimeArtifact,
  type LookupAliasRuntimeCoreArtifact,
  type LookupAliasRuntimeHangulCompletionEntry,
  type LookupAliasRuntimePrefixEntry,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';

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

type AliasStrategy = AliasMatchConfidenceStrategy;

const MIN_WHOLE_TOKEN_LOOKUP_LENGTH = 4;

/**
 * Reused empty Double Metaphone keyset for aliases that don't produce
 * Latin-script phonetic codes (Hangul-only aliases, etc.). Module-scope
 * to avoid per-iteration allocation during the strategy decision loop.
 */
const EMPTY_DM_KEYSET: ReadonlySet<string> = new Set<string>();

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupAliasRuntimeJson: z.string().min(1),
    lookupAliasBroadRecallRuntimeJson: z.string().min(1).optional(),
  }).passthrough(),
  // T-ELV2-03: capture the registry identity (snapshot id + alias content hash)
  // already present on the manifest — used for the V2 alias-registry version stamp.
  snapshotId: z.string().min(1),
  hashes: z.object({ aliases: z.string().min(1) }).passthrough(),
}).passthrough();

interface ParsedAliasesManifest {
  readonly lookupAliasRuntimePath: string;
  readonly lookupAliasBroadRecallRuntimePath?: string;
  readonly snapshotId: string;
  readonly aliasContentHash: string;
}

// Phonetic skeleton (compactForLookup / phoneticCompactForLookup /
// PHONETIC_NORMALIZATION_RULES / LATIN_VOWEL_RE) is the SSoT in
// `@domain/query/service/phonetic-skeleton`.

function tokenizeForLookup(value: string): readonly string[] {
  return buildNormalizedQueryViews(value).punctuationStripped
    .split(/\s+/)
    .filter(Boolean);
}

function parseAliasesManifestPath(raw: string, manifestPath: string): ParsedAliasesManifest {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const lookupAliasRuntimeJson = manifest.artifacts.lookupAliasRuntimeJson;
  if (lookupAliasRuntimeJson.length === 0) {
    throw new Error(`Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupAliasRuntimeJson is required`);
  }
  return {
    lookupAliasRuntimePath: lookupAliasRuntimeJson,
    ...(manifest.artifacts.lookupAliasBroadRecallRuntimeJson !== undefined
      ? { lookupAliasBroadRecallRuntimePath: manifest.artifacts.lookupAliasBroadRecallRuntimeJson }
      : {}),
    snapshotId: manifest.snapshotId,
    aliasContentHash: manifest.hashes.aliases,
  };
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
  aliasType: AliasType | undefined;
}

interface PrefixCatalogGroupRecord {
  readonly candidateTerm: string;
  readonly aliases: readonly IndexedAliasRecord[];
}

type ArtifactAliasIndex = Readonly<Record<string, readonly number[]>>;
type ArtifactDoubleMetaphoneKeysByAliasId = Readonly<Record<string, readonly string[]>>;

export interface AliasMatcherBuildStateSnapshot {
  readonly artifactHydrated: boolean;
  readonly compactIndexBuilt: boolean;
  readonly broadRecallIndexesBuilt: boolean;
  readonly wholeTokenIndexBuilt: boolean;
  readonly phoneticIndexesBuilt: boolean;
  readonly prefixCatalogBuilt: boolean;
  readonly hangulCompletionIndexBuilt: boolean;
}

export class SearchSnapshotAliasMatcher implements AliasMatcher {
  /** T-ELV2-03: the dedicated alias-registry version identity for this substrate. */
  getRegistryVersion(): AliasRegistryVersion | undefined {
    return this.registryVersion;
  }

  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotAliasMatcher | undefined> {
    try {
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const parsedManifest = parseAliasesManifestPath(manifestRaw, manifestPath);
      const [
        artifactRaw,
        broadRecallArtifactRaw,
      ] = await Promise.all([
        fs.readFile(parsedManifest.lookupAliasRuntimePath, 'utf8'),
        parsedManifest.lookupAliasBroadRecallRuntimePath === undefined
          ? Promise.resolve(undefined)
          : fs.readFile(parsedManifest.lookupAliasBroadRecallRuntimePath, 'utf8'),
      ]);
      const buildStartedAt = Date.now();
      let aliasCount = 0;
      let matcher: SearchSnapshotAliasMatcher;
      if (parsedManifest.lookupAliasBroadRecallRuntimePath === undefined) {
        const artifact = parseTrustedLookupAliasRuntimeArtifact(
          artifactRaw,
          parsedManifest.lookupAliasRuntimePath,
        );
        aliasCount = artifact.aliases.length;
        matcher = SearchSnapshotAliasMatcher.fromRuntimeArtifact(
          artifact,
          buildAliasRegistryVersion({
            source: 'snapshot_manifest',
            aliasCount,
            snapshotId: parsedManifest.snapshotId,
            aliasContentHash: parsedManifest.aliasContentHash,
          }),
        );
      } else {
        const artifact = parseTrustedLookupAliasRuntimeCoreArtifact(
          artifactRaw,
          parsedManifest.lookupAliasRuntimePath,
        );
        const broadRecallArtifact =
          broadRecallArtifactRaw === undefined
            ? undefined
            : parseTrustedLookupAliasBroadRecallRuntimeArtifact(
              broadRecallArtifactRaw,
              parsedManifest.lookupAliasBroadRecallRuntimePath,
            );
        if (broadRecallArtifact === undefined) {
          throw new Error(
            `Malformed search snapshot manifest at ${manifestPath}: broad-recall runtime artifact missing`,
          );
        }
        aliasCount = artifact.aliases.length;
        matcher = SearchSnapshotAliasMatcher.fromRuntimeArtifact(
          artifact,
          buildAliasRegistryVersion({
            source: 'snapshot_manifest',
            aliasCount,
            snapshotId: parsedManifest.snapshotId,
            aliasContentHash: parsedManifest.aliasContentHash,
          }),
          broadRecallArtifact,
        );
      }
      bootstrapLogger.info(
        {
          manifestPath,
          aliasCount,
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

  static fromRuntimeArtifact(
    artifact: LookupAliasRuntimeArtifact | LookupAliasRuntimeCoreArtifact,
    registryVersion?: AliasRegistryVersion,
    broadRecallArtifact?:
      | LookupAliasBroadRecallRuntimeArtifact
      | {
        readonly raw: string;
        readonly filePath: string;
      },
  ): SearchSnapshotAliasMatcher {
    const aliases = artifact.aliases as readonly IndexedAliasRecord[];
    const deferredBroadRecallArtifact =
      broadRecallArtifact !== undefined
      && 'raw' in broadRecallArtifact
        ? broadRecallArtifact
        : undefined;
    const eagerBroadRecallArtifact =
      broadRecallArtifact !== undefined
      && !('raw' in broadRecallArtifact)
        ? broadRecallArtifact
        : undefined;
    const broadRecallPrecomputed =
      'wholeTokenIndex' in artifact
        ? {
          wholeTokenIndex: artifact.wholeTokenIndex,
          phoneticIndex: artifact.phoneticIndex,
          doubleMetaphoneIndex: artifact.doubleMetaphoneIndex,
          ...(artifact.doubleMetaphoneKeysByAliasId !== undefined
            ? { doubleMetaphoneKeysByAliasId: artifact.doubleMetaphoneKeysByAliasId }
            : {}),
          prefixCatalog: artifact.prefixCatalog,
          ...(artifact.hangulCompletionRecords !== undefined
            ? { hangulCompletionRecords: artifact.hangulCompletionRecords }
            : {}),
        }
        : eagerBroadRecallArtifact !== undefined
          ? {
            wholeTokenIndex: eagerBroadRecallArtifact.wholeTokenIndex,
            phoneticIndex: eagerBroadRecallArtifact.phoneticIndex,
            doubleMetaphoneIndex: eagerBroadRecallArtifact.doubleMetaphoneIndex,
            ...(eagerBroadRecallArtifact.doubleMetaphoneKeysByAliasId !== undefined
              ? { doubleMetaphoneKeysByAliasId: eagerBroadRecallArtifact.doubleMetaphoneKeysByAliasId }
              : {}),
            prefixCatalog: eagerBroadRecallArtifact.prefixCatalog,
            ...(eagerBroadRecallArtifact.hangulCompletionRecords !== undefined
              ? { hangulCompletionRecords: eagerBroadRecallArtifact.hangulCompletionRecords }
              : {}),
          }
        : undefined;
    return new SearchSnapshotAliasMatcher(
      aliases,
      registryVersion,
      {
        ...(artifact.surfaceForms !== undefined ? { surfaceForms: artifact.surfaceForms } : {}),
        exactIndex: artifact.exactIndex,
        compactIndex: artifact.compactIndex,
        ...(broadRecallPrecomputed !== undefined ? broadRecallPrecomputed : {}),
        ...(deferredBroadRecallArtifact !== undefined ? { deferredBroadRecallArtifact } : {}),
      },
    );
  }

  private readonly exactIndex: Map<string, IndexedAliasRecord[]>;
  private readonly wholeTokenIndex: Map<string, IndexedAliasRecord[]>;
  private readonly compactIndex: Map<string, IndexedAliasRecord[]>;
  private readonly phoneticIndex: Map<string, IndexedAliasRecord[]>;
  private artifactExactIndex: ArtifactAliasIndex | undefined;
  private artifactWholeTokenIndex: ArtifactAliasIndex | undefined;
  private artifactCompactIndex: ArtifactAliasIndex | undefined;
  private artifactPhoneticIndex: ArtifactAliasIndex | undefined;
  /**
   * Double Metaphone code → aliases. Each alias contributes its
   * primary key and (if distinct) its alternate key. The matcher uses
   * the union of query DM keys to retrieve candidates from this index.
   */
  private readonly doubleMetaphoneIndex: Map<string, IndexedAliasRecord[]>;
  private artifactDoubleMetaphoneIndex: ArtifactAliasIndex | undefined;
  /**
   * Cached DM keyset per alias to avoid re-encoding during the strategy
   * decision loop. Empty set for non-Latin aliases.
   */
  private readonly doubleMetaphoneKeysByAliasId: Map<string, ReadonlySet<string>>;
  private artifactDoubleMetaphoneKeysByAliasId: ArtifactDoubleMetaphoneKeysByAliasId | undefined;
  private readonly prefixCatalog: PrefixCatalogGroupRecord[];
  private artifactPrefixCatalog: readonly LookupAliasRuntimePrefixEntry[] | undefined;
  private readonly hangulCompletionRecords: HangulCompletionAliasRecord[];
  private artifactHangulCompletionRecords: readonly LookupAliasRuntimeHangulCompletionEntry[] | undefined;
  private readonly aliases: readonly IndexedAliasRecord[];
  private surfaceForms: readonly string[];
  private surfaceFormsBuilt: boolean;
  private readonly artifactHydrated: boolean;
  private deferredBroadRecallArtifact:
    | {
      readonly raw: string;
      readonly filePath: string;
    }
    | undefined;
  private compactIndexBuilt: boolean;
  private broadRecallIndexesBuilt: boolean;
  private wholeTokenIndexBuilt: boolean;
  private phoneticIndexesBuilt: boolean;
  private prefixCatalogBuilt: boolean;
  private hangulCompletionIndexBuilt: boolean;
  private stageSequence = 0;

  constructor(
    aliases: readonly SnapshotAliasRecord[],
    private readonly registryVersion?: AliasRegistryVersion,
    precomputed?: {
      readonly surfaceForms?: readonly string[] | undefined;
      readonly exactIndex: ArtifactAliasIndex;
      readonly compactIndex: ArtifactAliasIndex;
      readonly wholeTokenIndex?: ArtifactAliasIndex;
      readonly phoneticIndex?: ArtifactAliasIndex;
      readonly doubleMetaphoneIndex?: ArtifactAliasIndex;
      readonly doubleMetaphoneKeysByAliasId?: ArtifactDoubleMetaphoneKeysByAliasId;
      readonly prefixCatalog?: readonly LookupAliasRuntimePrefixEntry[];
      readonly hangulCompletionRecords?: readonly LookupAliasRuntimeHangulCompletionEntry[] | undefined;
      readonly deferredBroadRecallArtifact?: {
        readonly raw: string;
        readonly filePath: string;
      };
    },
  ) {
    this.aliases = aliases as readonly IndexedAliasRecord[];
    this.exactIndex = new Map<string, IndexedAliasRecord[]>();
    this.compactIndex = new Map<string, IndexedAliasRecord[]>();
    this.wholeTokenIndex = new Map<string, IndexedAliasRecord[]>();
    this.phoneticIndex = new Map<string, IndexedAliasRecord[]>();
    this.doubleMetaphoneIndex = new Map<string, IndexedAliasRecord[]>();
    this.doubleMetaphoneKeysByAliasId = new Map<string, ReadonlySet<string>>();
    this.prefixCatalog = [];
    this.hangulCompletionRecords = [];
    this.artifactExactIndex = precomputed?.exactIndex;
    this.artifactCompactIndex = precomputed?.compactIndex;
    this.artifactWholeTokenIndex = precomputed?.wholeTokenIndex;
    this.artifactPhoneticIndex = precomputed?.phoneticIndex;
    this.artifactDoubleMetaphoneIndex = precomputed?.doubleMetaphoneIndex;
    this.artifactDoubleMetaphoneKeysByAliasId = precomputed?.doubleMetaphoneKeysByAliasId;
    this.artifactPrefixCatalog = precomputed?.prefixCatalog;
    this.artifactHangulCompletionRecords = precomputed?.hangulCompletionRecords;
    this.deferredBroadRecallArtifact = precomputed?.deferredBroadRecallArtifact;
    this.artifactHydrated = precomputed !== undefined;

    if (precomputed !== undefined) {
      this.surfaceForms = precomputed.surfaceForms ?? [];
      this.surfaceFormsBuilt = precomputed.surfaceForms !== undefined;
      this.compactIndexBuilt = true;
      const broadRecallHydrated =
        precomputed.wholeTokenIndex !== undefined
        && precomputed.phoneticIndex !== undefined
        && precomputed.doubleMetaphoneIndex !== undefined
        && precomputed.prefixCatalog !== undefined
        && precomputed.hangulCompletionRecords !== undefined;
      this.broadRecallIndexesBuilt = broadRecallHydrated;
      this.wholeTokenIndexBuilt = broadRecallHydrated;
      this.phoneticIndexesBuilt = broadRecallHydrated;
      this.prefixCatalogBuilt = broadRecallHydrated;
      this.hangulCompletionIndexBuilt = broadRecallHydrated;
      return;
    }

    const surfaceForms: string[] = [];
    const seenSurfaceForms = new Set<string>();
    for (const alias of this.aliases) {
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
    this.surfaceForms = surfaceForms;
    this.surfaceFormsBuilt = true;
    this.compactIndexBuilt = true;
    this.broadRecallIndexesBuilt = false;
    this.wholeTokenIndexBuilt = false;
    this.phoneticIndexesBuilt = false;
    this.prefixCatalogBuilt = false;
    this.hangulCompletionIndexBuilt = false;
  }

  getSurfaceForms(): readonly string[] {
    if (!this.surfaceFormsBuilt) {
      const surfaceForms: string[] = [];
      const seenSurfaceForms = new Set<string>();
      for (const alias of this.aliases) {
        if (seenSurfaceForms.has(alias.value)) {
          continue;
        }
        seenSurfaceForms.add(alias.value);
        surfaceForms.push(alias.value);
      }
      this.surfaceForms = surfaceForms;
      this.surfaceFormsBuilt = true;
    }
    return this.surfaceForms;
  }

  getBuildStateSnapshot(): AliasMatcherBuildStateSnapshot {
    return {
      artifactHydrated: this.artifactHydrated,
      compactIndexBuilt: this.compactIndexBuilt,
      broadRecallIndexesBuilt: this.broadRecallIndexesBuilt,
      wholeTokenIndexBuilt: this.wholeTokenIndexBuilt,
      phoneticIndexesBuilt: this.phoneticIndexesBuilt,
      prefixCatalogBuilt: this.prefixCatalogBuilt,
      hangulCompletionIndexBuilt: this.hangulCompletionIndexBuilt,
    };
  }

  isFullyHydratedRuntimeArtifact(): boolean {
    const state = this.getBuildStateSnapshot();
    return state.artifactHydrated
      && state.compactIndexBuilt
      && state.broadRecallIndexesBuilt
      && state.wholeTokenIndexBuilt
      && state.phoneticIndexesBuilt
      && state.prefixCatalogBuilt
      && state.hangulCompletionIndexBuilt;
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
    const prefixMatchedAliasIds = new Set<string>();
    const transliteratedPrefixMatchedAliasIds = new Set<string>();
    const stageTimer: StageTimer | undefined = options?.stageTimer;
    const exactStage = stageTimer !== undefined ? this.nextTimedStage('exact') : undefined;

    if (exactStage !== undefined) {
      stageTimer?.start(exactStage);
    }
    try {
      for (const token of tokens) {
        for (const alias of this.lookupIndexAliases(this.exactIndex, this.artifactExactIndex, token)) {
          candidateAliases.set(alias.aliasId, alias);
        }
      }
    } finally {
      if (exactStage !== undefined) {
        stageTimer?.end(exactStage);
      }
    }

    let hangulCompletionMatches: readonly HangulCompletionAliasRecord[] = [];
    if (candidateAliases.size === 0) {
      const compactStage = stageTimer !== undefined ? this.nextTimedStage('compact') : undefined;
      if (compactStage !== undefined) {
        stageTimer?.start(compactStage);
      }
      try {
        this.ensureCompactIndex();
        for (const token of compactTokens) {
          for (const alias of this.lookupIndexAliases(this.compactIndex, this.artifactCompactIndex, token)) {
            candidateAliases.set(alias.aliasId, alias);
          }
        }
      } finally {
        if (compactStage !== undefined) {
          stageTimer?.end(compactStage);
        }
      }
      if (allowBroadRecall) {
        const broadRecallStage = stageTimer !== undefined ? this.nextTimedStage('broad_recall') : undefined;
        if (broadRecallStage !== undefined) {
          stageTimer?.start(broadRecallStage);
        }
        try {
          for (const token of tokens) {
            if (
              isAtomicAliasQuery &&
              token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH &&
              !token.includes(' ')
            ) {
              this.ensureWholeTokenIndex();
              for (const alias of this.lookupIndexAliases(this.wholeTokenIndex, this.artifactWholeTokenIndex, token)) {
                candidateAliases.set(alias.aliasId, alias);
              }
            }
          }

          if (shouldUsePhoneticBroadRecall) {
            this.ensurePhoneticRecallIndexes();
            const nextDmKeys = new Set<string>();
            for (const variant of views.lookupVariants) {
              for (const dmKey of doubleMetaphoneKeys(variant)) {
                nextDmKeys.add(dmKey);
              }
            }
            queryDmKeys = nextDmKeys;

            for (const token of phoneticTokens) {
              for (const alias of this.lookupIndexAliases(this.phoneticIndex, this.artifactPhoneticIndex, token)) {
                candidateAliases.set(alias.aliasId, alias);
              }
            }

            for (const dmKey of queryDmKeys) {
              for (const alias of this.lookupIndexAliases(this.doubleMetaphoneIndex, this.artifactDoubleMetaphoneIndex, dmKey)) {
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

            this.ensurePrefixCatalog();
            for (const token of prefixTokens) {
              for (const alias of this.findPrefixMatches(token)) {
                candidateAliases.set(alias.aliasId, alias);
                prefixMatchedAliasIds.add(alias.aliasId);
              }
            }
            for (const token of transliteratedPrefixTokens) {
              for (const alias of this.findPrefixMatches(token)) {
                candidateAliases.set(alias.aliasId, alias);
                transliteratedPrefixMatchedAliasIds.add(alias.aliasId);
              }
            }

            if (tokens.some((token) => {
              const key = buildHangulJamoKey(token);
              return key.containsHangul && key.key.length > 0 && key.syllableCount >= 2;
            })) {
              this.ensureHangulCompletionIndex();
              hangulCompletionMatches = this.findHangulCompletionAliases(tokens);
            }
          }
        } finally {
          if (broadRecallStage !== undefined) {
            stageTimer?.end(broadRecallStage);
          }
        }
      }
    }

    for (const alias of candidateAliases.values()) {
      const compactValue = compactForLookup(alias.normalizedValue);
      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      const hasWholeTokenMatch =
        queryTokens.some((token) => (
          token.length >= MIN_WHOLE_TOKEN_LOOKUP_LENGTH
          && !token.includes(' ')
          && tokenizeForLookup(alias.normalizedValue).includes(token)
          && !isDisallowedWholeLeadingTokenExpansion(token, alias.normalizedValue)
        ));
      const hasTransliteratedPrefixMatch = transliteratedPrefixMatchedAliasIds.has(alias.aliasId);
      const hasPrefixMatch = prefixMatchedAliasIds.has(alias.aliasId);
      // Phonetic *promotion* accepts EITHER the legacy compact-vowel
      // skeleton OR a Double Metaphone keyset overlap. Decoupling
      // recall (broad) from promotion (precise) lets us tighten
      // precision via DM without dropping the legacy recall path.
      const hasPhoneticSkeletonMatch = phoneticSet.has(phoneticValue);
      const hasPhoneticDoubleMetaphoneMatch =
        this.aliasHasDoubleMetaphoneOverlap(alias, queryDmKeys);
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

  private nextTimedStage(base: string): string {
    this.stageSequence += 1;
    return `${base}#${this.stageSequence}`;
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
    const hydratedRecords = this.hangulCompletionRecords;
    const artifactRecords = this.artifactHangulCompletionRecords;
    for (const token of tokens) {
      const key = buildHangulJamoKey(token);
      if (
        !key.containsHangul ||
        key.key.length === 0 ||
        key.syllableCount < 2
      ) {
        continue;
      }

      for (const record of hydratedRecords) {
        if (
          key.key.length >= record.jamoKey.length ||
          !record.jamoKey.startsWith(key.key)
        ) {
          continue;
        }
        matches.set(`${record.alias.aliasId}\u0000${record.jamoKey}`, record);
      }

      if (artifactRecords === undefined) {
        continue;
      }

      for (const record of artifactRecords) {
        if (
          key.key.length >= record.jamoKey.length ||
          !record.jamoKey.startsWith(key.key)
        ) {
          continue;
        }
        const alias = this.aliases[record.aliasIndex];
        if (alias === undefined) {
          continue;
        }
        matches.set(`${alias.aliasId}\u0000${record.jamoKey}`, {
          alias,
          jamoKey: record.jamoKey,
          syllableBoundaryOffsets: new Set(record.syllableBoundaryOffsets ?? []),
        });
      }
    }
    return [...matches.values()];
  }

  private lookupIndexAliases(
    hydratedIndex: ReadonlyMap<string, readonly IndexedAliasRecord[]>,
    artifactIndex: ArtifactAliasIndex | undefined,
    key: string,
  ): readonly IndexedAliasRecord[] {
    const hydrated = hydratedIndex.get(key);
    if (hydrated !== undefined) {
      return hydrated;
    }
    const aliasIndexes = artifactIndex?.[key];
    if (aliasIndexes === undefined) {
      return [];
    }
    return this.resolveAliasIndexes(aliasIndexes);
  }

  private resolveAliasIndexes(aliasIndexes: readonly number[]): readonly IndexedAliasRecord[] {
    const resolved: IndexedAliasRecord[] = [];
    for (const aliasIndex of aliasIndexes) {
      const alias = this.aliases[aliasIndex];
      if (alias !== undefined) {
        resolved.push(alias);
      }
    }
    return resolved;
  }

  private aliasHasDoubleMetaphoneOverlap(
    alias: IndexedAliasRecord,
    queryDmKeys: ReadonlySet<string>,
  ): boolean {
    if (queryDmKeys.size === 0) {
      return false;
    }
    const hydrated = this.doubleMetaphoneKeysByAliasId.get(alias.aliasId);
    if (hydrated !== undefined) {
      for (const key of queryDmKeys) {
        if (hydrated.has(key)) {
          return true;
        }
      }
      return false;
    }
    const raw = this.artifactDoubleMetaphoneKeysByAliasId?.[alias.aliasId];
    const aliasDmKeys = raw === undefined
      ? doubleMetaphoneKeys(alias.normalizedValue)
      : new Set(raw);
    this.doubleMetaphoneKeysByAliasId.set(alias.aliasId, aliasDmKeys);
    for (const key of aliasDmKeys) {
      if (queryDmKeys.has(key)) {
        return true;
      }
    }
    return false;
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

  private ensureDeferredBroadRecallArtifactHydrated(): void {
    if (this.deferredBroadRecallArtifact === undefined) {
      return;
    }
    const artifact = parseTrustedLookupAliasBroadRecallRuntimeArtifact(
      this.deferredBroadRecallArtifact.raw,
      this.deferredBroadRecallArtifact.filePath,
    );
    this.artifactWholeTokenIndex = artifact.wholeTokenIndex;
    this.artifactPhoneticIndex = artifact.phoneticIndex;
    this.artifactDoubleMetaphoneIndex = artifact.doubleMetaphoneIndex;
    this.artifactDoubleMetaphoneKeysByAliasId = artifact.doubleMetaphoneKeysByAliasId;
    this.artifactPrefixCatalog = artifact.prefixCatalog;
    this.artifactHangulCompletionRecords = artifact.hangulCompletionRecords;
    this.deferredBroadRecallArtifact = undefined;
  }

  private ensureBroadRecallIndexes(): void {
    if (this.broadRecallIndexesBuilt) {
      return;
    }
    this.ensureDeferredBroadRecallArtifactHydrated();

    this.ensureWholeTokenIndex();
    this.ensurePhoneticRecallIndexes();
    this.ensurePrefixCatalog();
    this.ensureHangulCompletionIndex();
  }

  private ensureWholeTokenIndex(): void {
    if (this.wholeTokenIndexBuilt) {
      return;
    }
    this.ensureDeferredBroadRecallArtifactHydrated();
    if (this.artifactWholeTokenIndex !== undefined) {
      this.wholeTokenIndexBuilt = true;
      this.broadRecallIndexesBuilt =
        this.phoneticIndexesBuilt && this.prefixCatalogBuilt && this.hangulCompletionIndexBuilt;
      return;
    }

    for (const alias of this.aliases) {
      for (const token of tokenizeForLookup(alias.normalizedValue)) {
        this.addToIndex(this.wholeTokenIndex, token, alias);
      }
    }

    this.wholeTokenIndexBuilt = true;
    this.broadRecallIndexesBuilt = true;
  }

  private ensurePhoneticRecallIndexes(): void {
    if (this.phoneticIndexesBuilt) {
      return;
    }
    this.ensureDeferredBroadRecallArtifactHydrated();
    if (
      this.artifactPhoneticIndex !== undefined
      && this.artifactDoubleMetaphoneIndex !== undefined
    ) {
      this.phoneticIndexesBuilt = true;
      this.broadRecallIndexesBuilt =
        this.wholeTokenIndexBuilt && this.prefixCatalogBuilt && this.hangulCompletionIndexBuilt;
      return;
    }

    for (const alias of this.aliases) {
      const phoneticValue = phoneticCompactForLookup(alias.normalizedValue);
      if (phoneticValue.length > 0) {
        this.addToIndex(this.phoneticIndex, phoneticValue, alias);
      }

      const dmKeys = doubleMetaphoneKeys(alias.normalizedValue);
      this.doubleMetaphoneKeysByAliasId.set(alias.aliasId, dmKeys);
      for (const dmKey of dmKeys) {
        this.addToIndex(this.doubleMetaphoneIndex, dmKey, alias);
      }
    }

    this.phoneticIndexesBuilt = true;
    this.broadRecallIndexesBuilt = true;
  }

  private ensurePrefixCatalog(): void {
    if (this.prefixCatalogBuilt) {
      return;
    }
    this.ensureDeferredBroadRecallArtifactHydrated();
    if (this.artifactPrefixCatalog !== undefined) {
      this.prefixCatalogBuilt = true;
      this.broadRecallIndexesBuilt =
        this.wholeTokenIndexBuilt && this.phoneticIndexesBuilt && this.hangulCompletionIndexBuilt;
      return;
    }

    const grouped = new Map<string, IndexedAliasRecord[]>();
    for (const alias of this.aliases) {
      // Prefix recall operates on normalized query surfaces, so the published
      // strict-normalized alias surface is the authority. Recomputing the same
      // prefix substrate from the raw display label doubles startup cost on
      // large snapshots without adding distinct prefix keys.
      const prefixTerms = buildAliasPrefixTerms([alias.normalizedValue]);
      for (const prefixTerm of prefixTerms) {
        const existing = grouped.get(prefixTerm);
        if (existing === undefined) {
          grouped.set(prefixTerm, [alias]);
          continue;
        }
        existing.push(alias);
      }
    }

    this.prefixCatalog.push(
      ...[...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidateTerm, aliases]) => ({ candidateTerm, aliases })),
    );
    this.prefixCatalogBuilt = true;
    this.broadRecallIndexesBuilt = true;
  }

  private ensureHangulCompletionIndex(): void {
    if (this.hangulCompletionIndexBuilt) {
      return;
    }
    this.ensureDeferredBroadRecallArtifactHydrated();
    if (this.artifactHangulCompletionRecords !== undefined) {
      this.hangulCompletionIndexBuilt = true;
      this.broadRecallIndexesBuilt =
        this.wholeTokenIndexBuilt && this.phoneticIndexesBuilt && this.prefixCatalogBuilt;
      return;
    }

    for (const alias of this.aliases) {
      for (const record of this.buildHangulCompletionRecords(alias)) {
        this.hangulCompletionRecords.push(record);
      }
    }

    this.hangulCompletionIndexBuilt = true;
    this.broadRecallIndexesBuilt = true;
  }

  private findPrefixMatches(queryPrefix: string): readonly IndexedAliasRecord[] {
    if (queryPrefix.trim().length === 0) {
      return [];
    }

    const prefixCatalog = this.artifactPrefixCatalog ?? this.prefixCatalog;
    let low = 0;
    let high = prefixCatalog.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const candidateTerm = prefixCatalog[mid]?.candidateTerm ?? '';
      if (candidateTerm.localeCompare(queryPrefix) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    const matches: IndexedAliasRecord[] = [];
    for (let index = low; index < prefixCatalog.length; index += 1) {
      const record = prefixCatalog[index];
      if (record === undefined || !record.candidateTerm.startsWith(queryPrefix)) {
        break;
      }
      if (!matchesAliasPrefixTerm(queryPrefix, record.candidateTerm)) {
        continue;
      }
      if ('aliases' in record) {
        matches.push(...record.aliases);
        continue;
      }
      matches.push(...this.resolveAliasIndexes(record.aliasIndexes));
    }
    return matches;
  }
}
