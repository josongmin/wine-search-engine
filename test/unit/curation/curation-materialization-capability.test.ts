import { describe, expect, it } from 'vitest';
import {
  CURATION_MATERIALIZATION_SNAPSHOT_COLUMN,
  pgCurationMaterializationTrackingEnabled,
} from '../../../src/infrastructure/curation/curation-materialization-capability.js';

describe('curation-materialization-capability', () => {
  it('probes migration 033 column name on alias_proposals', () => {
    expect(CURATION_MATERIALIZATION_SNAPSHOT_COLUMN).toBe('materialized_snapshot_id');
  });

  it('pgCurationMaterializationTrackingEnabled is exported for graceful degrade', () => {
    expect(typeof pgCurationMaterializationTrackingEnabled).toBe('function');
  });
});
