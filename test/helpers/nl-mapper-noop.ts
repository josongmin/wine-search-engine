/**
 * No-op NL mapper implementation for unit testing.
 * Returns empty results for all constraint mapping requests.
 */

import { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';

/**
 * Creates a no-op NL mapper that returns no constraints for any query.
 */
export class NLMapperNoOp extends NLMapper {
  constructor() {
    const noOpMappingTable: MappingTablePort = {
      findMapping: async () => null,
      findMappingsByAttribute: async () => [],
      getCurrentVersion: async () => 'v1-noop',
    };
    super(noOpMappingTable);
  }
}
