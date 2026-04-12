import type { Config } from './env.js';

export function isWatchlistEnabled(config: Config): boolean {
  return config.watchlist.enabled;
}

export function getWatchlistWebhookSecret(config: Config): string {
  if (!isWatchlistEnabled(config) || config.watchlist.webhookSecret === undefined) {
    throw new Error('Watchlist delivery is not fully configured');
  }

  return config.watchlist.webhookSecret;
}

export function expectsRedisAtStartup(config: Config): boolean {
  // No Redis URL configured → skip connection attempt entirely.
  if (config.redis.url === undefined) return false;
  return !config.killSwitch.queryCache
    || (config.anthropic.apiKey !== undefined && !config.killSwitch.injectionJudge)
    || isWatchlistEnabled(config);
}

export function canUseInMemoryWatchlistStore(config: Config): boolean {
  return config.nodeEnv !== 'production';
}

export function requiresPersistentWatchlistStore(config: Config): boolean {
  return isWatchlistEnabled(config) && !canUseInMemoryWatchlistStore(config);
}
