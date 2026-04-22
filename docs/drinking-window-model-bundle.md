# Drinking Window Model Bundle

The runtime baseline is the built-in deterministic predictor.

`DRINKING_WINDOW_MODEL_DIR`, when set, points to an ONNX override directory that must contain:

- `window_start.onnx`
- `window_end.onnx`

Startup behavior:

- if `DRINKING_WINDOW_MODEL_DIR` is unset, the service uses the built-in deterministic predictor
- if `DRINKING_WINDOW_MODEL_DIR` is set, startup attempts to load both ONNX files and upgrades the runtime predictor to the ONNX path
- if either file is missing or `onnxruntime-node` cannot load them, startup fails

Operational expectations:

- `/ready` exposes `drinking_window_model`
- deterministic and loaded ONNX-backed models surface as `up`
- heuristic or unknown model versions surface as a degraded check (`down`)
- heuristic or unknown model versions are never reported to clients as high-confidence
