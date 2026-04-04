/**
 * An attribute value inferred by the system from grape, region, or style data.
 * Inferred attributes are used to fill gaps when explicit attribute data is missing.
 */
export interface InferredAttribute {
  /** The attribute name (e.g. "body", "acidity", "sweetness"). */
  readonly attribute: string;
  /** The inferred numeric value in [0, 1]. */
  readonly value: number;
  /**
   * Confidence in this inference.
   * Range [0, 1]. This is an inference confidence, NOT a calibrated decision C.
   */
  readonly inferenceConfidence: number;
  /** Provenance of the inference rule (e.g. "grape_rule:cabernet_sauvignon", "region_rule:sauternes"). */
  readonly inferenceSource: string;
}
