import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistStoragePort,
  TransactionalWatchlistStore,
} from '../../domain/watchlist/port/watchlist-repository.port.js';

export class InMemoryWatchlistStore implements WatchlistStoragePort, TransactionalWatchlistStore {
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

  findByIdForUpdate(id: string): Promise<WatchlistEntry | null> {
    // In-memory: no locking needed, same as findById
    return this.findById(id);
  }

  async withTransaction<T>(fn: (tx: TransactionalWatchlistStore) => Promise<T>): Promise<T> {
    // Parity with PgWatchlistStore: the port JSDoc says "Commits on success,
    // rolls back on error". In production the rollback happens via PG's
    // BEGIN/ROLLBACK; for in-memory parity we snapshot the maps before fn()
    // runs and restore them if fn() throws. Without this, tests that use
    // the in-memory adapter would observe partial mutations on error while
    // production (PG) would see none — a silent stub-vs-prod drift.
    const watchlistsSnapshot = new Map(this.watchlists);
    const deliveryLogsSnapshot = new Map<string, WatchlistDeliveryLogEntry[]>();
    for (const [k, v] of this.deliveryLogs) {
      deliveryLogsSnapshot.set(k, [...v]);
    }
    try {
      return await fn(this);
    } catch (err) {
      this.watchlists.clear();
      for (const [k, v] of watchlistsSnapshot) {
        this.watchlists.set(k, v);
      }
      this.deliveryLogs.clear();
      for (const [k, v] of deliveryLogsSnapshot) {
        this.deliveryLogs.set(k, v);
      }
      throw err;
    }
  }
}
