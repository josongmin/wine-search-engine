import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

export const ETL_ARTIFACT_FILES = {
  silver: resolveDataPath('data/silver.ndjson'),
  aliases: resolveDataPath('data/silver-aliases.ndjson'),
  ko: resolveDataPath('data/silver-ko.ndjson'),
  docquery: resolveDataPath('data/silver-docquery.ndjson'),
  trackc: resolveDataPath('data/silver-trackc.ndjson'),
  qualityReport: resolveDataPath('data/silver-quality-report.json'),
  ambiguityRegistry: resolveDataPath('data/ambiguity-registry.ndjson'),
  searchSnapshotsDir: resolveDataPath('data/search-snapshots'),
  nlMappings: resolveDataPath('data/nl-mappings.json'),
} as const;

export type EtlArtifactKey = keyof typeof ETL_ARTIFACT_FILES;

export const ETL_CANONICAL_ARTIFACT_SEQUENCE = [
  ETL_ARTIFACT_FILES.silver,
  ETL_ARTIFACT_FILES.aliases,
  ETL_ARTIFACT_FILES.ko,
  ETL_ARTIFACT_FILES.docquery,
  ETL_ARTIFACT_FILES.trackc,
] as const;

export const ETL_STAGE_FILE_GRAPH = {
  silver: {
    input: undefined,
    output: ETL_ARTIFACT_FILES.silver,
  },
  aliases: {
    input: ETL_ARTIFACT_FILES.silver,
    output: ETL_ARTIFACT_FILES.aliases,
  },
  koreanAliases: {
    input: ETL_ARTIFACT_FILES.aliases,
    output: ETL_ARTIFACT_FILES.ko,
  },
  docQuery: {
    input: ETL_ARTIFACT_FILES.ko,
    output: ETL_ARTIFACT_FILES.docquery,
  },
  trackC: {
    input: ETL_ARTIFACT_FILES.docquery,
    output: ETL_ARTIFACT_FILES.trackc,
  },
  validate: {
    input: ETL_ARTIFACT_FILES.trackc,
    output: ETL_ARTIFACT_FILES.qualityReport,
  },
  index: {
    input: ETL_ARTIFACT_FILES.trackc,
    output: undefined,
  },
  buildSearchSnapshot: {
    input: ETL_ARTIFACT_FILES.trackc,
    output: ETL_ARTIFACT_FILES.searchSnapshotsDir,
  },
  publishSearchSnapshot: {
    input: ETL_ARTIFACT_FILES.trackc,
    output: undefined,
  },
  buildAmbiguityRegistry: {
    input: ETL_ARTIFACT_FILES.ko,
    output: ETL_ARTIFACT_FILES.ambiguityRegistry,
  },
} as const;

export const DEFAULT_INDEXABLE_ETL_INPUT = ETL_ARTIFACT_FILES.trackc;
