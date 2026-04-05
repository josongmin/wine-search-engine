import { describe, expect, it } from 'vitest';
import { createTestContainer } from '../../helpers/test-container.js';
import { InterpretResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';

describe('InterpretResponseSchema', () => {
  it('accepts the planner output for a representative semantic query', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: '오푸스원',
    });

    expect(InterpretResponseSchema.safeParse(plan).success).toBe(true);
  });

  it('accepts the planner output for a representative hybrid discovery query', async () => {
    const parts = createTestContainer();

    const plan = await parts.container.interpretUseCase.execute({
      query: 'full body red wine',
    });

    expect(InterpretResponseSchema.safeParse(plan).success).toBe(true);
  });
});
