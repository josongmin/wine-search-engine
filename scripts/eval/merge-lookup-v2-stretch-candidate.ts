import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  assignLookupV2StretchQids,
  formatLookupV2StretchCorpusSummary,
  loadLookupV2StretchCandidateSync,
  loadLookupV2StretchCorpusSync,
  serializeLookupV2StretchRows,
  summarizeLookupV2StretchCorpus,
} from './lookup-v2-stretch-corpus.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      corpus: { type: 'string', default: 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl' },
      candidate: { type: 'string' },
      output: { type: 'string', default: '/tmp/lookup-v2-korean-realworld-stretch.merged.jsonl' },
      qidPrefix: { type: 'string', default: 'kry' },
      write: { type: 'boolean', default: false },
    },
  });

  const corpusPath = values.corpus ?? 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl';
  const candidatePath = values.candidate;
  if (candidatePath === undefined) {
    throw new Error('missing required --candidate <path>');
  }
  const outputPath = values.write ? corpusPath : (values.output ?? '/tmp/lookup-v2-korean-realworld-stretch.merged.jsonl');

  const corpusRows = loadLookupV2StretchCorpusSync(corpusPath);
  const candidateRows = loadLookupV2StretchCandidateSync(candidatePath);
  const assignedRows = assignLookupV2StretchQids({
    candidateRows,
    existingRows: corpusRows,
    qidPrefix: values.qidPrefix ?? 'kry',
  });
  const mergedRows = [...corpusRows, ...assignedRows];
  writeFileSync(outputPath, serializeLookupV2StretchRows(mergedRows), 'utf8');

  console.log(`[stretch-corpus-merge] corpus=${corpusPath}`);
  console.log(`[stretch-corpus-merge] candidate=${candidatePath}`);
  console.log(`[stretch-corpus-merge] output=${outputPath}`);
  console.log(`[stretch-corpus-merge] appended_rows=${assignedRows.length}`);
  console.log(formatLookupV2StretchCorpusSummary(summarizeLookupV2StretchCorpus(assignedRows)));
  console.log('[stretch-corpus-merge] merged_summary');
  console.log(formatLookupV2StretchCorpusSummary(summarizeLookupV2StretchCorpus(mergedRows)));
}

main().catch((error: unknown) => {
  console.error('[stretch-corpus-merge] FATAL', error);
  process.exit(2);
});

