/**
 * Contract test: HTTP schema validation must agree with domain parser.
 *
 * Catches drift between two parallel validation layers:
 * - HTTP schema (Zod, src/interface/http/schemas/watchlist.schema.ts)
 * - Domain parser (parseWatchlistTrigger, src/domain/watchlist/model/watchlist-entry.ts)
 *
 * If these layers disagree on whether a value is valid, downstream code
 * either crashes or accepts garbage. This test enforces parity for the
 * fields most likely to drift (numeric thresholds, sign conventions).
 *
 * Append-only.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CreateWatchlistRequestSchema } from '../../src/interface/http/schemas/watchlist.schema.js';
import { parseWatchlistTrigger } from '../../src/domain/watchlist/model/watchlist-entry.js';


describe('Watchlist schema ↔ domain parser parity', () => {
  it('price_drop threshold: schema and parser agree on accept/reject', async () => {

    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-50), max: Math.fround(150), noNaN: true }),
        fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
        (threshold, baseline) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [
              { type: 'price_drop', threshold, baseline_price: baseline },
            ],
            callback_url: 'https://example.com/hook',
          });

          const parserResult = parseWatchlistTrigger({
            type: 'price_drop',
            threshold,
            baselinePrice: baseline,
          });

          // Both must agree: either both accept or both reject.
          const schemaOk = schemaResult.success;
          const parserOk = parserResult !== null;
          return schemaOk === parserOk;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('new_vintage minVintage: schema and parser agree', async () => {

    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 3000 }),
        (minVintage) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [
              { type: 'new_vintage', min_vintage: minVintage },
            ],
            callback_url: 'https://example.com/hook',
          });

          const parserResult = parseWatchlistTrigger({
            type: 'new_vintage',
            minVintage,
          });

          return schemaResult.success === (parserResult !== null);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('stock_available minQty: schema and parser agree', async () => {

    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 1000 }),
        (minQty) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [
              { type: 'stock_available', min_qty: minQty },
            ],
            callback_url: 'https://example.com/hook',
          });

          const parserResult = parseWatchlistTrigger({
            type: 'stock_available',
            minQty,
          });

          return schemaResult.success === (parserResult !== null);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('critic_score_above threshold: schema and parser agree', async () => {

    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-10), max: Math.fround(120), noNaN: true }),
        (threshold) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [
              { type: 'critic_score_above', threshold },
            ],
            callback_url: 'https://example.com/hook',
          });

          const parserResult = parseWatchlistTrigger({
            type: 'critic_score_above',
            threshold,
          });

          return schemaResult.success === (parserResult !== null);
        },
      ),
      { numRuns: 100 },
    );
  });

  // The most likely drift is in integer-vs-float handling. fc.integer generators
  // miss this drift class entirely; fuzz with floats to lock parity.
  it('new_vintage rejects fractional values on both layers', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(1.1), max: Math.fround(2999.9), noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        (minVintage) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [{ type: 'new_vintage', min_vintage: minVintage }],
            callback_url: 'https://example.com/hook',
          });
          const parserResult = parseWatchlistTrigger({ type: 'new_vintage', minVintage });
          // Both must reject fractional values for new_vintage (integer-only).
          return !schemaResult.success && parserResult === null;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('stock_available rejects fractional values on both layers', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(1.1), max: Math.fround(999.9), noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        (minQty) => {
          const schemaResult = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [{ type: 'stock_available', min_qty: minQty }],
            callback_url: 'https://example.com/hook',
          });
          const parserResult = parseWatchlistTrigger({ type: 'stock_available', minQty });
          return !schemaResult.success && parserResult === null;
        },
      ),
      { numRuns: 100 },
    );
  });

  // Boundary cases for both layers
  it('boundary cases — both layers reject 0, NaN, Infinity, -1 for stock_available', () => {
    const badValues = [0, -1, NaN, Infinity, -Infinity, 1.5];
    for (const v of badValues) {
      const schemaResult = CreateWatchlistRequestSchema.safeParse({
        entity_id: 'wine-1',
        trigger_conditions: [{ type: 'stock_available', min_qty: v }],
        callback_url: 'https://example.com/hook',
      });
      const parserResult = parseWatchlistTrigger({ type: 'stock_available', minQty: v });
      expect(schemaResult.success).toBe(false);
      expect(parserResult).toBe(null);
    }
  });
});
