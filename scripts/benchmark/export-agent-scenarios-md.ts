/**
 * Dumps `AGENT_SCENARIOS` to `test/benchmark/agent/AGENT_SCENARIOS.md` for human
 * reference (single file listing every benchmark scenario id / tier / description / query).
 *
 *   pnpm run bench:agent:export-scenarios-md
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../../test/benchmark/agent/AGENT_SCENARIOS.md');

function esc(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function block(s: string): string {
  const body = esc(s).replace(/```/g, '\\`\\`\\`');
  return `\`\`\`\n${body}\n\`\`\``;
}

function scenarioSection(s: AgentBenchmarkScenario): string {
  const parts: string[] = [
    `### ${s.id} · ${s.tier}`,
    '',
    `**${esc(s.description)}**`,
    '',
    block(s.query),
    '',
  ];
  if (s.goldenKeywords?.length) {
    parts.push(`- **goldenKeywords:** ${s.goldenKeywords.join(', ')}`, '');
  }
  if (s.severity) {
    parts.push(`- **severity:** ${s.severity}`, '');
  }
  if (s.skip) {
    parts.push(`- **skip:** ${s.skip}`, '');
  }
  return parts.join('\n');
}

const sorted = [...AGENT_SCENARIOS].sort((a, b) => a.id - b.id);

const doc = [
  '# Agent benchmark scenarios (`AGENT_SCENARIOS`)',
  '',
  'Canonical definitions live in `test/benchmark/agent/scenarios.ts` (and merged modules).',
  'This file is generated — do not edit by hand.',
  '',
  '```text',
  'pnpm exec tsx scripts/benchmark/export-agent-scenarios-md.ts',
  '```',
  '',
  `**Total:** ${sorted.length} scenarios`,
  '',
  '---',
  '',
  ...sorted.map(scenarioSection),
  '',
].join('\n');

writeFileSync(OUT, doc, 'utf8');
console.error(`Wrote ${sorted.length} scenarios to ${OUT}`);
