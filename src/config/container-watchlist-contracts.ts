import type { WatchlistServicePort } from '../application/watchlist/watchlist.service.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';

export type WatchlistServiceContract = WatchlistServicePort;
export type WatchlistRuntimeContract = WatchlistRuntimePort;
