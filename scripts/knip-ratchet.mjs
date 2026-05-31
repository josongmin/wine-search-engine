#!/usr/bin/env node
/**
 * Knip ratchet gate.
 *
 * Why: `pnpm run deadcode` runs knip with `--no-exit-code`, so dead-code never
 * fails CI — and it is not wired into ci.yml at all. The repo went from a
 * knip-clean state (272 → 0 in a prior cleanup) back up to ~160 dead exports
 * precisely because nothing froze the count. This script is that freeze.
 *
 * Contract: compare the current knip issue counts (per category) against the
 * frozen baseline in `knip-baseline.json`. If ANY category grows, exit 1 with a
 * diff. If counts shrink, print the improvement and tell the dev to lock it in
 * with `--update` (lowering the baseline — a monotone ratchet, never raised by
 * hand). Equal → pass.
 *
 * Usage:
 *   node scripts/knip-ratchet.mjs            # gate (CI + prepush)
 *   node scripts/knip-ratchet.mjs --update   # lower baseline after a cleanup
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE_PATH = fileURLToPath(new URL('../knip-baseline.json', import.meta.url));

// Knip JSON `issues[]` entries carry per-file arrays/objects for each category.
// Counting every category keeps the ratchet honest across all dead-code kinds.
// Keys MUST match knip's actual JSON reporter output — `nsExports`/`nsTypes`/
// `classMembers` are NOT emitted (they count 0 forever, a false sense of
// coverage); the real namespace/catalog keys are `namespaceMembers`/`catalog`.
// (self-audit R3: verified against `knip --reporter json` key enumeration.)
const CATS = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'namespaceMembers',
  'types',
  'duplicates',
  'enumMembers',
  'catalog',
];

function runKnip() {
  let out;
  try {
    out = execFileSync('pnpm', ['exec', 'knip', '--reporter', 'json'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    // knip exits non-zero when issues exist; the JSON is still on stdout.
    out = e.stdout ? e.stdout.toString() : '';
  }
  const start = out.indexOf('{');
  if (start < 0) {
    throw new Error('knip produced no JSON output — cannot evaluate dead-code ratchet');
  }
  const data = JSON.parse(out.slice(start));
  const by = {};
  for (const c of CATS) by[c] = 0;
  for (const it of data.issues ?? []) {
    for (const c of CATS) {
      const v = it[c];
      if (Array.isArray(v)) by[c] += v.length;
      else if (v && typeof v === 'object') by[c] += Object.keys(v).length;
    }
  }
  by.total = CATS.reduce((a, c) => a + by[c], 0);
  return by;
}

const current = runKnip();
const update = process.argv.includes('--update');

if (!existsSync(BASELINE_PATH) || update) {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
  console.log(`[knip-ratchet] baseline ${update ? 'updated' : 'created'}: total=${current.total}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const regressions = [];
const improvements = [];
for (const k of [...CATS, 'total']) {
  const cur = current[k] ?? 0;
  const base = baseline[k] ?? 0;
  if (cur > base) regressions.push(`  ${k}: ${base} → ${cur} (+${cur - base})`);
  else if (cur < base) improvements.push(`  ${k}: ${base} → ${cur} (-${base - cur})`);
}

if (regressions.length > 0) {
  console.error('[knip-ratchet] ❌ dead-code increased above the frozen baseline:');
  for (const r of regressions) console.error(r);
  console.error('');
  console.error('Fix one of: wire the new export into a production code path,');
  console.error('delete it, or (if intentionally unused) add it to knip.json ignoreIssues.');
  console.error('See CLAUDE.md rule 33 (new modules must be wired into production).');
  process.exit(1);
}

if (improvements.length > 0) {
  console.log('[knip-ratchet] ✅ dead-code shrank — lock it in with `pnpm run deadcode:ratchet:update`:');
  for (const i of improvements) console.log(i);
} else {
  console.log(`[knip-ratchet] ✅ no dead-code regressions (total=${current.total})`);
}
process.exit(0);
