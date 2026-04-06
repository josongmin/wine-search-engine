# Drinking Window Model Bundle

`DRINKING_WINDOW_MODEL_DIR` points to a directory that must contain:

- `window_start.onnx`
- `window_end.onnx`

Startup behavior:

- if `DRINKING_WINDOW_MODEL_DIR` is unset, the service uses the built-in heuristic predictor
- if `DRINKING_WINDOW_MODEL_DIR` is set, startup attempts to load both ONNX files
- if either file is missing or `onnxruntime-node` cannot load them, startup fails
- in `production`, heuristic-only drinking-window prediction is rejected unless
  `ALLOW_HEURISTIC_DRINKING_WINDOW=true` is explicitly set

Operational expectations:

- `/ready` exposes `drinking_window_model`
- heuristic models surface as a non-required degraded check (`down`)
- loaded ONNX-backed models surface as `up`
- heuristic or unknown model versions are never reported to clients as high-confidence
