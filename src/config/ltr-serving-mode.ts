/**
 * Product SSOT: LTR serving is intentionally disabled for the live request path.
 * Re-enable here first before wiring runtime/model loading back into startup.
 */
export function isLtrServingEnabled(): boolean {
  return false;
}
