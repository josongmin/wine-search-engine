# Audit package handoff

**Product / repository:** Wine Search Engine (replace with public codename if needed)  
**Archive filename:** `________________________`  
**SHA-256:** `________________________`  
**Git commit (if archive excludes `.git`):** `________________________`  
**Date:** `________________________`

## Scope

**In scope for this review**

- (e.g. HTTP API surface, search pipeline in `src/`, agent orchestration, infrastructure adapters)

**Explicitly out of scope**

- (e.g. production databases, live API keys, Vespa/Redis/PG production clusters)

## Environment & secrets

- **No production credentials** are included. Configuration keys are listed in **`.env.example`** (values must be supplied by the auditor’s sandbox or omitted).
- **Third-party / external services** (names only): e.g. OpenAI, PostgreSQL, Redis, Vespa, …

## How to build & test (no secrets)

- **Node.js:** version `________________________` (see `package.json` `engines`)
- **Install:** `npm ci`
- **Typecheck:** `npm run typecheck`
- **Tests (pick one):** `npm run test` / `npm run test:unit` / …  
  **Note:** some integration or e2e tests may require local Vespa/DB; document what fails without them.

## Known limitations

- (e.g. “Vespa-backed e2e skipped without `VESPA_URL`”, “path X is stub only”, …)

## Contact

- **Technical:** Name / email / Slack: `________________________`
