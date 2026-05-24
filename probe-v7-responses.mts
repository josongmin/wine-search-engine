/**
 * Probe — re-run 4 interesting v7 scenarios and dump the FULL response
 * (answer text + tool outcomes + data sources) so we can see WHAT the
 * agent actually returned and WHICH data it used.
 *
 * Picked scenarios:
 *   #52  knowledge_hybrid — 0% → 70.7% (biggest lift)
 *   #61  korean_colloquial — 0% → 34.7%
 *   #117 comparison_nested — 30.7% → 41.0%
 *   #200 wine_name_lookup — "Sassicaia" (entity lookup, baseline 57%)
 */
import { createContainer } from './src/config/container.js';
import { loadConfig } from './src/config/env.js';

const SCENARIOS = [
  { id: 52, query: '디캔팅 해야 되는 와인이면 미리 알려줘' },
  { id: 61, query: '쌈싸먹을때 와인 뭐가 좋아' },
  { id: 117, query: '오푸스 원 2018이랑 알마비바 2019 중 지금 마시기 더 좋은 쪽 골라줘' },
  { id: 200, query: 'Sassicaia' },
];

const config = loadConfig();
const container = await createContainer(config);
const orchestrator = container.wineSearch?.wineSearchOrchestrator;
if (orchestrator === undefined) {
  console.error('wineSearch slice not present — set WINE_SEARCH_ENABLED=true');
  process.exit(1);
}

for (const sc of SCENARIOS) {
  console.log('\n' + '='.repeat(80));
  console.log(`#${sc.id}  Q: ${sc.query}`);
  console.log('='.repeat(80));
  const t0 = Date.now();
  try {
    const result = await orchestrator.execute({
      query: sc.query,
      requestId: `probe-${sc.id}`,
      perStepTimeoutMs: 30_000,
    });
    const wall = Date.now() - t0;
    console.log(`\n[answer / ${result.layer} / ${result.intent} / ${result.terminationReason} / ${wall}ms]`);
    console.log(result.answer);
    console.log(`\n[tool_outcomes: ${result.toolOutcomes.length}]`);
    for (const t of result.toolOutcomes) {
      const out = (t as unknown as { result?: unknown }).result;
      let summary = '';
      if (out === undefined || out === null) {
        summary = '(empty)';
      } else if (typeof out === 'object') {
        const obj = out as Record<string, unknown>;
        if (Array.isArray(obj['items'])) {
          const items = obj['items'] as Array<Record<string, unknown>>;
          summary = `${items.length} items`;
          if (items.length > 0) {
            const top = items.slice(0, 3).map((it) =>
              `${it['canonical_label'] ?? it['canonicalLabel'] ?? it['entity_id'] ?? '?'}`
            ).join(' | ');
            summary += ` — top: ${top}`;
          }
        } else if (Array.isArray(obj['hits'])) {
          const hits = obj['hits'] as Array<Record<string, unknown>>;
          summary = `${hits.length} hits`;
          if (hits.length > 0) {
            const top = hits.slice(0, 3).map((it) =>
              `${it['canonical_label'] ?? it['canonicalLabel'] ?? '?'}`
            ).join(' | ');
            summary += ` — top: ${top}`;
          }
        } else if (obj['canonical_label'] !== undefined || obj['canonicalLabel'] !== undefined) {
          summary = `${obj['canonical_label'] ?? obj['canonicalLabel']}`;
        } else if (obj['answer'] !== undefined) {
          summary = String(obj['answer']).slice(0, 100);
        } else {
          summary = JSON.stringify(obj).slice(0, 200);
        }
      } else {
        summary = String(out).slice(0, 200);
      }
      console.log(`  • ${t.tool} [${t.kind}, ${t.durationMs}ms]: ${summary}`);
      if (t.errorMessage !== undefined) console.log(`      err: ${t.errorMessage}`);
    }
    console.log(`\n[execution_steps: ${result.executionSteps.length}, toolCallCount: ${result.toolCallCount}]`);
    for (const s of result.executionSteps) {
      console.log(`  ${s.source}/${s.kind}` + (s.toolCalls != null ? ` × ${s.toolCalls.length}` : ''));
    }
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
}
process.exit(0);
