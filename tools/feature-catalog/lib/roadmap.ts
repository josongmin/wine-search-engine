import type { LoadedFeature } from './load.js';
import type { Feature, Maturity } from '../schema/feature.schema.js';

type Effort = 'quick-win' | 'medium' | 'strategic';

const EFFORT_LABEL: Record<Effort, string> = {
  'quick-win': 'Quick Wins (≤1 week)',
  medium: 'Medium Effort (1-4 weeks)',
  strategic: 'Strategic (1+ months / cross-cutting)',
};

const STRATEGIC_TAG_HINTS: ReadonlySet<string> = new Set([
  'migration-candidate',
  'deletion-candidate',
  'experimental',
  'pte',
  'poc',
]);

const STRATEGIC_TEXT_HINTS: readonly string[] = [
  'migration',
  'architecture',
  'react replacement',
  'rewrite',
  'serving stack',
  'closed-loop',
  'closed loop',
  'fully integrate',
  'a/b',
  'rollout',
];

const MEDIUM_TEXT_HINTS: readonly string[] = [
  'integration',
  'learning',
  'feedback loop',
  'online',
  'eval',
  'calibration',
  'cross-validation',
  'retraining',
  'sla',
  'auto-rollback',
  'cache invalidation',
  'versioning',
];

function classifyEffort(feature: Feature): Effort {
  const tags = feature.tags;
  if (tags.some((t) => STRATEGIC_TAG_HINTS.has(t))) {
    return 'strategic';
  }
  if (feature.status === 'experimental') {
    return 'strategic';
  }

  const text = [
    ...feature.known_limitations,
    ...feature.next_steps,
  ].join(' ').toLowerCase();

  if (STRATEGIC_TEXT_HINTS.some((h) => text.includes(h))) {
    return 'strategic';
  }
  if (MEDIUM_TEXT_HINTS.some((h) => text.includes(h))) {
    return 'medium';
  }
  return 'quick-win';
}

function targetMaturity(current: Maturity): Maturity {
  return current < 5 ? ((current + 1) as Maturity) : 5;
}

function maturityCell(current: Maturity, target: Maturity): string {
  if (current === target) return `${current}/5 (held)`;
  return `${current} → ${target}`;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function summarizeSteps(steps: readonly string[]): string {
  if (steps.length === 0) return '_no plan_';
  return steps
    .slice(0, 2)
    .map((s) => shorten(s, 90))
    .join(' · ');
}

function summarizeBlockers(blockers: readonly string[]): string {
  if (blockers.length === 0) return '—';
  return blockers
    .slice(0, 2)
    .map((s) => shorten(s, 80))
    .join(' · ');
}

export function renderRoadmap(
  features: readonly LoadedFeature[],
  builtAt: string,
): string {
  const groups: Record<Effort, LoadedFeature[]> = {
    'quick-win': [],
    medium: [],
    strategic: [],
  };
  for (const lf of features) {
    groups[classifyEffort(lf.feature)].push(lf);
  }
  for (const tier of ['quick-win', 'medium', 'strategic'] as const) {
    groups[tier].sort((a, b) => {
      if (a.feature.maturity !== b.feature.maturity) {
        return a.feature.maturity - b.feature.maturity;
      }
      return a.feature.id.localeCompare(b.feature.id);
    });
  }

  const lines: string[] = [];
  lines.push('# Wine Search Engine — Maturity Improvement Roadmap');
  lines.push('');
  lines.push(`_Built: ${builtAt}_`);
  lines.push('');
  lines.push('각 feature의 `known_limitations` + `next_steps` 텍스트에서 effort tier를 휴리스틱 분류하고 현재 → 목표 maturity 1단계 bump 위한 핵심 작업을 추출.');
  lines.push('');

  const total = features.length;
  lines.push('## At a glance');
  lines.push('');
  lines.push(`- **Total features**: ${total}`);
  lines.push(`- **${EFFORT_LABEL['quick-win']}**: ${groups['quick-win'].length}`);
  lines.push(`- **${EFFORT_LABEL.medium}**: ${groups.medium.length}`);
  lines.push(`- **${EFFORT_LABEL.strategic}**: ${groups.strategic.length}`);
  lines.push('');
  lines.push('Hold at 5: features already at maturity 5 (이미 SOTA++) listed as `held`.');
  lines.push('');

  for (const tier of ['quick-win', 'medium', 'strategic'] as const) {
    const items = groups[tier];
    lines.push(`## ${EFFORT_LABEL[tier]} (${items.length})`);
    lines.push('');
    if (items.length === 0) {
      lines.push('_(none)_');
      lines.push('');
      continue;
    }

    lines.push('| ID | Maturity | Top Plan | Blockers |');
    lines.push('|---|---|---|---|');
    for (const { feature } of items) {
      const target = targetMaturity(feature.maturity);
      const mat = maturityCell(feature.maturity, target);
      const plan = summarizeSteps(feature.next_steps);
      const blockers = summarizeBlockers(feature.known_limitations);
      lines.push(
        `| [\`${feature.id}\`](./features/${feature.id}.md) | ${mat} | ${plan} | ${blockers} |`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Effort classification heuristic');
  lines.push('');
  lines.push('- **strategic**: `tags` 에 `migration-candidate` / `deletion-candidate` / `experimental` / `pte` / `poc` 또는 limitations/steps에 "migration", "architecture", "rollout", "closed-loop" 등 키워드.');
  lines.push('- **medium**: "integration", "learning", "feedback loop", "calibration", "cross-validation", "retraining", "SLA", "versioning" 등.');
  lines.push('- **quick-win**: 나머지 (test backfill, observability hook, threshold tuning 등).');
  lines.push('');
  return lines.join('\n') + '\n';
}

export function renderImprovementSummary(
  features: readonly LoadedFeature[],
): string {
  const byCategory = new Map<string, { count: number; quickWins: number; medium: number; strategic: number; totalMaturity: number }>();
  for (const lf of features) {
    const cat = lf.feature.category;
    const effort = classifyEffort(lf.feature);
    const entry = byCategory.get(cat) ?? {
      count: 0,
      quickWins: 0,
      medium: 0,
      strategic: 0,
      totalMaturity: 0,
    };
    entry.count += 1;
    entry.totalMaturity += lf.feature.maturity;
    if (effort === 'quick-win') entry.quickWins += 1;
    if (effort === 'medium') entry.medium += 1;
    if (effort === 'strategic') entry.strategic += 1;
    byCategory.set(cat, entry);
  }

  const lines: string[] = [];
  lines.push('# Improvement Summary by Category');
  lines.push('');
  lines.push('| Category | Avg Maturity | Quick Wins | Medium | Strategic |');
  lines.push('|---|---|---|---|---|');
  for (const [cat, e] of [...byCategory.entries()].sort()) {
    const avg = (e.totalMaturity / e.count).toFixed(2);
    lines.push(
      `| \`${cat}\` | ${avg} (n=${e.count}) | ${e.quickWins} | ${e.medium} | ${e.strategic} |`,
    );
  }
  lines.push('');
  return lines.join('\n') + '\n';
}
