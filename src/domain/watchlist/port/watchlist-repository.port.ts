import type {
  WatchlistDeliveryLogEntry,
  WatchlistEntry,
} from '../model/watchlist-entry.js';

export interface WatchlistRepositoryPort {
  save(entry: WatchlistEntry): Promise<void>;
  findById(id: string): Promise<WatchlistEntry | null>;
  findByUserId(userId: string): Promise<readonly WatchlistEntry[]>;
  findByEntityId(entityId: string): Promise<readonly WatchlistEntry[]>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface WatchlistDeliveryLogRepositoryPort {
  listByWatchlistId(watchlistId: string): Promise<readonly WatchlistDeliveryLogEntry[]>;
  append(log: WatchlistDeliveryLogEntry): Promise<void>;
  clear(): Promise<void>;
}

export interface WatchlistStoragePort extends
  WatchlistRepositoryPort,
  WatchlistDeliveryLogRepositoryPort {

  /**
   * Executes `fn` within a database transaction.
   * The transactional store passed to `fn` uses the same connection and
   * supports `findByIdForUpdate` for row-level locking.
   *
   * Commits on success, rolls back on error.
   */
  withTransaction<T>(fn: (tx: TransactionalWatchlistStore) => Promise<T>): Promise<T>;
}

/**
 * Extended store interface available inside a transaction.
 * Adds `findByIdForUpdate` for SELECT ... FOR UPDATE row locking.
 */
export interface TransactionalWatchlistStore extends WatchlistStoragePort {
  findByIdForUpdate(id: string): Promise<WatchlistEntry | null>;
}
