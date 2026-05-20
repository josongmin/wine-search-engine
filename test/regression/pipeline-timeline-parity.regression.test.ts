/**
 * T-E10-02: Pipeline timeline parity — structural invariants for
 * PIPELINE_STAGE_ORDER / PIPELINE_STAGE_STEPS / PipelineDebugStep.
 *
 * These tests guarantee that the stage→step mapping is exhaustive, disjoint,
 * and consistent with the PipelineDebugStep enum. A failure here means a new
 * step was added to PipelineDebugStep but not assigned to any stage (or a
 * stage was added to the order without a corresponding entry in the map).
 *
 * APPEND-ONLY. Never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import {
  PipelineDebugStep,
  PIPELINE_STAGE_ORDER,
  PIPELINE_STAGE_STEPS,
  type PipelineDebugStepId,
} from '../../src/domain/observability/pipeline-debug-steps.js';

/** All step IDs declared in PipelineDebugStep. */
const ALL_STEP_IDS: readonly PipelineDebugStepId[] = Object.values(PipelineDebugStep);

/** All step IDs referenced in PIPELINE_STAGE_STEPS (flattened). */
function collectMappedSteps(): PipelineDebugStepId[] {
  const result: PipelineDebugStepId[] = [];
  for (const stage of PIPELINE_STAGE_ORDER) {
    const steps = PIPELINE_STAGE_STEPS[stage];
    for (const step of steps) {
      result.push(step);
    }
  }
  return result;
}

describe('Pipeline timeline parity (T-E10-02)', () => {
  it('every stage in PIPELINE_STAGE_ORDER has an entry in PIPELINE_STAGE_STEPS', () => {
    for (const stage of PIPELINE_STAGE_ORDER) {
      expect(
        PIPELINE_STAGE_STEPS[stage],
        `Stage "${stage}" is in PIPELINE_STAGE_ORDER but missing from PIPELINE_STAGE_STEPS`,
      ).toBeDefined();
      expect(
        PIPELINE_STAGE_STEPS[stage].length,
        `Stage "${stage}" is in PIPELINE_STAGE_STEPS but has zero steps`,
      ).toBeGreaterThan(0);
    }
  });

  it('no step ID appears in more than one stage (disjoint stages)', () => {
    const seen = new Map<PipelineDebugStepId, string>();
    for (const stage of PIPELINE_STAGE_ORDER) {
      for (const step of PIPELINE_STAGE_STEPS[stage]) {
        const existing = seen.get(step);
        expect(
          existing,
          `Step "${step}" appears in both "${existing}" and "${stage}"`,
        ).toBeUndefined();
        seen.set(step, stage);
      }
    }
  });

  it('all PipelineDebugStepId values are covered by PIPELINE_STAGE_STEPS', () => {
    const mapped = new Set<PipelineDebugStepId>(collectMappedSteps());
    const unmapped = ALL_STEP_IDS.filter((id) => !mapped.has(id));
    expect(
      unmapped,
      `Steps not assigned to any stage: ${unmapped.join(', ')}`,
    ).toEqual([]);
  });

  it('PIPELINE_STAGE_ORDER covers all stages in PIPELINE_STAGE_STEPS', () => {
    const orderedStages = new Set<string>(PIPELINE_STAGE_ORDER);
    const mappedStages = Object.keys(PIPELINE_STAGE_STEPS);
    const missing = mappedStages.filter((s) => !orderedStages.has(s));
    expect(
      missing,
      `Stages in PIPELINE_STAGE_STEPS but not in PIPELINE_STAGE_ORDER: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
