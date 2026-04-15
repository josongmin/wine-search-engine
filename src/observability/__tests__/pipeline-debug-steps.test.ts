import { describe, expect, it } from 'vitest';
import {
  PIPELINE_STAGE_ORDER,
  PIPELINE_STAGE_STEPS,
  PipelineDebugStep,
} from '../pipeline-debug-steps.js';

describe('pipeline debug stage mapping', () => {
  it('keeps post-route timeline after decision and before completion', () => {
    const decisionIndex = PIPELINE_STAGE_ORDER.indexOf('decision');
    const postRouteIndex = PIPELINE_STAGE_ORDER.indexOf('post_route');
    const completionIndex = PIPELINE_STAGE_ORDER.indexOf('completion');

    expect(decisionIndex).toBeGreaterThanOrEqual(0);
    expect(postRouteIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(decisionIndex).toBeLessThan(postRouteIndex);
    expect(postRouteIndex).toBeLessThan(completionIndex);
  });

  it('maps post-route steps into the post_route stage for timeline reconstruction', () => {
    expect(PIPELINE_STAGE_STEPS.post_route).toEqual([
      PipelineDebugStep.POST_ROUTE_ENTER,
      PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN,
      PipelineDebugStep.CACHE_SET_SKIPPED,
    ]);
    expect(PIPELINE_STAGE_STEPS.decision).toEqual([
      PipelineDebugStep.DECISION_PHASE_ENTER,
      PipelineDebugStep.DECISION_ENGINE_REQUEST,
      PipelineDebugStep.DECISION_ENGINE_RESPONSE,
    ]);
    expect(PIPELINE_STAGE_STEPS.completion).toEqual([
      PipelineDebugStep.SEARCH_EXECUTE_DONE,
    ]);
  });
});
