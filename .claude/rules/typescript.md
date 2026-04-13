# TypeScript (`src/**/*.ts`)

- Match existing patterns: path aliases (`@domain/*`, etc.), ESM imports with `.js` extensions where the project uses them.
- Respect `exactOptionalPropertyTypes`: build objects with conditional spreads instead of assigning `undefined` to optional keys.
- After edits, run `pnpm run lint` and `pnpm run typecheck` before considering the task done.
