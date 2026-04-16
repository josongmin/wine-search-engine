import { describe, expect, it } from 'vitest';
import { createTestContainer } from '../../helpers/test-container.js';
import { deepKeysToSnake } from '../../../../src/interface/http/middleware/snake-case-hook.js';
import { InterpretResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';

describe('InterpretResponseSchema', () => {
  it('accepts the planner output for a representative semantic query', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: '오푸스원',
    });

    expect(InterpretResponseSchema.safeParse(deepKeysToSnake(plan)).success).toBe(true);
  });

  it('accepts the planner output for a representative hybrid discovery query', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: 'full body red wine',
    });

    expect(InterpretResponseSchema.safeParse(deepKeysToSnake(plan)).success).toBe(true);
  });

  it('rejects V2 explain fields so the V1 interpret contract stays fail-closed', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: 'Opus One 2018',
    });

    const polluted = {
      ...deepKeysToSnake(plan),
      version: '2',
      response_type: 'interpret',
      query_id: 'q-v2',
      detected_intent: 'entity_exact',
      active_channels: ['sparse_bm25'],
      applied_constraints: [],
      ranking_signals: ['semantic_similarity'],
      confidence: 0.9,
    };

    expect(InterpretResponseSchema.safeParse(polluted).success).toBe(false);
  });

  it('rejects unexpected keys inside typed interpret policy and anchors', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: '오푸스원',
    });

    const polluted = {
      ...deepKeysToSnake(plan),
      policy: {
        ...deepKeysToSnake(plan).policy,
        stray_flag: true,
      },
      anchors: [
        ...deepKeysToSnake(plan).anchors,
        {
          surface_form: 'x',
          normalized_form: 'x',
          candidate_entity_ids: ['x'],
          confidence: 0.5,
          source: 'alias',
          stray_flag: true,
        },
      ],
    };

    expect(InterpretResponseSchema.safeParse(polluted).success).toBe(false);
  });
});
