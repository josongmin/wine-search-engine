# E2E Testing Guide

## InMemory E2E (fast, no external deps)
pnpm run test:e2e

## Vespa E2E (requires Docker)
pnpm run test:e2e:vespa
# This will: start Docker, deploy schema, seed 35 wines, run tests, teardown

## Manual Vespa setup
pnpm run test:e2e:vespa:setup   # start + seed
pnpm run test:e2e:vespa:only    # run tests only (assumes setup done)
pnpm run test:e2e:vespa:teardown  # cleanup

## Architecture
- InMemory tests: test/e2e/*.test.ts (uses InMemorySearchIndex)
- Vespa tests: test/e2e/vespa/*.test.ts (requires VESPA_URL)

## Adding test wines
Edit scripts/seed-wines-real.ts and add to WINES array.
