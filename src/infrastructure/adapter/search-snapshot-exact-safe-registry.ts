import fs from 'node:fs/promises';
import { z } from 'zod';
import { normalizeForMatch } from '../../domain/alias/service/normalize.js';
import { compactForLookup } from '../../domain/query/service/phonetic-skeleton.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import {
  parseLookupExactSafeRuntimeArtifact,
} from '../../domain/shared/types/search-snapshot-lookup-runtime.js';
import type {
  LookupExactSafeMatch,
  LookupExactSafeRegistryPort,
} from '../../domain/resolver/v2/lookup-v2-types.js';
import type { NormalizedQueryViews } from '../../domain/query/model/query-views.js';

const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SEARCH_SNAPSHOT_SCHEMA_VERSION),
  artifacts: z.object({
    lookupExactSafeRuntimeJson: z.string().min(1),
  }).passthrough(),
}).passthrough();

function parseExactSafeRuntimePath(raw: string, manifestPath: string): string {
  const parsed: unknown = JSON.parse(raw);
  const manifest = SnapshotManifestSchema.parse(parsed);
  const artifactPath = manifest.artifacts.lookupExactSafeRuntimeJson;
  if (artifactPath.length === 0) {
    throw new Error(
      `Malformed search snapshot manifest at ${manifestPath}: artifacts.lookupExactSafeRuntimeJson is required`,
    );
  }
  return artifactPath;
}

export class SearchSnapshotExactSafeRegistry implements LookupExactSafeRegistryPort {
  static async loadFromManifest(
    manifestPath: string,
  ): Promise<SearchSnapshotExactSafeRegistry> {
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const artifactPath = parseExactSafeRuntimePath(manifestRaw, manifestPath);
    const artifactRaw = await fs.readFile(artifactPath, 'utf8');
    const artifact = parseLookupExactSafeRuntimeArtifact(artifactRaw, artifactPath);
    bootstrapLogger.info(
      {
        manifestPath,
        artifactPath,
        exactEntryCount: Object.keys(artifact.exactEntries).length,
        compactEntryCount: Object.keys(artifact.compactEntries).length,
      },
      '[Container] Search snapshot exact-safe runtime loaded from manifest into memory',
    );
    return new SearchSnapshotExactSafeRegistry(
      new Map(
        Object.entries(artifact.exactEntries).map(([surface, entry]) => [
          surface,
          {
            entityId: createCanonicalEntityId(entry.entityId),
            locale: entry.locale,
            kind: entry.certificate.kind,
            normalizedSurface: entry.certificate.normalizedSurface,
            ...(entry.certificate.compactSurface !== undefined
              ? { compactSurface: entry.certificate.compactSurface }
              : {}),
          } satisfies LookupExactSafeMatch,
        ]),
      ),
      new Map(
        Object.entries(artifact.compactEntries).map(([surface, entry]) => [
          surface,
          {
            entityId: createCanonicalEntityId(entry.entityId),
            locale: entry.locale,
            kind: entry.certificate.kind,
            normalizedSurface: entry.certificate.normalizedSurface,
            ...(entry.certificate.compactSurface !== undefined
              ? { compactSurface: entry.certificate.compactSurface }
              : {}),
          } satisfies LookupExactSafeMatch,
        ]),
      ),
    );
  }

  constructor(
    private readonly exactEntries: ReadonlyMap<string, LookupExactSafeMatch>,
    private readonly compactEntries: ReadonlyMap<string, LookupExactSafeMatch>,
  ) {}

  match(views: NormalizedQueryViews): LookupExactSafeMatch | null {
    const exactKeys = new Set<string>();
    for (const surface of [
      views.raw,
      views.strict,
      views.accentless,
      views.collapsedWhitespace,
      views.punctuationStripped,
      views.vintageCanonicalized,
      views.vintageStripped,
      views.transliterated,
      ...views.lookupVariants,
    ]) {
      if (surface === undefined) {
        continue;
      }
      const normalized = normalizeForMatch(surface);
      if (normalized.length > 0) {
        exactKeys.add(normalized);
      }
    }
    for (const key of exactKeys) {
      const hit = this.exactEntries.get(key);
      if (hit !== undefined) {
        return hit;
      }
    }

    const compactKeys = new Set<string>();
    for (const surface of [
      views.raw,
      views.strict,
      views.accentless,
      views.compact,
      views.vintageCanonicalized,
      views.vintageStripped,
      views.transliterated,
      views.phoneticCompact,
      ...views.lookupVariants,
    ]) {
      if (surface === undefined) {
        continue;
      }
      const compact = compactForLookup(surface);
      if (compact.length > 0) {
        compactKeys.add(compact);
      }
    }
    for (const key of compactKeys) {
      const hit = this.compactEntries.get(key);
      if (hit !== undefined) {
        return hit;
      }
    }
    return null;
  }
}
