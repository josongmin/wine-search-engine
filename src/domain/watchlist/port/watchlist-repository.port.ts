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
  WatchlistDeliveryLogRepositoryPort {}
