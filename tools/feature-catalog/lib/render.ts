import type { LoadedFeature } from './load.js';
import type { Feature, Maturity } from '../schema/feature.schema.js';

const MATURITY_LABELS: Record<Maturity, string> = {
  1: 'Concept/Stub',
  2: 'Prototype',
  3: 'Functional',
  4: 'Production',
  5: 'SOTA++',
};

/** Use BWP-safe characters (not emoji) so output is plain markdown. */
function maturityStars(maturity: Maturity): string {
  return '★'.repeat(maturity) + '☆'.repeat(5 - maturity);
}

function statusBadge(status: Feature['status']): string {
  return `\`${status}\``;
}

/**
 * Build a relative link from a generated markdown file back to a file at repo root.
 * Caller passes the prefix corresponding to the markdown's own depth.
 */
function fileLink(path: string, repoRootRelative: string): string {
  return `[\`${path}\`](${repoRootRelative}${path})`;
}

export function renderFeatureDetail(
  loaded: LoadedFeature,
  repoRootRelative: string,
): string {
  const { feature } = loaded;
  const lines: string[] = [];
  lines.push(`# ${feature.name}`);
  lines.push('');
  lines.push(`> ${feature.summary.trim()}`);
  lines.push('');

  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| **ID** | \`${feature.id}\` |`);
  lines.push(`| **Category** | \`${feature.category}\` |`);
  lines.push(
    `| **Maturity** | ${maturityStars(feature.maturity)} **${feature.maturity}/5** — ${MATURITY_LABELS[feature.maturity]} |`,
  );
  lines.push(`| **Status** | ${statusBadge(feature.status)} |`);
  if (feature.since !== undefined) lines.push(`| **Since** | ${feature.since} |`);
  lines.push(`| **Last reviewed** | ${feature.last_reviewed} |`);
  if (feature.owner !== undefined) lines.push(`| **Owner** | ${feature.owner} |`);
  lines.push('');

  lines.push('## Maturity rationale');
  lines.push('');
  lines.push(feature.maturity_rationale.trim());
  lines.push('');

  if (feature.surfaces.length > 0) {
    lines.push('## Surfaces');
    lines.push('');
    for (const s of feature.surfaces) lines.push(`- ${s}`);
    lines.push('');
  }

  if (feature.key_files.length > 0) {
    lines.push('## Key files');
    lines.push('');
    for (const f of feature.key_files) {
      lines.push(`- ${fileLink(f, repoRootRelative)}`);
    }
    lines.push('');
  }

  const tests = feature.tests ?? {
    unit: [],
    integration: [],
    e2e: [],
    bench: [],
    regression: [],
  };
  const totalTests =
    tests.unit.length + tests.integration.length + tests.e2e.length + tests.bench.length + tests.regression.length;
  if (totalTests > 0) {
    lines.push('## Tests');
    lines.push('');
    for (const kind of ['unit', 'integration', 'e2e', 'bench', 'regression'] as const) {
      const paths = tests[kind];
      if (paths.length === 0) continue;
      lines.push(`- **${kind}**:`);
      for (const p of paths) lines.push(`  - ${fileLink(p, repoRootRelative)}`);
    }
    lines.push('');
  }

  if (feature.depends_on.length > 0) {
    lines.push('## Dependencies');
    lines.push('');
    for (const dep of feature.depends_on) {
      lines.push(`- [\`${dep}\`](./${dep}.md)`);
    }
    lines.push('');
  }

  if (feature.related_rfcs.length > 0) {
    lines.push('## Related RFCs');
    lines.push('');
    for (const rfc of feature.related_rfcs) {
      lines.push(`- ${fileLink(rfc, repoRootRelative)}`);
    }
    lines.push('');
  }

  if (
    feature.metrics !== undefined &&
    Object.keys(feature.metrics).length > 0
  ) {
    lines.push('## Metrics');
    lines.push('');
    lines.push('| Key | Value |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(feature.metrics)) {
      lines.push(`| \`${k}\` | \`${String(v)}\` |`);
    }
    lines.push('');
  }

  if (feature.known_limitations.length > 0) {
    lines.push('## Known limitations');
    lines.push('');
    for (const l of feature.known_limitations) lines.push(`- ${l}`);
    lines.push('');
  }

  if (feature.next_steps.length > 0) {
    lines.push('## Next steps');
    lines.push('');
    for (const s of feature.next_steps) lines.push(`- ${s}`);
    lines.push('');
  }

  if (feature.tags.length > 0) {
    lines.push('## Tags');
    lines.push('');
    lines.push(feature.tags.map((t) => `\`${t}\``).join(' '));
    lines.push('');
  }

  lines.push('---');
  lines.push(`_Source: \`${loaded.sourcePath}\`_`);
  return lines.join('\n') + '\n';
}

export function renderIndex(
  features: readonly LoadedFeature[],
  builtAt: string,
  repoRootRelative: string,
): string {
  void repoRootRelative;
  const lines: string[] = [];
  lines.push('# Wine Search Engine — Feature Catalog');
  lines.push('');
  lines.push(`_Last built: ${builtAt}_`);
  lines.push('');

  const total = features.length;
  const byMaturity: Record<Maturity, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const { feature } of features) {
    byMaturity[feature.maturity] = (byMaturity[feature.maturity] ?? 0) + 1;
  }

  lines.push('## At a glance');
  lines.push('');
  lines.push(`- **Total features**: ${total}`);
  for (const m of [5, 4, 3, 2, 1] as const) {
    lines.push(
      `- **${m}/5** (${MATURITY_LABELS[m]}): ${byMaturity[m]}`,
    );
  }
  lines.push('');
  lines.push('See also: [by maturity](./by-maturity.md)');
  lines.push('');

  const byCategory = new Map<string, LoadedFeature[]>();
  for (const lf of features) {
    const list = byCategory.get(lf.feature.category) ?? [];
    list.push(lf);
    byCategory.set(lf.feature.category, list);
  }

  for (const [category, items] of [...byCategory.entries()].sort()) {
    lines.push(`## ${category} (${items.length})`);
    lines.push('');
    lines.push('| ID | Name | Maturity | Status |');
    lines.push('|---|---|---|---|');
    for (const { feature } of items) {
      lines.push(
        `| [\`${feature.id}\`](./features/${feature.id}.md) | ${feature.name} | ${maturityStars(feature.maturity)} ${feature.maturity}/5 | ${statusBadge(feature.status)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

export function renderByMaturity(
  features: readonly LoadedFeature[],
  builtAt: string,
): string {
  const lines: string[] = [];
  lines.push('# Catalog — by Maturity');
  lines.push('');
  lines.push(`_Last built: ${builtAt}_`);
  lines.push('');
  for (const m of [5, 4, 3, 2, 1] as const) {
    const items = features.filter((f) => f.feature.maturity === m);
    lines.push(
      `## ${maturityStars(m)} ${m}/5 — ${MATURITY_LABELS[m]} (${items.length})`,
    );
    lines.push('');
    if (items.length === 0) {
      lines.push('_(none)_');
      lines.push('');
      continue;
    }
    lines.push('| ID | Name | Category | Status |');
    lines.push('|---|---|---|---|');
    for (const { feature } of items) {
      lines.push(
        `| [\`${feature.id}\`](./features/${feature.id}.md) | ${feature.name} | \`${feature.category}\` | ${statusBadge(feature.status)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
