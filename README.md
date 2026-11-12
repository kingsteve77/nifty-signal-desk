# NIFTY Signal Desk

A mobile-first intraday decision dashboard for NIFTY and BANK NIFTY.

## Current release: safe starter / paper-trading shell

This project intentionally does **not** fabricate live prices or live signals. The browser starts in Demo mode. A real Angel One feed must be configured and verified before the app can display a Live status.

### Features in this starter
- NIFTY and BANK NIFTY dashboard cards
- Live / stale / demo connection states
- Signal panel: BUY CE, BUY PE, EXIT, or NO TRADE
- Setup quality score (not a probability of profit)
- Entry, stop, target, invalidation and estimated holding window fields
- Paper-trade journal
- Risk calculator
- Node/Express backend health endpoint
- Environment variable template; no credentials committed

## Architecture

- `public/`: responsive browser dashboard
- `server/`: Express API and provider boundary
- `server/strategy.js`: transparent indicator-based rules
- Angel One SmartAPI integration must run server-side. Never put API keys, client codes, passwords, PINs, TOTP secrets, JWTs or feed tokens in frontend code or GitHub.

## Run locally

Requirements: Node.js 20+

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000

The app remains in DEMO mode until a verified provider adapter is implemented and configured.

## Angel One setup

1. Create/register a SmartAPI app through Angel One's official SmartAPI portal.
2. Read the current official SmartAPI documentation and confirm the current authentication, WebSocket 2.0 packet format, instrument-master format, and API limits.
3. Put credentials only in the backend `.env` or a deployment secret manager.
4. Implement the provider adapter in `server/providers/angelOne.js`.
5. Resolve current NIFTY and BANKNIFTY index tokens and option contract tokens from the current instrument master at runtime. Do not hard-code expiry/strike tokens.
6. Verify timestamp freshness, reconnect/heartbeat handling, market-session handling, and candle construction before enabling `LIVE`.
7. Test with paper trades for a meaningful sample and review slippage, charges and drawdown.

Official documentation: https://smartapi.angelone.in/docs

## Signal interpretation

The initial rule engine is deliberately conservative:
- It needs enough 5-minute candles.
- It uses VWAP, EMA 9/20, RSI(14), relative volume and recent price structure.
- It returns NO TRADE if data is missing, stale, contradictory or the setup is weak.
- The score is a rule-confluence score, not a statistically validated win probability.
- The holding window is a risk-management estimate, not a guarantee. Exit on stop, target, invalidation, or timeout.

## Important limitations

- No order execution is implemented.
- No live Angel One connection is included in this starter release.
- No financial return is guaranteed.
- Options are leveraged and can lose the entire premium. Use paper trading first.
- Brokerage, STT, exchange charges, GST, stamp duty, slippage and option liquidity must be included in realistic P&L testing.
