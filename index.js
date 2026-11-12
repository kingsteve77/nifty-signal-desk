import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSignal } from "./strategy.js";

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

let providerState = {
  mode: process.env.APP_MODE === "live" ? "stale" : "demo",
  connected: false,
  lastTickAt: null,
  note: "No verified Angel One provider is connected. Demo mode only."
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: providerState, now: new Date().toISOString() });
});

app.get("/api/signal/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!["NIFTY", "BANKNIFTY"].includes(symbol)) {
    return res.status(400).json({ error: "Supported symbols: NIFTY, BANKNIFTY" });
  }
  // Never generate a trade signal from placeholder or fabricated candles.
  res.json({
    symbol,
    action: "NO TRADE",
    reason: "No verified live or historical candle feed is configured.",
    source: providerState.mode,
    setupScore: null,
    entry: null,
    stopLoss: null,
    target: null,
    holdingWindow: null,
    updatedAt: new Date().toISOString()
  });
});

app.post("/api/analyze", (req, res) => {
  const { symbol, candles, source, lastTickAt } = req.body || {};
  if (!["NIFTY", "BANKNIFTY"].includes(String(symbol).toUpperCase())) {
    return res.status(400).json({ error: "Invalid symbol." });
  }
  if (source !== "angelone" || !Array.isArray(candles)) {
    return res.status(400).json({ error: "Only verified Angel One candle payloads can be analyzed." });
  }
  const freshnessMs = lastTickAt ? Date.now() - new Date(lastTickAt).getTime() : Infinity;
  if (!Number.isFinite(freshnessMs) || freshnessMs > 30_000) {
    return res.status(409).json({ error: "Market data is stale. Signal blocked." });
  }
  res.json(evaluateSignal(String(symbol).toUpperCase(), candles));
});

app.listen(PORT, () => {
  console.log(`NIFTY Signal Desk running at http://localhost:${PORT}`);
});
