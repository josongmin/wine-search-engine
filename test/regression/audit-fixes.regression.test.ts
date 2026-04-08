/**
 * Regression tests for fixes discovered during the L15 audit rounds.
 *
 * This file is APPEND-ONLY. Each entry locks in a specific fix from a specific
 * round so that no future change silently re-introduces the bug. Never delete
 * tests from this file — only add new ones.
 *
 * Format per entry:
 * - regression ID (round number + short tag)
 * - link/comment to the original fix
 * - test that would FAIL if the fix were reverted
 */

import { describe, it, expect } from 'vitest';
import { CreateWatchlistRequestSchema } from '../../src/interface/http/schemas/watchlist.schema.js';
import { extractRuleBasedConstraints } from '../../src/domain/query/service/rule-based-constraint-extractor.js';
import { DrinkingWindowSchema } from '../../src/interface/http/schemas/search-response.schema.js';
import { ConfidenceRefusalPolicy } from '../../src/domain/decision/service/confidence-refusal.js';
import { QuerySanitizer } from '../../src/domain/security/service/query-sanitizer.js';
import { EmbeddingCacheKeyBuilder } from '../../src/domain/performance/model/cache-key.js';
import { MAX_QUERY_LENGTH } from '../../src/domain/shared/constants.js';

describe('Audit regressions — round 8 (self-audit pass)', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // R8-IPV6-FALSE-POSITIVE: hostnames starting with fc/fd/fe8/fe9/fea/feb
  // (e.g. fcm.googleapis.com, fedoraproject.org) were incorrectly classified
  // as IPv6 private addresses, breaking legitimate webhook callbacks.
  // Fix: only run IPv6 prefix checks when hostname contains ':'.
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-IPV6-FALSE-POSITIVE: legitimate hostnames not blocked', () => {
    const legitDomains = [
      'fcm.googleapis.com',
      'fedoraproject.org',
      'feature.example.com',
      'fdb.example.com',
      'febrile.example.com',
      'fearless.example.com',
    ];

    for (const domain of legitDomains) {
      it(`accepts https://${domain}/`, async () => {
        const result = CreateWatchlistRequestSchema.safeParse({
          entity_id: 'wine-1',
          trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
          callback_url: `https://${domain}/webhook`,
        });
        expect(result.success).toBe(true);
      });
    }

    it('still rejects actual IPv6 unique-local addresses', async () => {
      const result = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
        callback_url: 'https://[fc00::1]/webhook',
      });
      expect(result.success).toBe(false);
    });

    it('still rejects link-local IPv6 addresses', async () => {
      const result = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
        callback_url: 'https://[fe80::1]/webhook',
      });
      expect(result.success).toBe(false);
    });

    it('still rejects loopback IPv4', async () => {
      const result = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
        callback_url: 'https://127.0.0.1/webhook',
      });
      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-ROSE-REGEX: \b is ASCII-aware. \b(?:ros[eé]|로제)\b silently failed
  // to match "rosé" because é is not a word character, so the trailing
  // boundary did not behave as expected.
  // Fix: use Unicode lookarounds (\p{L}\p{N} + /u flag).
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-ROSE-REGEX: Unicode-aware rosé matching', () => {
    it('matches "rosé" with accent', async () => {
      const result = extractRuleBasedConstraints('rosé from Provence');
      const wineType = [...result.hard, ...result.soft, ...result.inferred].find(
        (c) => c.attribute === 'wine_type',
      );
      expect(wineType?.value).toBe('rosé');
    });

    it('matches "rose" without accent', async () => {
      const result = extractRuleBasedConstraints('rose from Provence');
      const wineType = [...result.hard, ...result.soft, ...result.inferred].find(
        (c) => c.attribute === 'wine_type',
      );
      expect(wineType?.value).toBe('rosé');
    });

    it('matches Korean 로제', async () => {
      const result = extractRuleBasedConstraints('프로방스 로제');
      const wineType = [...result.hard, ...result.soft, ...result.inferred].find(
        (c) => c.attribute === 'wine_type',
      );
      expect(wineType?.value).toBe('rosé');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-DRINKING-WINDOW-HISTORICAL: min(1900) rejected legitimate historical
  // wines (1800s Madeira, 1700s Port). Fix: lower bound to 1700.
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-DRINKING-WINDOW-HISTORICAL: pre-1900 vintages allowed', () => {
    it('accepts 1850 vintage (historical Madeira range)', async () => {
      const result = DrinkingWindowSchema.safeParse({
        drinking_window_start: 1850,
        drinking_window_end: 2050,
        currently_drinkable: true,
        confidence: 'medium',
      });
      expect(result.success).toBe(true);
    });

    it('accepts 1750 vintage (oldest historical wine range)', async () => {
      const result = DrinkingWindowSchema.safeParse({
        drinking_window_start: 1750,
        drinking_window_end: 2100,
        currently_drinkable: true,
        confidence: 'low',
      });
      expect(result.success).toBe(true);
    });

    it('still rejects year 999 (clearly invalid)', async () => {
      const result = DrinkingWindowSchema.safeParse({
        drinking_window_start: 999,
        drinking_window_end: 2050,
        currently_drinkable: true,
        confidence: 'medium',
      });
      expect(result.success).toBe(false);
    });

    it('still enforces start <= end', async () => {
      const result = DrinkingWindowSchema.safeParse({
        drinking_window_start: 2025,
        drinking_window_end: 2020,
        currently_drinkable: true,
        confidence: 'medium',
      });
      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-WATCHLIST-THRESHOLD-FRACTIONAL: schema rejected fractional percent
  // drops (0.5%) while domain parser accepted them — drift between layers.
  // Fix: schema uses .gt(0) to match domain parser's > 0.
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-WATCHLIST-THRESHOLD-FRACTIONAL', () => {
    it('accepts fractional price drop threshold (0.5%)', async () => {
      const result = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [
          { type: 'price_drop', threshold: 0.5, baseline_price: 100 },
        ],
        callback_url: 'https://example.com/hook',
      });
      expect(result.success).toBe(true);
    });

    it('rejects zero threshold', async () => {
      const result = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [
          { type: 'price_drop', threshold: 0, baseline_price: 100 },
        ],
        callback_url: 'https://example.com/hook',
      });
      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-NAN-CONFIDENCE-BYPASS: NaN < threshold returned false, allowing
  // NaN confidence to bypass the refusal policy.
  // Fix: explicit Number.isFinite guard returning true (refuse).
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-NAN-CONFIDENCE-BYPASS', () => {
    it('refuses NaN confidence', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      expect(policy.shouldRefuse(NaN)).toBe(true);
    });

    it('refuses Infinity', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      expect(policy.shouldRefuse(Infinity)).toBe(true);
    });

    it('refuses -Infinity', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      expect(policy.shouldRefuse(-Infinity)).toBe(true);
    });

    it('passes confidence above threshold', async () => {
      const policy = new ConfidenceRefusalPolicy(0.45);
      expect(policy.shouldRefuse(0.9)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-QUERY-SANITIZER-IGNORE-BYPASS: tightened ignore regex was too narrow,
  // missing "ignore everything", "ignore safety", "ignore rules" etc.
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-QUERY-SANITIZER-IGNORE-BYPASS', () => {
    const blockedPhrases = [
      'ignore previous instructions',
      'ignore all instructions',
      'ignore your safety guidelines',
      'ignore the rules',
      'ignore all policies',
      'ignore everything',
      'ignore instructions',
      'ignore rules',
      'ignore guidelines',
      'ignore safety',
    ];

    for (const phrase of blockedPhrases) {
      it(`blocks "${phrase}"`, async () => {
        const sanitizer = new QuerySanitizer();
        const result = sanitizer.sanitize(phrase);
        expect(result.safe).toBe(false);
      });
    }

    // Negative test: legitimate wine queries containing "ignore" followed by
    // a non-denylist word must NOT be blocked. The earlier version of this test
    // used a query ending in "ignore" which trivially passed because the regex
    // requires \s+ after "ignore" — that didn't actually exercise the narrowing.
    const legitimateQueries = [
      'wines that critics ignore for vintage tasting',
      'Bordeaux ignore tasting notes from 1990',
      'producers who ignore biodynamic certification',
    ];
    for (const phrase of legitimateQueries) {
      it(`does NOT block legitimate query: "${phrase}"`, async () => {
        const sanitizer = new QuerySanitizer();
        const result = sanitizer.sanitize(phrase);
        expect(result.safe).toBe(true);
      });
    }

    it('still rejects empty queries with EMPTY_QUERY reason', async () => {
      const sanitizer = new QuerySanitizer();
      const result = sanitizer.sanitize('');
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason).toBe('EMPTY_QUERY');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-EMBEDDING-CACHE-COLLISION: ("Search:","test") and ("Search",":test")
  // produced the same hash. Fix: null-byte delimiter.
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-EMBEDDING-CACHE-COLLISION', () => {
    it('different prefix+text combinations produce different keys', async () => {
      const builder = new EmbeddingCacheKeyBuilder();
      const a = builder.build('test', 'model-1', 'Search:');
      const b = builder.build(':test', 'model-1', 'Search');
      expect(a.redisKey).not.toBe(b.redisKey);
    });

    it('same inputs produce same key (deterministic)', async () => {
      const builder = new EmbeddingCacheKeyBuilder();
      const a = builder.build('test', 'model-1', 'Search:');
      const b = builder.build('test', 'model-1', 'Search:');
      expect(a.redisKey).toBe(b.redisKey);
    });

    it('no instruction prefix produces stable key', async () => {
      const builder = new EmbeddingCacheKeyBuilder();
      const a = builder.build('test', 'model-1');
      const b = builder.build('test', 'model-1');
      expect(a.redisKey).toBe(b.redisKey);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // R8-PLANNER-LENGTH-CAP: planner uses MAX_QUERY_LENGTH (not magic 500)
  // for ReDoS defense. Lock in the constant linkage AND that planner.ts
  // actually imports + uses it (not a duplicated magic number).
  // ─────────────────────────────────────────────────────────────────────────
  describe('R8-PLANNER-LENGTH-CAP', () => {
    it('MAX_QUERY_LENGTH constant exists and is reasonable', async () => {
      expect(MAX_QUERY_LENGTH).toBeGreaterThan(0);
      expect(MAX_QUERY_LENGTH).toBeLessThanOrEqual(2000);
    });

    it('planner.ts source imports MAX_QUERY_LENGTH (not a magic number)', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const plannerPath = fileURLToPath(
        new URL('../../src/domain/query/service/planner.ts', import.meta.url),
      );
      const source = readFileSync(plannerPath, 'utf8');
      // Must import the constant
      expect(source).toMatch(/import\s+\{[^}]*MAX_QUERY_LENGTH[^}]*\}\s+from/);
      // Must use it as the cap (not a hardcoded 500)
      expect(source).toMatch(/MAX_QUERY_LENGTH/);
      // Must NOT contain the literal `500` followed by `slice` (the old pattern)
      expect(source).not.toMatch(/length\s*>\s*500\s*\?\s*query\.slice\(0,\s*500\)/);
    });
  });
});
