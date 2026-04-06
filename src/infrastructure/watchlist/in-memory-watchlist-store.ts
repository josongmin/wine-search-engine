import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistStoragePort,
} from '../../domain/watchlist/port/watchlist-repository.port.js';

export class InMemoryWatchlistStore implements WatchlistStoragePort {
  private readonly watchlists = new Map<string, WatchlistEntry>();
  private readonly deliveryLogs = new Map<string, WatchlistDeliveryLogEntry[]>();

  save(entry: WatchlistEntry): Promise<void> {
    this.watchlists.set(entry.id, entry);
    if (!this.deliveryLogs.has(entry.id)) {
      this.deliveryLogs.set(entry.id, []);
    }
    return Promise.resolve();
  }

  findById(id: string): Promise<WatchlistEntry | null> {
    return Promise.resolve(this.watchlists.get(id) ?? null);
  }

  findByUserId(userId: string): Promise<readonly WatchlistEntry[]> {
    return Promise.resolve(
      [...this.watchlists.values()].filter((entry) => entry.userId === userId),
    );
  }

  findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    return Promise.resolve(
      [...this.watchlists.values()].filter((entry) => entry.entityId === entityId),
    );
  }

  delete(id: string): Promise<boolean> {
    const deleted = this.watchlists.delete(id);
    if (deleted) {
      this.deliveryLogs.delete(id);
    }
    return Promise.resolve(deleted);
  }

  listByWatchlistId(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[]> {
    return Promise.resolve(this.deliveryLogs.get(watchlistId) ?? []);
  }

  append(log: WatchlistDeliveryLogEntry): Promise<void> {
    const logs = this.deliveryLogs.get(log.watchlistId) ?? [];
    logs.push(log);
    this.deliveryLogs.set(log.watchlistId, logs);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.watchlists.clear();
    this.deliveryLogs.clear();
    return Promise.resolve();
  }
}
