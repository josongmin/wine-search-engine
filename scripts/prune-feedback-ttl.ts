/**
 * Runs one RFC-010 §8 feedback TTL prune cycle against Postgres.
 *
 * Usage (from repo root): `npx tsx scripts/prune-feedback-ttl.ts`
 */
import 'dotenv/config';

import { FeedbackTTLEnforcer } from '../src/domain/learning/service/feedback-ttl-enforcer.js';
import { config } from '../src/config/env.js';
import { createPgPool, closePgPool } from '../src/infrastructure/db/pg-pool.js';
import { PgFeedbackStore } from '../src/infrastructure/adapter/pg-feedback-store.js';

async function main(): Promise<void> {
  if (!config.pg.password || config.pg.password.length === 0) {
    console.error('PG password not configured; refusing to run.');
    process.exitCode = 1;
    return;
  }

  const pool = createPgPool(config.pg);
  try {
    const store = new PgFeedbackStore(pool);
    const enforcer = new FeedbackTTLEnforcer(store);
    const result = await enforcer.enforce();
    console.log(
      JSON.stringify(
        {
          runAt: result.runAt,
          deletedCount: result.deletedCount,
          shortSignalCutoff: result.shortSignalCutoff.toISOString(),
          longSignalCutoff: result.longSignalCutoff.toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await closePgPool(pool);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
