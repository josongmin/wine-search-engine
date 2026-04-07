# Test lanes & profiles

Repo-local rules for choosing test lanes. This file is for agents and operators. Product behavior still lives in `docs/RFC-*.md`.

## Default rule

- Do **not** run the heaviest search regression tests by default.
- Start with the narrowest lane that matches the change.
- Only escalate to heavier lanes when the changed code actually touches those paths.

## Lane map

### Fast/default lanes

- `npm run test`
  - Lightweight everyday lane.
  - Uses `config/vitest/dev.config.ts`.
  - Keeps normal local iteration focused on the fastest useful coverage.

- `npm run test:watch`
  - Watch-mode version of the same lightweight everyday lane.

- `npm run check:dev`
  - Recommended everyday check before or during local iteration.
  - Runs `typecheck + npm test`.

- `npm run test:unit`
  - Fuller unit regression lane.
  - Uses `config/vitest/unit.config.ts`.
  - Excludes heavy search regression coverage on purpose.
  - Also excludes watchlist/search-specific suites that already have dedicated lanes.

- `npm run test:integration`
  - General integration lane from `test/integration/**/*.test.ts`.
  - Excludes `test/integration/search-pipeline.test.ts`, which is treated as heavy.
  - Also includes `src/__tests__/integration/**/*.integration.test.ts`.

- `npm run test:watchlist`
  - Watchlist-focused lane only.
  - Owns the watchlist-specific `src/__tests__` files so they do not slow down the default unit lane.

- `npm run test:meta`
  - Meta/parity lane for workflow, fixture-lane, and route-contract consistency checks.
  - Kept out of the everyday dev lane because these are important but not part of the core inner loop.

### Heavy lane

- `npm run test:heavy`
  - Uses `config/vitest/heavy.config.ts`.
  - Single-fork lane for the expensive search regression tests that are still worth keeping:
    - `test/integration/search-pipeline.test.ts`
  - Run this when touching:
    - query planning / routing
    - candidate retrieval / fusion
    - decision engine behavior
    - response-building behavior for search
    - replay behavior / search snapshot compatibility

### Other specialized lanes

- `npm run test:e2e:contract`
  - HTTP contract lane.

- `npm run test:e2e:runtime`
  - Runtime/quality-heavy e2e lane.

- `npm run test:e2e:replay:fixtures:runtime-required`
  - Replay fixtures that require runtime behavior but not the full external-runtime lane.

- `npm run test:e2e:replay:fixtures:full-runtime`
  - Full-runtime replay lane. Expensive. Do not run casually.

- `npm run test:quality`
  - Quality regression lane.

## Pre-push profiles

- `npm run git:prepush:quick`
  - `typecheck + test:unit`
  - Use for quick local iteration.

- `npm run git:prepush`
  - `typecheck + test:unit + verify:http-contracts`
  - Main default pre-push gate.

- `npm run git:prepush:heavy`
  - `git:prepush + test:heavy`
  - Use before pushing changes that touch search pipeline logic or replay/snapshot behavior.

## Keep / remove guidance

- Keep heavy tests only if they provide distinct regression value.
- Remove or rewrite tests that are mainly:
  - ad hoc debugging logs
  - exploratory root-cause traces
  - duplicate coverage of better-structured regression tests
  - large fixture loads with weak assertions

- If a test needs giant fixtures or verbose tracing just to help an investigation, prefer:
  - a one-off local script
  - a temporary test not wired into any default lane
  - a narrowly scoped heavy-lane regression with strong assertions

## Current policy

- The old diagnostic tests (`live-search`, `debug-search`, `trace-pipeline`, `root-cause-trace`) were intentionally removed from automated lanes because they were expensive and low-signal.
- The heavy lane should stay small. Add to it reluctantly.
- `src/__tests__/integration/cache-service.integration.test.ts` lives in the integration lane rather than the default unit lane.
