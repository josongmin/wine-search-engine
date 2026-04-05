import { createContainer } from './src/config/container.js';
import { config } from './src/config/env.js';

async function test() {
  console.log('Starting container...');
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

test().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
