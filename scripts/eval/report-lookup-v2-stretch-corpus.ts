import { parseArgs } from 'node:util';
import {
  formatLookupV2StretchCorpusSummary,
  loadLookupV2StretchCorpusSync,
  summarizeLookupV2StretchCorpus,
} from './lookup-v2-stretch-corpus.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl' },
    },
  });
  const inputPath = values.input ?? 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl';
  const rows = loadLookupV2StretchCorpusSync(inputPath);
  const summary = summarizeLookupV2StretchCorpus(rows);
  console.log(formatLookupV2StretchCorpusSummary(summary));
  console.log(`[stretch-corpus] input=${inputPath}`);
}

main().catch((error: unknown) => {
  console.error('[stretch-corpus] FATAL', error);
  process.exit(2);
});

