#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { EvalResult, EvalDeltaBucket } from './metrics.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

interface Args {
  input: string;
}

function parseArgs(argv: readonly string[]): Args {
  let input = '/tmp/offline-eval-smoke-results.json';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      input = resolveCliDataPathArg(argv[index + 1] ?? input);
      index += 1;
    }
  }
  return { input };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDeltaBucket(delta: EvalDeltaBucket | undefined): string {
  if (delta === undefined) {
    return 'n/a';
  }
  const sign = delta.count_delta >= 0 ? '+' : '';
  return `${sign}${delta.count_delta} (${(delta.percentage_point_delta * 100).toFixed(1)}pp)`;
}

export function buildOfflineEvalMarkdownSummary(
  result: Pick<
    EvalResult,
    | 'query_count'
    | 'ndcg_at_10'
    | 'mrr_at_10'
    | 'recall_at_3'
    | 'decision_utility'
    | 'ece'
    | 'calibration_eligible_resolved_count'
    | 'ece_scope'
    | 'provenance'
    | 'release_report'
    | 'baseline_comparison'
  >,
): string {
  const lines: string[] = [
    '## Offline Eval Regression',
    '',
    `- Queries: \`${result.query_count}\``,
    `- NDCG@10: \`${result.ndcg_at_10.toFixed(4)}\``,
    `- MRR@10: \`${result.mrr_at_10.toFixed(4)}\``,
    `- Recall@3: \`${result.recall_at_3.toFixed(4)}\``,
    `- Decision utility: \`${result.decision_utility.toFixed(4)}\``,
    `- ECE (trusted only): \`${result.ece.toFixed(4)}\` (n=${result.calibration_eligible_resolved_count}, scope=\`${result.ece_scope}\`)`,
  ];

  if (result.provenance !== undefined) {
    lines.push('');
    lines.push('### Provenance');
    lines.push('');
    lines.push(`- Runtime target: \`${result.provenance.runtime_target}\``);
    lines.push(`- Uses live API: \`${result.provenance.uses_live_api}\``);
    lines.push(`- Gate eligible: \`${result.provenance.gate_eligible}\``);
    lines.push(`- Corpus ID: \`${result.provenance.corpus_id}\``);
    lines.push(`- Corpus hash: \`${result.provenance.corpus_hash}\``);
    lines.push(`- Threshold source: \`${result.provenance.threshold_source}\``);
    if (result.provenance.embedding_sensitive_eval === true) {
      lines.push(`- Embedding-sensitive eval: \`true\``);
    }
    if (result.provenance.dense_retrieval_enabled != null) {
      lines.push(`- Dense retrieval enabled: \`${result.provenance.dense_retrieval_enabled}\``);
    }
    if (result.provenance.query_embedding_model != null) {
      lines.push(`- Query embedding model: \`${result.provenance.query_embedding_model}\``);
    }
    if (result.provenance.query_embedding_model_version != null) {
      lines.push(`- Query embedding model version: \`${result.provenance.query_embedding_model_version}\``);
    }
    lines.push(`- Compatibility key: \`${result.provenance.comparison_compatibility_key}\``);
  }

  const releaseReport = result.release_report;
  if (releaseReport !== undefined) {
    lines.push('');
    lines.push('### Release Report');
    lines.push('');
    lines.push(
      `- Degraded share: \`${formatPercent(releaseReport.degraded_query_share.share)}\` `
      + `(${releaseReport.degraded_query_share.query_count}/${result.query_count})`,
    );
    lines.push(
      `- Heuristic share: \`${formatPercent(releaseReport.heuristic_query_share.share)}\` `
      + `(${releaseReport.heuristic_query_share.query_count}/${result.query_count})`,
    );
    lines.push(
      `- Blocking share: \`${formatPercent(releaseReport.blocking_vs_advisory_summary.blocking_eligible.share)}\` `
      + `(${releaseReport.blocking_vs_advisory_summary.blocking_eligible.query_count}/${result.query_count})`,
    );
    lines.push(
      `- Advisory share: \`${formatPercent(releaseReport.blocking_vs_advisory_summary.advisory_queries.share)}\` `
      + `(${releaseReport.blocking_vs_advisory_summary.advisory_queries.query_count}/${result.query_count})`,
    );
    if (releaseReport.top_degradation_reasons.length > 0) {
      lines.push(
        `- Top degradation reasons: ${releaseReport.top_degradation_reasons
          .map((reason) => `\`${reason.reason}\` ${reason.query_count} (${formatPercent(reason.share)})`)
          .join(', ')}`,
      );
    }
    const fallbackSummary = releaseReport.specialized_fallback_summary;
    if (fallbackSummary !== undefined) {
      lines.push(
        `- Specialized fallback: producer=\`${fallbackSummary.fallback_rate.producer_browse.fallback_rate === null ? 'n/a' : formatPercent(fallbackSummary.fallback_rate.producer_browse.fallback_rate)}\`, `
        + `region=\`${fallbackSummary.fallback_rate.region_browse.fallback_rate === null ? 'n/a' : formatPercent(fallbackSummary.fallback_rate.region_browse.fallback_rate)}\`, `
        + `compare=\`${fallbackSummary.fallback_rate.compare_candidates.fallback_rate === null ? 'n/a' : formatPercent(fallbackSummary.fallback_rate.compare_candidates.fallback_rate)}\``,
      );
    }
  }

  const baseline = result.baseline_comparison;
  if (baseline !== undefined) {
    lines.push('');
    lines.push('### Baseline Comparison');
    lines.push('');
    lines.push(`- Baseline: \`${baseline.baseline_path}\``);
    if (baseline.compatibility_status === 'skipped') {
      lines.push(`- Compatibility: skipped (\`${baseline.compatibility_reason ?? 'unknown'}\`)`);
    } else {
      lines.push(`- NDCG@10 delta: \`${baseline.deltas.ndcg_at_10.toFixed(4)}\``);
      lines.push(`- MRR@10 delta: \`${baseline.deltas.mrr_at_10.toFixed(4)}\``);
      lines.push(`- Recall@3 delta: \`${baseline.deltas.recall_at_3.toFixed(4)}\``);
      lines.push(`- Decision utility delta: \`${baseline.deltas.decision_utility.toFixed(4)}\``);
      lines.push(
        `- Degraded mix delta: \`${formatDeltaBucket(baseline.deltas.execution_mode_mix?.degraded)}\``,
      );
      lines.push(
        `- Blocking mix delta: \`${formatDeltaBucket(baseline.deltas.blocking_eligible_share?.blocking_eligible)}\``,
      );
    }
    if ((baseline.highlights?.length ?? 0) > 0) {
      lines.push(`- Highlights: ${baseline.highlights?.map((item) => `\`${item}\``).join(', ')}`);
    }
    if (baseline.significance !== undefined) {
      lines.push(
        `- Significant metrics: \`${baseline.significance.significant_metrics.length > 0 ? baseline.significance.significant_metrics.join(', ') : 'none'}\``,
      );
    } else if (baseline.significance_skipped_reason !== undefined) {
      lines.push(`- Significance: skipped (\`${baseline.significance_skipped_reason}\`)`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.input, 'utf8');
  const report = JSON.parse(raw) as EvalResult;
  process.stdout.write(buildOfflineEvalMarkdownSummary(report));
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void run();
}
