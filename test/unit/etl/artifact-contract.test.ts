import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDEXABLE_ETL_INPUT,
  ETL_ARTIFACT_FILES,
  ETL_CANONICAL_ARTIFACT_SEQUENCE,
  ETL_STAGE_FILE_GRAPH,
} from '../../../scripts/etl/artifact-contract.js';
import { DEFAULT_INPUT as GENERATE_ALIASES_INPUT, DEFAULT_OUTPUT as GENERATE_ALIASES_OUTPUT } from '../../../scripts/etl/generate-aliases.js';
import { DEFAULT_INPUT as GENERATE_KOREAN_ALIASES_INPUT, DEFAULT_OUTPUT as GENERATE_KOREAN_ALIASES_OUTPUT } from '../../../scripts/etl/generate-korean-aliases.js';
import { DEFAULT_INPUT as GENERATE_DOC_QUERIES_INPUT, DEFAULT_OUTPUT as GENERATE_DOC_QUERIES_OUTPUT } from '../../../scripts/etl/generate-doc-queries.js';
import { DEFAULT_INPUT as BUILD_AMBIGUITY_REGISTRY_INPUT, DEFAULT_OUTPUT as BUILD_AMBIGUITY_REGISTRY_OUTPUT } from '../../../scripts/etl/build-ambiguity-registry.js';
import { DEFAULT_INPUT as BUILD_SEARCH_SNAPSHOT_INPUT } from '../../../scripts/etl/build-search-snapshot.js';
import { DEFAULT_INPUT as PUBLISH_SEARCH_SNAPSHOT_INPUT } from '../../../scripts/etl/publish-search-snapshot.js';
import { DEFAULT_INPUT as VALIDATE_SILVER_INPUT } from '../../../scripts/etl/validate-silver.js';
import { DEFAULT_INPUT as INDEX_TO_VESPA_INPUT } from '../../../scripts/etl/index-to-vespa.js';
import { TRACK_C_OUTPUT_FILE, TRACK_C_SOURCE_FILE } from '../../../scripts/etl/run-track-c.js';
import { DATA_FILE as TRACK_C_STEP1_FILE } from '../../../scripts/etl/run-track-c-step1.js';
import { DATA_FILE as TRACK_C_STEP2_FILE } from '../../../scripts/etl/run-track-c-step2.js';
import { DATA_FILE as TRACK_C_STEP3_FILE } from '../../../scripts/etl/run-track-c-step3.js';
import { DATA_FILE as DRINKING_WINDOW_FILE } from '../../../scripts/etl/drinking-window-backfill.js';

describe('ETL artifact contract', () => {
  it('defines the canonical silver -> aliases -> ko -> docquery -> trackc chain', () => {
    expect(ETL_CANONICAL_ARTIFACT_SEQUENCE).toEqual([
      ETL_ARTIFACT_FILES.silver,
      ETL_ARTIFACT_FILES.aliases,
      ETL_ARTIFACT_FILES.ko,
      ETL_ARTIFACT_FILES.docquery,
      ETL_ARTIFACT_FILES.trackc,
    ]);
    expect(ETL_STAGE_FILE_GRAPH.aliases).toEqual({
      input: ETL_ARTIFACT_FILES.silver,
      output: ETL_ARTIFACT_FILES.aliases,
    });
    expect(ETL_STAGE_FILE_GRAPH.koreanAliases).toEqual({
      input: ETL_ARTIFACT_FILES.aliases,
      output: ETL_ARTIFACT_FILES.ko,
    });
    expect(ETL_STAGE_FILE_GRAPH.docQuery).toEqual({
      input: ETL_ARTIFACT_FILES.ko,
      output: ETL_ARTIFACT_FILES.docquery,
    });
    expect(ETL_STAGE_FILE_GRAPH.trackC).toEqual({
      input: ETL_ARTIFACT_FILES.docquery,
      output: ETL_ARTIFACT_FILES.trackc,
    });
    expect(DEFAULT_INDEXABLE_ETL_INPUT).toBe(ETL_ARTIFACT_FILES.trackc);
  });

  it('keeps CLI defaults aligned with the SSOT', () => {
    expect(GENERATE_ALIASES_INPUT).toBe(ETL_ARTIFACT_FILES.silver);
    expect(GENERATE_ALIASES_OUTPUT).toBe(ETL_ARTIFACT_FILES.aliases);
    expect(GENERATE_KOREAN_ALIASES_INPUT).toBe(ETL_ARTIFACT_FILES.aliases);
    expect(GENERATE_KOREAN_ALIASES_OUTPUT).toBe(ETL_ARTIFACT_FILES.ko);
    expect(GENERATE_DOC_QUERIES_INPUT).toBe(ETL_ARTIFACT_FILES.ko);
    expect(GENERATE_DOC_QUERIES_OUTPUT).toBe(ETL_ARTIFACT_FILES.docquery);
    expect(BUILD_AMBIGUITY_REGISTRY_INPUT).toBe(ETL_ARTIFACT_FILES.ko);
    expect(BUILD_AMBIGUITY_REGISTRY_OUTPUT).toBe(ETL_ARTIFACT_FILES.ambiguityRegistry);
    expect(BUILD_SEARCH_SNAPSHOT_INPUT).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(PUBLISH_SEARCH_SNAPSHOT_INPUT).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(VALIDATE_SILVER_INPUT).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(INDEX_TO_VESPA_INPUT).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(TRACK_C_SOURCE_FILE).toBe(ETL_ARTIFACT_FILES.docquery);
    expect(TRACK_C_OUTPUT_FILE).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(TRACK_C_STEP1_FILE).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(TRACK_C_STEP2_FILE).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(TRACK_C_STEP3_FILE).toBe(ETL_ARTIFACT_FILES.trackc);
    expect(DRINKING_WINDOW_FILE).toBe(ETL_ARTIFACT_FILES.trackcExperimental);
  });
});
