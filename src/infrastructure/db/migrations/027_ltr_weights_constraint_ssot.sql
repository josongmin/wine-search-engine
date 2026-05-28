-- LTR weight vector dimensionality is governed by feature_schema_hash, not a
-- stale SQL constant. The registry must accept any non-empty 1-D vector and
-- let runtime feature-parity validation reject incompatible models.
ALTER TABLE ltr_model_registry
  DROP CONSTRAINT IF EXISTS ltr_model_registry_weights_check;

ALTER TABLE ltr_model_registry
  ADD CONSTRAINT ltr_model_registry_weights_check
  CHECK (array_ndims(weights) = 1 AND array_length(weights, 1) >= 1);
