import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type {
  WatchlistDeliveryLogRepositoryPort,
  WatchlistRepositoryPort,
} from '../../domain/watchlist/port/watchlist-repository.port.js';

export class InMemoryWatchlistStore
implements WatchlistRepositoryPort, WatchlistDeliveryLogRepositoryPort {
  private readonly watchlists = new Map<string, WatchlistEntry>();
  private readonly deliveryLogs = new Map<string, WatchlistDeliveryLogEntry[]>();

  async save(entry: WatchlistEntry): Promise<void> {
    this.watchlists.set(entry.id, entry);
    if (!this.deliveryLogs.has(entry.id)) {
      this.deliveryLogs.set(entry.id, []);
    }
  }

  async findById(id: string): Promise<WatchlistEntry | null> {
    return this.watchlists.get(id) ?? null;
  }

  async findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]> {
    return [...this.watchlists.values()].filter((entry) => entry.entityId === entityId);
  }

  async delete(id: string): Promise<boolean> {
    return this.watchlists.delete(id);
  }

  async listByWatchlistId(
    watchlistId: string,
  ): Promise<readonly WatchlistDeliveryLogEntry[]> {
    return this.deliveryLogs.get(watchlistId) ?? [];
  }

  async append(log: WatchlistDeliveryLogEntry): Promise<void> {
    const logs = this.deliveryLogs.get(log.watchlistId) ?? [];
    logs.push(log);
    this.deliveryLogs.set(log.watchlistId, logs);
  }

  async deleteByWatchlistId(watchlistId: string): Promise<void> {
    this.deliveryLogs.delete(watchlistId);
  }

  async clear(): Promise<void> {
    this.watchlists.clear();
    this.deliveryLogs.clear();
  }
}
