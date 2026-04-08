// Models
export {
  type AttributeSpace,
  type WineStyle,
  type PriceBand,
  PRICE_BAND_BOUNDARIES_KRW,
  priceBandFromKRW,
} from './model/attributes.js';

export { type NLMapping } from './model/nl-mapping.js';

export {
  type NormalizedConstraint,
  type ConstraintBundle,
  type ConstraintOperator,
  type ConstraintEvaluationResult,
} from './model/constraint.js';

export { type InferredAttribute } from './model/inferred-attribute.js';

// Ports
export { type MappingTablePort } from './port/mapping-table.port.js';

// Services
export { NLMapper, type MapConstraintsOptions } from './service/nl-mapper.js';
export { ConstraintEvaluator } from './service/constraint-evaluator.js';
export { AttributeInferrer } from './service/attribute-inferrer.js';
