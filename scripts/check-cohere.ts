import { parseEnv } from '../src/config/env.js';
import { buildCoreAdapterServices } from '../src/config/container-adapters.js';

const config = parseEnv();
const adapters = buildCoreAdapterServices(config);

console.log('cohere.apiKey set:', config.cohere.apiKey !== undefined);
console.log('cohere.rerankModel:', config.cohere.rerankModel);
console.log('reranker adapter wired:', adapters.reranker !== undefined);
console.log('reranker constructor:', adapters.reranker?.constructor?.name ?? 'none');
