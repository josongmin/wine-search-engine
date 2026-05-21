#!/usr/bin/env tsx
/**
 * Abbreviation Alias ETL (P1.4 / KIL category recall lift).
 *
 * Generates curated wine-community abbreviation aliases (alias_type
 * `'abbreviation'`) for a set of entities and writes proposals to a
 * review JSONL file. A `--commit` pass then upserts approved proposals
 * into the `aliases` table.
 *
 * Sources of candidate surfaces (per the P1.4 spec):
 *   1. Deterministic generation (no LLM): `deriveAbbreviations` produces
 *      the bare initialism, producer-initial + 2-digit-vintage compound,
 *      apostrophe-vintage, tight-join, 4-digit-vintage, and
 *      producer-first-word + 2-digit-vintage surfaces. Every rule is
 *      audited in `src/domain/alias/service/abbreviation-derivation.ts`
 *      with a documented wine-community convention.
 *   2. LLM-assisted generation (opt-in via `--llm`): queries an OpenAI
 *      chat completion with a fixed JSON schema and a curated wine
 *      sommelier prompt. Output is parsed with the Zod schema in
 *      `abbreviation-llm-parser.ts` — extra fields tolerated,
 *      string-coerced numerics accepted, out-of-vocabulary surfaces
 *      dropped. Bounded at `MAX_LLM_CANDIDATES_PER_ENTITY` per entity.
 *
 * Proposal lifecycle:
 *   - Run with `--input <ids.json>` (or `--all`) → writes proposals to
 *     `data/abbreviation-aliases-proposals/<timestamp>.jsonl`.
 *   - Human review (or `--auto-approve` for the deterministic-only path
 *     which carries no fabrication risk): annotate `status: 'approved'`
 *     on the JSONL lines you want to commit.
 *   - Run with `--commit <proposals.jsonl>` to upsert the approved rows
 *     into the `aliases` table. Idempotent: UPSERT keyed by
 *     `(entity_id, normalized_value, alias_type)`.
 *
 * No query-time heuristic: the matcher (`pg-alias-matcher.ts`) already
 * looks up by `aliases.normalized_value`. Once an abbreviation alias is
 * in the table, it participates in the standard exact-match phase
 * automatically — no matcher changes needed.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
 *     --all --limit 100 --out data/abbreviation-aliases-proposals/
 *
 *   pnpm tsx --env-file=.env scripts/etl/generate-abbreviation-aliases.ts \
 *     --commit data/abbreviation-aliases-proposals/2026-05-21T12-00-00.jsonl
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Pool } from 'pg';

import {
  DERIVED_ABBREVIATION_CONFIDENCE,
  deriveAbbreviations,
  type DerivedAbbreviation,
} from '../../src/domain/alias/service/abbreviation-derivation.js';
import { atomicWriteFile } from './etl-utils.js';
import {
  MAX_CANDIDATES_PER_ENTITY as MAX_LLM_CANDIDATES_PER_ENTITY,
  parseLlmAbbreviationOutput,
  type ProposedAbbreviation,
} from './abbreviation-llm-parser.js';

// ---------------------------------------------------------------------------
// Tunables (named constants — no magic numbers, CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/**
 * Default cap on how many entities a single ETL run will process. The
 * runbook lists ~100 high-traffic wines for the v1 rollout; larger
 * batches require operator acknowledgement (see runbook).
 */
const DEFAULT_ENTITY_LIMIT = 100;

/** OpenAI chat model used for the LLM-assisted layer. */
const OPENAI_MODEL = 'gpt-4.1-mini-2025-04-14';

/** OpenAI chat-completions endpoint. */
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/** Per-call output token budget. */
const OPENAI_MAX_TOKENS = 800;

/** Per-call temperature. Low to suppress fabrication. */
const OPENAI_TEMPERATURE = 0.2;

/** Inter-request delay (ms) to stay under per-minute rate limits. */
const INTER_REQUEST_DELAY_MS = 750;

/** Default proposals output directory. */
const DEFAULT_PROPOSALS_DIR = 'data/abbreviation-aliases-proposals';

/**
 * Default `alias_scope` for emitted abbreviation rows. `'global'`
 * because the surface forms are language-agnostic (English-letter
 * initialisms + numeric vintages); locale-specific scoping is reserved
 * for the Korean/French dedicated catalogs.
 */
const DEFAULT_ALIAS_SCOPE = 'global';

/** Source provenance string written into `aliases.source`. */
const DETERMINISTIC_SOURCE_TAG = 'etl:abbreviation_derivation_v1';
const LLM_SOURCE_TAG = 'etl:llm_abbreviation_v1';

/** Source-trust score persisted into `aliases.source_trust`. */
const DETERMINISTIC_SOURCE_TRUST = 0.85;
const LLM_SOURCE_TRUST = 0.6;

/** Suffix written to the proposals filename for the deterministic-only run. */
const DETERMINISTIC_RUN_SUFFIX = '-deterministic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer?: string | undefined;
  readonly vintageYear?: number | undefined;
}

export interface AbbreviationProposal {
  readonly proposalId: string;
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly source: typeof DETERMINISTIC_SOURCE_TAG | typeof LLM_SOURCE_TAG;
  readonly sourceTrust: number;
  readonly confidence: number;
  readonly rule?: DerivedAbbreviation['rule'] | 'llm';
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly createdAt: string;
}

interface CliArgs {
  readonly mode: 'generate' | 'commit';
  readonly entityIdsPath?: string;
  readonly all: boolean;
  readonly limit: number;
  readonly llm: boolean;
  readonly autoApprove: boolean;
  readonly proposalsPath: string;
  readonly outDir: string;
  readonly dryRun: boolean;
  readonly nowYear?: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliArgs {
  let mode: CliArgs['mode'] = 'generate';
  let entityIdsPath: string | undefined;
  let all = false;
  let limit = DEFAULT_ENTITY_LIMIT;
  let llm = false;
  let autoApprove = false;
  let proposalsPath = '';
  let outDir = DEFAULT_PROPOSALS_DIR;
  let dryRun = false;
  let nowYear: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      entityIdsPath = argv[++i];
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--limit') {
      const next = argv[++i];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      }
    } else if (arg === '--llm') {
      llm = true;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    } else if (arg === '--commit') {
      mode = 'commit';
      const next = argv[++i];
      if (next !== undefined) proposalsPath = next;
    } else if (arg === '--out') {
      const next = argv[++i];
      if (next !== undefined) outDir = next;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--now-year') {
      const next = argv[++i];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed)) nowYear = parsed;
      }
    }
  }

  return {
    mode,
    ...(entityIdsPath !== undefined ? { entityIdsPath } : {}),
    all,
    limit,
    llm,
    autoApprove,
    proposalsPath,
    outDir,
    dryRun,
    ...(nowYear !== undefined ? { nowYear } : {}),
  };
}

// ---------------------------------------------------------------------------
// Entity loading
// ---------------------------------------------------------------------------

async function loadEntitiesFromIds(
  pool: Pool,
  entityIds: readonly string[],
): Promise<readonly EntityRow[]> {
  if (entityIds.length === 0) return [];
  const result = await pool.query<{
    entity_id: string;
    canonical_label: string;
    attributes: unknown;
  }>(
    `SELECT entity_id, canonical_label, attributes
       FROM entities
      WHERE entity_id = ANY($1::text[])`,
    [entityIds],
  );
  return result.rows.map((row) => toEntityRow(row));
}

async function loadAllEntities(
  pool: Pool,
  limit: number,
): Promise<readonly EntityRow[]> {
  const result = await pool.query<{
    entity_id: string;
    canonical_label: string;
    attributes: unknown;
  }>(
    `SELECT entity_id, canonical_label, attributes
       FROM entities
      WHERE entity_type IN ('wine','vintage')
      ORDER BY entity_id
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => toEntityRow(row));
}

function toEntityRow(row: {
  entity_id: string;
  canonical_label: string;
  attributes: unknown;
}): EntityRow {
  // attributes is JSONB — guard with isRecord and pull vintageYear/producer
  // via runtime validation (CLAUDE.md rule 11: no direct `as` on JSONB).
  const attributes = isRecord(row.attributes) ? row.attributes : {};
  const rawVintage = attributes['vintage'];
  const vintageYear =
    typeof rawVintage === 'number' && Number.isFinite(rawVintage)
      ? rawVintage
      : typeof rawVintage === 'string'
        ? safeParseInt(rawVintage)
        : undefined;
  const rawProducer = attributes['producer'];
  const producer = typeof rawProducer === 'string' ? rawProducer : undefined;
  return {
    entityId: row.entity_id,
    canonicalLabel: row.canonical_label,
    ...(producer !== undefined ? { producer } : {}),
    ...(vintageYear !== undefined ? { vintageYear } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParseInt(input: string): number | undefined {
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------

function generateDeterministicProposals(
  entity: EntityRow,
  nowYear: number | undefined,
  autoApprove: boolean,
): readonly AbbreviationProposal[] {
  const derived = deriveAbbreviations({
    canonicalLabel: entity.canonicalLabel,
    ...(entity.vintageYear !== undefined ? { vintageYear: entity.vintageYear } : {}),
    ...(nowYear !== undefined ? { nowYear } : {}),
  });

  const out: AbbreviationProposal[] = [];
  for (const candidate of derived) {
    out.push({
      proposalId: crypto.randomUUID(),
      entityId: entity.entityId,
      canonicalLabel: entity.canonicalLabel,
      surface: candidate.surface,
      normalizedSurface: normalizeForLookup(candidate.surface),
      source: DETERMINISTIC_SOURCE_TAG,
      sourceTrust: DETERMINISTIC_SOURCE_TRUST,
      confidence: candidate.confidencePrior,
      rule: candidate.rule,
      // Deterministic surfaces carry no fabrication risk — every rule is
      // a published wine-community convention with an audit trail in the
      // derivation module. Auto-approval is therefore safe for the
      // deterministic layer when the operator opts in.
      status: autoApprove ? 'approved' : 'pending',
      createdAt: new Date().toISOString(),
    });
  }
  return out;
}

function normalizeForLookup(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// LLM-assisted generation
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You are a wine sommelier. Generate short, common informal abbreviations a sommelier or wine forum (CellarTracker, Wine Berserkers, K&L Wine Merchants forum) might use for the given wines.

Rules:
- ONE abbreviation per line in the JSON output's "surface" field.
- Output ONLY valid JSON matching the requested schema — no prose, no markdown.
- ${String(MAX_LLM_CANDIDATES_PER_ENTITY)} candidates per wine MAX.
- Each surface ≤ 40 characters.
- Use only letters, digits, spaces, hyphens, apostrophes, periods, commas. No emoji, no currency, no CJK punctuation.
- Confidence is a float 0-1 reflecting how widely the abbreviation is actually used in the community.
- Do NOT invent abbreviations that aren't in real-world community usage.`;

interface LlmEntityInput {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer?: string | undefined;
}

function buildLlmUserPrompt(entities: readonly LlmEntityInput[]): string {
  const lines = entities.map((e) => {
    const producerPart = e.producer !== undefined ? ` (producer: ${e.producer})` : '';
    return `- ${e.entityId}: "${e.canonicalLabel}"${producerPart}`;
  });
  return `Generate abbreviations for these wines:

${lines.join('\n')}

Return a JSON object: {"results": [{"entityId": "<id>", "abbreviations": [{"surface": "<text>", "confidence": <0-1>}]}]}`;
}

async function callOpenAi(prompt: string): Promise<string> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('OPENAI_API_KEY not set — required for --llm mode');
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: OPENAI_TEMPERATURE,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error [${String(response.status)}]: ${errText.slice(0, 200)}`);
  }

  // OpenAI response is a known shape — cast to `unknown` first, then
  // dig out the text safely.
  const data = (await response.json()) as unknown;
  if (!isRecord(data)) {
    throw new Error('OpenAI response is not an object');
  }
  const choices = data['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('OpenAI response missing choices array');
  }
  const first = choices[0];
  if (!isRecord(first)) {
    throw new Error('OpenAI choices[0] is not an object');
  }
  const message = first['message'];
  if (!isRecord(message)) {
    throw new Error('OpenAI choices[0].message is not an object');
  }
  const content = message['content'];
  if (typeof content !== 'string') {
    throw new Error('OpenAI choices[0].message.content is not a string');
  }
  return content;
}

async function generateLlmProposals(
  entity: EntityRow,
): Promise<readonly AbbreviationProposal[]> {
  const llmInput: LlmEntityInput = {
    entityId: entity.entityId,
    canonicalLabel: entity.canonicalLabel,
    ...(entity.producer !== undefined ? { producer: entity.producer } : {}),
  };
  const prompt = buildLlmUserPrompt([llmInput]);
  const rawText = await callOpenAi(prompt);
  const parseResult = parseLlmAbbreviationOutput(rawText);

  if (parseResult.rejected.length > 0) {
    console.warn(
      `  [llm] dropped ${String(parseResult.rejected.length)} candidate(s) for ${entity.entityId}: ` +
        `${parseResult.rejected
          .slice(0, 3)
          .map((r) => `${r.surface} (${r.reason})`)
          .join('; ')}`,
    );
  }

  const proposals: AbbreviationProposal[] = [];
  for (const entityResult of parseResult.accepted) {
    if (entityResult.entityId !== entity.entityId) continue;
    for (const abbr of entityResult.abbreviations) {
      proposals.push(
        toLlmProposal(entity, abbr),
      );
    }
  }
  return proposals;
}

function toLlmProposal(
  entity: EntityRow,
  abbr: ProposedAbbreviation,
): AbbreviationProposal {
  // LLM-supplied confidence values in [0, 1]; clamp out-of-range LLM
  // outputs (we already accept >1 from the parser; clamp here so the
  // alias row's confidence field stays in domain bounds).
  const llmConfidence =
    abbr.confidence === undefined
      ? DERIVED_ABBREVIATION_CONFIDENCE
      : Math.min(1, Math.max(0, abbr.confidence));
  return {
    proposalId: crypto.randomUUID(),
    entityId: entity.entityId,
    canonicalLabel: entity.canonicalLabel,
    surface: abbr.surface,
    normalizedSurface: normalizeForLookup(abbr.surface),
    source: LLM_SOURCE_TAG,
    sourceTrust: LLM_SOURCE_TRUST,
    confidence: llmConfidence,
    rule: 'llm' as const,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence — commit phase
// ---------------------------------------------------------------------------

/**
 * Persists approved proposals into the `alias_proposals` **staging** table.
 *
 * Architectural note (migration 016 invariant — see
 * `test/regression/runtime-plane-insert-authority.regression.test.ts`):
 * `scripts/etl/publish-runtime-substrates.ts` is the **only** authorized
 * writer to the runtime-plane `aliases` table. This ETL writes to
 * `alias_proposals` instead. The operator then uses the existing
 * `publish-runtime-substrates` ETL (or the curator promotion pipeline)
 * to materialize approved proposals into `aliases` on the next snapshot
 * publish.
 *
 * The proposal evidence shape is:
 *   { abbreviationRule, normalizedSurface, aliasScope }
 * — kept JSON-serializable so it round-trips through `alias_proposals.evidence`.
 */
export async function commitProposals(
  pool: Pool,
  proposals: readonly AbbreviationProposal[],
): Promise<{ readonly inserted: number; readonly skipped: number }> {
  const approved = proposals.filter((p) => p.status === 'approved');
  let inserted = 0;
  let skipped = 0;

  for (const proposal of approved) {
    try {
      const result = await pool.query(
        `INSERT INTO alias_proposals (
            proposal_id, surface_form, target_entity_id, proposed_type,
            evidence, confidence, status
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6, 'approved'
         )
         ON CONFLICT (proposal_id) DO UPDATE SET
            surface_form = EXCLUDED.surface_form,
            target_entity_id = EXCLUDED.target_entity_id,
            proposed_type = EXCLUDED.proposed_type,
            evidence = EXCLUDED.evidence,
            confidence = EXCLUDED.confidence,
            status = EXCLUDED.status,
            updated_at = NOW()`,
        [
          proposal.proposalId,
          proposal.surface,
          proposal.entityId,
          // `alias_proposals.proposed_type` is TEXT — we persist
          // 'abbreviation' verbatim; the downstream
          // publish-runtime-substrates lane validates the type via
          // the same closed-world enum as the runtime CHECK constraint
          // (migration 021).
          'abbreviation',
          JSON.stringify({
            abbreviationRule: proposal.rule ?? 'unknown',
            normalizedSurface: proposal.normalizedSurface,
            aliasScope: DEFAULT_ALIAS_SCOPE,
            source: proposal.source,
            sourceTrust: proposal.sourceTrust,
          }),
          proposal.confidence,
        ],
      );
      if ((result.rowCount ?? 0) > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  commit failed for entity_id=${proposal.entityId} surface=${proposal.surface}: ${msg}`,
      );
      throw err;
    }
  }

  return { inserted, skipped };
}

function deterministicAliasId(
  entityId: string,
  normalizedValue: string,
  aliasType: string,
  aliasScope: string,
): string {
  // SHA-256 of the natural key components → 16 chars hex → prefixed
  // with "abbr-" so operators can grep abbreviation aliases directly.
  // Using crypto.createHash, not Math.random (CLAUDE.md schema bar).
  const digest = crypto
    .createHash('sha256')
    .update(`${entityId}|${normalizedValue}|${aliasType}|${aliasScope}`)
    .digest('hex')
    .slice(0, 16);
  return `abbr-${digest}`;
}

// ---------------------------------------------------------------------------
// Proposals I/O
// ---------------------------------------------------------------------------

function buildProposalsFilePath(outDir: string, suffix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');
  return path.join(outDir, `${stamp}${suffix}.jsonl`);
}

export async function writeProposalsFile(
  filePath: string,
  proposals: readonly AbbreviationProposal[],
): Promise<void> {
  const lines = proposals.map((p) => JSON.stringify(p)).join('\n');
  await atomicWriteFile(filePath, lines + (lines.length > 0 ? '\n' : ''));
}

export async function readProposalsFile(
  filePath: string,
): Promise<readonly AbbreviationProposal[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const out: AbbreviationProposal[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Cast to `unknown` first (CLAUDE.md rule 12). The proposal file is
    // operator-controlled — schema drift here means a bug in the
    // operator's review tooling, so we fail loud.
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isProposalShape(parsed)) {
      throw new Error(`Malformed proposal entry: ${trimmed.slice(0, 200)}`);
    }
    out.push(parsed);
  }
  return out;
}

function isProposalShape(value: unknown): value is AbbreviationProposal {
  if (!isRecord(value)) return false;
  return (
    typeof value['proposalId'] === 'string' &&
    typeof value['entityId'] === 'string' &&
    typeof value['canonicalLabel'] === 'string' &&
    typeof value['surface'] === 'string' &&
    typeof value['normalizedSurface'] === 'string' &&
    typeof value['source'] === 'string' &&
    typeof value['sourceTrust'] === 'number' &&
    Number.isFinite(value['sourceTrust']) &&
    typeof value['confidence'] === 'number' &&
    Number.isFinite(value['confidence']) &&
    (value['status'] === 'pending' ||
      value['status'] === 'approved' ||
      value['status'] === 'rejected')
  );
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export {
  generateDeterministicProposals,
  generateLlmProposals,
  normalizeForLookup,
  deterministicAliasId,
  DEFAULT_ALIAS_SCOPE,
  DETERMINISTIC_SOURCE_TAG,
  LLM_SOURCE_TAG,
  DETERMINISTIC_SOURCE_TRUST,
  LLM_SOURCE_TRUST,
  parseArgs,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Lazy-load pg-pool only when DB I/O is actually required — keeps
  // the deterministic dry-run path testable without a live PG.
  const { createPgPool, closePgPool } = await import('../../src/infrastructure/db/pg-pool.js');
  const { config } = await import('../../src/config/env.js');

  if (args.mode === 'commit') {
    if (args.proposalsPath.length === 0) {
      throw new Error('--commit requires a proposals file path');
    }
    const proposals = await readProposalsFile(args.proposalsPath);
    console.log(`Loaded ${String(proposals.length)} proposal(s) from ${args.proposalsPath}`);

    const pool = createPgPool(config.pg);
    try {
      const result = await commitProposals(pool, proposals);
      console.log(
        `Staged to alias_proposals: inserted=${String(result.inserted)} ` +
          `skipped=${String(result.skipped)} ` +
          `(approved=${String(proposals.filter((p) => p.status === 'approved').length)})`,
      );
      console.log(
        'Next step: run `pnpm tsx scripts/etl/publish-runtime-substrates.ts` to publish ' +
          'the approved proposals into the runtime-plane `aliases` table on the next snapshot.',
      );
    } finally {
      await closePgPool(pool);
    }
    return;
  }

  // Generate mode
  const pool = createPgPool(config.pg);
  try {
    let entities: readonly EntityRow[];
    if (args.all) {
      entities = await loadAllEntities(pool, args.limit);
    } else if (args.entityIdsPath !== undefined) {
      const raw = await fs.readFile(args.entityIdsPath, 'utf8');
      const parsedIds = (JSON.parse(raw) as unknown);
      if (!Array.isArray(parsedIds) || !parsedIds.every((id) => typeof id === 'string')) {
        throw new Error('--input file must be a JSON array of entityId strings');
      }
      entities = await loadEntitiesFromIds(pool, parsedIds);
    } else {
      throw new Error('Must specify --all or --input <ids.json>');
    }
    console.log(`Loaded ${String(entities.length)} entities`);

    const allProposals: AbbreviationProposal[] = [];
    for (const entity of entities) {
      const detProposals = generateDeterministicProposals(
        entity,
        args.nowYear,
        args.autoApprove,
      );
      allProposals.push(...detProposals);

      if (args.llm) {
        try {
          const llmProposals = await generateLlmProposals(entity);
          allProposals.push(...llmProposals);
          await new Promise<void>((resolve) => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  [llm] failed for ${entity.entityId}: ${msg}`);
        }
      }
    }
    console.log(`Generated ${String(allProposals.length)} proposal(s) (deterministic + LLM)`);

    if (args.dryRun) {
      console.log('DRY RUN — skipping write. Sample of first 5 proposals:');
      for (const p of allProposals.slice(0, 5)) {
        console.log(`  ${p.entityId} → "${p.surface}" (rule=${p.rule ?? 'unknown'}, status=${p.status})`);
      }
      return;
    }

    const suffix = args.llm ? '' : DETERMINISTIC_RUN_SUFFIX;
    const outPath = buildProposalsFilePath(args.outDir, suffix);
    await writeProposalsFile(outPath, allProposals);
    console.log(`Wrote ${String(allProposals.length)} proposals to ${outPath}`);
  } finally {
    await closePgPool(pool);
  }
}

import { fileURLToPath as _fileURLToPath } from 'node:url';
const _invokedAsMain =
  process.argv[1] != null && _fileURLToPath(import.meta.url) === process.argv[1];
if (_invokedAsMain) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
