/*
 * Angel One SmartAPI provider boundary.
 *
 * This file is intentionally not connected yet. Implement against the current
 * official SmartAPI docs and the currently supported SDK/API version.
 *
 * Required safeguards before returning providerState.mode = "live":
 * - server-side authentication and token refresh
 * - WebSocket 2.0 reconnect + 30-second heartbeat
 * - current instrument-master lookup (never hard-code option tokens)
 * - correct binary packet parsing and exchange timestamps
 * - tick-to-5-minute OHLCV aggregation
 * - stale-feed detection and market-session handling
 * - option contract selection, bid/ask spread and liquidity filters
 *
 * Never log or expose credentials, JWTs, feed tokens, PINs or TOTP values.
 */
export function createAngelOneProvider() {
  throw new Error("Angel One provider is not configured. App must remain in DEMO/STALE mode.");
}
