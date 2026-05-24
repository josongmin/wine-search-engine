#!/usr/bin/env tsx
/**
 * Manual smoke probe for the Wave 2 wine_aware rank-profile fusion.
 *
 * Sends a YQL query to Vespa Cloud (mTLS), asks for `wine_aware` ranking, and
 * prints the top-N hits along with each `match_features` value so an operator
 * can sanity-check that:
 *   - `learned_sparse_contribution` lands in [0, ~5] (not NaN / not Infinity)
 *   - dense `closeness(field, embedding)` is in (0, 1]
 *   - BM25 features are finite
 *   - top results look topical for the probed query
 *
 * This is NOT a CI test (Vespa Cloud + mTLS + live data). Run by hand after
 * `vespa deploy` and a successful re-embed pass.
 *
 * Required env:
 *   VESPA_URL              — e.g. https://bf75dff7....aoa.aws-us-east-1c.dev.z.vespa-app.cloud
 *   VESPA_CERT_PATH        — local PEM cert path
 *   VESPA_KEY_PATH         — local PEM key path
 *   PROBE_QUERY            — optional; defaults to 'Cabernet Sauvignon'
 *   PROBE_LIMIT            — optional; defaults to 5
 *
 * Usage:
 *   pnpm tsx tools/vespa-probe/probe-wine-aware-fusion.mts
 */

import fs from 'node:fs';
import https from 'node:https';

const DEFAULT_QUERY = 'Cabernet Sauvignon';
const DEFAULT_LIMIT = 5;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) {
    throw new Error(`probe-wine-aware-fusion: missing required env ${name}`);
  }
  return v.trim();
}

async function main(): Promise<void> {
  const vespaUrl = requireEnv('VESPA_URL').replace(/\/$/, '');
  const certPath = requireEnv('VESPA_CERT_PATH');
  const keyPath = requireEnv('VESPA_KEY_PATH');
  const query = process.env['PROBE_QUERY']?.trim() || DEFAULT_QUERY;
  const limitRaw = process.env['PROBE_LIMIT']?.trim();
  const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw))
    ? Math.max(1, Math.min(100, Number(limitRaw)))
    : DEFAULT_LIMIT;

  const yql =
    `select entity_id, canonical_label, producer from sources * where userQuery() limit ${limit}`;

  const body = {
    yql,
    query,
    'ranking.profile': 'wine_aware',
    'ranking.matchPhase.diversity': null,
    'presentation.summary': 'minimal',
    hits: limit,
  };

  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  const agent = new https.Agent({ cert, key });

  const res = await fetch(`${vespaUrl}/search/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // @ts-expect-error — Node 22 fetch accepts `dispatcher`/`agent` extensions
    agent,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vespa HTTP ${res.status}: ${text}`);
  }
  const json = await res.json() as {
    root?: { children?: Array<{
      relevance?: number;
      fields?: Record<string, unknown>;
    }> };
  };
  const children = json.root?.children ?? [];

  console.log(`query: ${query}`);
  console.log(`profile: wine_aware`);
  console.log(`hits: ${children.length}`);
  console.log('---');

  let issues = 0;
  for (let i = 0; i < children.length; i += 1) {
    const hit = children[i];
    if (hit === undefined) continue;
    const rank = i + 1;
    const fields = hit.fields ?? {};
    const score = hit.relevance ?? Number.NaN;
    const features = fields['matchfeatures'] ?? fields['match_features'] ?? {};

    if (!Number.isFinite(score)) {
      console.warn(`[rank ${rank}] FAIL: relevance is not finite (${String(score)})`);
      issues += 1;
    }

    let sparseContribution: number | undefined;
    let denseCloseness: number | undefined;
    if (typeof features === 'object' && features !== null) {
      const f = features as Record<string, unknown>;
      const ls = f['learned_sparse_contribution'];
      if (typeof ls === 'number') sparseContribution = ls;
      const cs = f['closeness(field,embedding)'] ?? f['closeness(field, embedding)'];
      if (typeof cs === 'number') denseCloseness = cs;
    }

    if (sparseContribution !== undefined && !Number.isFinite(sparseContribution)) {
      console.warn(`[rank ${rank}] FAIL: learned_sparse_contribution non-finite (${sparseContribution})`);
      issues += 1;
    }
    if (denseCloseness !== undefined && !Number.isFinite(denseCloseness)) {
      console.warn(`[rank ${rank}] FAIL: closeness non-finite (${denseCloseness})`);
      issues += 1;
    }

    console.log(
      `[rank ${rank}] score=${score.toFixed(4)} `
      + `entity_id=${String(fields['entity_id'])} `
      + `label=${String(fields['canonical_label'])}`,
    );
    console.log(
      `           sparse_contribution=${sparseContribution ?? 'n/a'} `
      + `closeness=${denseCloseness ?? 'n/a'}`,
    );
  }

  console.log('---');
  if (issues > 0) {
    console.error(`probe FAILED: ${issues} non-finite feature(s)`);
    process.exit(1);
  } else {
    console.log('probe OK: no NaN/Infinity in surveyed features');
  }
}

main().catch((err) => {
  console.error('probe FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
