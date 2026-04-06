# Drinking Window Model Drop Zone

Place the production model bundle here when available:

- `window_start.onnx`
- `window_end.onnx`

Example verification:

```bash
npm run verify:drinking-window-model -- models/drinking-window
```

Example startup:

```bash
DRINKING_WINDOW_MODEL_DIR=models/drinking-window npm run dev
```

**Production policy:** without ONNX, `NODE_ENV=production` refuses startup unless `ALLOW_HEURISTIC_DRINKING_WINDOW=true`. At runtime, `DrinkingWindowPredictor` uses ONNX when loaded; with `allowHeuristicFallback=false` (production + heuristic not opted-in), `predict()` throws instead of silently using the rule-based path.
