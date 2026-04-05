import type { Pool } from 'pg';
import type { RedisClient } from '../infrastructure/db/redis-client.js';

export interface RuntimeHandles {
  readonly pool?: Pool;
  readonly redisClient?: RedisClient;
}
