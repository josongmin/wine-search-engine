import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  loadLookupV2StretchCorpusSync,
  summarizeLookupV2StretchCorpus,
  type LookupV2StretchRow,
} from './lookup-v2-stretch-corpus.js';

function sampleQueriesByStatus(rows: readonly LookupV2StretchRow[], status: LookupV2StretchRow['expected_status'], limit: number): readonly string[] {
  return rows
    .filter((row) => row.expected_status === status)
    .slice(0, limit)
    .map((row) => row.query);
}

function buildPrompt(args: {
  readonly baseRows: readonly LookupV2StretchRow[];
  readonly targetRows: number;
  readonly resolvedRows: number;
  readonly ambiguousRows: number;
  readonly redirectRows: number;
  readonly failedRows: number;
}): string {
  const summary = summarizeLookupV2StretchCorpus(args.baseRows);
  const resolvedExamples = sampleQueriesByStatus(args.baseRows, 'resolved', 16);
  const ambiguousExamples = sampleQueriesByStatus(args.baseRows, 'ambiguous', 12);
  const redirectExamples = sampleQueriesByStatus(args.baseRows, 'redirect_discovery', 12);
  const failedExamples = sampleQueriesByStatus(args.baseRows, 'failed', 12);
  const topClasses = [...Object.entries(summary.classCounts)]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([className, count]) => `${className}=${count}`);

  return `You are generating JSONL benchmark candidates for a Korean-heavy wine entity-lookup stretch corpus.

Current corpus facts:
- existing_rows=${summary.totalRows}
- existing_entity_rows=${summary.entityRows}
- existing_discovery_rows=${summary.discoveryRows}
- existing_status_counts=${JSON.stringify(summary.statusCounts)}
- dominant_classes=${topClasses.join(', ')}

Goal:
- produce exactly ${args.targetRows} NEW rows
- do NOT include qid
- output JSONL only
- do NOT repeat any existing query verbatim
- keep this corpus entity-lookup focused; discovery rows are allowed but should stay explicit redirect_discovery, not fake resolved rows

Required output schema:
{"query":"...","expected_status":"resolved|ambiguous|failed|redirect_discovery","expected_entity_hint":"... optional only for resolved","accepted_statuses":["... optional"],"class":"...","note":"..."}

Hard rules:
1. resolved rows MUST include expected_entity_hint
2. non-resolved rows MUST NOT include expected_entity_hint or expected_entity_id
3. keep note short and concrete
4. no markdown, no prose, no numbering, JSONL only
5. no duplicate queries inside the output
6. queries must look like Korean real search input, not catalog labels
7. bias toward hard Korean long-tail behavior:
   - producer/family variants
   - compact Hangul spellings
   - mixed-script queries
   - producer-prefixed forms
   - vintage suffix forms
   - fake-but-plausible no-match labels
   - short-form policy collisions
8. do NOT output generic discovery slop unless expected_status=redirect_discovery

Target distribution:
- resolved=${args.resolvedRows}
- ambiguous=${args.ambiguousRows}
- redirect_discovery=${args.redirectRows}
- failed=${args.failedRows}

Preferred class families:
- resolved:
  - realworld_exact_vintage
  - realworld_korean_orthography
  - realworld_spaced_alias
  - realworld_brand_suffix
  - realworld_producer_prefixed
  - realworld_compact_alias
  - realworld_vintage_suffix
  - realworld_mixed_script_alias
- ambiguous:
  - realworld_short_form_collision
  - realworld_broad_icon_collision
  - realworld_common_noun_collision
  - realworld_appellation_collision
  - realworld_family_collision
  - realworld_near_miss_ambiguous
- redirect_discovery:
  - realworld_grape_recommendation
  - realworld_region_grape
  - realworld_style_recommendation
  - realworld_pairing_recommendation
  - realworld_occasion_recommendation
  - realworld_gift_recommendation
  - realworld_price_band_recommendation
  - realworld_generic_discovery
- failed:
  - realworld_adversarial_no_match
  - realworld_collapsed_typo_gap
  - realworld_frenchish_korean_gap
  - realworld_fake_chateau_label
  - realworld_fake_napa_reserve
  - realworld_fake_champagne_label
  - realworld_under_specified_failure

Already-covered resolved examples to avoid repeating:
${resolvedExamples.map((query) => `- ${query}`).join('\n')}

Already-covered ambiguous examples to avoid repeating:
${ambiguousExamples.map((query) => `- ${query}`).join('\n')}

Already-covered redirect_discovery examples to avoid repeating:
${redirectExamples.map((query) => `- ${query}`).join('\n')}

Already-covered failed examples to avoid repeating:
${failedExamples.map((query) => `- ${query}`).join('\n')}

Important:
- Do not output qid
- Do not output expected_entity_id
- If uncertain, prefer ambiguous or failed over resolved
- Keep responses realistic for Korean users who type messy wine searches
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string', default: 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl' },
      output: { type: 'string', default: 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-expansion-prompt.txt' },
      rows: { type: 'string', default: '500' },
      resolved: { type: 'string', default: '200' },
      ambiguous: { type: 'string', default: '100' },
      redirect: { type: 'string', default: '100' },
      failed: { type: 'string', default: '100' },
    },
  });
  const inputPath = values.input ?? 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl';
  const outputPath = values.output ?? 'data/lookup-v2/drafts/lookup-v2-korean-realworld-stretch-expansion-prompt.txt';
  const rows = loadLookupV2StretchCorpusSync(inputPath);
  const prompt = buildPrompt({
    baseRows: rows,
    targetRows: Number.parseInt(values.rows ?? '500', 10),
    resolvedRows: Number.parseInt(values.resolved ?? '200', 10),
    ambiguousRows: Number.parseInt(values.ambiguous ?? '100', 10),
    redirectRows: Number.parseInt(values.redirect ?? '100', 10),
    failedRows: Number.parseInt(values.failed ?? '100', 10),
  });
  writeFileSync(outputPath, prompt, 'utf8');
  console.log(`[stretch-corpus-prompt] input=${inputPath}`);
  console.log(`[stretch-corpus-prompt] output=${outputPath}`);
}

main().catch((error: unknown) => {
  console.error('[stretch-corpus-prompt] FATAL', error);
  process.exit(2);
});

