/**
 * Ad-hoc search smoke: wires DI container and runs one query.
 * For manual debugging; not part of Vitest.
 */
import { createContainer } from '../../src/config/container.js';
import { config } from '../../src/config/env.js';

async function test(): Promise<void> {
  console.log('Starting container...');
  console.log('Env ANTHROPIC_API_KEY:', process.env['ANTHROPIC_API_KEY'] ?? '(not set)');
  console.log('Config anthropic.apiKey:', config.anthropic.apiKey ?? '(undefined)');
  console.log('Config killswitch injectionJudge:', config.killSwitch.injectionJudge);
  const container = await createContainer(config);
  console.log('Container created');

  console.log('Executing search...');
  const result = await container.searchUseCase.execute(
    {
      query: 'cabernet',
    },
    'test-request-id',
  );

  console.log('Search result structure:', {
    route: result.route,
    resultsLength: result.results?.length ?? 'undefined',
    metaKeys: Object.keys(result.meta || {}),
  });
  console.log('Full result:', JSON.stringify(result, null, 2).slice(0, 500));
  process.exit(0);
}

void test().catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
