import type { SearchLogSchema } from './search-log-schema.js';
import { bootstrapLogger } from '../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'search_observability' });

export function logSearchEvent(event: SearchLogSchema): void {
  log.info({
    event_type: 'search_execution',
    ...event,
  });
}
