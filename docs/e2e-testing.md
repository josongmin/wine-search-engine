# E2E Testing Guide

## InMemory E2E (fast, no external deps)
npm run test:e2e

## Vespa E2E (requires Docker)
npm run test:e2e:vespa
# This will: start Docker, deploy schema, seed 35 wines, run tests, teardown

## Manual Vespa setup
npm run test:e2e:vespa:setup   # start + seed
npm run test:e2e:vespa:only    # run tests only (assumes setup done)
npm run test:e2e:vespa:teardown  # cleanup

## Architecture
- InMemory tests: test/e2e/*.test.ts (uses InMemorySearchIndex)
- Vespa tests: test/e2e/vespa/*.test.ts (requires VESPA_URL)

## Adding test wines
Edit scripts/seed-wines-real.ts and add to WINES array.
