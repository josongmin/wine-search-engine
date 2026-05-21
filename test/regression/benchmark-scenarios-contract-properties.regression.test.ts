/**
 * Property-based contract invariants for the agent benchmark scenario corpus.
 *
 * The `AGENT_SCENARIOS` corpus (480 scenarios, assembled from MAIN +
 * ADVERSARIAL + COVERAGE + BUNDLE + ROBUSTNESS bundles in scenarios.ts) is
 * DATA, not behavior: it is deterministic and fully enumerable at test time.
 * The LLM-as-judge that scores agent runs against these scenarios is a
 * separate concern and is NOT exercised here. This file pins the *structural*
 * contract of the corpus itself — the SOTA++ v3 scenario schema — so that a
 * malformed scenario (duplicate id, unknown tier, empty query, invalid attack
 * type, non-finite budget, missing expectation signal) is caught at unit-test
 * time instead of surfacing as a confusing benchmark-runner failure.
 *
 * Why property-based (fast-check) AND full enumeration: the deterministic
 * invariants (uniqueness, tier validity, budget finiteness) are checked by
 * exhaustive enumeration over the REAL corpus — that is strictly stronger than
 * sampling. fast-check is used for the sampled membership property (every
 * sampled scenario satisfies the per-scenario contract predicate) to document
 * the invariant in property form and to give shrinking on any future
 * regression. The corpus is the source of truth; no mocks.
 *
 * Touch-policy: regression-only, append-only. If a property does not hold,
 * the FIX is to repair the malformed scenario in the scenarios.* files — never
 * to loosen an invariant here.
 *
 * Invariants verified:
 *  1. id uniqueness — all scenario ids distinct across all merged bundles.
 *  2. required fields present — every scenario carries a numeric id, a tier,
 *     a string query, a non-empty description, and an expectation object that
 *     declares at least one observable expectation signal.
 *  3. tier validity — every tier ∈ the documented ScenarioTier enum.
 *  4. Korean coverage — a substantial number of scenarios contain Korean
 *     (Hangul) queries, and every query is NFC-normalized (no decomposed
 *     Jamo that would silently break NFKC substring matching downstream).
 *  5. adversarial attack-type validity — any declared attackType ∈ the
 *     documented AttackType enum; every fail-closed (expectedBlocked) scenario
 *     declares a concrete attackType.
 *  6. token / step / latency budget sanity — declared budgets are positive
 *     finite numbers; maxSteps is a non-negative integer.
 *  7. no empty query — every scenario query is non-empty after trim, EXCEPT
 *     the single documented empty-query edge case (id 21), which is a
 *     deliberate "reject empty input" contract.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AGENT_SCENARIOS } from '../benchmark/agent/scenarios.js';
import type {
  AgentBenchmarkScenario,
  AttackType,
  ScenarioTier,
  Severity,
} from '../benchmark/agent/scenario.js';

// ── Documented enums (mirror scenario.ts; kept here as the contract baseline).
// If scenario.ts adds a tier/attack-type, this list MUST be updated in lockstep
// — that is the point: the test forces an intentional review of corpus shape.
const VALID_TIERS: ReadonlySet<ScenarioTier> = new Set<ScenarioTier>([
  'single_shot',
  'multi_step',
  'complex_reasoning',
  'conversational',
  'edge_case',
  'nested_condition',
  'comparison_nested',
  'relative_reference',
  'situation_based',
  'negation',
  'knowledge_hybrid',
  'extreme',
  'korean_colloquial',
  'price_expression',
  'mood_atmosphere',
  'korean_food_pairing',
  'gift_refined',
  'seasonal_temporal',
  'adversarial',
  'wine_name_lookup',
  'taste_descriptor',
  'rating_score',
  'wine_type_basic',
  'negation_complex',
  'arithmetic_query',
  'bilingual_mixed',
  'cellar_aging',
]);

const VALID_ATTACK_TYPES: ReadonlySet<AttackType> = new Set<AttackType>([
  'prompt_injection',
  'jailbreak',
  'indirect_injection',
  'token_smuggling',
  'resource_exhaustion',
  'off_domain',
  'pii_extraction',
  'hallucination_bait',
  'sql_injection',
  'output_hijack',
]);

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['critical', 'major', 'minor']);

/**
 * The single documented exception to the "no empty query" rule: scenario 21
 * deliberately submits an empty query to assert the agent rejects empty input
 * (see scenarios.ts id 21, "Empty query → 400").
 */
const DOCUMENTED_EMPTY_QUERY_ID = 21;

// Hangul syllable + Jamo blocks. Used to detect Korean content.
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/u;

/**
 * Does a scenario declare at least one observable expectation signal? A
 * scenario with none would be silently un-scoreable (the runner would have
 * nothing to assert against), so the corpus contract requires at least one.
 */
function hasExpectationSignal(s: AgentBenchmarkScenario): boolean {
  const e = s.expectation;
  return (
    (e.tools != null && e.tools.length > 0) ||
    (e.mustNotCallTools != null && e.mustNotCallTools.length > 0) ||
    (e.answerContains != null && e.answerContains.length > 0) ||
    (e.answerMustMatch != null && e.answerMustMatch.length > 0) ||
    (e.answerMustNotMatch != null && e.answerMustNotMatch.length > 0) ||
    e.rubric != null ||
    e.expectedBlocked === true ||
    e.exactLookup != null ||
    e.expectedConstraints != null ||
    e.expectedEntities != null ||
    (s.goldenKeywords != null && s.goldenKeywords.length > 0)
  );
}

describe('benchmark scenario corpus — contract properties (regression)', () => {
  // Sanity: the merged corpus is non-trivially large. Guards against an import
  // regression that silently drops a bundle (e.g. COVERAGE_SCENARIOS = []).
  it('corpus is the full merged AGENT_SCENARIOS set (non-trivial size)', () => {
    expect(AGENT_SCENARIOS.length).toBeGreaterThanOrEqual(400);
  });

  it('property 1 — scenario ids are unique across all merged bundles', () => {
    const ids = AGENT_SCENARIOS.map((s) => s.id);
    const seen = new Set<number>();
    const duplicates: number[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(AGENT_SCENARIOS.length);
  });

  it('property 2 — every scenario carries required fields + an expectation signal', () => {
    const offenders = AGENT_SCENARIOS.filter(
      (s) =>
        !Number.isInteger(s.id) ||
        typeof s.tier !== 'string' ||
        typeof s.query !== 'string' ||
        typeof s.description !== 'string' ||
        s.description.trim().length === 0 ||
        s.expectation == null ||
        !hasExpectationSignal(s),
    ).map((s) => s.id);
    expect(offenders).toEqual([]);
  });

  it('property 3 — every tier is in the documented ScenarioTier enum', () => {
    const offenders = AGENT_SCENARIOS.filter((s) => !VALID_TIERS.has(s.tier)).map((s) => ({
      id: s.id,
      tier: s.tier,
    }));
    expect(offenders).toEqual([]);
  });

  it('property 3b — every declared severity is in the documented Severity enum', () => {
    const offenders = AGENT_SCENARIOS.filter(
      (s) => s.severity != null && !VALID_SEVERITIES.has(s.severity),
    ).map((s) => ({ id: s.id, severity: s.severity }));
    expect(offenders).toEqual([]);
  });

  it('property 4 — substantial Korean (Hangul) query coverage exists', () => {
    const koreanScenarios = AGENT_SCENARIOS.filter((s) => HANGUL.test(s.query));
    // The corpus is a Korean wine-assistant benchmark; Korean queries dominate.
    expect(koreanScenarios.length).toBeGreaterThan(0);
    expect(koreanScenarios.length).toBeGreaterThanOrEqual(100);
  });

  it('property 4b — every query is NFC-normalized (no decomposed Hangul Jamo)', () => {
    // Decomposed Hangul (NFD) silently breaks NFKC substring matching in the
    // scorer and answerContains/answerMustMatch contracts. Pin NFC.
    const offenders = AGENT_SCENARIOS.filter((s) => s.query.normalize('NFC') !== s.query).map(
      (s) => s.id,
    );
    expect(offenders).toEqual([]);
  });

  it('property 5 — every declared attackType is in the documented AttackType enum', () => {
    const offenders = AGENT_SCENARIOS.filter(
      (s) => s.expectation.attackType != null && !VALID_ATTACK_TYPES.has(s.expectation.attackType),
    ).map((s) => ({ id: s.id, attackType: s.expectation.attackType }));
    expect(offenders).toEqual([]);
  });

  it('property 5b — every fail-closed (expectedBlocked) scenario declares a concrete attackType', () => {
    // A blocked scenario asserts a security gate fired; without a taxonomy tag
    // the security dashboard cannot attribute the block. This invariant holds
    // for the current corpus (5/5) and must be preserved for new blocks.
    const offenders = AGENT_SCENARIOS.filter(
      (s) => s.expectation.expectedBlocked === true && s.expectation.attackType == null,
    ).map((s) => s.id);
    expect(offenders).toEqual([]);
  });

  it('property 6 — step / token / latency budgets are sane (positive finite; maxSteps non-negative int)', () => {
    const offenders = AGENT_SCENARIOS.filter((s) => {
      const e = s.expectation;
      if (!Number.isInteger(e.maxSteps) || e.maxSteps < 0) return true;
      if (e.maxTotalTokens != null && (!Number.isFinite(e.maxTotalTokens) || e.maxTotalTokens <= 0))
        return true;
      if (e.maxDurationMs != null && (!Number.isFinite(e.maxDurationMs) || e.maxDurationMs <= 0))
        return true;
      return false;
    }).map((s) => ({
      id: s.id,
      maxSteps: s.expectation.maxSteps,
      maxTotalTokens: s.expectation.maxTotalTokens,
      maxDurationMs: s.expectation.maxDurationMs,
    }));
    expect(offenders).toEqual([]);
  });

  it('property 7 — no empty query except the documented empty-query edge case (id 21)', () => {
    const offenders = AGENT_SCENARIOS.filter(
      (s) => s.query.trim().length === 0 && s.id !== DOCUMENTED_EMPTY_QUERY_ID,
    ).map((s) => s.id);
    expect(offenders).toEqual([]);
    // The documented exception must still be present (guards against silent removal).
    expect(AGENT_SCENARIOS.some((s) => s.id === DOCUMENTED_EMPTY_QUERY_ID)).toBe(true);
  });

  it('property 8 — goldenKeywords (when present) are non-empty, lowercase fragments', () => {
    // contextRecall matching is NFKC + case-insensitive but authored lowercase;
    // an upper-case or blank keyword would never match observation strings.
    const offenders = AGENT_SCENARIOS.filter(
      (s) =>
        s.goldenKeywords != null &&
        s.goldenKeywords.some((k) => k.trim().length === 0 || k !== k.toLowerCase()),
    ).map((s) => s.id);
    expect(offenders).toEqual([]);
  });

  // ── Property-based membership: every sampled scenario satisfies the full
  // per-scenario contract predicate. Exhaustive enumeration above already
  // proves the population; this documents the invariant in fast-check form and
  // yields shrinking on any future regression.
  it('property (fast-check) — every sampled scenario satisfies the full contract predicate', () => {
    const corpus = AGENT_SCENARIOS;
    fc.assert(
      fc.property(fc.nat({ max: corpus.length - 1 }), (idx) => {
        const s = corpus[idx];
        if (s == null) return false;
        const e = s.expectation;
        const tierOk = VALID_TIERS.has(s.tier);
        const queryOk =
          typeof s.query === 'string' &&
          s.query.normalize('NFC') === s.query &&
          (s.query.trim().length > 0 || s.id === DOCUMENTED_EMPTY_QUERY_ID);
        const attackOk =
          e.attackType == null ? true : VALID_ATTACK_TYPES.has(e.attackType);
        const blockedOk = e.expectedBlocked === true ? e.attackType != null : true;
        const budgetOk =
          Number.isInteger(e.maxSteps) &&
          e.maxSteps >= 0 &&
          (e.maxTotalTokens == null || (Number.isFinite(e.maxTotalTokens) && e.maxTotalTokens > 0)) &&
          (e.maxDurationMs == null || (Number.isFinite(e.maxDurationMs) && e.maxDurationMs > 0));
        const signalOk = hasExpectationSignal(s);
        return tierOk && queryOk && attackOk && blockedOk && budgetOk && signalOk;
      }),
      { numRuns: 100 },
    );
  });
});
