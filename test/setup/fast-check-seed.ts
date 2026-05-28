/**
 * Determinism for fast-check property tests (R5 C1).
 *
 * Without a fixed seed, every CI run re-shuffles property inputs and a
 * flake from a rare counterexample is unreproducible. We pin ONE seed
 * here so any failure can be replayed by re-running the same test file;
 * coverage diversity still comes from `numRuns` per `fc.assert` call,
 * not from seed randomness.
 *
 * To temporarily explore with a different seed locally, set
 * `FAST_CHECK_SEED=<integer>` in the environment.
 */
import fc from 'fast-check';

/** Fixed seed for reproducible property-test runs. Arbitrary but stable. */
const DEFAULT_FAST_CHECK_SEED = 0x5eed_1234;

function resolveSeed(): number {
  const raw = process.env['FAST_CHECK_SEED'];
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_FAST_CHECK_SEED;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_FAST_CHECK_SEED;
}

fc.configureGlobal({ seed: resolveSeed() });
