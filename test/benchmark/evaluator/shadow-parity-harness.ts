/**
 * ADR-016 Axis 3 — shadow-parity harness (Wave D bootstrap).
 *
 * Runs the LEGACY 5-class path (`claim-extractor` → `routeAndVerify`)
 * side-by-side with the NEW 9-class path (`atomic-claim-verifier-router`)
 * against the flat `gold-claims.jsonl` bootstrap annotation set, and
 * reports per-type parity numbers.
 *
 * Per ADR-016 §2.8 the parity gate is dual-reported: measured once on
 * the `status === 'ok'` subset (legacy-compatible filter) and once on
 * the full set (skipped / failed verifications count as `not_entailed`).
 * The effective gate is the LOWER of the two.
 *
 * This harness is explicitly a BOOTSTRAP artifact — the cutover gate
 * lives in `test/regression/claim-extractor-deletion-guard.regression.test.ts`
 * and requires a ≥200-row annotation set + ≥2 nightly greens. The
 * bootstrap proves the wiring; it does NOT trip the cutover.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import type { AtomicClaim } from '../../../src/domain/response/model/grounded-claim.js';
import { ATOMIC_CLAIM_TYPES } from '../../../src/domain/response/model/grounded-claim.js';
import type { AtomicClaimType } from '../../../src/domain/response/model/atomic-claim-type.js';
import { verifyAtomicClaims } from '../../../src/domain/evaluation/service/verifiers/atomic-claim-verifier-router.js';
import type { AtomicClaimVerification } from '../../../src/domain/evaluation/service/verifiers/atomic-claim-verifier.port.js';
import type { EvidenceRecord } from '../../../src/domain/evaluation/service/claim-verifier-deterministic.js';
import { extractClaims } from '../../../src/domain/evaluation/service/claim-extractor.js';
import { routeAndVerify } from '../../../src/domain/evaluation/service/claim-verifier-router.js';

import { parseGoldClaimsJsonl } from '../agent/gold-claims/schema.js';
import type {
  GoldClaim,
  GoldExpectedVerdict,
} from '../agent/gold-claims/schema.js';

// ─── Evidence: one record per bootstrap wine ──────────────────────────────────

/**
 * Hand-curated evidence records mirroring `data/gold-wine-catalog.jsonl`
 * rows for the 8 wines the bootstrap references. Values are in the
 * shape the deterministic verifiers expect — numeric body/tannin/acidity
 * on a 1-5 scale, price in USD, vintage_year as int. These records are
 * fed to BOTH the legacy and the new pipeline so both see identical
 * evidence (any verdict divergence is then due to pipeline semantics,
 * not input drift).
 */
const BOOTSTRAP_EVIDENCE_RECORDS: readonly EvidenceRecord[] = Object.freeze([
  {
    entity_id: 'opus-one-2018',
    canonical_label: 'Opus One 2018',
    producer: 'Opus One Winery',
    country: 'USA',
    region: 'Napa Valley',
    appellation: 'Napa Valley',
    grape_primary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc', 'Merlot', 'Petit Verdot', 'Malbec'],
    wine_type: 'red',
    vintage_year: 2018,
    price_usd: 450,
    body: 5,
    tannin: 4,
    acidity: 3,
    critic_score_normalized: 0.96,
    style: 'full-bodied bordeaux-blend',
    style_description: 'full-bodied bordeaux-blend with firm tannins from Napa Valley',
  },
  {
    entity_id: 'sassicaia-2018',
    canonical_label: 'Tenuta San Guido Sassicaia 2018',
    producer: 'Tenuta San Guido',
    country: 'Italy',
    region: 'Tuscany',
    appellation: 'Bolgheri Sassicaia',
    grape_primary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Cabernet Franc'],
    wine_type: 'red',
    vintage_year: 2018,
    price_usd: 260,
    body: 4,
    tannin: 4,
    acidity: 4,
    critic_score_normalized: 0.97,
    style: 'super tuscan bordeaux-blend',
    style_description: 'super tuscan bordeaux-blend with high tannin and bright acidity',
  },
  {
    entity_id: 'penfolds-grange-2017',
    canonical_label: 'Penfolds Grange 2017',
    producer: 'Penfolds',
    country: 'Australia',
    region: 'South Australia',
    appellation: 'South Australia',
    grape_primary: 'Shiraz',
    grapes: ['Shiraz', 'Cabernet Sauvignon'],
    wine_type: 'red',
    vintage_year: 2017,
    price_usd: 900,
    body: 5,
    tannin: 5,
    acidity: 3,
    critic_score_normalized: 0.98,
    style: 'iconic australian shiraz',
    style_description: 'iconic australian shiraz with powerful full body',
  },
  {
    entity_id: 'masi-amarone',
    canonical_label: 'Masi Amarone della Valpolicella Classico',
    producer: 'Masi Agricola',
    country: 'Italy',
    region: 'Veneto',
    appellation: 'Amarone della Valpolicella',
    grape_primary: 'Corvina',
    grapes: ['Corvina', 'Rondinella', 'Molinara'],
    wine_type: 'red',
    vintage_year: 2017,
    price_usd: 80,
    body: 5,
    tannin: 4,
    acidity: 3,
    critic_score_normalized: 0.92,
    style: 'rich dried-grape amarone',
    style_description: 'rich dried-grape amarone from Veneto with concentrated dark fruit',
  },
  {
    entity_id: 'barolo-giacomo',
    canonical_label: 'Giacomo Conterno Barolo Monfortino Riserva 2015',
    producer: 'Giacomo Conterno',
    country: 'Italy',
    region: 'Piedmont',
    appellation: 'Barolo',
    grape_primary: 'Nebbiolo',
    grapes: ['Nebbiolo'],
    wine_type: 'red',
    vintage_year: 2015,
    price_usd: 1100,
    body: 5,
    tannin: 5,
    acidity: 5,
    critic_score_normalized: 1.0,
    style: 'traditional barolo riserva',
    style_description: 'traditional barolo riserva with very high tannin and bright acidity',
  },
  {
    entity_id: 'moet-brut',
    canonical_label: "Moet & Chandon Brut Imperial NV",
    producer: 'Moet & Chandon',
    country: 'France',
    region: 'Champagne',
    appellation: 'Champagne',
    grape_primary: 'Chardonnay',
    grapes: ['Chardonnay', 'Pinot Noir', 'Pinot Meunier'],
    wine_type: 'sparkling',
    vintage_year: 0,
    price_usd: 55,
    body: 2,
    tannin: 1,
    acidity: 4,
    critic_score_normalized: 0.9,
    style: 'classic champagne sparkling',
    style_description: 'classic champagne sparkling with crisp acidity and fine bubbles',
  },
  {
    entity_id: 'sauternes-2015',
    canonical_label: "Chateau d'Yquem 2015",
    producer: "Chateau d'Yquem",
    country: 'France',
    region: 'Bordeaux',
    appellation: 'Sauternes',
    grape_primary: 'Semillon',
    grapes: ['Semillon', 'Sauvignon Blanc'],
    wine_type: 'dessert',
    vintage_year: 2015,
    price_usd: 450,
    body: 4,
    acidity: 4,
    sweetness: 5,
    critic_score_normalized: 0.98,
    style: 'legendary botrytis sauternes',
    style_description: 'legendary botrytis sauternes dessert wine with notable sweetness',
  },
  {
    entity_id: 'cloudy-bay-2022',
    canonical_label: 'Cloudy Bay Sauvignon Blanc 2022',
    producer: 'Cloudy Bay',
    country: 'New Zealand',
    region: 'Marlborough',
    appellation: 'Marlborough',
    grape_primary: 'Sauvignon Blanc',
    grapes: ['Sauvignon Blanc'],
    wine_type: 'white',
    vintage_year: 2022,
    price_usd: 30,
    body: 2,
    tannin: 1,
    acidity: 5,
    critic_score_normalized: 0.91,
    style: 'crisp light-bodied new zealand sauvignon blanc',
    style_description: 'crisp light-bodied new zealand sauvignon blanc with grassy and citrus notes',
  },
]);

/** Flattened prose of the evidence records. Passed to verifiers that
 *  take `evidenceContext: string` (LLM NLI verifiers build their prompt
 *  from this buffer). */
function buildEvidenceContext(
  records: readonly EvidenceRecord[],
): string {
  return records
    .map((rec) => {
      const label = String(rec['canonical_label'] ?? rec['entity_id'] ?? '?');
      const region = String(rec['region'] ?? '?');
      const grapes = Array.isArray(rec['grapes'])
        ? rec['grapes'].join(', ')
        : String(rec['grape_primary'] ?? '?');
      const price = typeof rec['price_usd'] === 'number' ? `$${rec['price_usd']}` : '?';
      const style = String(rec['style_description'] ?? rec['style'] ?? '?');
      return `${label} — ${region}, ${grapes}, ${price}. ${style}.`;
    })
    .join('\n');
}

// ─── Deterministic fake LLM (seeded canned responses) ────────────────────────

/**
 * Canned `ChatLlmPort` used by both the legacy semantic verifier and
 * the new LLM-backed per-type verifiers (pairing/comparative).
 *
 * We cannot depend on a live LLM in a regression test, so the fake
 * returns a FIXED token based on the claim text: claims with an obvious
 * "entailed" keyword (pairing, more powerful, etc.) get `ENTAILED`;
 * everything else returns the legacy semantic verifier's neutral
 * `PARTIAL` token so both the new and legacy paths see the same
 * deterministic verdict. This keeps the bootstrap numbers replayable.
 */
class CannedLlmPort implements ChatLlmPort {
  private readonly entailedPatterns: readonly RegExp[];

  constructor(entailedPatterns: readonly RegExp[]) {
    this.entailedPatterns = entailedPatterns;
  }

  async complete(request: {
    readonly messages: readonly { readonly role: string; readonly content: string }[];
  }): Promise<{ readonly text: string; readonly model: string; readonly finishReason: string | null }> {
    await Promise.resolve();
    // Look at the concatenated prompt — the claim text is always
    // embedded as "Claim: …" in both the atomic and legacy prompts.
    const prompt = request.messages.map((m) => m.content).join('\n');
    // Legacy semantic verifier (RFC-020) expects a JSON array keyed by
    // `claim_id`; the atomic per-type verifiers (ADR-016 §2.8) expect a
    // single token ENTAILED|PARTIAL|NOT_ENTAILED. We cover both by
    // sniffing the legacy system prompt marker.
    const isLegacyJsonExpected = prompt.includes('[CLAIMS TO VERIFY]');
    if (isLegacyJsonExpected) {
      // Extract each claim's `[id] field: "value"` line and decide a
      // verdict per-claim based on the ENTAILED pattern matching the
      // surrounding sentence fragment. This mirrors how a real LLM
      // would judge individual claims from one batched prompt.
      const lineMatches = Array.from(
        prompt.matchAll(
          /^\s*\d+\.\s+\[([^\]]+)\]\s+([^:]+):\s+"([^"]*)"\s+\(from:\s+"([^"]*)"\)/gm,
        ),
      );
      const out = lineMatches.map((m) => {
        const claimId = m[1] ?? '';
        const sourceText = m[4] ?? '';
        const verdict = this.judgeEntailed(sourceText) ? 'entailed' : 'partially_entailed';
        return {
          claim_id: claimId,
          verdict,
          explanation: `canned LLM (${verdict})`,
        };
      });
      return {
        text: JSON.stringify(out),
        model: 'canned-llm',
        finishReason: 'stop',
      };
    }
    const label: 'ENTAILED' | 'PARTIAL' | 'NOT_ENTAILED' = this.judgeEntailed(prompt)
      ? 'ENTAILED'
      : 'PARTIAL';
    return {
      text: label,
      model: 'canned-llm',
      finishReason: 'stop',
    };
  }

  private judgeEntailed(text: string): boolean {
    for (const re of this.entailedPatterns) {
      if (re.test(text)) return true;
    }
    return false;
  }
}

/** Default canned-entailment patterns for the bootstrap set. Picks up
 *  pairing and comparative claims that the bootstrap expects to land
 *  on the `entailed` verdict. */
const DEFAULT_ENTAILED_PATTERNS: readonly RegExp[] = Object.freeze([
  /pairs?\s+with/iu,
  /pairs?\s+well\s+with/iu,
  /more\s+powerful\s+than/iu,
  /bolder\s+than/iu,
]);

// ─── Harness result types ────────────────────────────────────────────────────

export interface PerTypeParity {
  readonly type: AtomicClaimType;
  readonly compared: number;
  readonly matches: number;
  readonly parity: number;
}

export interface ParityAggregate {
  readonly overallParity: number;
  readonly overallCompared: number;
  readonly overallMatches: number;
  readonly perType: readonly PerTypeParity[];
}

export interface ShadowParityResult {
  readonly bootstrapClaimCount: number;
  /** Subset parity — only verifications whose new-path status is `ok`. */
  readonly statusOkSubset: ParityAggregate;
  /** Full-set parity — all bootstrap claims, skipped counted as mismatch. */
  readonly fullSet: ParityAggregate;
  /** The lower of the two aggregate parities — per ADR-016 §2.8. */
  readonly effectiveGate: number;
  /** Per-row verdict traces for human diffing. */
  readonly rows: readonly ShadowParityRow[];
  /** Metadata — when the harness ran, which fake LLM was used. */
  readonly meta: {
    readonly runAt: string;
    readonly llm: 'canned';
    readonly evidenceRecordCount: number;
  };
}

export interface ShadowParityRow {
  readonly claimId: string;
  readonly type: AtomicClaimType;
  readonly expectedVerdict: GoldExpectedVerdict;
  readonly newVerdict: GoldExpectedVerdict | 'skipped';
  readonly newConfidence: number;
  readonly legacyVerdict: GoldExpectedVerdict | 'skipped';
  readonly legacyStatus: string;
  readonly verdictsMatch: boolean;
}

// ─── Harness entry point ─────────────────────────────────────────────────────

export interface RunShadowParityOptions {
  readonly goldClaims: readonly GoldClaim[];
  readonly evidenceRecords?: readonly EvidenceRecord[];
  readonly llm?: ChatLlmPort;
}

export async function runShadowParity(
  opts: RunShadowParityOptions,
): Promise<ShadowParityResult> {
  const evidenceRecords = opts.evidenceRecords ?? BOOTSTRAP_EVIDENCE_RECORDS;
  const evidenceContext = buildEvidenceContext(evidenceRecords);
  const llm = opts.llm ?? new CannedLlmPort(DEFAULT_ENTAILED_PATTERNS);

  // ── New-path verification (9-class router) ─────────────────────────────
  const atomicClaims: readonly AtomicClaim[] = opts.goldClaims.map((g) => g.claim);
  const newVerifications: readonly AtomicClaimVerification[] = await verifyAtomicClaims(
    atomicClaims,
    { evidenceRecords, evidenceContext, llm },
  );
  const newById = new Map<string, AtomicClaimVerification>();
  for (const v of newVerifications) newById.set(v.claimId, v);

  // ── Legacy-path verification (5-class router + regex extractor) ────────
  // Each gold claim's `shadowAnswerText` is fed to the legacy extractor.
  // The legacy path produces N extracted claims per text; we take the
  // best-matching verdict for the (category, field) pair closest to the
  // gold claim's type. If the extractor produces no claim or the
  // verifier skips (`status !== 'ok'`), we record 'skipped'.
  const legacyVerdictByRow = new Map<string, {
    readonly verdict: GoldExpectedVerdict | 'skipped';
    readonly status: string;
  }>();
  for (const gold of opts.goldClaims) {
    const extracted = extractClaims(gold.shadowAnswerText, { currentYear: SHADOW_PARITY_PINNED_YEAR });
    const verifications = await routeAndVerify(
      extracted,
      evidenceRecords,
      evidenceContext,
      llm,
    );
    const picked = pickLegacyVerdictForGold(gold, verifications);
    legacyVerdictByRow.set(gold.claimId, picked);
  }

  // ── Build the per-row parity trace ──────────────────────────────────────
  const rows: ShadowParityRow[] = [];
  for (const gold of opts.goldClaims) {
    const newVer = newById.get(gold.claim.id);
    const newVerdict: GoldExpectedVerdict | 'skipped' =
      newVer !== undefined ? newVer.verdict : 'skipped';
    const newConfidence = newVer?.confidence ?? 0;
    const legacy = legacyVerdictByRow.get(gold.claimId) ?? {
      verdict: 'skipped' as const,
      status: 'missing',
    };
    const verdictsMatch = newVerdict === legacy.verdict && newVerdict !== 'skipped';
    rows.push({
      claimId: gold.claimId,
      type: gold.claim.type,
      expectedVerdict: gold.expectedVerdict,
      newVerdict,
      newConfidence,
      legacyVerdict: legacy.verdict,
      legacyStatus: legacy.status,
      verdictsMatch,
    });
  }

  // ── Aggregate on two denominators per ADR-016 §2.8 ──────────────────────
  const statusOkRows = rows.filter((r) => r.newVerdict !== 'skipped');
  const statusOkSubset = aggregateParity(statusOkRows);
  const fullSet = aggregateParity(rows);
  const effectiveGate = Math.min(statusOkSubset.overallParity, fullSet.overallParity);

  return {
    bootstrapClaimCount: opts.goldClaims.length,
    statusOkSubset,
    fullSet,
    effectiveGate,
    rows,
    meta: {
      runAt: SHADOW_PARITY_METADATA_RUN_AT,
      llm: 'canned',
      evidenceRecordCount: evidenceRecords.length,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pinned year the legacy extractor treats as "current year" for the
 * vintage-upper-bound check. Must be ≥ max vintage we annotate in the
 * bootstrap (2022) so no valid gold vintage is rejected. Hard-coding
 * the value keeps harness output byte-stable across calendar years.
 */
const SHADOW_PARITY_PINNED_YEAR = 2030;

/** Hard-pinned metadata timestamp so regression tests can assert on
 *  a fixed `meta.runAt`. Real nightlies can override via options. */
const SHADOW_PARITY_METADATA_RUN_AT = '2026-04-15T00:00:00.000Z';

/**
 * Pick the legacy verdict most relevant to the gold claim's type.
 * The legacy 5-class extractor emits multiple claims per answer text;
 * we select the one that maps to the gold's (category, field-ish) pair
 * — favouring deterministic over semantic when both exist for the same
 * field, and preferring `status === 'ok'` over skipped.
 */
function pickLegacyVerdictForGold(
  gold: GoldClaim,
  verifications: readonly import('../../../src/domain/evaluation/model/claim.js').ClaimVerification[],
): { readonly verdict: GoldExpectedVerdict | 'skipped'; readonly status: string } {
  if (verifications.length === 0) {
    return { verdict: 'skipped', status: 'no_claim_extracted' };
  }
  const preferOk = verifications.filter((v) => v.status === 'ok');
  const pool = preferOk.length > 0 ? preferOk : verifications;
  // Map 9-class type → legacy category to prefer.
  const legacyCategoryForType: Readonly<Record<AtomicClaimType, string>> = {
    entity_reference: 'identity_claim',
    attribute_assertion: 'derived_structured_claim',
    price_assertion: 'core_structured_claim',
    vintage_assertion: 'core_structured_claim',
    pairing_assertion: 'semantic_claim',
    comparative_assertion: 'comparative_claim',
    drinking_window_assertion: 'core_structured_claim',
    style_assertion: 'derived_structured_claim',
    recommendation: 'semantic_claim',
  };
  const wantCat = legacyCategoryForType[gold.claim.type];
  const ranked = [...pool].sort((a, b) => {
    // Prefer exact category match, then higher confidence, then
    // deterministic verifier (fewer moving parts).
    const aCatMatch = legacyCategoryFromId(a.claimId) === wantCat ? 0 : 1;
    const bCatMatch = legacyCategoryFromId(b.claimId) === wantCat ? 0 : 1;
    if (aCatMatch !== bCatMatch) return aCatMatch - bCatMatch;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return 0;
  });
  // Fallback: just pick the highest-confidence `ok` verdict.
  const best = ranked[0] ?? pool[0];
  if (best === undefined) {
    return { verdict: 'skipped', status: 'empty_pool' };
  }
  if (best.status !== 'ok') {
    return { verdict: 'skipped', status: best.status };
  }
  return { verdict: best.verdict, status: 'ok' };
}

/** The legacy extractor produces claim ids of the form
 *  `sha256(category:field:value)`. We don't know the category from the
 *  id alone, so the pairing function is a no-op — all tiebreaking falls
 *  through to confidence ranking. Left as a named helper so a future
 *  refactor can wire category-aware matching once claim ids carry
 *  richer metadata. */
function legacyCategoryFromId(_claimId: string): string {
  return '';
}

function aggregateParity(rows: readonly ShadowParityRow[]): ParityAggregate {
  const perTypeMap = new Map<AtomicClaimType, { matches: number; compared: number }>();
  for (const t of ATOMIC_CLAIM_TYPES) {
    perTypeMap.set(t, { matches: 0, compared: 0 });
  }
  let matches = 0;
  for (const row of rows) {
    const bucket = perTypeMap.get(row.type);
    if (bucket === undefined) continue;
    bucket.compared += 1;
    if (row.verdictsMatch) {
      bucket.matches += 1;
      matches += 1;
    }
  }
  const perType: PerTypeParity[] = [];
  for (const t of ATOMIC_CLAIM_TYPES) {
    const b = perTypeMap.get(t)!;
    perType.push({
      type: t,
      compared: b.compared,
      matches: b.matches,
      parity: b.compared > 0 ? b.matches / b.compared : 0,
    });
  }
  return {
    overallParity: rows.length > 0 ? matches / rows.length : 0,
    overallCompared: rows.length,
    overallMatches: matches,
    perType,
  };
}

// ─── Bootstrap loader ────────────────────────────────────────────────────────

const BOOTSTRAP_GOLD_CLAIMS_PATH = fileURLToPath(
  new URL('../agent/gold-claims/gold-claims.jsonl', import.meta.url),
);

/** Load the bootstrap `gold-claims.jsonl` from disk and return the
 *  parsed {@link GoldClaim} list. Throws on schema violation. */
export function loadBootstrapGoldClaims(): readonly GoldClaim[] {
  const buf = readFileSync(BOOTSTRAP_GOLD_CLAIMS_PATH, 'utf8');
  return parseGoldClaimsJsonl(buf);
}
