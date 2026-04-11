import { describe, expect, it } from 'vitest';
import { buildPlannerContextFromSearchRequest } from '../../../../src/application/search/search-usecase-planner-context.js';

describe('buildPlannerContextFromSearchRequest', () => {
  it('enables planner trace when explain=true', () => {
    const plannerContext = buildPlannerContextFromSearchRequest({
      query: 'Opus One 2018',
      options: {
        mode: 'auto',
        explain: true,
        clarification: false,
      },
    });

    expect(plannerContext.enablePlannerTrace).toBe(true);
  });

  it('enables planner trace when debugRequest=true even if explain=false', () => {
    const plannerContext = buildPlannerContextFromSearchRequest(
      {
        query: 'Opus One 2018',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      { debugRequest: true },
    );

    expect(plannerContext.enablePlannerTrace).toBe(true);
  });

  it('keeps planner trace disabled when neither explain nor debugRequest is set', () => {
    const plannerContext = buildPlannerContextFromSearchRequest({
      query: 'Opus One 2018',
      options: {
        mode: 'auto',
        explain: false,
        clarification: false,
      },
    });

    expect(plannerContext.enablePlannerTrace).toBeUndefined();
  });
});
